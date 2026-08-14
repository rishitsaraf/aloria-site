/* /api/store/checkout — order creation.
   Every amount is computed server-side from the database; the client only
   ever sends identifiers. Stock is reserved inside a transaction with row
   locks so two buyers can't take the last piece. Payment is Stripe Checkout
   when STRIPE_SECRET_KEY is configured, otherwise a "test" payment so the
   whole flow works before payments are wired up. */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const cartLib = require("./cartLib");
const email = require("../lib/email");
const {
  json, badRequest, notFound, cleanEmail, cleanString, rateLimit, clientIp,
} = require("../lib/http");

const FREE_SHIPPING_CENTS = parseInt(process.env.FREE_SHIPPING_CENTS, 10) || 7500;
const SHIPPING_FLAT_CENTS = parseInt(process.env.SHIPPING_FLAT_CENTS, 10) || 800;

function shippingFor(subtotalAfterDiscount) {
  return subtotalAfterDiscount >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_FLAT_CENTS;
}

async function resolveDiscount(code, subtotalCents) {
  if (!code) return { code: null, cents: 0 };
  const r = await db.query(
    `SELECT * FROM discounts WHERE code = $1 AND active AND (expires_at IS NULL OR expires_at > now())`,
    [code.toUpperCase()]
  );
  const d = r.rows[0];
  if (!d) throw badRequest("That discount code isn't valid");
  if (subtotalCents < d.min_cents) throw badRequest("Your bag doesn't meet the minimum for this code");
  const cents = d.kind === "percent"
    ? Math.floor((subtotalCents * Math.min(d.value, 100)) / 100)
    : Math.min(d.value, subtotalCents);
  return { code: d.code, cents };
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
  let discount = { code: null, cents: 0 };
  const code = cleanString((req.body || {}).discountCode, { max: 40 });
  if (code && payload.subtotalCents > 0) discount = await resolveDiscount(code, payload.subtotalCents);
  const afterDiscount = payload.subtotalCents - discount.cents;
  const shipping = payload.subtotalCents > 0 ? shippingFor(afterDiscount) : 0;
  json(res, 200, {
    cart: payload,
    discountCents: discount.cents,
    discountCode: discount.code,
    shippingCents: shipping,
    totalCents: afterDiscount + shipping,
    freeShippingThresholdCents: FREE_SHIPPING_CENTS,
  });
}

