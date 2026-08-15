/* CMS content & configuration: store settings (shipping/tax/abandoned
   timing), storefront content blocks (hero/tiles/announcement), static
   pages, and collections. */

const db = require("../lib/db");
const settings = require("../lib/settings");
const { json, badRequest, notFound, cleanInt, cleanString, slugify } = require("../lib/http");

/* ---------- settings ---------- */

async function getSettings(req, res) {
  json(res, 200, {
    settings: await settings.getAll(),
    integrations: {
      stripe: Boolean(process.env.STRIPE_SECRET_KEY),
      resend: Boolean(process.env.RESEND_API_KEY),
      blob: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      cronSecret: Boolean(process.env.CRON_SECRET),
    },
  });
}

async function putSettings(req, res) {
  const body = (req.body || {}).settings || {};
  const patch = {};
  const intKeys = ["shipping.flat_cents", "shipping.free_threshold_cents", "abandoned.minutes", "abandoned.second_reminder_hours"];
  for (const key of intKeys) {
    if (body[key] !== undefined) patch[key] = cleanInt(body[key], { name: key, min: 0, max: 10_000_000 });
  }
  if (body["tax.default_pct"] !== undefined) {
    const pct = Number(body["tax.default_pct"]);
    if (!Number.isFinite(pct) || pct < 0 || pct > 60) throw badRequest("tax.default_pct must be 0–60");
    patch["tax.default_pct"] = pct;
  }
  if (body["tax.by_country"] !== undefined) {
    const raw = body["tax.by_country"];
    if (typeof raw !== "object" || Array.isArray(raw)) throw badRequest("tax.by_country must be an object like {\"GB\": 20}");
    const clean = {};
    for (const [country, pct] of Object.entries(raw)) {
      const cc = String(country).toUpperCase();
      const n = Number(pct);
      if (!/^[A-Z]{2}$/.test(cc) || !Number.isFinite(n) || n < 0 || n > 60) throw badRequest(`Bad tax entry: ${country}`);
      clean[cc] = n;
    }
    patch["tax.by_country"] = clean;
  }
  if (!Object.keys(patch).length) throw badRequest("Nothing to update");
  await settings.put(patch);
  json(res, 200, { ok: true, settings: await settings.getAll() });
}

/* ---------- content blocks ---------- */

async function putContent(req, res) {
  const body = req.body || {};
  const patch = {};
  if (body.announcement !== undefined) {
    patch["content.announcement"] = {
      text: cleanString((body.announcement || {}).text, { name: "Announcement", max: 160 }),
      enabled: Boolean((body.announcement || {}).enabled),
    };
  }
  if (body.hero !== undefined) {
    patch["content.hero"] = {
      title: cleanString((body.hero || {}).title, { name: "Hero title", max: 120, required: true }),
      tagline: cleanString((body.hero || {}).tagline, { name: "Hero tagline", max: 160 }),
      image: cleanString((body.hero || {}).image, { name: "Hero image", max: 500 }),
    };
  }
  if (body.tiles !== undefined) {
    if (!Array.isArray(body.tiles) || body.tiles.length !== 3) throw badRequest("tiles must be an array of 3");
    patch["content.tiles"] = body.tiles.map((t) => ({
      category: ["ear", "neck", "rings"].includes(t.category) ? t.category : "ear",
      image: cleanString(t.image, { name: "Tile image", max: 500 }),
    }));
  }
  if (!Object.keys(patch).length) throw badRequest("Nothing to update");
  await settings.put(patch);
  json(res, 200, { ok: true });
}

/* ---------- pages ---------- */

async function listPages(req, res) {
  const r = await db.query("SELECT id, slug, title, published, updated_at FROM pages ORDER BY id");
  json(res, 200, { pages: r.rows });
}

async function getPage(req, res, params) {
  const id = cleanInt(params.id, { name: "page id", min: 1 });
  const r = await db.query("SELECT * FROM pages WHERE id = $1", [id]);
  if (!r.rows.length) throw notFound("Page not found");
  json(res, 200, { page: r.rows[0] });
}

async function createPage(req, res) {
  const body = req.body || {};
  const title = cleanString(body.title, { name: "Title", max: 140, required: true });
  let slug = slugify(body.slug || title);
  const clash = await db.query("SELECT 1 FROM pages WHERE slug = $1", [slug]);
  if (clash.rows.length) slug = `${slug}-${Date.now().toString(36)}`;
  const r = await db.query(
    "INSERT INTO pages (slug, title, body, published) VALUES ($1,$2,$3,$4) RETURNING *",
    [slug, title, cleanString(body.body, { name: "Body", max: 50000 }), Boolean(body.published)]
  );
  json(res, 201, { page: r.rows[0] });
}

