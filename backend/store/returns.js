/* RMA returns portal.
   Customers look up an order by number + email, pick the pieces to send
   back, and get an RMA number. Staff move each RMA through
   requested → approved → received → refunded (or rejected); refunding also
   refunds the order through the payment adapter and restocks it.
   The return window (days after purchase) lives in Settings; 0 disables. */

const db = require("../lib/db");
const settings = require("../lib/settings");
const emailLib = require("../lib/email");
const checkout = require("./checkout");
const {
  json, badRequest, notFound, cleanEmail, cleanInt, cleanString,
  rateLimit, clientIp,
} = require("../lib/http");

const OPEN_STATUSES = ["requested", "approved", "received"];
const RMA_STATUSES = ["requested", "approved", "rejected", "received", "refunded"];

async function findOrder(number, email) {
  const r = await db.query(
    "SELECT * FROM orders WHERE number = $1 AND lower(email) = lower($2)",
    [String(number || "").trim().toUpperCase(), email]
  );
  if (!r.rows[0]) throw notFound("We can't find that order for this email");
  return r.rows[0];
}

async function assertWithinWindow(order) {
  const days = await settings.get("returns.window_days");
  if (!days || days <= 0) throw badRequest("Returns are not available right now");
  const ageDays = (Date.now() - new Date(order.created_at).getTime()) / 86400000;
  if (ageDays > days) throw badRequest(`The ${days}-day return window for this order has closed`);
  if (!["paid", "fulfilled"].includes(order.status)) throw badRequest("Only paid orders can be returned");
}

/** GET returns/eligible?number&email — what can still come back. */
async function eligible(req, res) {
  await rateLimit(`rma-look:${clientIp(req)}`, 30, 3600);
  const q = req.query || {};
  const email = cleanEmail(q.email);
  const order = await findOrder(q.number, email);
  const items = await db.query(
    "SELECT sku, product_title, variant_label, qty, unit_price_cents FROM order_items WHERE order_id = $1",
    [order.id]
  );
  const existing = await db.query(
    "SELECT rma_number, status, items, reason, created_at FROM returns WHERE order_id = $1 ORDER BY id DESC",
    [order.id]
  );
  let windowError = null;
  try { await assertWithinWindow(order); } catch (e) { windowError = e.message; }
  json(res, 200, {
    order: { number: order.number, status: order.status, createdAt: order.created_at, currency: order.currency },
    eligible: !windowError && !existing.rows.some((x) => OPEN_STATUSES.includes(x.status)),
    windowError,
    items: items.rows.map((i) => ({
      sku: i.sku, title: i.product_title, label: i.variant_label, qty: i.qty, unitCents: i.unit_price_cents,
    })),
    returns: existing.rows.map((x) => ({
      rma: x.rma_number, status: x.status, items: x.items, reason: x.reason, createdAt: x.created_at,
    })),
  });
}

/** POST returns {orderNumber, email, items:[{sku, qty}], reason} */
async function request(req, res) {
  await rateLimit(`rma:${clientIp(req)}`, 10, 3600);
  const body = req.body || {};
  const email = cleanEmail(body.email);
  const reason = cleanString(body.reason, { name: "reason", max: 1000, required: true });
  const order = await findOrder(body.orderNumber, email);
  await assertWithinWindow(order);

  const open = await db.query(
    "SELECT rma_number FROM returns WHERE order_id = $1 AND status = ANY($2)",
    [order.id, OPEN_STATUSES]
  );
  if (open.rows.length) throw badRequest(`Return ${open.rows[0].rma_number} is already in progress for this order`);

  const ordered = await db.query(
    "SELECT sku, product_title, variant_label, qty FROM order_items WHERE order_id = $1",
    [order.id]
  );
  const bySku = new Map(ordered.rows.map((i) => [i.sku, i]));
  const requested = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
  const items = [];
  for (const it of requested) {
    const line = bySku.get(String(it.sku || ""));
    if (!line) throw badRequest(`${it.sku || "item"} is not on this order`);
    const qty = cleanInt(it.qty == null ? 1 : it.qty, { name: "qty", min: 1, max: line.qty });
    items.push({ sku: line.sku, title: line.product_title, label: line.variant_label, qty });
  }
  if (!items.length) throw badRequest("Pick at least one piece to return");

  const rma = await db.query(
    `INSERT INTO returns (rma_number, order_id, email, reason, items)
     VALUES ('RMA-' || nextval('rma_number_seq'), $1, $2, $3, $4) RETURNING *`,
    [order.id, order.email, reason, JSON.stringify(items)]
  );
  await db.query(
    "INSERT INTO order_events (order_id, kind, data) VALUES ($1, 'note', $2)",
    [order.id, JSON.stringify({ note: `Return ${rma.rows[0].rma_number} requested by the customer` })]
  );
  emailLib.sendRmaUpdate(rma.rows[0], order).catch(() => {});
  json(res, 200, { ok: true, rma: rma.rows[0].rma_number, status: "requested" });
}

