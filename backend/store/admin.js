/* /api/store/admin/* — the CMS backend. Every route here is wrapped with
   requireAdmin by the router. Products own an options schema; variants are
   the sellable rows (sku / price / stock / image) keyed by option values. */

const db = require("../lib/db");
const emailLib = require("../lib/email");
const cartLib = require("./cartLib");
const checkout = require("./checkout");
const {
  json, badRequest, notFound, cleanString, cleanInt, slugify,
} = require("../lib/http");

/* ---------- helpers ---------- */

function cleanOptions(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 3) throw badRequest("options must be an array of at most 3 option groups");
  return raw.map((o) => {
    const name = cleanString(o && o.name, { name: "Option name", max: 40, required: true });
    const values = Array.isArray(o.values) ? o.values.map((v) => cleanString(v, { name: "Option value", max: 60, required: true })) : [];
    if (values.length === 0 || values.length > 30) throw badRequest(`Option "${name}" needs 1–30 values`);
    if (new Set(values).size !== values.length) throw badRequest(`Option "${name}" has duplicate values`);
    return { name, values };
  });
}

function cleanImages(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 12) throw badRequest("images must be an array (max 12)");
  return raw.map((s) => {
    const url = cleanString(s, { name: "Image", max: 500, required: true });
    if (!/^(\/|https:\/\/)/.test(url)) throw badRequest("Image paths must start with / or https://");
    return url;
  });
}

const PRODUCT_STATUSES = ["draft", "active", "archived"];
const CATEGORIES = ["ear", "neck", "rings"];

/* ---------- metrics dashboard (range-aware, with previous-period deltas) ---------- */

