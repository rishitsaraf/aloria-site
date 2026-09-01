/* Wishlist (signed-in customers) + back-in-stock alerts (anyone).
   Alerts are registered against a specific sold-out variant and delivered
   by the hourly cron once that variant is restocked. */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const emailLib = require("../lib/email");
const {
  json, badRequest, notFound, cleanEmail, cleanInt, cleanString,
  rateLimit, clientIp,
} = require("../lib/http");

/* ---------------- wishlist ---------------- */

async function listWishlist(req, res) {
  const user = await authLib.requireUser(req);
  const r = await db.query(
    `SELECT p.slug, p.title, p.subtitle, p.category, p.currency, p.images,
            COALESCE(MIN(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents) AS price_from_cents,
            COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0)::int AS total_stock,
            p.status
       FROM wishlists w
       JOIN products p ON p.id = w.product_id
       LEFT JOIN variants v ON v.product_id = p.id
      WHERE w.user_id = $1
      GROUP BY p.id, w.created_at
      ORDER BY w.created_at DESC`,
    [user.id]
  );
  json(res, 200, {
    items: r.rows.map((p) => ({
      slug: p.slug,
      title: p.title,
      subtitle: p.subtitle,
      category: p.category,
      currency: p.currency,
      image: (p.images || [])[0] || null,
      priceFromCents: p.price_from_cents,
      inStock: p.total_stock > 0,
      available: p.status === "active",
    })),
  });
}

/** POST wishlist/toggle {slug} → {saved:true|false} */
async function toggleWishlist(req, res) {
  const user = await authLib.requireUser(req);
  const slug = cleanString((req.body || {}).slug, { name: "slug", max: 120, required: true });
  const p = await db.query("SELECT id FROM products WHERE slug = $1", [slug]);
  if (!p.rows[0]) throw notFound("Product not found");
  const del = await db.query(
    "DELETE FROM wishlists WHERE user_id = $1 AND product_id = $2 RETURNING product_id",
    [user.id, p.rows[0].id]
  );
  if (del.rows.length) return json(res, 200, { ok: true, saved: false });
  await db.query("INSERT INTO wishlists (user_id, product_id) VALUES ($1, $2)", [user.id, p.rows[0].id]);
  json(res, 200, { ok: true, saved: true });
}

/* ---------------- back-in-stock alerts ---------------- */

/** POST stock-alerts {variantId, email?} — email optional when signed in. */
async function createAlert(req, res) {
  await rateLimit(`alert:${clientIp(req)}`, 15, 3600);
  const body = req.body || {};
  const variantId = cleanInt(body.variantId, { name: "variantId", min: 1 });
  const user = await authLib.currentUser(req).catch(() => null);
  const email = user ? user.email : cleanEmail(body.email);

  const v = await db.query(
    `SELECT v.id, v.stock, v.active, p.status FROM variants v
       JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
    [variantId]
  );
  if (!v.rows[0] || !v.rows[0].active || v.rows[0].status !== "active") throw notFound("Variant not found");
  if (v.rows[0].stock > 0) throw badRequest("This piece is in stock — add it to your bag");

  await db.query(
    `INSERT INTO stock_alerts (variant_id, email) VALUES ($1, $2)
     ON CONFLICT (variant_id, email) DO UPDATE SET notified_at = NULL`,
    [variantId, email]
  );
  json(res, 200, { ok: true });
}

/** Cron: deliver alerts whose variant is back in stock. */
async function sendStockAlerts() {
  const r = await db.query(
    `SELECT sa.id, sa.email, v.sku, v.options, p.title, p.slug
       FROM stock_alerts sa
       JOIN variants v ON v.id = sa.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE sa.notified_at IS NULL AND v.active AND v.stock > 0 AND p.status = 'active'
      LIMIT 100`
  );
  let sent = 0;
  for (const row of r.rows) {
    const result = await emailLib.sendStockAlert(row.email, row).catch(() => ({ ok: false }));
    // mark delivered either way so a broken address can't loop forever
    await db.query("UPDATE stock_alerts SET notified_at = now() WHERE id = $1", [row.id]);
    if (result.ok) sent++;
  }
  return { stockAlertsSent: sent };
}

module.exports = { listWishlist, toggleWishlist, createAlert, sendStockAlerts };