async function updatePage(req, res, params) {
  const id = cleanInt(params.id, { name: "page id", min: 1 });
  const body = req.body || {};
  const fields = {};
  if (body.title !== undefined) fields.title = cleanString(body.title, { name: "Title", max: 140, required: true });
  if (body.slug !== undefined) {
    const slug = slugify(body.slug);
    const clash = await db.query("SELECT 1 FROM pages WHERE slug = $1 AND id <> $2", [slug, id]);
    if (clash.rows.length) throw badRequest("That slug is already in use");
    fields.slug = slug;
  }
  if (body.body !== undefined) fields.body = cleanString(body.body, { name: "Body", max: 50000 });
  if (body.published !== undefined) fields.published = Boolean(body.published);
  if (!Object.keys(fields).length) throw badRequest("Nothing to update");
  const cols = Object.keys(fields);
  const r = await db.query(
    `UPDATE pages SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, ...cols.map((c) => fields[c])]
  );
  if (!r.rows.length) throw notFound("Page not found");
  json(res, 200, { page: r.rows[0] });
}

async function deletePage(req, res, params) {
  const id = cleanInt(params.id, { name: "page id", min: 1 });
  await db.query("DELETE FROM pages WHERE id = $1", [id]);
  json(res, 200, { ok: true });
}

/* ---------- collections ---------- */

async function listCollections(req, res) {
  const r = await db.query(
    `SELECT c.*, COALESCE(json_agg(pc.product_id) FILTER (WHERE pc.product_id IS NOT NULL), '[]') AS product_ids
       FROM collections c LEFT JOIN product_collections pc ON pc.collection_id = c.id
      GROUP BY c.id ORDER BY c.id`
  );
  json(res, 200, { collections: r.rows });
}

async function createCollection(req, res) {
  const body = req.body || {};
  const title = cleanString(body.title, { name: "Title", max: 140, required: true });
  let slug = slugify(body.slug || title);
  const clash = await db.query("SELECT 1 FROM collections WHERE slug = $1", [slug]);
  if (clash.rows.length) slug = `${slug}-${Date.now().toString(36)}`;
  const r = await db.query(
    "INSERT INTO collections (slug, title, description, image) VALUES ($1,$2,$3,$4) RETURNING *",
    [slug, title, cleanString(body.description, { max: 1000 }), cleanString(body.image, { max: 500 }) || null]
  );
  json(res, 201, { collection: r.rows[0] });
}

async function updateCollection(req, res, params) {
  const id = cleanInt(params.id, { name: "collection id", min: 1 });
  const body = req.body || {};
  const exists = await db.query("SELECT id FROM collections WHERE id = $1", [id]);
  if (!exists.rows.length) throw notFound("Collection not found");
  if (body.title !== undefined || body.description !== undefined || body.image !== undefined) {
    await db.query(
      `UPDATE collections SET
         title = COALESCE($2, title),
         description = COALESCE($3, description),
         image = COALESCE($4, image)
       WHERE id = $1`,
      [id,
       body.title === undefined ? null : cleanString(body.title, { name: "Title", max: 140, required: true }),
       body.description === undefined ? null : cleanString(body.description, { max: 1000 }),
       body.image === undefined ? null : (cleanString(body.image, { max: 500 }) || null)]
    );
  }
  if (Array.isArray(body.productIds)) {
    const ids = body.productIds.slice(0, 500).map((i) => cleanInt(i, { name: "productId", min: 1 }));
    await db.tx(async (client) => {
      await client.query("DELETE FROM product_collections WHERE collection_id = $1", [id]);
      for (const pid of ids) {
        await client.query(
          "INSERT INTO product_collections (product_id, collection_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [pid, id]
        );
      }
    });
  }
  json(res, 200, { ok: true });
}

async function deleteCollection(req, res, params) {
  const id = cleanInt(params.id, { name: "collection id", min: 1 });
  await db.query("DELETE FROM collections WHERE id = $1", [id]);
  json(res, 200, { ok: true });
}

module.exports = {
  getSettings, putSettings, putContent,
  listPages, getPage, createPage, updatePage, deletePage,
  listCollections, createCollection, updateCollection, deleteCollection,
};