async function windowStats(days, offsetDays) {
  const r = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE status IN ('paid','fulfilled'))::int AS paid_orders,
        COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid','fulfilled')), 0)::bigint AS revenue_cents,
        COUNT(*) FILTER (WHERE status IN ('paid','fulfilled') AND from_recovered_cart)::int AS recovered_orders,
        COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid','fulfilled') AND from_recovered_cart), 0)::bigint AS recovered_revenue_cents
       FROM orders
      WHERE created_at >= now() - make_interval(days => $1)
        AND created_at <  now() - make_interval(days => $2)`,
    [days + offsetDays, offsetDays]
  );
  const m = r.rows[0];
  return {
    revenueCents: Number(m.revenue_cents),
    paidOrders: m.paid_orders,
    aovCents: m.paid_orders ? Math.round(Number(m.revenue_cents) / m.paid_orders) : 0,
    recoveredOrders: m.recovered_orders,
    recoveredRevenueCents: Number(m.recovered_revenue_cents),
  };
}

async function metrics(req, res) {
  const days = [7, 14, 30, 90].includes(parseInt((req.query || {}).days, 10)) ? parseInt(req.query.days, 10) : 14;
  const [current, previous, prod, low, cust, carts, recent, trend, top, byCat, funnel] = await Promise.all([
    windowStats(days, 0),
    windowStats(days, days),
    db.query(`SELECT COUNT(*) FILTER (WHERE status = 'active')::int AS active, COUNT(*)::int AS total FROM products`),
    db.query(`SELECT COUNT(*)::int AS n FROM variants WHERE active AND stock <= 3`),
    db.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'`),
    db.query(`SELECT COUNT(*)::int AS n,
                     COALESCE(SUM(sub.value), 0)::bigint AS value_cents
                FROM carts c
                LEFT JOIN LATERAL (
                  SELECT SUM(ci.qty * COALESCE(v.price_cents, p.price_cents)) AS value
                    FROM cart_items ci JOIN variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
                   WHERE ci.cart_id = c.id) sub ON true
               WHERE c.status = 'abandoned'`),
    db.query(`SELECT id, number, email, status, total_cents, currency, created_at FROM orders ORDER BY created_at DESC LIMIT 8`),
    db.query(
      `SELECT d::date AS day,
              COALESCE(SUM(o.total_cents) FILTER (WHERE o.status IN ('paid','fulfilled')), 0)::bigint AS revenue_cents,
              COUNT(o.id) FILTER (WHERE o.status IN ('paid','fulfilled'))::int AS orders
         FROM generate_series((now() - make_interval(days => $1))::date, now()::date, interval '1 day') d
         LEFT JOIN orders o ON o.created_at::date = d::date
        GROUP BY d ORDER BY d`,
      [days - 1]
    ),
    db.query(
      `SELECT oi.product_title, oi.sku,
              SUM(oi.qty)::int AS units,
              SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue_cents
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ('paid','fulfilled') AND o.created_at >= now() - make_interval(days => $1)
        GROUP BY oi.product_title, oi.sku ORDER BY revenue_cents DESC LIMIT 8`,
      [days]
    ),
    db.query(
      `SELECT COALESCE(p.category, 'other') AS category,
              SUM(oi.qty * oi.unit_price_cents)::bigint AS revenue_cents,
              SUM(oi.qty)::int AS units
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN variants v ON v.id = oi.variant_id
         LEFT JOIN products p ON p.id = v.product_id
        WHERE o.status IN ('paid','fulfilled') AND o.created_at >= now() - make_interval(days => $1)
        GROUP BY 1 ORDER BY revenue_cents DESC`,
      [days]
    ),
    db.query(
      `SELECT
         (SELECT COUNT(*) FROM carts WHERE created_at >= now() - make_interval(days => $1))::int AS carts_created,
         (SELECT COUNT(*) FROM carts WHERE created_at >= now() - make_interval(days => $1) AND email IS NOT NULL)::int AS carts_with_email,
         (SELECT COUNT(*) FROM orders WHERE created_at >= now() - make_interval(days => $1))::int AS checkouts,
         (SELECT COUNT(*) FROM orders WHERE created_at >= now() - make_interval(days => $1) AND status IN ('paid','fulfilled'))::int AS paid,
         (SELECT COUNT(*) FROM carts WHERE recovery_sent_at >= now() - make_interval(days => $1))::int AS recovery_emails,
         (SELECT COUNT(*) FROM orders WHERE created_at >= now() - make_interval(days => $1) AND from_recovered_cart AND status IN ('paid','fulfilled'))::int AS recovered_paid`,
      [days]
    ),
  ]);
  json(res, 200, {
    days,
    ...current,
    previous,
    pendingOrders: (await db.query("SELECT COUNT(*)::int AS n FROM orders WHERE status = 'pending'")).rows[0].n,
    activeProducts: prod.rows[0].active,
    totalProducts: prod.rows[0].total,
    lowStockVariants: low.rows[0].n,
    customers: cust.rows[0].n,
    abandonedCarts: carts.rows[0].n,
    abandonedValueCents: Number(carts.rows[0].value_cents),
    recentOrders: recent.rows,
    revenueByDay: trend.rows.map((r2) => ({ day: r2.day, revenueCents: Number(r2.revenue_cents), orders: r2.orders })),
    topProducts: top.rows.map((t) => ({ title: t.product_title, sku: t.sku, units: t.units, revenueCents: Number(t.revenue_cents) })),
    byCategory: byCat.rows.map((c) => ({ category: c.category, units: c.units, revenueCents: Number(c.revenue_cents) })),
    funnel: {
      cartsCreated: funnel.rows[0].carts_created,
      cartsWithEmail: funnel.rows[0].carts_with_email,
      checkouts: funnel.rows[0].checkouts,
      paid: funnel.rows[0].paid,
      recoveryEmails: funnel.rows[0].recovery_emails,
      recoveredPaid: funnel.rows[0].recovered_paid,
    },
  });
}

/* ---------- products ---------- */