async function create(req, res) {
  await rateLimit(`checkout:${clientIp(req)}`, 15, 900);
  const body = req.body || {};
  const user = await authLib.currentUser(req);
  const buyerEmail = cleanEmail(body.email || (user && user.email));
  const name = cleanString(body.name, { name: "Full name", max: 140, required: true });
  const address = cleanAddress(body.address);
  const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY);
  const paymentMethod = stripeEnabled && body.paymentMethod !== "test" ? "stripe" : "test";

  const cart = await cartLib.findCartByCookie(req);
  if (!cart) throw badRequest("Your bag is empty");
  const payload = await cartLib.cartPayload(cart);
  const items = payload.items.filter((i) => i.purchasable);
  if (items.length === 0) throw badRequest("Your bag is empty");

  const discount = await resolveDiscount(cleanString(body.discountCode, { max: 40 }), payload.subtotalCents);

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
    const shippingCents = shippingFor(subtotal - discountCents);
    const totalCents = subtotal - discountCents + shippingCents;

    for (const item of items) {
      await client.query("UPDATE variants SET stock = stock - $1, updated_at = now() WHERE id = $2", [item.qty, item.variantId]);
    }
    const num = await client.query("SELECT nextval('order_number_seq') AS n");
    const number = `ALR-${num.rows[0].n}`;
    const publicToken = require("crypto").randomBytes(24).toString("hex");
    const or = await client.query(
      `INSERT INTO orders (number, public_token, user_id, cart_id, email, status, payment_method,
                           subtotal_cents, shipping_cents, discount_cents, discount_code, total_cents,
                           currency, shipping_name, shipping_address, from_recovered_cart)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [number, publicToken, user ? user.id : null, cart.id, buyerEmail, paymentMethod,
       subtotal, shippingCents, discountCents, discount.code, totalCents,
       payload.currency, name, JSON.stringify(address), cart.recovered]
    );
    for (const item of items) {
      const row = bySku.get(item.variantId);
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, product_title, variant_label, sku, image, unit_price_cents, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [or.rows[0].id, item.variantId, row.title, Object.values(row.options || {}).join(" · "),
         row.sku, row.v_image || (row.images || [])[0] || null, row.unit_cents, item.qty]
      );
    }
    await client.query("UPDATE carts SET status = 'converted', email = $2, updated_at = now() WHERE id = $1", [cart.id, buyerEmail]);
    return or.rows[0];
  });

  if (paymentMethod === "stripe") {
    const url = await createStripeSession(order, items);
    json(res, 200, { ok: true, orderNumber: order.number, key: order.public_token, checkoutUrl: url });
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
  const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [order.id])).rows;
  try { await email.sendOrderConfirmation(order, items); }
  catch (e) { console.error("[checkout] confirmation email failed:", e.message); }
  return order;
}

/* ---------- Stripe via REST (no SDK dependency) ---------- */

async function stripeCall(path, params) {
  const body = new URLSearchParams(params);
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error("[stripe]", data.error && data.error.message);
    throw new Error("Payment provider error — try again");
  }
  return data;
}

async function createStripeSession(order, items) {
  const params = {
    mode: "payment",
    customer_email: order.email,
    client_reference_id: order.number,
    success_url: email.siteUrl(`/checkout/thanks?order=${order.number}&key=${order.public_token}`),
    cancel_url: email.siteUrl("/checkout?cancelled=1"),
    "metadata[order_number]": order.number,
  };
  if (order.discount_cents > 0) {
    // Stripe line items can't be negative; collapse to one discounted line.
    params["line_items[0][quantity]"] = "1";
    params["line_items[0][price_data][currency]"] = order.currency.toLowerCase();
    params["line_items[0][price_data][product_data][name]"] = `Aloria order ${order.number}`;
    params["line_items[0][price_data][unit_amount]"] = String(order.total_cents);
  } else {
    items.forEach((item, i) => {
      params[`line_items[${i}][quantity]`] = String(item.qty);
      params[`line_items[${i}][price_data][currency]`] = order.currency.toLowerCase();
      params[`line_items[${i}][price_data][product_data][name]`] =
        item.variantLabel ? `${item.title} — ${item.variantLabel}` : item.title;
      params[`line_items[${i}][price_data][unit_amount]`] = String(item.unitCents);
    });
    if (order.shipping_cents > 0) {
      const i = items.length;
      params[`line_items[${i}][quantity]`] = "1";
      params[`line_items[${i}][price_data][currency]`] = order.currency.toLowerCase();
      params[`line_items[${i}][price_data][product_data][name]`] = "Shipping";
      params[`line_items[${i}][price_data][unit_amount]`] = String(order.shipping_cents);
    }
  }
  const session = await stripeCall("checkout/sessions", params);
  await db.query("UPDATE orders SET payment_ref = $1 WHERE id = $2", [session.id, order.id]);
  return session.url;
}

/** Thanks page calls this; the server asks Stripe directly, so the client
    can't forge a paid state. Safe to call repeatedly. */
async function confirm(req, res) {
  const body = req.body || {};
  const number = cleanString(body.order, { name: "order", max: 20, required: true });
  const key = cleanString(body.key, { name: "key", max: 64, required: true });
  const r = await db.query("SELECT * FROM orders WHERE number = $1 AND public_token = $2", [number, key]);
  const order = r.rows[0];
  if (!order) throw notFound("Order not found");

  if (order.status === "pending" && order.payment_method === "stripe" && order.payment_ref && process.env.STRIPE_SECRET_KEY) {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.payment_ref)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const session = await resp.json();
    if (resp.ok && session.payment_status === "paid") await markPaid(order.id, order.payment_ref);
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

/** Restock a cancelled/expired order's reserved inventory. */
async function restockOrder(client, orderId) {
  await client.query(
    `UPDATE variants v SET stock = v.stock + oi.qty, updated_at = now()
       FROM order_items oi
      WHERE oi.order_id = $1 AND oi.variant_id = v.id`,
    [orderId]
  );
}

module.exports = { quote, create, confirm, lookup, myOrders, markPaid, restockOrder, shapeOrder };
