/* /api/store/products — the public catalog.
   Only active products are visible; variant stock is exposed as a coarse
   availability signal, exact counts stay in the CMS. */

const db = require("../lib/db");
const reviewsLib = require("./reviews");
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
    ratingAvg: Number(p.rating_avg) || 0,
    ratingCount: Number(p.rating_count) || 0,
  };
}

/* Faceted navigation: a facet narrows to products with at least one active
   variant matching EVERY selected axis value — "is this piece made in
   Gold + Emerald + Round?" — not merely one variant per facet. */
const FACET_AXES = [
  ["plating", "Plating"],
  ["stone", "Stone Color"],
  ["shape", "Stone Shape"],
];

const SORTS = {
  featured: "p.featured DESC, p.category, p.id",
  newest: "p.created_at DESC, p.id DESC",
  price_asc: "price_from_cents ASC, p.id",
  price_desc: "price_from_cents DESC, p.id",
  rating: "rv.rating_avg DESC NULLS LAST, rv.rating_count DESC NULLS LAST, p.id",
};

async function list(req, res) {
  const q = req.query || {};
  const category = ["ear", "neck", "rings"].includes(q.category) ? q.category : null;
  const search = cleanString(q.q, { max: 100 });
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const params = [];
  let where = "p.status = 'active'";
  if (category) { params.push(category); where += ` AND p.category = $${params.length}`; }
  if (search) { params.push(`%${search}%`); where += ` AND (p.title ILIKE $${params.length} OR p.subtitle ILIKE $${params.length} OR p.description ILIKE $${params.length})`; }
  const slugs = cleanString(q.slugs, { max: 1500 });
  if (slugs) {
    params.push(slugs.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12));
    where += ` AND p.slug = ANY($${params.length})`;
  }
  const collection = cleanString(q.collection, { max: 80 });
  if (collection) {
    params.push(collection);
    where += ` AND EXISTS (SELECT 1 FROM product_collections pc JOIN collections c ON c.id = pc.collection_id
                            WHERE pc.product_id = p.id AND c.slug = $${params.length})`;
  }

  const facetConds = [];
  for (const [param, optionName] of FACET_AXES) {
    const val = cleanString(q[param], { max: 40 });
    if (!val) continue;
    params.push(optionName);
    const ki = params.length;
    params.push(val);
    facetConds.push(`vf.options->>$${ki} = $${params.length}`);
  }
  if (facetConds.length) {
    where += ` AND EXISTS (SELECT 1 FROM variants vf WHERE vf.product_id = p.id AND vf.active AND ${facetConds.join(" AND ")})`;
  }

  const priceExpr = "COALESCE(MIN(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents)";
  const havings = [];
  const pmin = parseInt(q.pmin, 10);
  const pmax = parseInt(q.pmax, 10);
  if (Number.isInteger(pmin) && pmin >= 0) { params.push(pmin); havings.push(`${priceExpr} >= $${params.length}`); }
  if (Number.isInteger(pmax) && pmax > 0) { params.push(pmax); havings.push(`${priceExpr} <= $${params.length}`); }

  const orderBy = SORTS[q.sort] || SORTS.featured;

  params.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const r = await db.query(
    `SELECT p.slug, p.title, p.subtitle, p.category, p.currency, p.images, p.featured,
            ${priceExpr} AS price_from_cents,
            COALESCE(MAX(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents) AS price_to_cents,
            COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0)::int AS total_stock,
            rv.rating_avg, rv.rating_count,
            COUNT(*) OVER () AS total_rows
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
       LEFT JOIN (SELECT product_id, AVG(rating)::numeric(3,2) AS rating_avg, COUNT(*)::int AS rating_count
                    FROM reviews WHERE status = 'approved' GROUP BY product_id) rv ON rv.product_id = p.id
      WHERE ${where}
      GROUP BY p.id, rv.rating_avg, rv.rating_count
      ${havings.length ? `HAVING ${havings.join(" AND ")}` : ""}
      ORDER BY ${orderBy}
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
      videoUrl: p.video_url || "",
      seoTitle: p.seo_title || "",
      seoDescription: p.seo_description || "",
      rating: await reviewsLib.summaryFor(p.id),
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

/* "Complete the stack": a stack mixes categories, so recommendations lead
   with pieces from the OTHER categories (in stock, featured first) and only
   then fall back to siblings. */
async function related(req, res, params) {
  const pr = await db.query("SELECT id, category FROM products WHERE slug = $1 AND status = 'active'", [params.slug]);
  const p = pr.rows[0];
  if (!p) throw notFound("Product not found");
  const r = await db.query(
    `SELECT p.slug, p.title, p.subtitle, p.category, p.currency, p.images,
            COALESCE(MIN(COALESCE(v.price_cents, p.price_cents)) FILTER (WHERE v.active), p.price_cents) AS price_from_cents,
            COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0)::int AS total_stock
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
      WHERE p.status = 'active' AND p.id <> $1
      GROUP BY p.id
      ORDER BY (p.category = $2)::int ASC,
               (COALESCE(SUM(v.stock) FILTER (WHERE v.active), 0) > 0)::int DESC,
               p.featured DESC, p.id
      LIMIT 4`,
    [p.id, p.category]
  );
  json(res, 200, {
    products: r.rows.map((x) => ({
      slug: x.slug,
      title: x.title,
      subtitle: x.subtitle,
      category: x.category,
      currency: x.currency,
      image: (x.images || [])[0] || null,
      priceFromCents: x.price_from_cents,
      inStock: x.total_stock > 0,
    })),
  });
}

module.exports = { list, detail, related };