async function listProducts(req, res) {
  const q = req.query || {};
  const params = [];
  let where = "true";
  if (PRODUCT_STATUSES.includes(q.status)) { params.push(q.status); where += ` AND p.status = $${params.length}`; }
  if (CATEGORIES.includes(q.category)) { params.push(q.category); where += ` AND p.category = $${params.length}`; }
  const search = cleanString(q.q, { max: 100 });
  if (search) { params.push(`%${search}%`); where += ` AND (p.title ILIKE $${params.length} OR p.slug ILIKE $${params.length})`; }
  const r = await db.query(
    `SELECT p.id, p.slug, p.title, p.category, p.status, p.price_cents, p.currency, p.featured, p.images, p.updated_at,
            COUNT(v.id)::int AS variant_count,
            COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0)::int AS total_stock
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
      WHERE ${where} GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 200`,
    params
  );
  json(res, 200, { products: r.rows });
}

function productFields(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has("title")) out.title = cleanString(body.title, { name: "Title", max: 160, required: true });
  if (has("subtitle")) out.subtitle = cleanString(body.subtitle, { name: "Subtitle", max: 240 });
  if (has("description")) out.description = cleanString(body.description, { name: "Description", max: 5000 });
  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) throw badRequest("category must be ear, neck or rings");
    out.category = body.category;
  }
  if (has("status")) {
    if (!PRODUCT_STATUSES.includes(body.status)) throw badRequest("status must be draft, active or archived");
    out.status = body.status;
  }
  if (has("price_cents")) out.price_cents = cleanInt(body.price_cents, { name: "price_cents", min: 0, max: 100_000_000 });
  if (has("images")) out.images = JSON.stringify(cleanImages(body.images));
  if (has("options")) out.options = JSON.stringify(cleanOptions(body.options));
  if (has("tags")) out.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map((t) => cleanString(t, { max: 40 })) : []);
  if (has("featured")) out.featured = Boolean(body.featured);
  if (has("video_url")) {
    const vu = cleanString(body.video_url, { name: "Video URL", max: 500 });
    if (vu && !/^(https:\/\/|\/)/.test(vu)) throw badRequest("Video URL must be https:// or a site path");
    out.video_url = vu;
  }
  if (has("seo_title")) out.seo_title = cleanString(body.seo_title, { name: "SEO title", max: 70 });
  if (has("seo_description")) out.seo_description = cleanString(body.seo_description, { name: "SEO description", max: 170 });
  if (has("publish_at")) {
    if (!body.publish_at) out.publish_at = null;
    else {
      const d = new Date(body.publish_at);
      if (isNaN(d.getTime())) throw badRequest("publish_at must be a valid date");
      out.publish_at = d;
    }
  }
  return out;
}

async function createProduct(req, res) {
  const body = req.body || {};
  const fields = productFields({ status: "draft", subtitle: "", description: "", category: "ear", price_cents: 0, images: [], options: [], tags: [], featured: false, ...body });
  let slug = slugify(body.slug || fields.title);
  const clash = await db.query("SELECT 1 FROM products WHERE slug = $1", [slug]);
  if (clash.rows.length) slug = `${slug}-${Date.now().toString(36)}`;
  const cols = Object.keys(fields);
  const r = await db.query(
    `INSERT INTO products (slug, ${cols.join(", ")}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(", ")}) RETURNING *`,
    [slug, ...cols.map((c) => fields[c])]
  );
  json(res, 201, { product: r.rows[0] });
}

async function getProduct(req, res, params) {
  const id = cleanInt(params.id, { name: "product id", min: 1 });
  const r = await db.query("SELECT * FROM products WHERE id = $1", [id]);
  if (!r.rows.length) throw notFound("Product not found");
  const variants = (await db.query("SELECT * FROM variants WHERE product_id = $1 ORDER BY id", [id])).rows;
  json(res, 200, { product: r.rows[0], variants });
}

