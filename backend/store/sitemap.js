/* GET /sitemap.xml (rewritten to /api/store/sitemap) — storefront pages plus
   every active product. Hub/admin/account/checkout stay out by design. */

const db = require("../lib/db");
const { siteUrl } = require("../lib/email");

async function sitemap(req, res) {
  const r = await db.query(
    "SELECT slug, updated_at, category FROM products WHERE status = 'active' ORDER BY id"
  );
  const urls = [
    { loc: siteUrl("/shop"), priority: "1.0" },
    { loc: siteUrl("/shop?category=ear"), priority: "0.8" },
    { loc: siteUrl("/shop?category=neck"), priority: "0.8" },
    { loc: siteUrl("/shop?category=rings"), priority: "0.8" },
    ...r.rows.map((p) => ({
      loc: siteUrl(`/shop/product?slug=${encodeURIComponent(p.slug)}`),
      lastmod: new Date(p.updated_at).toISOString().slice(0, 10),
      priority: "0.7",
    })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc.replace(/&/g, "&amp;")}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority></url>`).join("\n")}
</urlset>`;
  res.status(200);
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(xml);
}

async function robots(req, res) {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /hub",
    "Disallow: /data",
    "Disallow: /admin",
    "Disallow: /account",
    "Disallow: /cart",
    "Disallow: /checkout",
    "Disallow: /api",
    "",
    `Sitemap: ${siteUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
  res.status(200);
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end(body);
}

module.exports = { sitemap, robots };
