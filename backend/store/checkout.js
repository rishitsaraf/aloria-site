/* /api/store/checkout — order creation.
   Every amount is computed server-side from the database; the client only
   ever sends identifiers. Stock is reserved inside a transaction with row
   locks so two buyers can't take the last piece. Payment goes through the
   gateway-agnostic adapter layer in backend/lib/payments — whichever
   provider is configured via PAYMENT_PROVIDER, with the built-in "test"
   provider keeping the whole flow working until one is chosen. */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const payments = require("../lib/payments");
const settings = require("../lib/settings");
const cartLib = require("./cartLib");
const email = require("../lib/email");
const {
  json, badRequest, notFound, cleanEmail, cleanString, rateLimit, clientIp,
} = require("../lib/http");

async function shippingRules() {
  return {
    flat: await settings.get("shipping.flat_cents"),
    freeThreshold: await settings.get("shipping.free_threshold_cents"),
  };
}

async function taxPctFor(country) {
  const byCountry = (await settings.get("tax.by_country")) || {};
  const pct = byCountry[String(country || "").toUpperCase()];
  return typeof pct === "number" ? pct : (await settings.get("tax.default_pct")) || 0;
}

/** Validate a code and compute its effect. Per-customer limits are enforced
    at order time (when we know the email); everything else applies here too. */
async function resolveDiscount(code, subtotalCents, buyerEmail = null) {
  if (!code) return { code: null, cents: 0, freeShipping: false };
  const r = await db.query(
    `SELECT * FROM discounts WHERE code = $1 AND active
        AND (expires_at IS NULL OR expires_at > now())
        AND (starts_at IS NULL OR starts_at <= now())`,
    [code.toUpperCase()]
  );
  const d = r.rows[0];
  if (!d) throw badRequest("That discount code isn't valid");
  if (d.max_uses != null && d.uses >= d.max_uses) throw badRequest("That code has been fully redeemed");
  if (subtotalCents < d.min_cents) throw badRequest("Your bag doesn't meet the minimum for this code");
  if (buyerEmail && d.once_per_customer) {
    const used = await db.query(
      `SELECT 1 FROM orders WHERE discount_code = $1 AND email = $2 AND status NOT IN ('cancelled') LIMIT 1`,
      [d.code, buyerEmail]
    );
    if (used.rows.length) throw badRequest("You've already used this code");
  }
  if (d.kind === "free_shipping") return { code: d.code, cents: 0, freeShipping: true };
  const cents = d.kind === "percent"
    ? Math.floor((subtotalCents * Math.min(d.value, 100)) / 100)
    : Math.min(d.value, subtotalCents);
  return { code: d.code, cents, freeShipping: false };
}

function cleanAddress(raw) {
  const a = raw || {};
  return {
    line1: cleanString(a.line1, { name: "Address", max: 200, required: true }),
    line2: cleanString(a.line2, { name: "Address line 2", max: 200 }),
    city: cleanString(a.city, { name: "City", max: 100, required: true }),
    region: cleanString(a.region, { name: "State / region", max: 100 }),
    postal: cleanString(a.postal, { name: "Postal code", max: 20, required: true }),
    country: cleanString(a.country, { name: "Country", max: 2, required: true }).toUpperCase(),
    phone: cleanString(a.phone, { name: "Phone", max: 30 }),
  };
}

/** Preview totals for the checkout page (no side effects). */
async function quote(req, res) {
  const cart = await cartLib.findCartByCookie(req);
  const payload = await cartLib.cartPayload(cart);
  const rules = await shippingRules();
  let discount = { code: null, cents: 0, freeShipping: false };
  const code = cleanString((req.body || {}).discountCode, { max: 40 });
  if (code && payload.subtotalCents > 0) discount = await resolveDiscount(code, payload.subtotalCents);
  const afterDiscount = payload.subtotalCents - discount.cents;
  const shipping = payload.subtotalCents > 0 && !discount.freeShipping
    ? (afterDiscount >= rules.freeThreshold ? 0 : rules.flat) : 0;
  const taxPct = await taxPctFor((req.body || {}).country);
  const tax = Math.round((afterDiscount * taxPct) / 100);
  json(res, 200, {
    cart: payload,
    discountCents: discount.cents,
    discountCode: discount.code,
    discountFreeShipping: discount.freeShipping,
    shippingCents: shipping,
    taxCents: tax,
    taxPct,
    totalCents: afterDiscount + shipping + tax,
    freeShippingThresholdCents: rules.freeThreshold,
    payments: { provider: payments.active().name, online: payments.onlineEnabled() },
  });
}

