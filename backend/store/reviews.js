/* Reviews & ratings.
   Public: read approved reviews per product (with the aggregate the PDP and
   its schema.org markup need); submit a review into the moderation queue.
   "Verified" is earned, never claimed — we check the author actually has a
   paid/fulfilled order containing the product.
   CMS: moderation queue (approve / reject / reply / delete). */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const {
  json, badRequest, notFound, cleanEmail, cleanInt, cleanString,
  rateLimit, clientIp, HttpError,
} = require("../lib/http");

const MAX_PER_PRODUCT = 50;

async function productBySlug(slug) {
  const r = await db.query("SELECT id, slug, title FROM products WHERE slug = $1 AND status = 'active'", [slug]);
  if (!r.rows[0]) throw notFound("Product not found");
  return r.rows[0];
}

async function summaryFor(productId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS count, COALESCE(AVG(rating), 0)::numeric(3,2) AS avg,
            COUNT(*) FILTER (WHERE rating = 5)::int AS r5, COUNT(*) FILTER (WHERE rating = 4)::int AS r4,
            COUNT(*) FILTER (WHERE rating = 3)::int AS r3, COUNT(*) FILTER (WHERE rating = 2)::int AS r2,
            COUNT(*) FILTER (WHERE rating = 1)::int AS r1
       FROM reviews WHERE product_id = $1 AND status = 'approved'`,
    [productId]
  );
  const s = r.rows[0];
  return {
    count: s.count,
    avg: Number(s.avg),
    histogram: { 5: s.r5, 4: s.r4, 3: s.r3, 2: s.r2, 1: s.r1 },
  };
}

/** GET products/:slug/reviews — approved reviews + aggregate. */
async function listForProduct(req, res, params) {
  const p = await productBySlug(params.slug);
  const r = await db.query(
    `SELECT id, author_name, rating, title, body, verified, reply, created_at
       FROM reviews WHERE product_id = $1 AND status = 'approved'
      ORDER BY created_at DESC LIMIT $2`,
    [p.id, MAX_PER_PRODUCT]
  );
  json(res, 200, {
    summary: await summaryFor(p.id),
    reviews: r.rows.map((x) => ({
      id: x.id,
      author: x.author_name,
      rating: x.rating,
      title: x.title,
      body: x.body,
      verified: x.verified,
      reply: x.reply,
      createdAt: x.created_at,
    })),
  });
}

/** Did this person actually buy the product? (paid or fulfilled order) */
async function hasPurchased(productId, userId, email) {
  const r = await db.query(
    `SELECT 1 FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN variants v ON v.id = oi.variant_id
      WHERE v.product_id = $1 AND o.status IN ('paid', 'fulfilled')
        AND (($2::bigint IS NOT NULL AND o.user_id = $2) OR lower(o.email) = lower($3))
      LIMIT 1`,
    [productId, userId, email || ""]
  );
  return r.rows.length > 0;
}

/** POST products/:slug/reviews — into the moderation queue. */
async function create(req, res, params) {
  await rateLimit(`review:${clientIp(req)}`, 10, 3600);
  const p = await productBySlug(params.slug);
  const body = req.body || {};
  const user = await authLib.currentUser(req).catch(() => null);

  const rating = cleanInt(body.rating, { name: "rating", min: 1, max: 5 });
  const author = cleanString(body.name || (user && user.name), { name: "name", max: 80, required: true });
  const email = user ? user.email : cleanEmail(body.email);
  const title = cleanString(body.title, { name: "title", max: 120 });
  const text = cleanString(body.body, { name: "review", max: 2000, required: true });

  const dup = await db.query(
    "SELECT 1 FROM reviews WHERE product_id = $1 AND lower(email) = lower($2) AND status <> 'rejected'",
    [p.id, email]
  );
  if (dup.rows.length) throw new HttpError(409, "You've already reviewed this piece");

  const verified = await hasPurchased(p.id, user ? user.id : null, email);
  await db.query(
    `INSERT INTO reviews (product_id, user_id, author_name, email, rating, title, body, verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.id, user ? user.id : null, author, email, rating, title, text, verified]
  );
  json(res, 200, { ok: true, pending: true, verified });
}

/* ---------------- CMS moderation ---------------- */

const ADMIN_STATUSES = ["pending", "approved", "rejected"];

/** GET admin/reviews?status= — the moderation queue. */
async function adminList(req, res) {
  const q = req.query || {};
  const status = ADMIN_STATUSES.includes(q.status) ? q.status : null;
  const params = [];
  let where = "TRUE";
  if (status) { params.push(status); where = `r.status = $${params.length}`; }
  const r = await db.query(
    `SELECT r.*, p.title AS product_title, p.slug AS product_slug
       FROM reviews r JOIN products p ON p.id = r.product_id
      WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`,
    params
  );
  const counts = await db.query("SELECT status, COUNT(*)::int AS n FROM reviews GROUP BY status");
  json(res, 200, {
    reviews: r.rows.map((x) => ({
      id: x.id,
      productTitle: x.product_title,
      productSlug: x.product_slug,
      author: x.author_name,
      email: x.email,
      rating: x.rating,
      title: x.title,
      body: x.body,
      verified: x.verified,
      status: x.status,
      reply: x.reply,
      createdAt: x.created_at,
    })),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
  });
}

/** PATCH admin/reviews/:id — {status} and/or {reply}. */
async function adminUpdate(req, res, params) {
  const id = cleanInt(params.id, { name: "id", min: 1 });
  const body = req.body || {};
  const sets = [];
  const vals = [];
  if (body.status !== undefined) {
    if (!ADMIN_STATUSES.includes(body.status)) throw badRequest("Bad status");
    vals.push(body.status);
    sets.push(`status = $${vals.length}`);
  }
  if (body.reply !== undefined) {
    vals.push(cleanString(body.reply, { name: "reply", max: 1000 }));
    sets.push(`reply = $${vals.length}`);
  }
  if (!sets.length) throw badRequest("Nothing to update");
  vals.push(id);
  const r = await db.query(`UPDATE reviews SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id, status, reply`, vals);
  if (!r.rows[0]) throw notFound("Review not found");
  json(res, 200, { ok: true, review: r.rows[0] });
}

/** DELETE admin/reviews/:id */
async function adminDelete(req, res, params) {
  const id = cleanInt(params.id, { name: "id", min: 1 });
  const r = await db.query("DELETE FROM reviews WHERE id = $1 RETURNING id", [id]);
  if (!r.rows[0]) throw notFound("Review not found");
  json(res, 200, { ok: true });
}

module.exports = { listForProduct, create, adminList, adminUpdate, adminDelete, summaryFor };
