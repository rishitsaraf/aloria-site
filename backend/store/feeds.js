/* Product feeds for ad/shopping platforms.
   /feeds/products.xml — Google Merchant Center RSS 2.0 (g: namespace),
   one item per variant, grouped by item_group_id. Meta (Facebook/Instagram
   Shops) ingests the same Google format, and /feeds/meta.csv is provided
   for catalogs configured with CSV instead. */

const db = require("../lib/db");
const { siteUrl } = require("../lib/email");

const escXml = (s) => String(s == null ? "" : s)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

async function feedRows() {
  const r = await db.query(
    `SELECT p.slug, p.title, p.description, p.category, p.currency, p.images, p.price_cents AS base_cents,
            v.sku, v.options, COALESCE(v.price_cents, p.price_cents) AS price_cents, v.stock, v.image
       FROM products p JOIN variants v ON v.product_id = p.id
      WHERE p.status = 'active' AND v.active
      ORDER BY p.id, v.id`
  );
  return r.rows.map((row) => {
    const opts = row.options || {};
    const label = Object.values(opts).join(" · ");
    const colorBits = [opts["Plating"], opts["Stone Color"]].filter(Boolean);
    return {
      id: row.sku,
      groupId: row.slug,
      title: label ? `${row.title} — ${label}`.slice(0, 150) : row.title.slice(0, 150),
      description: (row.description || row.title).slice(0, 5000),
      link: siteUrl(`/shop/product?slug=${encodeURIComponent(row.slug)}`),
      image: row.image || (row.images || [])[0] || "",
      availability: row.stock > 0 ? "in_stock" : "out_of_stock",
      price: `${(row.price_cents / 100).toFixed(2)} ${row.currency}`,
      color: colorBits.join("/"),
      size: opts["Ring Size"] || opts["Length"] || opts["Width"] || "",
      category: row.category,
    };
  });
}

async function google(req, res) {
  const rows = await feedRows();
  const items = rows.map((i) => `  <item>
    <g:id>${escXml(i.id)}</g:id>
    <g:item_group_id>${escXml(i.groupId)}</g:item_group_id>
    <title>${escXml(i.title)}</title>
    <description>${escXml(i.description)}</description>
    <link>${escXml(i.link)}</link>
    ${i.image ? `<g:image_link>${escXml(siteUrl(i.image))}</g:image_link>` : ""}
    <g:availability>${i.availability}</g:availability>
    <g:price>${i.price}</g:price>
    <g:brand>Aloria</g:brand>
    <g:condition>new</g:condition>
    <g:material>925 sterling silver</g:material>
    ${i.color ? `<g:color>${escXml(i.color)}</g:color>` : ""}
    ${i.size ? `<g:size>${escXml(i.size)}</g:size>` : ""}
    <g:google_product_category>Apparel &amp; Accessories &gt; Jewelry</g:google_product_category>
  </item>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>ALORIA</title>
  <link>${escXml(siteUrl("/shop"))}</link>
  <description>Stackable, customisable fine jewellery</description>
${items}
</channel>
</rss>`;
  res.status(200);
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(xml);
}

async function metaCsv(req, res) {
  const rows = await feedRows();
  const csvCell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const header = ["id", "item_group_id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"];
  const lines = [header.join(",")];
  for (const i of rows) {
    lines.push([
      i.id, i.groupId, i.title, i.description, i.availability, "new", i.price,
      i.link, i.image ? siteUrl(i.image) : "", "Aloria",
    ].map(csvCell).join(","));
  }
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(lines.join("\n"));
}

module.exports = { google, metaCsv };