async function create(req, res) {
  await rateLimit(`checkout:${clientIp(req)}`, 15, 900);
  const body = req.body || {};
  const user = await authLib.currentUser(req);
  const buyerEmail = cleanEmail(body.email || (user && user.email));
  const name = cleanString(body.name, { name: "Full name", max: 140, required: true });
  const address = cleanAddress(body.address);
  const provider = payments.active();
  const onlineAvailable = payments.onlineEnabled();
  const paymentMethod = onlineAvailable && body.paymentMethod !== "test" ? "online" : "test";

  const cart = await cartLib.findCartByCookie(req);
  if (!cart) throw badRequest("Your bag is empty");
  const payload = await cartLib.cartPayload(cart);
  const items = payload.items.filter((i) => i.purchasable);
  if (items.length === 0) throw badRequest("Your bag is empty");

  const discount = await resolveDiscount(cleanString(body.discountCode, { max: 40 }), payload.subtotalCents, buyerEmail);
  const rules = await shippingRules();
  const taxPct = await taxPctFor(address.country);

  // Reserve stock + create the order atomically.
  const order = await db.tx(async (client) => {
    const ids = items.map((i) => i.variantId);
    const locked = await client.query(
      `SELECT v.id, v.stock, v.sku, COALESCE(v.price_cents, p.price_cents) AS unit_cents,
              p.title, v.options, v.image AS v_image, p.images
         FROM variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ANY($1) FOR UPDATE OF v`,
      [ids]
    );
    const bySku = new Map(locked.rows.map((r) => [r.id, r]));
    let subtotal = 0;
    for (const item of items) {
      const row = bySku.get(item.variantId);
      if (!row) throw badRequest(`"${item.title}" is no longer available`);
      if (row.stock < item.qty) {
        const e = badRequest(`Only ${row.stock} left of "${row.title}${item.variantLabel ? " — " + item.variantLabel : ""}" — adjust your bag`);
        e.extra = { variantId: item.variantId, stock: row.stock };
        throw e;
      }
      subtotal += row.unit_cents * item.qty;
    }
    const discountCents = Math.min(discount.cents, subtotal);
    const afterDiscount = subtotal - discountCents;
    const shippingCents = discount.freeShipping ? 0 : (afterDiscount >= rules.freeThreshold ? 0 : rules.flat);
    const taxCents = Math.round((afterDiscount * taxPct) / 100);
    const totalCents = afterDiscount + shippingCents + taxCents;

    const num = await client.query("SELECT nextval('order_number_seq') AS n");
    const number = `ALR-${num.rows[0].n}`;
    const publicToken = require("crypto").randomBytes(24).toString("hex");
    const or = await client.query(
      `INSERT INTO orders (number, public_token, user_id, cart_id, email, status, payment_method, payment_provider,
                           subtotal_cents, shipping_cents, discount_cents, discount_code, tax_cents, total_cents,
                           currency, shipping_name, shipping_address, from_recovered_cart)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [number, publicToken, user ? user.id : null, cart.id, buyerEmail, paymentMethod,
       paymentMethod === "online" ? provider.name : "",
       subtotal, shippingCents, discountCents, discount.code, taxCents, totalCents,
       payload.currency, name, JSON.stringify(address), cart.recovered]
    );
    const orderId = or.rows[0].id;
    for (const item of items) {
      const row = bySku.get(item.variantId);
      await client.query("UPDATE variants SET stock = stock - $1, updated_at = now() WHERE id = $2", [item.qty, item.variantId]);
      await client.query(
        `INSERT INTO inventory_movements (variant_id, sku, delta, reason, order_id) VALUES ($1,$2,$3,'sale',$4)`,
        [item.variantId, row.sku, -item.qty, orderId]
      );
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, product_title, variant_label, sku, image, unit_price_cents, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderId, item.variantId, row.title, Object.values(row.options || {}).join(" · "),
         row.sku, row.v_image || (row.images || [])[0] || null, row.unit_cents, item.qty]
      );
    }
    if (discount.code) {
      await client.query("UPDATE discounts SET uses = uses + 1 WHERE code = $1", [discount.code]);
    }
    await client.query(
      `INSERT INTO order_events (order_id, kind, data) VALUES ($1, 'placed', $2)`,
      [orderId, JSON.stringify({ paymentMethod, totalCents, recovered: cart.recovered })]
    );
    await client.query("UPDATE carts SET status = 'converted', email = $2, updated_at = now() WHERE id = $1", [cart.id, buyerEmail]);
    return or.rows[0];
  });

  if (paymentMethod === "online") {
    // hand off to whichever gateway adapter is configured
    const created = await provider.createPayment(order, {
      successUrl: email.siteUrl(`/checkout/thanks?order=${order.number}&key=${order.public_token}`),
      cancelUrl: email.siteUrl("/checkout?cancelled=1"),
    });
    if (created.ref) await db.query("UPDATE orders SET payment_ref = $1 WHERE id = $2", [created.ref, order.id]);
    json(res, 200, {
      ok: true, orderNumber: order.number, key: order.public_token,
      checkoutUrl: created.redirectUrl || null,
      clientPayload: created.clientPayload || null,
    });
    return;
  }

  await markPaid(order.id, "test-payment");
  json(res, 200, { ok: true, orderNumber: order.number, key: order.public_token });
}

async function markPaid(orderId, ref) {
  const r = await db.query(
    "UPDATE orders SET status = 'paid', payment_ref = COALESCE($2, payment_ref), updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING *",
    [orderId, ref]
  );
  const order = r.rows[0];
  if (!order) return null;
  await db.query(
    "INSERT INTO order_events (order_id, kind, data) VALUES ($1, 'status', $2)",
    [order.id, JSON.stringify({ to: "paid", ref })]
  );
  const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [order.id])).rows;
  try {
    await email.sendOrderConfirmation(order, items);
    await db.query("INSERT INTO order_events (order_id, kind, data) VALUES ($1, 'email', $2)",
      [order.id, JSON.stringify({ template: "order_confirmation", to: order.email })]);
  } catch (e) { console.error("[checkout] confirmation email failed:", e.message); }
  return order;
}

/* ---------- gateway webhook (provider-agnostic, idempotent) ---------- */

/** POST /api/store/payments/webhook — the configured adapter verifies the
    signature and normalizes events; every event id is deduplicated in
    payment_events so gateway redelivery is always safe to replay. */
async function webhook(req, res) {
  const provider = payments.active();
  const parsed = await provider.parseWebhook(req);
  if (!parsed.ok) {
    json(res, 400, { ok: false, error: "signature verification failed" });
    return;
  }
  let applied = 0;
  for (const event of parsed.events || []) {
    if (!event.id || !event.type) continue;
    const fresh = await db.query(
      `INSERT INTO payment_events (event_id, provider, type, payload)
       VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [String(event.id).slice(0, 200), provider.name, event.type, JSON.stringify(event)]
    );
    if (!fresh.rows.length) continue; // already processed — idempotent skip
    const or = await db.query("SELECT * FROM orders WHERE number = $1", [event.orderNumber || ""]);
    const order = or.rows[0];
    if (!order) continue;
    await db.query("UPDATE payment_events SET order_id = $1 WHERE event_id = $2", [order.id, String(event.id).slice(0, 200)]);
    if (event.type === "paid") {
      await markPaid(order.id, event.ref || order.payment_ref);
      applied++;
    } else if (event.type === "failed" && order.status === "pending") {
      await db.tx(async (client) => {
        await client.query("UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending'", [order.id]);
        await restockOrder(client, order.id);
      });
      applied++;
    } else if (event.type === "refunded" && ["paid", "fulfilled"].includes(order.status)) {
      await db.tx(async (client) => {
        await client.query("UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1", [order.id]);
        await restockOrder(client, order.id);
      });
      applied++;
    }
  }
  json(res, 200, { ok: true, received: (parsed.events || []).length, applied });
}

/** Move money back through the configured gateway (best-effort; test mode
    always succeeds). Called by the CMS when an order is refunded. */
async function refundViaProvider(order, amountCents) {
  const provider = payments.PROVIDERS[order.payment_provider] || payments.active();
  if (!provider.capabilities().refunds) return { ok: false, reason: "provider has no refund API" };
  try {
    return await provider.refund(order, amountCents);
  } catch (e) {
    console.error("[payments] refund failed:", e.message);
    return { ok: false, reason: e.message };
  }
}

/** Thanks page calls this; the server asks the configured gateway directly,
    so the client can't forge a paid state. Safe to call repeatedly. */
async function confirm(req, res) {
  const body = req.body || {};
  const number = cleanString(body.order, { name: "order", max: 20, required: true });
  const key = cleanString(body.key, { name: "key", max: 64, required: true });
  const r = await db.query("SELECT * FROM orders WHERE number = $1 AND public_token = $2", [number, key]);
  const order = r.rows[0];
  if (!order) throw notFound("Order not found");

  if (order.status === "pending" && order.payment_method === "online") {
    // ask the gateway directly — the client can never forge a paid state
    const provider = payments.PROVIDERS[order.payment_provider] || payments.active();
    try {
      const check = await provider.verifyPayment(order);
      if (check.paid) await markPaid(order.id, check.ref || order.payment_ref);
    } catch (e) { console.error("[payments] verify failed:", e.message); }
  }
  return lookupByNumberKey(res, number, key);
}

/** Public order view (unguessable key, no account needed). */
async function lookup(req, res) {
  const q = req.query || {};
  return lookupByNumberKey(res, String(q.number || ""), String(q.key || ""));
}

async function lookupByNumberKey(res, number, key) {
  const r = await db.query("SELECT * FROM orders WHERE number = $1 AND public_token = $2", [number, key]);
  const order = r.rows[0];
  if (!order) throw notFound("Order not found");
  const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows;
  json(res, 200, { order: shapeOrder(order, items) });
}

/** Signed-in customer's order history. */
async function myOrders(req, res) {
  const user = await authLib.requireUser(req);
  const r = await db.query("SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50", [user.id]);
  const orders = [];
  for (const o of r.rows) {
    const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [o.id])).rows;
    orders.push(shapeOrder(o, items));
  }
  json(res, 200, { orders });
}

