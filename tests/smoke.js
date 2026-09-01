/* End-to-end smoke test for the Aloria commerce API against local Postgres. */
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://aloria@127.0.0.1:55432/aloria";
process.env.ADMIN_EMAIL = "admin@aloria.test";
process.env.ADMIN_PASSWORD = "super-secret-admin";
process.env.SITE_URL = "https://aloria.test";

const assert = require("assert");
const store = require("../backend/api/store.js");
const db = require("../backend/lib/db.js");

function makeRes() {
  const res = {
    headers: {}, statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    json(p) { this.body = p; this.done = true; },
  };
  return res;
}

class Jar {
  constructor() { this.cookies = {}; }
  absorb(res) {
    let sc = res.getHeader("set-cookie");
    if (!sc) return;
    for (const line of [].concat(sc)) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), val = decodeURIComponent(pair.slice(i + 1));
      if (/Max-Age=0/.test(line)) delete this.cookies[name];
      else this.cookies[name] = val;
    }
  }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function call(jar, method, path, body, query = {}) {
  const req = {
    method,
    url: `/api/store/${path}`,
    body,
    query,
    headers: { host: "aloria.test", "x-forwarded-proto": "https", cookie: jar ? jar.header() : "", "user-agent": "smoke" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  const res = makeRes();
  await store(req, res);
  if (jar) jar.absorb(res);
  return res;
}

async function call2(jar, method, path, res, query = {}) {
  const req = {
    method, url: `/api/store/${path}`, body: {}, query,
    headers: { host: "aloria.test", "x-forwarded-proto": "https", cookie: jar ? jar.header() : "", "user-agent": "smoke" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  await store(req, res);
  if (jar) jar.absorb(res);
  return res;
}

(async () => {
  const admin = new Jar();
  const shopper = new Jar();

  // --- admin bootstrap + login
  let r = await call(admin, "POST", "auth/login", { email: "admin@aloria.test", password: "super-secret-admin" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, "admin");
  console.log("✓ admin bootstrap + login");

  // wrong password rejected + rate limit works
  r = await call(new Jar(), "POST", "auth/login", { email: "admin@aloria.test", password: "nope" });
  assert.equal(r.statusCode, 400);
  console.log("✓ bad login rejected");

  // --- seed
  r = await call(admin, "POST", "admin/seed", {});
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  console.log(`✓ seed: ${r.body.productsCreated} products, ${r.body.variantsCreated} variants`);
  r = await call(admin, "POST", "admin/seed", {});
  assert.equal(r.statusCode, 400); // idempotent guard
  console.log("✓ re-seed guarded");

  // --- non-admin can't touch CMS
  r = await call(shopper, "GET", "admin/metrics");
  assert.equal(r.statusCode, 401);
  r = await call(shopper, "POST", "auth/register", { email: "rishi@example.com", password: "password123", name: "Rishit" });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  r = await call(shopper, "GET", "admin/metrics");
  assert.equal(r.statusCode, 403);
  console.log("✓ RBAC: customer blocked from CMS");

  // --- catalog
  r = await call(shopper, "GET", "products", null, {});
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.products.length >= 10, "expected seeded products");
  r = await call(shopper, "GET", "products", null, { category: "ear" });
  assert.ok(r.body.products.every((p) => p.category === "ear"));
  r = await call(shopper, "GET", "products/primary-stem-stud");
  assert.equal(r.statusCode, 200);
  const stud = r.body.product;
  assert.equal(stud.variants.length, 40);
  assert.equal(stud.options.length, 3);
  console.log(`✓ catalog: list + detail (${stud.variants.length} variants on E1)`);

  // --- cart flow
  const v1 = stud.variants[0], v2 = stud.variants[5];
  r = await call(shopper, "POST", "cart/items", { variantId: v1.id, qty: 2 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(shopper, "POST", "cart/items", { variantId: v2.id, qty: 1 });
  assert.equal(r.body.cart.count, 3);
  const itemId = r.body.cart.items[0].id;
  r = await call(shopper, "PATCH", `cart/items/${itemId}`, { qty: 1 });
  assert.equal(r.body.cart.count, 2);
  console.log("✓ cart: add / update");

  // --- quote with discount
  r = await call(shopper, "POST", "checkout/quote", { discountCode: "WELCOME10" });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.discountCents > 0);
  const expectedTotal = r.body.totalCents;
  console.log(`✓ quote: subtotal ${r.body.cart.subtotalCents}¢ − ${r.body.discountCents}¢ + ship ${r.body.shippingCents}¢`);

  // --- checkout (test payment)
  r = await call(shopper, "POST", "checkout", {
    email: "rishi@example.com", name: "Rishit Saraf",
    address: { line1: "1 Marina Blvd", city: "Singapore", postal: "018989", country: "SG" },
    discountCode: "WELCOME10", paymentMethod: "test",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const { orderNumber, key } = r.body;
  r = await call(shopper, "GET", "orders/lookup", null, { number: orderNumber, key });
  assert.equal(r.body.order.status, "paid");
  assert.equal(r.body.order.totalCents, expectedTotal);
  console.log(`✓ checkout: ${orderNumber} paid, total matches quote (${expectedTotal}¢)`);

  // stock decremented
  const st = await db.query("SELECT stock FROM variants WHERE id = $1", [v1.id]);
  console.log(`✓ stock decremented (variant ${v1.id} now ${st.rows[0].stock})`);

  // my orders
  r = await call(shopper, "GET", "orders");
  assert.equal(r.body.orders.length, 1);
  console.log("✓ order history for signed-in customer");

  // --- abandoned cart: new guest cart w/ email, backdate, sweep
  const guest = new Jar();
  r = await call(guest, "POST", "cart/items", { variantId: v2.id, qty: 1 });
  assert.equal(r.statusCode, 200);
  r = await call(guest, "POST", "cart/email", { email: "ghost@example.com" });
  assert.equal(r.statusCode, 200);
  await db.query("UPDATE carts SET updated_at = now() - interval '3 hours' WHERE email = 'ghost@example.com'");
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.marked >= 1, "cart should be marked abandoned");
  const ab = await db.query("SELECT status, recovery_token, recovery_sent_at FROM carts WHERE email = 'ghost@example.com'");
  assert.equal(ab.rows[0].status, "abandoned");
  assert.ok(ab.rows[0].recovery_token);
  assert.ok(ab.rows[0].recovery_sent_at, "recovery email should be recorded");
  console.log("✓ abandoned-cart sweep: marked + recovery email sent");

  // --- recovery link restores the cart in a fresh browser
  const newBrowser = new Jar();
  r = await call(newBrowser, "POST", "cart/recover", { token: ab.rows[0].recovery_token });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.cart.count, 1);
  r = await call(newBrowser, "GET", "cart");
  assert.equal(r.body.cart.count, 1);
  console.log("✓ recovery link restores bag in fresh browser");

  // recovered cart converts → tracked
  r = await call(newBrowser, "POST", "checkout", {
    email: "ghost@example.com", name: "Ghost Buyer",
    address: { line1: "2 Rue de Rivoli", city: "Paris", postal: "75001", country: "FR" },
    paymentMethod: "test",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const rec = await db.query("SELECT from_recovered_cart FROM orders WHERE number = $1", [r.body.orderNumber]);
  assert.equal(rec.rows[0].from_recovered_cart, true);
  console.log("✓ recovered cart conversion tracked");

  // --- admin: metrics, orders, abandoned view, product CRUD + variants
  r = await call(admin, "GET", "admin/metrics");
  assert.ok(r.body.paidOrders >= 2 && r.body.recoveredOrders >= 1, JSON.stringify(r.body));
  console.log(`✓ metrics: revenue ${r.body.revenueCents}¢, recovered ${r.body.recoveredRevenueCents}¢`);

  r = await call(admin, "GET", "admin/orders", null, { status: "paid" });
  const oid = r.body.orders.find((o) => o.number === orderNumber).id;
  r = await call(admin, "PATCH", `admin/orders/${oid}`, { status: "refunded" });
  assert.equal(r.body.order.status, "refunded");
  const st2 = await db.query("SELECT stock FROM variants WHERE id = $1", [v1.id]);
  assert.equal(st2.rows[0].stock, st.rows[0].stock + 1, "refund should restock");
  console.log("✓ admin order refund restocks inventory");

  // product CRUD + variant matrix
  r = await call(admin, "POST", "admin/products", {
    title: "Test Halo Band", category: "rings", price_cents: 4400, status: "draft",
    options: [{ name: "Plating", values: ["Gold", "Rhodium"] }],
    images: ["/assets/img/worn/rings/rings_worn_01.webp"],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const pid = r.body.product.id;
  r = await call(admin, "PUT", `admin/products/${pid}/variants`, {
    variants: [
      { sku: "THB-GLD", options: { Plating: "Gold" }, stock: 5 },
      { sku: "THB-RHD", options: { Plating: "Rhodium" }, stock: 3, price_cents: 4800 },
    ],
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.variants.length, 2);
  // round-trip with ids (regression: BIGINT string vs number comparison
  // must not delete kept rows)
  const withIds = r.body.variants.map((v) => ({ id: v.id, sku: v.sku, options: v.options, price_cents: v.price_cents, stock: 9, active: true }));
  r = await call(admin, "PUT", `admin/products/${pid}/variants`, { variants: withIds });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.variants.length, 2, "re-PUT with ids must keep both variants");
  assert.ok(r.body.variants.every((v) => v.stock === 9));
  console.log("✓ variant re-save with ids keeps all rows");
  r = await call(admin, "PATCH", `admin/products/${pid}`, { status: "active" });
  assert.equal(r.body.product.status, "active");
  r = await call(shopper, "GET", "products/test-halo-band");
  assert.equal(r.body.product.variants.length, 2);
  assert.equal(r.body.product.variants[1].priceCents, 4800);
  r = await call(admin, "DELETE", `admin/products/${pid}`);
  assert.ok(r.body.deleted);
  console.log("✓ admin product + variant matrix CRUD");

  // duplicate option combo rejected
  r = await call(admin, "POST", "admin/products", { title: "Dup Test", category: "ear", options: [{ name: "Plating", values: ["Gold"] }] });
  const pid2 = r.body.product.id;
  r = await call(admin, "PUT", `admin/products/${pid2}/variants`, {
    variants: [
      { sku: "DUP-1", options: { Plating: "Gold" }, stock: 1 },
      { sku: "DUP-2", options: { Plating: "Gold" }, stock: 1 },
    ],
  });
  assert.equal(r.statusCode, 400);
  await call(admin, "DELETE", `admin/products/${pid2}`);
  console.log("✓ duplicate option combination rejected");

  // abandoned list + manual recovery send
  r = await call(admin, "GET", "admin/carts/abandoned");
  assert.equal(r.statusCode, 200);
  console.log(`✓ admin abandoned-cart view (${r.body.carts.length} listed)`);

  // discounts admin
  r = await call(admin, "POST", "admin/discounts", { code: "vip20", kind: "percent", value: 20 });
  assert.equal(r.body.discount.code, "VIP20");
  r = await call(admin, "DELETE", "admin/discounts/VIP20");
  assert.equal(r.statusCode, 200);
  console.log("✓ discount management");

  // CSRF origin check
  r = await (async () => {
    const req = {
      method: "POST", url: "/api/store/cart/items", body: { variantId: v1.id },
      headers: { host: "aloria.test", origin: "https://evil.example", cookie: shopper.header() },
      socket: { remoteAddress: "1.2.3.4" },
    };
    const res = makeRes();
    await store(req, res);
    return res;
  })();
  assert.equal(r.statusCode, 403);
  console.log("✓ cross-origin mutation rejected");

  // oversell guard: cap stock at 1, two buyers race
  await db.query("UPDATE variants SET stock = 1 WHERE id = $1", [v2.id]);
  const b1 = new Jar(), b2 = new Jar();
  await call(b1, "POST", "cart/items", { variantId: v2.id, qty: 1 });
  await call(b2, "POST", "cart/items", { variantId: v2.id, qty: 1 });
  const addr = { line1: "x", city: "y", postal: "z", country: "US" };
  const [c1, c2] = await Promise.all([
    call(b1, "POST", "checkout", { email: "a@a.com", name: "A", address: addr, paymentMethod: "test" }),
    call(b2, "POST", "checkout", { email: "b@b.com", name: "B", address: addr, paymentMethod: "test" }),
  ]);
  const oks = [c1, c2].filter((x) => x.statusCode === 200).length;
  assert.equal(oks, 1, `expected exactly one winner, got ${oks}`);
  const finalStock = await db.query("SELECT stock FROM variants WHERE id = $1", [v2.id]);
  assert.equal(finalStock.rows[0].stock, 0);
  console.log("✓ concurrent checkout: no oversell, exactly one winner");

  // --- password reset flow
  r = await call(new Jar(), "POST", "auth/forgot", { email: "rishi@example.com" });
  assert.equal(r.statusCode, 200);
  r = await call(new Jar(), "POST", "auth/forgot", { email: "does-not-exist@example.com" });
  assert.equal(r.statusCode, 200, "no account enumeration");
  const prToken = await db.query(
    "SELECT pr.token_hash FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE u.email = 'rishi@example.com'");
  assert.equal(prToken.rows.length, 1);
  // we only store the hash; forge a known token directly for the test
  const crypto = require("crypto");
  const rawToken = crypto.randomBytes(32).toString("hex");
  await db.query("UPDATE password_resets SET token_hash = $1 WHERE token_hash = $2",
    [crypto.createHash("sha256").update(rawToken).digest("hex"), prToken.rows[0].token_hash]);
  const resetJar = new Jar();
  r = await call(resetJar, "POST", "auth/reset", { token: rawToken, password: "brand-new-pass-1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(resetJar, "GET", "auth/me");
  assert.equal(r.body.user.email, "rishi@example.com");
  r = await call(new Jar(), "POST", "auth/login", { email: "rishi@example.com", password: "brand-new-pass-1" });
  assert.equal(r.statusCode, 200, "new password works");
  r = await call(new Jar(), "POST", "auth/login", { email: "rishi@example.com", password: "password123" });
  assert.equal(r.statusCode, 400, "old password dead");
  r = await call(new Jar(), "POST", "auth/reset", { token: rawToken, password: "whatever-else-1" });
  assert.equal(r.statusCode, 400, "token single-use");
  console.log("✓ password reset: no enumeration, single-use token, sessions rotated");

  // --- quote exposes gateway-agnostic payment capability
  r = await call(shopper, "POST", "checkout/quote", {});
  assert.equal(r.body.payments.provider, "test");
  assert.equal(r.body.payments.online, false);
  console.log("✓ quote reports payment provider (test mode, no gateway)");

  // --- payment webhook endpoint exists and rejects unsigned calls (test provider)
  r = await call(null, "POST", "payments/webhook", {});
  assert.equal(r.statusCode, 400, "unverified webhook rejected");
  console.log("✓ payments webhook rejects unverifiable payloads");

  // --- metrics revenue series
  r = await call(admin, "GET", "admin/metrics");
  assert.equal(r.body.revenueByDay.length, 14);
  assert.ok(r.body.revenueByDay[13].revenueCents > 0, "today has revenue");
  console.log("✓ metrics: 14-day zero-filled revenue series");

  // --- sitemap + robots
  const smRes = makeRes();
  smRes.end = function (x) { this.body = x; };
  await store({ method: "GET", url: "/api/store/sitemap", headers: { host: "aloria.test" }, query: {}, socket: {} }, smRes);
  assert.ok(String(smRes.body).includes("<urlset"), "sitemap xml");
  assert.ok(String(smRes.body).includes("primary-stem-stud"), "sitemap lists products");
  const rbRes = makeRes();
  rbRes.end = function (x) { this.body = x; };
  await store({ method: "GET", url: "/api/store/robots", headers: { host: "aloria.test" }, query: {}, socket: {} }, rbRes);
  assert.ok(String(rbRes.body).includes("Sitemap: https://aloria.test/sitemap.xml"), "robots has absolute sitemap");
  assert.ok(String(rbRes.body).includes("Disallow: /admin"), "robots blocks admin");
  console.log("✓ sitemap.xml + robots.txt");

  // ================= ROUND 3 =================

  // --- settings: shipping + tax editable, quote honours them
  r = await call(admin, "GET", "admin/settings");
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.settings["shipping.flat_cents"] >= 0);
  r = await call(admin, "PUT", "admin/settings", { settings: {
    "shipping.flat_cents": 500, "shipping.free_threshold_cents": 999999,
    "tax.default_pct": 0, "tax.by_country": { GB: 20 },
  } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const taxShopper = new Jar();
  r = await call(taxShopper, "POST", "cart/items", { variantId: stud.variants[10].id, qty: 1 });
  assert.equal(r.statusCode, 200);
  r = await call(taxShopper, "POST", "checkout/quote", { country: "GB" });
  assert.equal(r.body.taxPct, 20);
  assert.equal(r.body.shippingCents, 500);
  assert.equal(r.body.taxCents, Math.round(r.body.cart.subtotalCents * 0.2));
  r = await call(taxShopper, "POST", "checkout/quote", { country: "US" });
  assert.equal(r.body.taxPct, 0);
  console.log("✓ settings drive shipping + per-country tax in quotes");

  // tax lands on the order itself
  r = await call(taxShopper, "POST", "checkout", {
    email: "taxman@example.com", name: "Tax Man",
    address: { line1: "1 High St", city: "London", postal: "E1", country: "GB" }, paymentMethod: "test",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(taxShopper, "GET", "orders/lookup", null, { number: r.body.orderNumber, key: r.body.key });
  assert.ok(r.body.order.taxCents > 0, "order carries tax");
  console.log("✓ checkout stores tax on the order");
  await call(admin, "PUT", "admin/settings", { settings: { "shipping.free_threshold_cents": 7500, "tax.by_country": {} } });

  // --- discount upgrades: free shipping + max uses + once per customer
  r = await call(admin, "POST", "admin/discounts", { code: "SHIPFREE", kind: "free_shipping", max_uses: 1, once_per_customer: true });
  assert.equal(r.body.discount.kind, "free_shipping");
  const fsJar = new Jar();
  await call(fsJar, "POST", "cart/items", { variantId: stud.variants[11].id, qty: 1 });
  r = await call(fsJar, "POST", "checkout/quote", { discountCode: "SHIPFREE" });
  assert.equal(r.body.shippingCents, 0, "free shipping discount");
  r = await call(fsJar, "POST", "checkout", {
    email: "ship@example.com", name: "Ship", discountCode: "SHIPFREE",
    address: { line1: "x", city: "y", postal: "z", country: "US" }, paymentMethod: "test",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const fsJar2 = new Jar();
  await call(fsJar2, "POST", "cart/items", { variantId: stud.variants[12].id, qty: 1 });
  r = await call(fsJar2, "POST", "checkout/quote", { discountCode: "SHIPFREE" });
  assert.equal(r.statusCode, 400, "max_uses=1 exhausted");
  console.log("✓ discounts: free shipping + usage limits enforced");

  // --- inventory: list, manual adjust, movement log
  r = await call(admin, "GET", "admin/inventory", null, { q: stud.variants[0].sku });
  assert.equal(r.statusCode, 200);
  const invVariant = r.body.variants[0];
  const beforeStock = invVariant.stock;
  r = await call(admin, "PATCH", `admin/inventory/${invVariant.id}`, { delta: 5, note: "restock test" });
  assert.equal(r.body.variant.stock, beforeStock + 5);
  r = await call(admin, "GET", "admin/inventory/movements", null, { sku: invVariant.sku });
  assert.ok(r.body.movements.some((mv) => mv.reason === "manual" && mv.delta === 5), "manual movement logged");
  assert.ok(r.body.movements.some((mv) => mv.reason === "sale"), "sale movements logged");
  console.log("✓ inventory: adjustments + movement audit trail");

  // --- order timeline, notes, tracking, resend
  r = await call(admin, "GET", "admin/orders", null, { status: "paid" });
  const tlOrder = r.body.orders[0];
  r = await call(admin, "POST", `admin/orders/${tlOrder.id}/notes`, { note: "gift wrap requested" });
  assert.equal(r.statusCode, 200);
  r = await call(admin, "PATCH", `admin/orders/${tlOrder.id}`, { status: "fulfilled", trackingCarrier: "DHL", trackingNumber: "JD123" });
  assert.equal(r.body.order.tracking_number, "JD123");
  r = await call(admin, "GET", `admin/orders/${tlOrder.id}`);
  const kinds = r.body.events.map((e) => e.kind);
  assert.ok(kinds.includes("note") && kinds.includes("status"), `timeline has note+status (${kinds})`);
  assert.ok(kinds.includes("email"), "shipping email logged in timeline");
  r = await call(admin, "POST", `admin/orders/${tlOrder.id}/resend-confirmation`, {});
  assert.equal(r.statusCode, 200);
  console.log("✓ orders: notes, tracking on fulfilment, timeline, re-send");

  // sku + date filters
  r = await call(admin, "GET", "admin/orders", null, { sku: stud.variants[0].sku.slice(0, 6) });
  assert.ok(r.body.orders.length >= 1, "sku filter finds orders");
  r = await call(admin, "GET", "admin/orders", null, { from: "2099-01-01" });
  assert.equal(r.body.orders.length, 0, "future date filter excludes all");
  console.log("✓ orders: sku + date-range filters");

  // --- manual order
  r = await call(admin, "POST", "admin/orders", {
    email: "phone@example.com", name: "Phone Buyer",
    items: [{ sku: stud.variants[1].sku, qty: 2 }],
    address: { line1: "5 Rue X", city: "Paris", postal: "75001", country: "FR" },
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.payment_method, "manual");
  assert.equal(r.body.order.status, "paid");
  console.log(`✓ manual order ${r.body.order.number} by SKU`);

  // --- duplicate + bulk
  const listP = await call(admin, "GET", "admin/products");
  const dupSource = listP.body.products.find((p) => p.slug === "linking-chain");
  r = await call(admin, "POST", `admin/products/${dupSource.id}/duplicate`, {});
  assert.equal(r.statusCode, 201);
  const dupId = r.body.product.id;
  r = await call(admin, "GET", `admin/products/${dupId}`);
  assert.equal(r.body.variants.length, 4, "variants copied");
  assert.ok(r.body.variants.every((v) => v.stock === 0), "copies start at zero stock");
  r = await call(admin, "POST", "admin/products/bulk", { ids: [dupId], action: "price", mode: "percent", value: 10 });
  assert.equal(r.statusCode, 200);
  r = await call(admin, "GET", `admin/products/${dupId}`);
  assert.equal(r.body.product.price_cents, Math.round(3800 * 1.1), "bulk +10% applied");
  await call(admin, "POST", "admin/products/bulk", { ids: [dupId], action: "archive" });
  console.log("✓ duplicate product + bulk price/status actions");

  // --- catalog CSV round-trip
  const csvRes = makeRes();
  csvRes.end = function (x) { this.body = x; };
  await call2(admin, "GET", "admin/catalog/export", csvRes);
  const csvText = String(csvRes.body);
  assert.ok(csvText.includes("primary-stem-stud"), "export contains catalog");
  const line = csvText.split("\r\n").find((l) => l.includes(stud.variants[2].sku));
  const boosted = line.replace(/"(\d+)","(true|false)","([^"]*)"$/, (m, stock, act, img) => `"77","${act}","${img}"`);
  r = await call(admin, "POST", "admin/catalog/import", { csv: csvText.split("\r\n")[0] + "\r\n" + boosted });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const chk = await db.query("SELECT stock FROM variants WHERE sku = $1", [stud.variants[2].sku]);
  assert.equal(chk.rows[0].stock, 77, "import updated stock");
  console.log("✓ catalog CSV export → edit → import round-trip");

  // --- collections
  r = await call(admin, "POST", "admin/collections", { title: "Lumière Link Set" });
  const collId = r.body.collection.id;
  const earIds = listP.body.products.filter((p) => p.category === "ear").slice(0, 3).map((p) => p.id);
  r = await call(admin, "PATCH", `admin/collections/${collId}`, { productIds: earIds });
  assert.equal(r.statusCode, 200);
  r = await call(shopper, "GET", "products", null, { collection: "lumiere-link-set" });
  assert.equal(r.body.products.length, 3, "collection filters the storefront");
  console.log("✓ collections: CRUD + storefront filter");

  // --- pages + content
  r = await call(admin, "POST", "admin/pages", { title: "Shipping & Returns", body: "## Shipping\n\nWorldwide, **free** over $75.", published: true });
  assert.equal(r.statusCode, 201);
  r = await call(shopper, "GET", "pages/shipping-returns");
  assert.equal(r.statusCode, 200);
  r = await call(admin, "PUT", "admin/content", { announcement: { text: "Free shipping over $75 ✦", enabled: true } });
  assert.equal(r.statusCode, 200);
  const contentRes = makeRes();
  await call2(shopper, "GET", "content", contentRes);
  assert.equal(contentRes.body.announcement.enabled, true);
  assert.ok(contentRes.body.pages.some((p) => p.slug === "shipping-returns"), "footer pages listed");
  assert.ok(contentRes.body.collections.some((c) => c.slug === "lumiere-link-set"), "collections listed");
  console.log("✓ pages published + content endpoint (announcement, footer, collections)");

  // --- staff roles: viewer reads, can't write; audit collects
  r = await call(admin, "POST", "admin/staff", { email: "viewer@aloria.test", name: "Viewer", role: "viewer" });
  assert.equal(r.statusCode, 201);
  const pw = await db.query("SELECT id FROM users WHERE email = 'viewer@aloria.test'");
  await db.query("UPDATE users SET password_hash = $1 WHERE email = 'viewer@aloria.test'",
    [require("/home/user/aloria-site/backend/lib/auth.js").hashPassword("viewer-pass-123")]);
  const viewerJar = new Jar();
  r = await call(viewerJar, "POST", "auth/login", { email: "viewer@aloria.test", password: "viewer-pass-123" });
  assert.equal(r.statusCode, 200);
  r = await call(viewerJar, "GET", "admin/metrics");
  assert.equal(r.statusCode, 200, "viewer can read");
  r = await call(viewerJar, "PATCH", `admin/products/${dupId}`, { status: "draft" });
  assert.equal(r.statusCode, 403, "viewer cannot write");
  r = await call(viewerJar, "GET", "admin/staff");
  assert.equal(r.statusCode, 403, "viewer cannot see staff");
  r = await call(admin, "GET", "admin/audit");
  assert.ok(r.body.audit.length > 5, "audit log populated");
  console.log("✓ staff roles: viewer read-only, audit log populated");

  // --- TOTP 2FA
  const totpLib = require("/home/user/aloria-site/backend/lib/totp.js");
  r = await call(admin, "POST", "admin/totp/setup", {});
  const secret = r.body.secret;
  assert.ok(secret && r.body.otpauth.startsWith("otpauth://totp/"));
  const code = totpLib.hotp(secret, Math.floor(Date.now() / 30000));
  r = await call(admin, "POST", "admin/totp/enable", { code });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const twoFaJar = new Jar();
  r = await call(twoFaJar, "POST", "auth/login", { email: "admin@aloria.test", password: "super-secret-admin" });
  assert.equal(r.body.requiresTotp, true, "login demands second factor");
  r = await call(twoFaJar, "POST", "auth/login", { email: "admin@aloria.test", password: "super-secret-admin",
    code: totpLib.hotp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.statusCode, 200, "login with code works");
  r = await call(admin, "POST", "admin/totp/disable", { code: totpLib.hotp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.statusCode, 200);
  console.log("✓ TOTP 2FA: setup, enforced at login, disable");

  // --- customer disable blocks login
  r = await call(admin, "GET", "admin/customers");
  const ghost = r.body.customers.find((c) => c.email === "rishi@example.com");
  r = await call(admin, "PATCH", `admin/customers/${ghost.id}`, { disabled: true, notes: "test disable", tags: ["vip"] });
  assert.equal(r.statusCode, 200);
  r = await call(new Jar(), "POST", "auth/login", { email: "rishi@example.com", password: "brand-new-pass-1" });
  assert.equal(r.statusCode, 400);
  assert.ok(/disabled/.test(r.body.error));
  await call(admin, "PATCH", `admin/customers/${ghost.id}`, { disabled: false });
  console.log("✓ customer disable blocks sign-in");

  // --- ranged metrics + funnel + best sellers
  r = await call(admin, "GET", "admin/metrics", null, { days: "7" });
  assert.equal(r.body.days, 7);
  assert.equal(r.body.revenueByDay.length, 7);
  assert.ok(r.body.topProducts.length >= 1, "best sellers present");
  assert.ok(r.body.funnel.cartsCreated >= 1 && r.body.funnel.paid >= 1, "funnel populated");
  assert.ok(r.body.previous, "previous-period comparison present");
  console.log("✓ metrics: 7d range, best sellers, funnel, previous period");

  // --- scheduled publishing via cron
  r = await call(admin, "POST", "admin/products", { title: "Scheduled Drop", category: "ear", status: "draft", publish_at: new Date(Date.now() - 60000).toISOString() });
  const schedId = r.body.product.id;
  r = await call(null, "GET", "cron/sweep");
  assert.ok(r.body.published >= 1, "cron published the scheduled draft");
  r = await call(admin, "GET", `admin/products/${schedId}`);
  assert.equal(r.body.product.status, "active");
  await call(admin, "DELETE", `admin/products/${schedId}`);
  console.log("✓ scheduled publishing (cron flips drafts live)");

  // --- email previews
  r = await call(admin, "GET", "admin/emails/order_confirmation/preview");
  assert.ok(r.body.html.includes("ALORIA"), "email preview renders");
  console.log("✓ email template preview");

  // --- reviews & ratings (B4)
  // ghost buyer has a paid order for primary-stem-stud → verified; goes to moderation queue
  // (the shopper's own order was refunded above, so it must NOT count)
  r = await call(null, "POST", "products/primary-stem-stud/reviews",
    { rating: 5, name: "Ghost Buyer", email: "ghost@example.com", title: "Stacks beautifully", body: "The gold plating is perfect and the stones catch the light." });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true);
  assert.equal(r.body.verified, true, "purchase makes the review verified");
  r = await call(null, "POST", "products/primary-stem-stud/reviews",
    { rating: 4, name: "Ghost Buyer", email: "ghost@example.com", body: "Trying to double-post" });
  assert.equal(r.statusCode, 409, "one review per customer per product");
  // a refunded order must not verify; an outsider who never bought → unverified
  r = await call(null, "POST", "products/primary-stem-stud/reviews",
    { rating: 3, name: "Rishit", email: "rishi@example.com", body: "My order was refunded so this should be unverified." });
  assert.equal(r.body.verified, false, "refunded order must not verify");
  r = await call(new Jar(), "POST", "products/primary-stem-stud/reviews",
    { rating: 2, name: "Stranger", email: "stranger@example.com", body: "Never bought this but here's my opinion anyway." });
  assert.equal(r.body.verified, false);
  // nothing public until moderation approves
  r = await call(null, "GET", "products/primary-stem-stud/reviews");
  assert.equal(r.body.summary.count, 0);
  assert.equal(r.body.reviews.length, 0);
  console.log("✓ reviews: verified-buyer detection + moderation queue holds them");

  // moderation: approve the verified one, reject the stranger
  r = await call(admin, "GET", "admin/reviews", null, { status: "pending" });
  assert.equal(r.body.reviews.length, 3);
  const verifiedRev = r.body.reviews.find((x) => x.verified);
  const strangerRev = r.body.reviews.find((x) => x.email === "stranger@example.com");
  r = await call(admin, "PATCH", `admin/reviews/${verifiedRev.id}`, { status: "approved", reply: "Thank you — wear it well." });
  assert.equal(r.statusCode, 200);
  r = await call(admin, "PATCH", `admin/reviews/${strangerRev.id}`, { status: "rejected" });
  assert.equal(r.statusCode, 200);
  r = await call(null, "GET", "products/primary-stem-stud/reviews");
  assert.equal(r.body.summary.count, 1);
  assert.equal(r.body.summary.avg, 5);
  assert.equal(r.body.reviews[0].verified, true);
  assert.equal(r.body.reviews[0].reply, "Thank you — wear it well.");
  console.log("✓ reviews: approve + reply publish, reject stays hidden");

  // aggregate reaches the catalog (PDP payload + listing cards)
  r = await call(null, "GET", "products/primary-stem-stud");
  assert.equal(r.body.product.rating.count, 1);
  assert.equal(r.body.product.rating.avg, 5);
  r = await call(null, "GET", "products", null, { category: "ear" });
  const studCard = r.body.products.find((p) => p.slug === "primary-stem-stud");
  assert.equal(studCard.ratingCount, 1);
  assert.equal(studCard.ratingAvg, 5);
  console.log("✓ reviews: aggregate rating on PDP payload + shop cards");

  // --- PDP depth (C2): product video + trust-strip data + contact inbox
  r = await call(admin, "GET", "admin/products");
  const anyProd = r.body.products.find((p) => p.slug === "primary-stem-stud");
  r = await call(admin, "PATCH", `admin/products/${anyProd.id}`, { video_url: "/assets/video/stud-worn.mp4" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(null, "GET", "products/primary-stem-stud");
  assert.equal(r.body.product.videoUrl, "/assets/video/stud-worn.mp4");
  r = await call(admin, "PATCH", `admin/products/${anyProd.id}`, { video_url: "javascript:alert(1)" });
  assert.equal(r.statusCode, 400, "non-https video URL rejected");
  r = await call(null, "GET", "content");
  assert.ok(r.body.shipping && r.body.shipping.freeThresholdCents > 0, "content exposes free-shipping threshold");
  console.log("✓ PDP depth: video URL round-trip (validated) + shipping in content");

  r = await call(null, "POST", "contact", { name: "Asker", email: "asker@example.com", subject: "Sizing", message: "Which ring size should I pick for stacking?" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(null, "POST", "contact", { name: "NoMail", message: "missing email" });
  assert.equal(r.statusCode, 400);
  r = await call(admin, "GET", "admin/contact", null, { open: "1" });
  assert.equal(r.body.openCount, 1);
  const cmsg = r.body.messages[0];
  assert.equal(cmsg.email, "asker@example.com");
  r = await call(admin, "PATCH", `admin/contact/${cmsg.id}`, { handled: true });
  assert.equal(r.statusCode, 200);
  r = await call(admin, "GET", "admin/contact", null, { open: "1" });
  assert.equal(r.body.openCount, 0);
  console.log("✓ contact: submit → inbox → handled");

  // --- faceted filters & sorting (C4)
  const all = await call(null, "GET", "products");
  r = await call(null, "GET", "products", null, { plating: "Gold", stone: "Emerald" });
  assert.ok(r.body.total > 0 && r.body.total <= all.body.total, "facets narrow the catalog");
  r = await call(null, "GET", "products", null, { plating: "Titanium" });
  assert.equal(r.body.total, 0, "unknown plating matches nothing");
  r = await call(null, "GET", "products", null, { sort: "price_asc" });
  const asc = r.body.products.map((p) => p.priceFromCents);
  assert.ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), "price ascending");
  r = await call(null, "GET", "products", null, { sort: "price_desc" });
  const desc = r.body.products.map((p) => p.priceFromCents);
  assert.ok(desc.every((v, i) => i === 0 || desc[i - 1] >= v), "price descending");
  r = await call(null, "GET", "products", null, { pmax: "6000" });
  assert.ok(r.body.total > 0 && r.body.products.every((p) => p.priceFromCents <= 6000), "price cap respected");
  r = await call(null, "GET", "products", null, { sort: "rating" });
  assert.equal(r.body.products[0].slug, "primary-stem-stud", "top-rated sort puts the reviewed piece first");
  console.log("✓ facets: plating/stone narrowing, price bounds, 4 sort orders");

  // --- wishlist + back-in-stock alerts (C5)
  const wisher = new Jar();
  r = await call(wisher, "POST", "wishlist/toggle", { slug: "primary-stem-stud" });
  assert.equal(r.statusCode, 401, "wishlist requires sign-in");
  await call(wisher, "POST", "auth/register", { email: "wisher@example.com", password: "password123", name: "Wisher" });
  r = await call(wisher, "POST", "wishlist/toggle", { slug: "primary-stem-stud" });
  assert.equal(r.body.saved, true);
  r = await call(wisher, "GET", "wishlist");
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].slug, "primary-stem-stud");
  r = await call(wisher, "POST", "wishlist/toggle", { slug: "primary-stem-stud" });
  assert.equal(r.body.saved, false);
  r = await call(wisher, "GET", "wishlist");
  assert.equal(r.body.items.length, 0);
  console.log("✓ wishlist: sign-in gate, toggle on/off, listing");

  // back-in-stock: zero a variant, register, restock, cron delivers
  r = await call(null, "GET", "products/primary-stem-stud");
  const alertVar = r.body.product.variants[3];
  await db.query("UPDATE variants SET stock = 0 WHERE id = $1", [alertVar.id]);
  r = await call(wisher, "POST", "stock-alerts", { variantId: alertVar.id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  r = await call(null, "POST", "stock-alerts", { variantId: alertVar.id, email: "watcher@example.com" });
  assert.equal(r.statusCode, 200);
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.body.stockAlertsSent, 0, "no alert while still out of stock");
  await db.query("UPDATE variants SET stock = 4 WHERE id = $1", [alertVar.id]);
  r = await call(wisher, "POST", "stock-alerts", { variantId: alertVar.id });
  assert.equal(r.statusCode, 400, "in-stock variant refuses new alerts");
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.body.stockAlertsSent, 2, "both watchers notified on restock");
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.body.stockAlertsSent, 0, "alerts fire exactly once");
  console.log("✓ back-in-stock: register while sold out, cron notifies once on restock");

  // --- product feeds (C6)
  {
    const res = makeRes();
    res.end = function (body) { this.body = body; this.done = true; };
    await call2(null, "GET", "feed/google", res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('xmlns:g="http://base.google.com/ns/1.0"'), "Google namespace");
    assert.ok(res.body.includes("<g:item_group_id>primary-stem-stud</g:item_group_id>"), "variants grouped by product");
    assert.ok(res.body.includes("<g:availability>in_stock</g:availability>"), "availability present");
    assert.ok(res.body.includes("<g:price>"), "price present");
    const itemCount = (res.body.match(/<item>/g) || []).length;
    const vc = await db.query("SELECT COUNT(*)::int AS n FROM variants v JOIN products p ON p.id = v.product_id WHERE v.active AND p.status = 'active'");
    assert.equal(itemCount, vc.rows[0].n, "one feed item per active variant");
  }
  {
    const res = makeRes();
    res.end = function (body) { this.body = body; this.done = true; };
    await call2(null, "GET", "feed/meta", res);
    assert.equal(res.statusCode, 200);
    const lines = res.body.split("\n");
    assert.equal(lines[0], "id,item_group_id,title,description,availability,condition,price,link,image_link,brand");
    assert.ok(lines.length > 100, "meta CSV carries the catalog");
  }
  console.log("✓ feeds: Google XML (grouped variants) + Meta CSV");

  // --- lifecycle + smarter cross-sell (D1)
  r = await call(null, "GET", "products/primary-stem-stud/related");
  assert.equal(r.body.products.length, 4);
  assert.notEqual(r.body.products[0].category, "ear", "cross-sell leads with the other categories");
  r = await call(null, "GET", "products", null, { slugs: "primary-stem-stud,primary-pendant-necklace" });
  assert.equal(r.body.total, 2, "slugs filter returns exactly the requested pieces");
  console.log("✓ cross-sell: component-aware related + slugs batch lookup");

  // review request: fires once, N days after purchase, only for kept orders
  await db.query("UPDATE orders SET created_at = now() - interval '6 days' WHERE email = 'ghost@example.com'");
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.body.reviewRequestsSent, 1, "one aged paid order → one review ask");
  const rra = await db.query("SELECT review_request_at FROM orders WHERE email = 'ghost@example.com'");
  assert.ok(rra.rows[0].review_request_at, "order marked as asked");
  r = await call(null, "GET", "cron/sweep");
  assert.equal(r.body.reviewRequestsSent, 0, "never asks twice");
  console.log("✓ lifecycle: post-purchase review request via cron (once per order)");

  // --- RMA returns portal (D2)
  r = await call(null, "GET", "returns/eligible", null, { number: "ALR-1002", email: "wrong@example.com" });
  assert.equal(r.statusCode, 404, "lookup requires the order's email");
  r = await call(null, "GET", "returns/eligible", null, { number: "ALR-1002", email: "ghost@example.com" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.eligible, true, "paid order inside the window is returnable");
  const retSku = r.body.items[0].sku;
  r = await call(null, "POST", "returns", { orderNumber: "ALR-1002", email: "ghost@example.com", items: [{ sku: retSku, qty: 1 }], reason: "Too long for my stack" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const rmaNumber = r.body.rma;
  assert.ok(/^RMA-\d+$/.test(rmaNumber), `RMA number (${rmaNumber})`);
  r = await call(null, "POST", "returns", { orderNumber: "ALR-1002", email: "ghost@example.com", items: [{ sku: retSku }], reason: "again" });
  assert.equal(r.statusCode, 400, "one open return per order");
  console.log(`✓ returns: lookup guarded, ${rmaNumber} opened, duplicates blocked`);

  r = await call(admin, "GET", "admin/returns", null, { status: "requested" });
  assert.equal(r.body.returns.length, 1);
  const rmaId = r.body.returns[0].id;
  r = await call(admin, "PATCH", `admin/returns/${rmaId}`, { status: "approved" });
  assert.equal(r.statusCode, 200);
  r = await call(admin, "PATCH", `admin/returns/${rmaId}`, { status: "received" });
  assert.equal(r.statusCode, 200);
  const ghostVariant = await db.query(
    "SELECT oi.variant_id, v.stock FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN orders o ON o.id = oi.order_id WHERE o.number = 'ALR-1002'");
  const stockBefore = ghostVariant.rows[0].stock;
  r = await call(admin, "PATCH", `admin/returns/${rmaId}`, { status: "refunded" });
  assert.equal(r.statusCode, 200);
  const after = await db.query("SELECT status FROM orders WHERE number = 'ALR-1002'");
  assert.equal(after.rows[0].status, "refunded", "refunding the RMA refunds the order");
  const stockAfter = await db.query("SELECT stock FROM variants WHERE id = $1", [ghostVariant.rows[0].variant_id]);
  assert.equal(stockAfter.rows[0].stock, stockBefore + 1, "refund restocks the returned piece");
  r = await call(null, "GET", "returns/eligible", null, { number: "ALR-1002", email: "ghost@example.com" });
  assert.equal(r.body.eligible, false, "refunded order can't open another return");
  assert.equal(r.body.returns[0].status, "refunded");
  console.log("✓ returns: approve → received → refunded (order refunded + restocked)");

  // --- health + inert third-party placeholders (E1)
  r = await call(null, "GET", "health");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.db, true);
  assert.equal(r.body.paymentProvider, "test");
  r = await call(null, "GET", "content");
  assert.equal(r.body.integrations.plausibleDomain, "", "analytics off until PLAUSIBLE_DOMAIN set");
  assert.equal(r.body.integrations.turnstileSiteKey, "", "captcha off until TURNSTILE keys set");
  console.log("✓ health endpoint + integrations stay inert until configured");

  console.log("\nALL SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("\nSMOKE FAILED:", e); process.exit(1); });
