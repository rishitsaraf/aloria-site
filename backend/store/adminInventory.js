/* /api/store/admin/inventory — stock across every variant in one place,
   with quick adjustments and a full movement log. Every stock change in the
   system (sales, restocks, editor saves, adjustments, imports) lands in
   inventory_movements, so the log is the audit trail. */

const db = require("../lib/db");
const { json, badRequest, notFound, cleanInt, cleanString } = require("../lib/http");

async function list(req, res) {
  const q = req.query || {};
  const params = [];
  let where = "true";
  if (q.low === "1") where += " AND v.stock <= 3";
  if (q.active === "1") where += " AND v.active AND p.status = 'active'";
  const search = cleanString(q.q, { max: 100 });
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (v.sku ILIKE $${params.length} OR p.title ILIKE $${params.length})`;
  }
  const r = await db.query(
    `SELECT v.id, v.sku, v.options, v.stock, v.active, v.price_cents,
            p.id AS product_id, p.title, p.category, p.price_cents AS base_price_cents, p.currency, p.status AS product_status
       FROM variants v JOIN products p ON p.id = v.product_id
      WHERE ${where}
      ORDER BY v.stock ASC, p.title, v.id LIMIT 500`,
    params
  );
  const totals = await db.query(
    `SELECT COALESCE(SUM(stock), 0)::int AS units,
            COUNT(*) FILTER (WHERE stock = 0 AND active)::int AS out,
            COUNT(*) FILTER (WHERE stock BETWEEN 1 AND 3 AND active)::int AS low
       FROM variants`
  );
  json(res, 200, { variants: r.rows, totals: totals.rows[0] });
}

/** Adjust one variant's stock by a delta (or set an absolute count). */
async function adjust(req, res, params) {
  const variantId = cleanInt(params.id, { name: "variant id", min: 1 });
  const body = req.body || {};
  const note = cleanString(body.note, { name: "Note", max: 300 });
  const hasDelta = body.delta !== undefined && body.delta !== null && body.delta !== "";
  const hasSet = body.set !== undefined && body.set !== null && body.set !== "";
  if (!hasDelta && !hasSet) throw badRequest("Provide delta (±n) or set (absolute)");

  const updated = await db.tx(async (client) => {
    const cur = await client.query("SELECT id, sku, stock FROM variants WHERE id = $1 FOR UPDATE", [variantId]);
    const v = cur.rows[0];
    if (!v) throw notFound("Variant not found");
    const target = hasSet
      ? cleanInt(body.set, { name: "set", min: 0, max: 1_000_000 })
      : v.stock + cleanInt(body.delta, { name: "delta", min: -1_000_000, max: 1_000_000 });
    if (target < 0) throw badRequest(`Stock can't go below zero (currently ${v.stock})`);
    const delta = target - v.stock;
    const r = await client.query(
      "UPDATE variants SET stock = $1, updated_at = now() WHERE id = $2 RETURNING id, sku, stock",
      [target, variantId]
    );
    if (delta !== 0) {
      await client.query(
        `INSERT INTO inventory_movements (variant_id, sku, delta, reason, note, user_id)
         VALUES ($1, $2, $3, 'manual', $4, $5)`,
        [variantId, v.sku, delta, note, req.adminUser ? req.adminUser.id : null]
      );
    }
    return r.rows[0];
  });
  json(res, 200, { ok: true, variant: updated });
}

async function movements(req, res) {
  const q = req.query || {};
  const params = [];
  let where = "true";
  if (q.variantId) { params.push(cleanInt(q.variantId, { name: "variantId", min: 1 })); where += ` AND m.variant_id = $${params.length}`; }
  const sku = cleanString(q.sku, { max: 60 });
  if (sku) { params.push(`%${sku}%`); where += ` AND m.sku ILIKE $${params.length}`; }
  const r = await db.query(
    `SELECT m.id, m.sku, m.delta, m.reason, m.note, m.created_at,
            o.number AS order_number, u.email AS actor
       FROM inventory_movements m
       LEFT JOIN orders o ON o.id = m.order_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE ${where} ORDER BY m.created_at DESC LIMIT 200`,
    params
  );
  json(res, 200, { movements: r.rows });
}

module.exports = { list, adjust, movements };
