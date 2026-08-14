/* /api/store/cart/* — bag management + abandoned-cart capture/recovery. */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const cartLib = require("./cartLib");
const { json, badRequest, notFound, cleanEmail, cleanInt, setCookie, randomToken, sha256, rateLimit, clientIp } = require("../lib/http");

async function get(req, res) {
  const cart = await cartLib.findCartByCookie(req);
  json(res, 200, { cart: await cartLib.cartPayload(cart) });
}

async function addItem(req, res) {
  const body = req.body || {};
  const variantId = cleanInt(body.variantId, { name: "variantId", min: 1 });
  const qty = cleanInt(body.qty == null ? 1 : body.qty, { name: "qty", min: 1, max: cartLib.MAX_QTY_PER_LINE });

  const v = await db.query(
    `SELECT v.id, v.stock, v.active, p.status FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1`,
    [variantId]
  );
  const variant = v.rows[0];
  if (!variant || !variant.active || variant.status !== "active") throw notFound("This piece is no longer available");
  if (variant.stock < 1) throw badRequest("This variant is sold out");

  const user = await authLib.currentUser(req);
  const cart = await cartLib.getOrCreateCart(req, res, { create: true, user });
  await db.query(
    `INSERT INTO cart_items (cart_id, variant_id, qty) VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, variant_id)
     DO UPDATE SET qty = LEAST(cart_items.qty + EXCLUDED.qty, $4)`,
    [cart.id, variantId, Math.min(qty, variant.stock), cartLib.MAX_QTY_PER_LINE]
  );
  await cartLib.touchCart(cart.id);
  json(res, 200, { ok: true, cart: await cartLib.cartPayload(cart) });
}

async function updateItem(req, res, params) {
  const itemId = cleanInt(params.id, { name: "item id", min: 1 });
  const qty = cleanInt((req.body || {}).qty, { name: "qty", min: 0, max: cartLib.MAX_QTY_PER_LINE });
  const cart = await cartLib.findCartByCookie(req);
  if (!cart) throw notFound("No bag yet");
  if (qty === 0) {
    await db.query("DELETE FROM cart_items WHERE id = $1 AND cart_id = $2", [itemId, cart.id]);
  } else {
    const r = await db.query(
      `UPDATE cart_items ci SET qty = LEAST($1, GREATEST(v.stock, 1))
         FROM variants v
        WHERE ci.id = $2 AND ci.cart_id = $3 AND v.id = ci.variant_id`,
      [qty, itemId, cart.id]
    );
    if (r.rowCount === 0) throw notFound("Item not in your bag");
  }
  await cartLib.touchCart(cart.id);
  json(res, 200, { ok: true, cart: await cartLib.cartPayload(cart) });
}

async function removeItem(req, res, params) {
  const itemId = cleanInt(params.id, { name: "item id", min: 1 });
  const cart = await cartLib.findCartByCookie(req);
  if (!cart) throw notFound("No bag yet");
  await db.query("DELETE FROM cart_items WHERE id = $1 AND cart_id = $2", [itemId, cart.id]);
  await cartLib.touchCart(cart.id);
  json(res, 200, { ok: true, cart: await cartLib.cartPayload(cart) });
}

/** Capture an email against the bag so it can be recovered if abandoned. */
async function captureEmail(req, res) {
  await rateLimit(`cartmail:${clientIp(req)}`, 20, 900);
  const email = cleanEmail((req.body || {}).email);
  const user = await authLib.currentUser(req);
  const cart = await cartLib.getOrCreateCart(req, res, { create: true, user });
  await db.query("UPDATE carts SET email = $1, updated_at = now() WHERE id = $2", [email, cart.id]);
  json(res, 200, { ok: true });
}

/** Open a recovery link: /cart?recover=TOKEN → this endpoint re-binds the cart
    to the visitor's browser and marks it recovered. */
async function recover(req, res) {
  await rateLimit(`recover:${clientIp(req)}`, 20, 900);
  const token = String((req.body || {}).token || "");
  if (!/^[a-f0-9]{64}$/.test(token)) throw badRequest("Invalid recovery link");
  const r = await db.query(
    "SELECT * FROM carts WHERE recovery_token = $1 AND status IN ('active','abandoned')",
    [token]
  );
  const cart = r.rows[0];
  if (!cart) throw notFound("This bag has expired or was already checked out");

  // Rotate the cookie token so the emailed link can't be replayed as a session.
  const newToken = randomToken();
  await db.query(
    "UPDATE carts SET token_hash = $1, status = 'active', recovered = true, updated_at = now() WHERE id = $2",
    [sha256(newToken), cart.id]
  );
  setCookie(req, res, cartLib.CART_COOKIE, newToken, cartLib.CART_DAYS * 86400);
  json(res, 200, { ok: true, cart: await cartLib.cartPayload({ ...cart, status: "active" }) });
}

module.exports = { get, addItem, updateItem, removeItem, captureEmail, recover };
