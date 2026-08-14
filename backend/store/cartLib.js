/* Cart core shared by cart routes, auth and checkout.
   Guest carts hang off an HttpOnly cookie holding a random token (only its
   sha256 is stored). Signing in attaches the cart to the account and captures
   the email for abandoned-cart recovery. */

const db = require("../lib/db");
const { parseCookies, setCookie, randomToken, sha256 } = require("../lib/http");

const CART_COOKIE = "aloria_cart";
const CART_DAYS = 90;
const MAX_QTY_PER_LINE = 10;

async function findCartByCookie(req) {
  const token = parseCookies(req)[CART_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const r = await db.query(
    "SELECT * FROM carts WHERE token_hash = $1 AND status IN ('active','abandoned')",
    [sha256(token)]
  );
  return r.rows[0] || null;
}

/** Resolve the visitor's cart; optionally create one (sets the cookie). */
async function getOrCreateCart(req, res, { create = false, user = null } = {}) {
  let cart = await findCartByCookie(req);
  if (!cart && create) {
    const token = randomToken();
    const r = await db.query(
      "INSERT INTO carts (token_hash, user_id, email) VALUES ($1, $2, $3) RETURNING *",
      [sha256(token), user ? user.id : null, user ? user.email : null]
    );
    cart = r.rows[0];
    setCookie(req, res, CART_COOKIE, token, CART_DAYS * 86400);
  }
  return cart;
}

/** After login/register: bind the cookie cart to the account. */
async function attachCartToUser(req, user) {
  const cart = await findCartByCookie(req);
  if (cart && (!cart.user_id || cart.user_id === user.id)) {
    await db.query(
      "UPDATE carts SET user_id = $1, email = COALESCE(email, $2), updated_at = now() WHERE id = $3",
      [user.id, user.email, cart.id]
    );
  }
}

/** Any interaction revives an abandoned cart and refreshes its timer. */
async function touchCart(cartId) {
  await db.query(
    "UPDATE carts SET updated_at = now(), status = 'active' WHERE id = $1 AND status IN ('active','abandoned')",
    [cartId]
  );
}

/** Full cart payload with live prices/stock — prices always come from the DB. */
async function cartPayload(cart) {
  if (!cart) return { id: null, email: null, currency: "USD", items: [], subtotalCents: 0, count: 0 };
  const r = await db.query(
    `SELECT ci.id, ci.qty, v.id AS variant_id, v.sku, v.options, v.image AS v_image, v.stock, v.active,
            COALESCE(v.price_cents, p.price_cents) AS unit_cents,
            p.title, p.slug, p.status AS product_status, p.images, p.currency
       FROM cart_items ci
       JOIN variants v ON v.id = ci.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE ci.cart_id = $1
      ORDER BY ci.id`,
    [cart.id]
  );
  const items = r.rows.map((row) => {
    const purchasable = row.active && row.product_status === "active";
    const qty = Math.min(row.qty, MAX_QTY_PER_LINE);
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: row.sku,
      title: row.title,
      productSlug: row.slug,
      variantLabel: Object.values(row.options || {}).join(" · "),
      image: row.v_image || (row.images || [])[0] || null,
      unitCents: row.unit_cents,
      qty,
      lineCents: purchasable ? row.unit_cents * qty : 0,
      stock: row.stock,
      purchasable,
    };
  });
  const live = items.filter((i) => i.purchasable);
  return {
    id: cart.id,
    email: cart.email,
    currency: cart.currency,
    items,
    subtotalCents: live.reduce((s, i) => s + i.lineCents, 0),
    count: live.reduce((s, i) => s + i.qty, 0),
  };
}

module.exports = {
  CART_COOKIE, CART_DAYS, MAX_QTY_PER_LINE,
  findCartByCookie, getOrCreateCart, attachCartToUser, touchCart, cartPayload,
};