/* ---------------- CMS ---------------- */

async function adminList(req, res) {
  const q = req.query || {};
  const status = RMA_STATUSES.includes(q.status) ? q.status : null;
  const params = [];
  let where = "TRUE";
  if (status) { params.push(status); where = `r.status = $${params.length}`; }
  const r = await db.query(
    `SELECT r.*, o.number AS order_number, o.total_cents, o.currency, o.status AS order_status
       FROM returns r JOIN orders o ON o.id = r.order_id
      WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`,
    params
  );
  const counts = await db.query("SELECT status, COUNT(*)::int AS n FROM returns GROUP BY status");
  json(res, 200, {
    returns: r.rows.map((x) => ({
      id: x.id,
      rma: x.rma_number,
      orderId: x.order_id,
      orderNumber: x.order_number,
      orderStatus: x.order_status,
      totalCents: x.total_cents,
      currency: x.currency,
      email: x.email,
      status: x.status,
      reason: x.reason,
      items: x.items,
      adminNote: x.admin_note,
      createdAt: x.created_at,
    })),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
  });
}

/** PATCH admin/returns/:id {status?, adminNote?} — refunded also refunds the
    order through the gateway adapter and restocks it. */
async function adminUpdate(req, res, params) {
  const id = cleanInt(params.id, { name: "id", min: 1 });
  const body = req.body || {};
  const cur = await db.query("SELECT * FROM returns WHERE id = $1", [id]);
  const rma = cur.rows[0];
  if (!rma) throw notFound("Return not found");

  const sets = [];
  const vals = [];
  let status = null;
  if (body.status !== undefined) {
    if (!RMA_STATUSES.includes(body.status)) throw badRequest("Bad status");
    status = body.status;
    vals.push(status);
    sets.push(`status = $${vals.length}`);
  }
  if (body.adminNote !== undefined) {
    vals.push(cleanString(body.adminNote, { name: "note", max: 1000 }));
    sets.push(`admin_note = $${vals.length}`);
  }
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id);
  const r = await db.query(
    `UPDATE returns SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  const updated = r.rows[0];

  if (status === "refunded" && rma.status !== "refunded") {
    let order = null;
    await db.tx(async (client) => {
      const o = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [rma.order_id]);
      order = o.rows[0];
      if (order && !["cancelled", "refunded"].includes(order.status)) {
        await client.query("UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1", [order.id]);
        await client.query(
          "INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'status', $2, $3)",
          [order.id, JSON.stringify({ from: order.status, to: "refunded", rma: rma.rma_number }), req.adminUser ? req.adminUser.id : null]
        );
        await checkout.restockOrder(client, order.id);
      }
    });
    if (order && order.payment_method === "online") {
      const result = await checkout.refundViaProvider(order, order.total_cents);
      await db.query("INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'note', $2, $3)",
        [order.id, JSON.stringify({ note: result.ok ? `Gateway refund issued for ${rma.rma_number}` : `Gateway refund FAILED for ${rma.rma_number}: ${result.reason || "unknown"} — refund manually` }),
         req.adminUser ? req.adminUser.id : null]);
    }
  }

  if (status && status !== rma.status && ["approved", "rejected", "refunded"].includes(status)) {
    const o = await db.query("SELECT * FROM orders WHERE id = $1", [rma.order_id]);
    if (o.rows[0]) emailLib.sendRmaUpdate(updated, o.rows[0]).catch(() => {});
  }
  json(res, 200, { ok: true, return: { id: updated.id, rma: updated.rma_number, status: updated.status } });
}

module.exports = { eligible, request, adminList, adminUpdate };
