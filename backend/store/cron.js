/* /api/store/cron/sweep — scheduled housekeeping (vercel.json cron, hourly).
   1. Marks stale active carts (with items + a known email) as abandoned and
      sends one recovery email with a tokenized restore link.
   2. Cancels stripe orders that never completed payment and restocks them.
   3. Prunes expired sessions and old rate-limit rows.
   Protected by CRON_SECRET (Vercel sends it as a Bearer token automatically). */

const crypto = require("crypto");
const db = require("../lib/db");
const authLib = require("../lib/auth");
const emailLib = require("../lib/email");
const checkout = require("./checkout");
const { json, unauthorized } = require("../lib/http");

const ABANDON_AFTER_MIN = parseInt(process.env.ABANDONED_AFTER_MINUTES, 10) || 120;
const STRIPE_PENDING_EXPIRE_MIN = 120;

function assertCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return; // not configured — allow, but recommend setting it
  const header = String(req.headers.authorization || "");
  if (header !== `Bearer ${secret}`) throw unauthorized("Bad cron secret");
}

async function sweepAbandonedCarts() {
  const r = await db.query(
    `SELECT c.* FROM carts c
      WHERE c.status = 'active' AND c.email IS NOT NULL
        AND c.updated_at < now() - make_interval(mins => $1)
        AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
      LIMIT 50`,
    [ABANDON_AFTER_MIN]
  );
  let sent = 0;
  for (const cart of r.rows) {
    const token = cart.recovery_token || crypto.randomBytes(32).toString("hex");
    await db.query(
      "UPDATE carts SET status = 'abandoned', recovery_token = $1 WHERE id = $2",
      [token, cart.id]
    );
    if (!cart.recovery_sent_at) {
      const payload = await require("./cartLib").cartPayload(cart);
      const items = payload.items
        .filter((i) => i.purchasable)
        .map((i) => ({ product_title: i.title, variant_label: i.variantLabel, qty: i.qty, unit_price_cents: i.unitCents }));
      if (items.length) {
        const result = await emailLib.sendCartRecovery({ ...cart, recovery_token: token }, items, payload.subtotalCents);
        if (result.ok) {
          await db.query("UPDATE carts SET recovery_sent_at = now() WHERE id = $1", [cart.id]);
          sent++;
        }
      }
    }
  }
  return { marked: r.rows.length, recoveryEmailsSent: sent };
}

async function expireStalePendingOrders() {
  const r = await db.query(
    `SELECT id FROM orders
      WHERE status = 'pending' AND payment_method = 'stripe'
        AND created_at < now() - make_interval(mins => $1)
      LIMIT 50`,
    [STRIPE_PENDING_EXPIRE_MIN]
  );
  for (const row of r.rows) {
    await db.tx(async (client) => {
      const o = await client.query(
        "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
        [row.id]
      );
      if (o.rows.length) await checkout.restockOrder(client, row.id);
    });
  }
  return { cancelled: r.rows.length };
}

async function sweep(req, res) {
  assertCronAuth(req);
  const carts = await sweepAbandonedCarts();
  const orders = await expireStalePendingOrders();
  await authLib.pruneSessions();
  json(res, 200, { ok: true, ...carts, ...orders });
}

module.exports = { sweep };