async function updateProduct(req, res, params) {
  const id = cleanInt(params.id, { name: "product id", min: 1 });
  const fields = productFields(req.body || {}, { partial: true });
  if ((req.body || {}).slug !== undefined) {
    const slug = slugify(req.body.slug);
    const clash = await db.query("SELECT 1 FROM products WHERE slug = $1 AND id <> $2", [slug, id]);
    if (clash.rows.length) throw badRequest("That slug is already in use");
    fields.slug = slug;
  }
  if (Object.keys(fields).length === 0) throw badRequest("Nothing to update");
  const cols = Object.keys(fields);
  const r = await db.query(
    `UPDATE products SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => fields[c])]
  );
  if (!r.rows.length) throw notFound("Product not found");
  json(res, 200, { product: r.rows[0] });
}

async function deleteProduct(req, res, params) {
  const id = cleanInt(params.id, { name: "product id", min: 1 });
  // Products that have been sold are archived (order history must survive);
  // never-sold products are removed outright.
  const sold = await db.query(
    "SELECT 1 FROM order_items oi JOIN variants v ON v.id = oi.variant_id WHERE v.product_id = $1 LIMIT 1",
    [id]
  );
  if (sold.rows.length) {
    await db.query("UPDATE products SET status = 'archived', updated_at = now() WHERE id = $1", [id]);
    json(res, 200, { ok: true, archived: true });
  } else {
    const r = await db.query("DELETE FROM products WHERE id = $1", [id]);
    if (r.rowCount === 0) throw notFound("Product not found");
    json(res, 200, { ok: true, deleted: true });
  }
}

/* ---------- variants (bulk upsert per product) ---------- */

async function putVariants(req, res, params) {
  const productId = cleanInt(params.id, { name: "product id", min: 1 });
  const pr = await db.query("SELECT * FROM products WHERE id = $1", [productId]);
  const product = pr.rows[0];
  if (!product) throw notFound("Product not found");

  const list = (req.body || {}).variants;
  if (!Array.isArray(list) || list.length > 500) throw badRequest("variants must be an array (max 500)");
  const optionNames = (product.options || []).map((o) => o.name);

  const cleaned = list.map((v, idx) => {
    const sku = cleanString(v.sku, { name: `variants[${idx}].sku`, max: 60, required: true }).toUpperCase();
    const options = {};
    for (const name of optionNames) {
      const group = (product.options || []).find((o) => o.name === name);
      const value = cleanString(v.options && v.options[name], { name: `variants[${idx}].options.${name}`, max: 60, required: true });
      if (!group.values.includes(value)) throw badRequest(`"${value}" is not a value of option "${name}"`);
      options[name] = value;
    }
    return {
      id: v.id ? cleanInt(v.id, { name: "variant id", min: 1 }) : null,
      sku,
      options,
      price_cents: v.price_cents == null || v.price_cents === "" ? null : cleanInt(v.price_cents, { name: "price_cents", min: 0, max: 100_000_000 }),
      compare_at_cents: v.compare_at_cents == null || v.compare_at_cents === "" ? null : cleanInt(v.compare_at_cents, { name: "compare_at_cents", min: 0, max: 100_000_000 }),
      stock: cleanInt(v.stock == null ? 0 : v.stock, { name: "stock", min: 0, max: 1_000_000 }),
      image: v.image ? cleanString(v.image, { max: 500 }) : null,
      active: v.active !== false,
    };
  });
  const skus = cleaned.map((v) => v.sku);
  if (new Set(skus).size !== skus.length) throw badRequest("Duplicate SKUs in variant list");
  const signatures = cleaned.map((v) => JSON.stringify(optionNames.map((n) => v.options[n])));
  if (new Set(signatures).size !== signatures.length) throw badRequest("Two variants share the same option combination");

  await db.tx(async (client) => {
    // pg returns BIGINT ids as strings — normalize to Number before comparing,
    // or every kept id "misses" and the whole matrix gets deleted.
    const existing = (await client.query("SELECT id FROM variants WHERE product_id = $1", [productId])).rows.map((r2) => Number(r2.id));
    const keptIds = cleaned.filter((v) => v.id).map((v) => Number(v.id));
    const toDelete = existing.filter((id) => !keptIds.includes(id));
    if (toDelete.length) {
      // Sold variants are deactivated instead of deleted so order lines keep meaning.
      await client.query(
        `UPDATE variants SET active = false, updated_at = now()
          WHERE id = ANY($1) AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.variant_id = variants.id)`,
        [toDelete]
      );
      await client.query(
        `DELETE FROM variants WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.variant_id = variants.id)`,
        [toDelete]
      );
    }
    for (const v of cleaned) {
      const clash = await client.query(
        "SELECT 1 FROM variants WHERE sku = $1 AND product_id <> $2" + (v.id ? " AND id <> $3" : ""),
        v.id ? [v.sku, productId, v.id] : [v.sku, productId]
      );
      if (clash.rows.length) throw badRequest(`SKU ${v.sku} is already used by another product`);
      if (v.id) {
        const before = await client.query("SELECT stock FROM variants WHERE id = $1 AND product_id = $2", [v.id, productId]);
        await client.query(
          `UPDATE variants SET sku=$1, options=$2, price_cents=$3, compare_at_cents=$4, stock=$5, image=$6, active=$7, updated_at=now()
            WHERE id = $8 AND product_id = $9`,
          [v.sku, JSON.stringify(v.options), v.price_cents, v.compare_at_cents, v.stock, v.image, v.active, v.id, productId]
        );
        if (before.rows.length && before.rows[0].stock !== v.stock) {
          await client.query(
            `INSERT INTO inventory_movements (variant_id, sku, delta, reason, note, user_id)
             VALUES ($1, $2, $3, 'manual', 'variant editor', $4)`,
            [v.id, v.sku, v.stock - before.rows[0].stock, req.adminUser ? req.adminUser.id : null]
          );
        }
      } else {
        await client.query(
          `INSERT INTO variants (product_id, sku, options, price_cents, compare_at_cents, stock, image, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (sku) DO UPDATE SET options=EXCLUDED.options, price_cents=EXCLUDED.price_cents,
             compare_at_cents=EXCLUDED.compare_at_cents, stock=EXCLUDED.stock, image=EXCLUDED.image,
             active=EXCLUDED.active, updated_at=now()
           WHERE variants.product_id = $1`,
          [productId, v.sku, JSON.stringify(v.options), v.price_cents, v.compare_at_cents, v.stock, v.image, v.active]
        );
      }
    }
  });
  const variants = (await db.query("SELECT * FROM variants WHERE product_id = $1 ORDER BY id", [productId])).rows;
  json(res, 200, { ok: true, variants });
}

/* ---------- orders ---------- */

const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled", "refunded"];

async function listOrders(req, res) {
  const q = req.query || {};
  const params = [];
  let where = "true";
  if (ORDER_STATUSES.includes(q.status)) { params.push(q.status); where += ` AND o.status = $${params.length}`; }
  const search = cleanString(q.q, { max: 100 });
  if (search) { params.push(`%${search}%`); where += ` AND (o.number ILIKE $${params.length} OR o.email ILIKE $${params.length})`; }
  const sku = cleanString(q.sku, { max: 60 });
  if (sku) {
    params.push(`%${sku}%`);
    where += ` AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.sku ILIKE $${params.length})`;
  }
  const from = cleanString(q.from, { max: 10 });
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); where += ` AND o.created_at >= $${params.length}::date`; }
  const to = cleanString(q.to, { max: 10 });
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { params.push(to); where += ` AND o.created_at < ($${params.length}::date + interval '1 day')`; }
  const r = await db.query(
    `SELECT o.id, o.number, o.email, o.status, o.payment_method, o.total_cents, o.currency, o.from_recovered_cart, o.created_at
       FROM orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT 200`,
    params
  );
  json(res, 200, { orders: r.rows });
}

async function getOrder(req, res, params) {
  const id = cleanInt(params.id, { name: "order id", min: 1 });
  const r = await db.query("SELECT * FROM orders WHERE id = $1", [id]);
  const order = r.rows[0];
  if (!order) throw notFound("Order not found");
  const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows;
  const events = (await db.query(
    `SELECT e.kind, e.data, e.created_at, u.email AS actor
       FROM order_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.order_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
    [order.id]
  )).rows;
  json(res, 200, { order, items, events });
}

