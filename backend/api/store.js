/* /api/store/* — single entry for the whole commerce API.
   Deployed via the catch-all shim api/store/[...route].js. Routes are
   declared as "METHOD pattern" pairs; ":name" segments capture params.

   CMS routes carry a minimum staff role — viewer (read), editor (operate),
   admin (settings/staff/destructive) — and every non-GET staff call is
   written to the admin audit log. All mutating requests pass the
   same-origin check (CSRF defence on top of SameSite cookies). */

const db = require("../lib/db");
const { json, notFound, assertSameOrigin, matchRoute, HttpError } = require("../lib/http");
const { requireStaff } = require("../lib/auth");

const authRoutes = require("../store/authRoutes");
const catalog = require("../store/catalog");
const content = require("../store/content");
const cartRoutes = require("../store/cartRoutes");
const checkout = require("../store/checkout");
const admin = require("../store/admin");
const adminInventory = require("../store/adminInventory");
const adminOps = require("../store/adminOps");
const adminContent = require("../store/adminContent");
const adminStaff = require("../store/adminStaff");
const reviews = require("../store/reviews");
const contact = require("../store/contact");
const wishlist = require("../store/wishlist");
const seed = require("../store/seed");
const cron = require("../store/cron");
const sitemap = require("../store/sitemap");
const feeds = require("../store/feeds");

/** Staff gate + audit trail. GETs need `viewer`; mutations default `editor`;
    sensitive routes pass "admin" explicitly. */
const staff = (fn, minRole) => async (req, res, params) => {
  const min = minRole || (req.method === "GET" ? "viewer" : "editor");
  const user = await requireStaff(req, min);
  req.adminUser = user;
  await fn(req, res, params);
  if (req.method !== "GET") {
    const pathname = new URL(req.url, "http://x").pathname;
    db.query(
      "INSERT INTO admin_audit (user_id, email, method, path) VALUES ($1, $2, $3, $4)",
      [user.id, user.email, req.method, pathname.slice(0, 300)]
    ).catch((e) => console.error("[audit]", e.message));
  }
};

