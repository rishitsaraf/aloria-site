/* /api/store/products — the public catalog.
   Only active products are visible; variant stock is exposed as a coarse
   availability signal, exact counts stay in the CMS. */

const db = require("../lib/db");
const { json, notFound, cleanString } = require("../lib/http");

const PAGE_SIZE = 24;

function shapeCard(p) {
  return {
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle,
    category: p.category,
    priceFromCents: p.price_from_cents,
    priceToCents: p.price_to_cents,
    currency: p.currency,
    image: (p.images || [])[0] || null,
    hoverImage: (p.images || [])[1] || null,
    featured: p.featured,
    inStock: p.total_stock > 0,
  };
}

async function list(req, res) {
  const q = req.query || {};
  const category = ["ear", "neck", "rings"].includes(q.category) ? q.category : null;
  const search = cleanString(q.q, { max: 100 });
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const params = [];
  let where = "p.status = 'active'";
  if (category) { params.push(category); where += ` AND p.category = $${params.length}`; }
  if (search) { params.push(`%${search}%`); where += ` AND (p.title ILIKE $${params.length} OR p.subtitle ILIKE $${params.length} OR p.description ILIKE $${params.length})`; }

  params.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const r = await db.query(
    `SELECT p.slug, p.title, p.subtitle, p.category, p.currency, p.images, p.featured,
            COALESCE(MIN(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents) AS price_from_cents,
            COALESCE(MAX(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents) AS price_to_cents,
            COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0)::int AS total_stock,
            COUNT(*) OVER () AS total_rows
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
      WHERE ${where}
      GROUP BY p.id
      ORDER BY p.featured DESC, p.category, p.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = r.rows.length ? Number(r.rows[0].total_rows) : 0;
  json(res, 200, {
    products: r.rows.map(shapeCard),
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    total,
  });
}

async function detail(req, res, params) {
  const r = await db.query("SELECT * FROM products WHERE slug = $1 AND status = 'active'", [params.slug]);
  const p = r.rows[0];
  if (!p) throw notFound("Product not found");
  const vr = await db.query(
    `SELECT id, sku, options, COALESCE(price_cents, $2) AS price_cents, compare_at_cents, stock, image
       FROM variants WHERE product_id = $1 AND active ORDER BY id`,
    [p.id, p.price_cents]
  );
  json(res, 200, {
    product: {
      slug: p.slug,
      title: p.title,
      subtitle: p.subtitle,
      description: p.description,
      category: p.category,
      currency: p.currency,
      images: p.images || [],
      options: p.options || [],
      tags: p.tags || [],
      variants: vr.rows.map((v) => ({
        id: v.id,
        sku: v.sku,
        options: v.options || {},
        priceCents: v.price_cents,
        compareAtCents: v.compare_at_cents,
        image: v.image,
        available: v.stock > 0,
        lowStock: v.stock > 0 && v.stock <= 3,
      })),
    },
  });
}

module.exports = { list, detail };