async function updateOrder(req, res, params) {
  const id = cleanInt(params.id, { name: "order id", min: 1 });
  const body = req.body || {};
  const status = String(body.status || "");
  if (!ORDER_STATUSES.includes(status)) throw badRequest(`status must be one of ${ORDER_STATUSES.join(", ")}`);
  const trackingCarrier = cleanString(body.trackingCarrier, { name: "Carrier", max: 60 });
  const trackingNumber = cleanString(body.trackingNumber, { name: "Tracking number", max: 100 });
  let shippedNow = false;
  let refundNow = false;
  const updated = await db.tx(async (client) => {
    const cur = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
    const order = cur.rows[0];
    if (!order) throw notFound("Order not found");
    const restockNow = ["cancelled", "refunded"].includes(status) && !["cancelled", "refunded"].includes(order.status);
    shippedNow = status === "fulfilled" && order.status !== "fulfilled";
    refundNow = status === "refunded" && order.status !== "refunded" && order.payment_method === "online";
    const r = await client.query(
      `UPDATE orders SET status = $1,
              tracking_carrier = COALESCE(NULLIF($3, ''), tracking_carrier),
              tracking_number  = COALESCE(NULLIF($4, ''), tracking_number),
              updated_at = now()
        WHERE id = $2 RETURNING *`,
      [status, id, trackingCarrier, trackingNumber]
    );
    if (order.status !== status) {
      await client.query(
        "INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'status', $2, $3)",
        [id, JSON.stringify({ from: order.status, to: status, trackingNumber: trackingNumber || undefined }), req.adminUser ? req.adminUser.id : null]
      );
    }
    if (restockNow) await checkout.restockOrder(client, id);
    return r.rows[0];
  });
  if (refundNow) {
    // move the money back through whichever gateway took it (test mode: no-op success)
    const result = await checkout.refundViaProvider(updated, updated.total_cents);
    await db.query("INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'note', $2, $3)",
      [id, JSON.stringify({ note: result.ok ? `Gateway refund issued (${result.ref || "ok"})` : `Gateway refund FAILED: ${result.reason || "unknown"} — refund manually` }),
       req.adminUser ? req.adminUser.id : null]);
  }
  if (shippedNow) {
    const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [id])).rows;
    try {
      await emailLib.sendShippingConfirmation(updated, items);
      await db.query("INSERT INTO order_events (order_id, kind, data) VALUES ($1, 'email', $2)",
        [id, JSON.stringify({ template: "shipping_confirmation", to: updated.email })]);
    } catch (e) { console.error("[admin] shipping email failed:", e.message); }
  }
  json(res, 200, { order: updated });
}

