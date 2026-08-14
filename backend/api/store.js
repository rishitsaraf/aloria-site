/* /api/store/* — single entry for the whole commerce API.
   Deployed via the catch-all shim api/store/[...route].js. Routes are
   declared as "METHOD pattern" pairs; ":name" segments capture params.
   Admin routes are wrapped with requireAdmin; all mutating requests pass
   the same-origin check (CSRF defence on top of SameSite cookies). */

const { json, notFound, assertSameOrigin, matchRoute, HttpError } = require("../lib/http");
const { requireAdmin } = require("../lib/auth");

const authRoutes = require("../store/authRoutes");
const catalog = require("../store/catalog");
const cartRoutes = require("../store/cartRoutes");
const checkout = require("../store/checkout");
const admin = require("../store/admin");
const seed = require("../store/seed");
const cron = require("../store/cron");

const adminWrap = (fn) => async (req, res, params) => { await requireAdmin(req); return fn(req, res, params); };

const ROUTES = [
  // auth & account
  ["POST", "auth/register", authRoutes.register],
  ["POST", "auth/login", authRoutes.login],
  ["POST", "auth/logout", authRoutes.logout],
  ["GET", "auth/me", authRoutes.me],

  // catalog (public)
  ["GET", "products", catalog.list],
  ["GET", "products/:slug", catalog.detail],

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
  ["GET", "orders/lookup", checkout.lookup],
  ["GET", "orders", checkout.myOrders],

  // cron
  ["GET", "cron/sweep", cron.sweep],

  // admin CMS
  ["GET", "admin/metrics", adminWrap(admin.metrics)],
  ["GET", "admin/products", adminWrap(admin.listProducts)],
  ["POST", "admin/products", adminWrap(admin.createProduct)],
  ["GET", "admin/products/:id", adminWrap(admin.getProduct)],
  ["PATCH", "admin/products/:id", adminWrap(admin.updateProduct)],
  ["DELETE", "admin/products/:id", adminWrap(admin.deleteProduct)],
  ["PUT", "admin/products/:id/variants", adminWrap(admin.putVariants)],
  ["GET", "admin/orders", adminWrap(admin.listOrders)],
  ["GET", "admin/orders/:id", adminWrap(admin.getOrder)],
  ["PATCH", "admin/orders/:id", adminWrap(admin.updateOrder)],
  ["GET", "admin/customers", adminWrap(admin.listCustomers)],
  ["GET", "admin/carts/abandoned", adminWrap(admin.listAbandoned)],
  ["POST", "admin/carts/:id/recovery-email", adminWrap(admin.sendRecovery)],
  ["GET", "admin/discounts", adminWrap(admin.listDiscounts)],
  ["POST", "admin/discounts", adminWrap(admin.createDiscount)],
  ["DELETE", "admin/discounts/:code", adminWrap(admin.deleteDiscount)],
  ["GET", "admin/waitlist", adminWrap(admin.listWaitlist)],
  ["POST", "admin/seed", adminWrap(seed.seed)],
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
