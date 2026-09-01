/* /api/store/cron/sweep — scheduled housekeeping (vercel.json cron, hourly).
   1. Marks stale active carts (with items + a known email) as abandoned and
      sends the first recovery email; optionally a second reminder later.
   2. Cancels online-gateway orders that never completed payment and restocks them.
   3. Activates draft products whose publish_at has arrived.
   4. Prunes expired sessions, reset tokens and old rate-limit rows.
   Timing comes from CMS Settings (env vars as fallback).
   Protected by CRON_SECRET (Vercel sends it as a Bearer token). */

const crypto = require("crypto");
const db = require("../lib/db");
const authLib = require("../lib/auth");
const settings = require("../lib/settings");
const emailLib = require("../lib/email");
const cartLib = require("./cartLib");
const checkout = require("./checkout");
const { json, unauthorized } = require("../lib/http");

const ONLINE_PENDING_EXPIRE_MIN = 120;

function assertCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return; // not configured — allow, but recommend setting it
  const header = String(req.headers.authorization || "");
  if (header !== `Bearer ${secret}`) throw unauthorized("Bad cron secret");
}

async function sendRecoveryFor(cart, token) {
  const payload = await cartLib.cartPayload(cart);
  const items = payload.items
    .filter((i) => i.purchasable)
    .map((i) => ({ product_title: i.title, variant_label: i.variantLabel, qty: i.qty, unit_price_cents: i.unitCents }));
  if (!items.length) return false;
  const result = await emailLib.sendCartRecovery({ ...cart, recovery_token: token }, items, payload.subtotalCents);
  return result.ok;
}

async function sweepAbandonedCarts() {
  const afterMinutes = await settings.get("abandoned.minutes");
  const r = await db.query(
    `SELECT c.* FROM carts c
      WHERE c.status = 'active' AND c.email IS NOT NULL
        AND c.updated_at < now() - make_interval(mins => $1)
        AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)
      LIMIT 50`,
    [afterMinutes]
  );
  let sent = 0;
  for (const cart of r.rows) {
    const token = cart.recovery_token || crypto.randomBytes(32).toString("hex");
    await db.query("UPDATE carts SET status = 'abandoned', recovery_token = $1 WHERE id = $2", [token, cart.id]);
    if (!cart.recovery_sent_at && (await sendRecoveryFor(cart, token))) {
      await db.query("UPDATE carts SET recovery_sent_at = now(), recovery_sent_count = 1 WHERE id = $1", [cart.id]);
      sent++;
    }
  }
  return { marked: r.rows.length, recoveryEmailsSent: sent };
}

/** Optional second nudge, hours after the first (0 in Settings = off). */
async function sendSecondReminders() {
  const hours = await settings.get("abandoned.second_reminder_hours");
  if (!hours || hours <= 0) return { secondRemindersSent: 0 };
  const r = await db.query(
    `SELECT * FROM carts
      WHERE status = 'abandoned' AND NOT recovered AND recovery_sent_count = 1
        AND recovery_sent_at < now() - make_interval(hours => $1)
      LIMIT 50`,
    [hours]
  );
  let sent = 0;
  for (const cart of r.rows) {
    if (await sendRecoveryFor(cart, cart.recovery_token)) {
      await db.query("UPDATE carts SET recovery_sent_count = 2, recovery_sent_at = now() WHERE id = $1", [cart.id]);
      sent++;
    } else {
      // nothing purchasable left — stop reminding
      await db.query("UPDATE carts SET recovery_sent_count = 2 WHERE id = $1", [cart.id]);
    }
  }
  return { secondRemindersSent: sent };
}

async function expireStalePendingOrders() {
  const r = await db.query(
    `SELECT id FROM orders
      WHERE status = 'pending' AND payment_method = 'online'
        AND created_at < now() - make_interval(mins => $1)
      LIMIT 50`,
    [ONLINE_PENDING_EXPIRE_MIN]
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

/** Scheduled publishing: drafts go live when their moment arrives. */
async function publishScheduled() {
  const r = await db.query(
    `UPDATE products SET status = 'active', publish_at = NULL, updated_at = now()
      WHERE status = 'draft' AND publish_at IS NOT NULL AND publish_at <= now()
      RETURNING slug`
  );
  return { published: r.rows.length };
}

async function sweep(req, res) {
  assertCronAuth(req);
  const carts = await sweepAbandonedCarts();
  const reminders = await sendSecondReminders();
  const orders = await expireStalePendingOrders();
  const published = await publishScheduled();
  await authLib.pruneSessions();
  json(res, 200, { ok: true, ...carts, ...reminders, ...orders, ...published });
}

module.exports = { sweep };