/** Private admin note on an order's timeline. */
async function addOrderNote(req, res, params) {
  const id = cleanInt(params.id, { name: "order id", min: 1 });
  const note = cleanString((req.body || {}).note, { name: "Note", max: 2000, required: true });
  const exists = await db.query("SELECT 1 FROM orders WHERE id = $1", [id]);
  if (!exists.rows.length) throw notFound("Order not found");
  await db.query(
    "INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'note', $2, $3)",
    [id, JSON.stringify({ note }), req.adminUser ? req.adminUser.id : null]
  );
  json(res, 200, { ok: true });
}

/** Re-send the confirmation email for a paid/fulfilled order. */
async function resendConfirmation(req, res, params) {
  const id = cleanInt(params.id, { name: "order id", min: 1 });
  const r = await db.query("SELECT * FROM orders WHERE id = $1", [id]);
  const order = r.rows[0];
  if (!order) throw notFound("Order not found");
  if (!["paid", "fulfilled"].includes(order.status)) throw badRequest("Only paid orders can re-send a confirmation");
  const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [id])).rows;
  const result = await emailLib.sendOrderConfirmation(order, items);
  await db.query("INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'email', $2, $3)",
    [id, JSON.stringify({ template: "order_confirmation", to: order.email, resend: true }), req.adminUser ? req.adminUser.id : null]);
  json(res, 200, { ok: true, delivered: result.delivered });
}

