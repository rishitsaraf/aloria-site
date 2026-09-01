/* Public site content — everything the storefront reads that the CMS edits:
   announcement bar, landing hero + category tiles, collections, and pages. */

const db = require("../lib/db");
const settings = require("../lib/settings");
const { json, notFound, cleanString } = require("../lib/http");

/** One round-trip for the storefront shell: bar + hero + tiles + collections
    + published page links for the footer. */
async function content(req, res) {
  const [announcement, hero, tiles, shipFlat, shipFree, collections, pages] = await Promise.all([
    settings.get("content.announcement"),
    settings.get("content.hero"),
    settings.get("content.tiles"),
    settings.get("shipping.flat_cents"),
    settings.get("shipping.free_threshold_cents"),
    db.query(
      `SELECT c.slug, c.title, c.image, COUNT(pc.product_id)::int AS products
         FROM collections c LEFT JOIN product_collections pc ON pc.collection_id = c.id
        GROUP BY c.id HAVING COUNT(pc.product_id) > 0 ORDER BY c.id`
    ),
    db.query("SELECT slug, title FROM pages WHERE published ORDER BY id LIMIT 12"),
  ]);
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.status(200).json({
    announcement,
    hero,
    tiles,
    shipping: { flatCents: shipFlat, freeThresholdCents: shipFree },
    integrations: {
      plausibleDomain: process.env.PLAUSIBLE_DOMAIN || "",   // analytics: set to enable
      turnstileSiteKey: require("../lib/captcha").siteKey(), // captcha: set to enable
    },
    collections: collections.rows,
    pages: pages.rows,
  });
}

async function pageDetail(req, res, params) {
  const slug = cleanString(params.slug, { max: 80, required: true });
  const r = await db.query("SELECT slug, title, body, updated_at FROM pages WHERE slug = $1 AND published", [slug]);
  if (!r.rows.length) throw notFound("Page not found");
  json(res, 200, { page: r.rows[0] });
}

module.exports = { content, pageDetail };