function shapeOrder(o, items) {
  return {
    number: o.number,
    key: o.public_token,
    status: o.status,
    paymentMethod: o.payment_method,
    email: o.email,
    subtotalCents: o.subtotal_cents,
    shippingCents: o.shipping_cents,
    discountCents: o.discount_cents,
    discountCode: o.discount_code,
    taxCents: o.tax_cents || 0,
    trackingCarrier: o.tracking_carrier || "",
    trackingNumber: o.tracking_number || "",
    totalCents: o.total_cents,
    currency: o.currency,
    shippingName: o.shipping_name,
    shippingAddress: o.shipping_address,
    createdAt: o.created_at,
    items: items.map((i) => ({
      title: i.product_title,
      variantLabel: i.variant_label,
      sku: i.sku,
      image: i.image,
      unitCents: i.unit_price_cents,
      qty: i.qty,
    })),
  };
}

/** Restock a cancelled/expired order's reserved inventory (logged). */
async function restockOrder(client, orderId) {
  await client.query(
    `UPDATE variants v SET stock = v.stock + oi.qty, updated_at = now()
       FROM order_items oi
      WHERE oi.order_id = $1 AND oi.variant_id = v.id`,
    [orderId]
  );
  await client.query(
    `INSERT INTO inventory_movements (variant_id, sku, delta, reason, order_id)
     SELECT oi.variant_id, oi.sku, oi.qty, 'restock', $1 FROM order_items oi
      WHERE oi.order_id = $1 AND oi.variant_id IS NOT NULL`,
    [orderId]
  );
}

module.exports = { quote, create, confirm, lookup, myOrders, markPaid, restockOrder, shapeOrder, webhook, refundViaProvider };