/* ---------- customers ---------- */

async function listCustomers(req, res) {
  const r = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.created_at, u.last_login_at,
            COUNT(o.id) FILTER (WHERE o.status IN ('paid','fulfilled'))::int AS orders,
            COALESCE(SUM(o.total_cents) FILTER (WHERE o.status IN ('paid','fulfilled')), 0)::bigint AS spent_cents
       FROM users u LEFT JOIN orders o ON o.user_id = u.id
      GROUP BY u.id ORDER BY spent_cents DESC, u.created_at DESC LIMIT 500`
  );
  json(res, 200, { customers: r.rows });
}

async function getCustomer(req, res, params) {
  const id = cleanInt(params.id, { name: "customer id", min: 1 });
  const r = await db.query(
    `SELECT id, email, name, role, disabled, notes, tags, created_at, last_login_at, totp_enabled FROM users WHERE id = $1`,
    [id]
  );
  const customer = r.rows[0];
  if (!customer) throw notFound("Customer not found");
  const orders = (await db.query(
    `SELECT id, number, status, total_cents, currency, created_at FROM orders
      WHERE user_id = $1 OR email = $2 ORDER BY created_at DESC LIMIT 100`,
    [id, customer.email]
  )).rows;
  const paid = orders.filter((o) => ["paid", "fulfilled"].includes(o.status));
  json(res, 200, {
    customer,
    orders,
    stats: {
      orders: paid.length,
      lifetimeCents: paid.reduce((s, o) => s + o.total_cents, 0),
      firstOrderAt: paid.length ? paid[paid.length - 1].created_at : null,
    },
  });
}

async function updateCustomer(req, res, params) {
  const id = cleanInt(params.id, { name: "customer id", min: 1 });
  const body = req.body || {};
  const target = await db.query("SELECT id, role FROM users WHERE id = $1", [id]);
  if (!target.rows.length) throw notFound("Customer not found");
  if (target.rows[0].role === "admin" && body.disabled) throw badRequest("Admins can't be disabled here — demote them first under Staff");
  const fields = {};
  if (body.notes !== undefined) fields.notes = cleanString(body.notes, { name: "Notes", max: 5000 });
  if (body.tags !== undefined) {
    fields.tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 20).map((t) => cleanString(t, { max: 40 })).filter(Boolean) : []);
  }
  if (body.disabled !== undefined) fields.disabled = Boolean(body.disabled);
  if (!Object.keys(fields).length) throw badRequest("Nothing to update");
  const cols = Object.keys(fields);
  const r = await db.query(
    `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1
     RETURNING id, email, name, role, disabled, notes, tags`,
    [id, ...cols.map((c) => fields[c])]
  );
  if (fields.disabled) await db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
  json(res, 200, { customer: r.rows[0] });
}

/* ---------- abandoned carts ---------- */

async function listAbandoned(req, res) {
  const r = await db.query(
    `SELECT c.id, c.email, c.status, c.recovered, c.recovery_sent_at, c.updated_at, c.currency,
            COALESCE(SUM(ci.qty), 0)::int AS item_count,
            COALESCE(SUM(ci.qty * COALESCE(v.price_cents, p.price_cents)), 0)::bigint AS value_cents,
            COALESCE(json_agg(json_build_object('title', p.title, 'label', v.options, 'qty', ci.qty))
                     FILTER (WHERE ci.id IS NOT NULL), '[]') AS items
       FROM carts c
       LEFT JOIN cart_items ci ON ci.cart_id = c.id
       LEFT JOIN variants v ON v.id = ci.variant_id
       LEFT JOIN products p ON p.id = v.product_id
      WHERE c.status = 'abandoned' OR (c.status = 'active' AND c.email IS NOT NULL AND c.updated_at < now() - interval '2 hours')
      GROUP BY c.id HAVING COUNT(ci.id) > 0
      ORDER BY c.updated_at DESC LIMIT 200`
  );
  json(res, 200, { carts: r.rows });
}

async function sendRecovery(req, res, params) {
  const id = cleanInt(params.id, { name: "cart id", min: 1 });
  const r = await db.query("SELECT * FROM carts WHERE id = $1", [id]);
  const cart = r.rows[0];
  if (!cart) throw notFound("Cart not found");
  if (!cart.email) throw badRequest("No email captured for this cart");
  if (cart.status === "converted") throw badRequest("This cart already checked out");

  const token = cart.recovery_token || require("crypto").randomBytes(32).toString("hex");
  await db.query("UPDATE carts SET recovery_token = $1, status = 'abandoned' WHERE id = $2", [token, id]);
  const payload = await cartLib.cartPayload(cart);
  const items = payload.items.filter((i) => i.purchasable)
    .map((i) => ({ product_title: i.title, variant_label: i.variantLabel, qty: i.qty, unit_price_cents: i.unitCents }));
  if (!items.length) throw badRequest("Cart has no purchasable items");
  const result = await emailLib.sendCartRecovery({ ...cart, recovery_token: token }, items, payload.subtotalCents);
  await db.query("UPDATE carts SET recovery_sent_at = now() WHERE id = $1", [id]);
  json(res, 200, { ok: true, delivered: result.delivered });
}

/* ---------- discounts ---------- */

async function listDiscounts(req, res) {
  const r = await db.query("SELECT * FROM discounts ORDER BY created_at DESC LIMIT 200");
  json(res, 200, { discounts: r.rows });
}

async function createDiscount(req, res) {
  const body = req.body || {};
  const code = cleanString(body.code, { name: "Code", max: 40, required: true }).toUpperCase().replace(/\s+/g, "");
  const kind = ["fixed", "free_shipping"].includes(body.kind) ? body.kind : "percent";
  const value = kind === "free_shipping" ? 0
    : cleanInt(body.value, { name: "value", min: 1, max: kind === "percent" ? 100 : 100_000_000 });
  const minCents = cleanInt(body.min_cents == null ? 0 : body.min_cents, { name: "min_cents", min: 0, max: 100_000_000 });
  const maxUses = body.max_uses == null || body.max_uses === "" ? null
    : cleanInt(body.max_uses, { name: "max_uses", min: 1, max: 1_000_000 });
  const oncePer = Boolean(body.once_per_customer);
  const parseDate = (raw, name) => {
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) throw badRequest(`${name} must be a valid date`);
    return d;
  };
  const expiresAt = parseDate(body.expires_at, "expires_at");
  const startsAt = parseDate(body.starts_at, "starts_at");
  const r = await db.query(
    `INSERT INTO discounts (code, kind, value, min_cents, expires_at, starts_at, max_uses, once_per_customer, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
     ON CONFLICT (code) DO UPDATE SET kind=$2, value=$3, min_cents=$4, expires_at=$5, starts_at=$6,
       max_uses=$7, once_per_customer=$8, active=true
     RETURNING *`,
    [code, kind, value, minCents, expiresAt, startsAt, maxUses, oncePer]
  );
  json(res, 201, { discount: r.rows[0] });
}

async function deleteDiscount(req, res, params) {
  const code = cleanString(params.code, { name: "code", max: 40, required: true }).toUpperCase();
  await db.query("UPDATE discounts SET active = false WHERE code = $1", [code]);
  json(res, 200, { ok: true });
}

/* ---------- waitlist ---------- */

async function listWaitlist(req, res) {
  const r = await db.query("SELECT email, created_at FROM waitlist ORDER BY created_at DESC LIMIT 1000");
  json(res, 200, { waitlist: r.rows });
}

module.exports = {
  metrics,
  listProducts, createProduct, getProduct, updateProduct, deleteProduct, putVariants,
  listOrders, getOrder, updateOrder, addOrderNote, resendConfirmation,
  listCustomers, getCustomer, updateCustomer, listAbandoned, sendRecovery,
  listDiscounts, createDiscount, deleteDiscount, listWaitlist,
};