const ROUTES = [
  // auth & account
  ["POST", "auth/register", authRoutes.register],
  ["POST", "auth/login", authRoutes.login],
  ["POST", "auth/logout", authRoutes.logout],
  ["POST", "auth/logout-all", authRoutes.logoutAll],
  ["GET", "auth/me", authRoutes.me],
  ["POST", "auth/forgot", authRoutes.forgot],
  ["POST", "auth/reset", authRoutes.reset],

  // catalog & site content (public)
  ["GET", "products", catalog.list],
  ["GET", "products/:slug", catalog.detail],
  ["GET", "products/:slug/reviews", reviews.listForProduct],
  ["POST", "products/:slug/reviews", reviews.create],
  ["GET", "content", content.content],
  ["GET", "pages/:slug", content.pageDetail],
  ["POST", "contact", contact.submit],
  ["POST", "stock-alerts", wishlist.createAlert],
  ["GET", "wishlist", wishlist.listWishlist],
  ["POST", "wishlist/toggle", wishlist.toggleWishlist],

  // cart
  ["GET", "cart", cartRoutes.get],
  ["POST", "cart/items", cartRoutes.addItem],
  ["PATCH", "cart/items/:id", cartRoutes.updateItem],
  ["DELETE", "cart/items/:id", cartRoutes.removeItem],
  ["POST", "cart/email", cartRoutes.captureEmail],
  ["POST", "cart/recover", cartRoutes.recover],

  // checkout & orders
  ["POST", "checkout/quote", checkout.quote],
  ["POST", "checkout", checkout.create],
  ["POST", "checkout/confirm", checkout.confirm],
  ["POST", "payments/webhook", checkout.webhook],
  ["GET", "orders/lookup", checkout.lookup],
  ["GET", "orders", checkout.myOrders],

  // cron & seo
  ["GET", "cron/sweep", cron.sweep],
  ["GET", "sitemap", sitemap.sitemap],
  ["GET", "robots", sitemap.robots],
  ["GET", "feed/google", feeds.google],
  ["GET", "feed/meta", feeds.metaCsv],

  // ---- CMS: dashboard & catalog
  ["GET", "admin/metrics", staff(admin.metrics)],
  ["GET", "admin/products", staff(admin.listProducts)],
  ["POST", "admin/products", staff(admin.createProduct)],
  ["POST", "admin/products/bulk", staff(adminOps.bulkProducts)],
  ["GET", "admin/products/:id", staff(admin.getProduct)],
  ["PATCH", "admin/products/:id", staff(admin.updateProduct)],
  ["DELETE", "admin/products/:id", staff(admin.deleteProduct, "admin")],
  ["PUT", "admin/products/:id/variants", staff(admin.putVariants)],
  ["POST", "admin/products/:id/duplicate", staff(adminOps.duplicateProduct)],
  ["GET", "admin/catalog/export", staff(adminOps.exportCatalog)],
  ["POST", "admin/catalog/import", staff(adminOps.importCatalog)],

  // ---- CMS: inventory
  ["GET", "admin/inventory", staff(adminInventory.list)],
  ["PATCH", "admin/inventory/:id", staff(adminInventory.adjust)],
  ["GET", "admin/inventory/movements", staff(adminInventory.movements)],

  // ---- CMS: orders
  ["GET", "admin/orders", staff(admin.listOrders)],
  ["POST", "admin/orders", staff(adminOps.createManualOrder)],
  ["GET", "admin/orders/:id", staff(admin.getOrder)],
  ["PATCH", "admin/orders/:id", staff(admin.updateOrder)],
  ["POST", "admin/orders/:id/notes", staff(admin.addOrderNote)],
  ["POST", "admin/orders/:id/resend-confirmation", staff(admin.resendConfirmation)],

  // ---- CMS: customers & carts
  ["GET", "admin/customers", staff(admin.listCustomers)],
  ["GET", "admin/customers/:id", staff(admin.getCustomer)],
  ["PATCH", "admin/customers/:id", staff(admin.updateCustomer)],
  ["GET", "admin/carts/abandoned", staff(admin.listAbandoned)],
  ["POST", "admin/carts/:id/recovery-email", staff(admin.sendRecovery)],

  // ---- CMS: marketing
  ["GET", "admin/discounts", staff(admin.listDiscounts)],
  ["POST", "admin/discounts", staff(admin.createDiscount)],
  ["DELETE", "admin/discounts/:code", staff(admin.deleteDiscount)],
  ["GET", "admin/waitlist", staff(admin.listWaitlist)],
  ["GET", "admin/reviews", staff(reviews.adminList)],
  ["PATCH", "admin/reviews/:id", staff(reviews.adminUpdate)],
  ["DELETE", "admin/reviews/:id", staff(reviews.adminDelete)],
  ["GET", "admin/contact", staff(contact.adminList)],
  ["PATCH", "admin/contact/:id", staff(contact.adminUpdate)],
  ["DELETE", "admin/contact/:id", staff(contact.adminDelete)],
  ["POST", "admin/waitlist/broadcast", staff(adminOps.broadcastWaitlist, "admin")],

  // ---- CMS: content, pages, collections
  ["PUT", "admin/content", staff(adminContent.putContent)],
  ["GET", "admin/pages", staff(adminContent.listPages)],
  ["POST", "admin/pages", staff(adminContent.createPage)],
  ["GET", "admin/pages/:id", staff(adminContent.getPage)],
  ["PATCH", "admin/pages/:id", staff(adminContent.updatePage)],
  ["DELETE", "admin/pages/:id", staff(adminContent.deletePage)],
  ["GET", "admin/collections", staff(adminContent.listCollections)],
  ["POST", "admin/collections", staff(adminContent.createCollection)],
  ["PATCH", "admin/collections/:id", staff(adminContent.updateCollection)],
  ["DELETE", "admin/collections/:id", staff(adminContent.deleteCollection)],

  // ---- CMS: settings, staff, security, tools
  ["GET", "admin/settings", staff(adminContent.getSettings)],
  ["PUT", "admin/settings", staff(adminContent.putSettings, "admin")],
  ["GET", "admin/staff", staff(adminStaff.listStaff, "admin")],
  ["POST", "admin/staff", staff(adminStaff.inviteStaff, "admin")],
  ["PATCH", "admin/staff/:id", staff(adminStaff.updateStaff, "admin")],
  ["GET", "admin/audit", staff(adminStaff.listAudit, "admin")],
  ["POST", "admin/totp/setup", staff(adminStaff.totpSetup, "viewer")],
  ["POST", "admin/totp/enable", staff(adminStaff.totpEnable, "viewer")],
  ["POST", "admin/totp/disable", staff(adminStaff.totpDisable, "viewer")],
  ["POST", "admin/uploads", staff(adminOps.upload)],
  ["GET", "admin/emails/:template/preview", staff(adminOps.previewEmail)],
  ["POST", "admin/emails/:template/test", staff(adminOps.testEmail)],
  ["POST", "admin/seed", staff(seed.seed, "admin")],
];

module.exports = async (req, res) => {
  try {
    assertSameOrigin(req);
    const pathname = new URL(req.url, "http://x").pathname;
    const segments = pathname.replace(/^\/api\/store\/?/, "").split("/").filter(Boolean);
    for (const [method, pattern, handler] of ROUTES) {
      if (req.method !== method) continue;
      const params = matchRoute(pattern, segments);
      if (params) {
        await handler(req, res, params);
        return;
      }
    }
    throw notFound(`No route for ${req.method} /api/store/${segments.join("/")}`);
  } catch (err) {
    if (err instanceof HttpError || err.expose) {
      json(res, err.statusCode || 400, { ok: false, error: err.message, ...(err.extra || {}) });
    } else {
      console.error(`[store] ${req.method} ${req.url} →`, err);
      json(res, 500, { ok: false, error: "Something went wrong on our side — please try again" });
    }
  }
};
