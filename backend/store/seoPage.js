/* Server-rendered SEO for the product page.
   /shop/product is rewritten to this handler (vercel.json + dev server): it
   serves the static PDP template with the head filled in server-side —
   title, meta description, canonical, Open Graph, and 2026-grade schema.org
   markup (Product with AggregateRating, OfferShippingDetails and
   MerchantReturnPolicy, plus a BreadcrumbList). The client script detects
   the injected JSON-LD and skips its own fallback injection. */

const fs = require("fs");
const path = require("path");
const db = require("../lib/db");
const settings = require("../lib/settings");
const reviewsLib = require("./reviews");
const { siteUrl } = require("../lib/email");

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "frontend", "shop", "product-page.html");
let template = null;
const loadTemplate = () => template || (template = fs.readFileSync(TEMPLATE_PATH, "utf8"));

const esc = (s) => String(s == null ? "" : s)
  .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CAT_NAMES = { ear: "Ear", neck: "Neck", rings: "Rings" };

async function productPage(req, res) {
  const slug = String((req.query || {}).slug || "").slice(0, 120);
  let head = "";
  let status = 200;

  try {
    const r = slug
      ? await db.query("SELECT * FROM products WHERE slug = $1 AND status = 'active'", [slug])
      : { rows: [] };
    const p = r.rows[0];
    if (p) {
      const vr = await db.query(
        `SELECT COALESCE(price_cents, $2) AS price_cents, stock FROM variants WHERE product_id = $1 AND active`,
        [p.id, p.price_cents]
      );
      const rating = await reviewsLib.summaryFor(p.id);
      const flatShip = await settings.get("shipping.flat_cents");
      head = buildHead(p, vr.rows, rating, flatShip);
    } else {
      status = 404;
      head = '<meta name="robots" content="noindex">';
    }
  } catch (e) {
    // DB down → serve the template plain; the client renders as before
    console.error("[seoPage]", e.message);
  }

  let html = loadTemplate();
  if (head) {
    const title = /<title>([^<]*)<\/title>/.exec(head);
    if (title) {
      html = html.replace(/<title>[^<]*<\/title>/, title[0]);
      head = head.replace(title[0], "");
    }
    html = html.replace("</head>", `${head}\n</head>`);
  }
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
  res.end(html);
}

function buildHead(p, variants, rating, flatShipCents) {
  const title = p.seo_title || `${p.title} — ALORIA`;
  const description = (p.seo_description || `${p.subtitle}. ${p.description}`).slice(0, 155);
  const canonical = siteUrl(`/shop/product?slug=${encodeURIComponent(p.slug)}`);
  const images = (p.images || []).map((i) => siteUrl(i));
  const prices = variants.length ? variants.map((v) => v.price_cents / 100) : [p.price_cents / 100];
  const inStock = variants.some((v) => v.stock > 0);

  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.title,
    description: p.description,
    image: images,
    sku: p.slug,
    brand: { "@type": "Brand", name: "Aloria" },
    ...(rating.count > 0 ? {
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: rating.avg.toFixed(1),
        reviewCount: rating.count,
        bestRating: 5,
      },
    } : {}),
    offers: {
      "@type": "AggregateOffer",
      url: canonical,
      priceCurrency: p.currency,
      lowPrice: Math.min(...prices).toFixed(2),
      highPrice: Math.max(...prices).toFixed(2),
      offerCount: variants.length || 1,
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      shippingDetails: {
        "@type": "OfferShippingDetails",
        shippingRate: {
          "@type": "MonetaryAmount",
          value: ((flatShipCents || 0) / 100).toFixed(2),
          currency: p.currency,
        },
        shippingDestination: { "@type": "DefinedRegion", addressCountry: "US" },
        deliveryTime: {
          "@type": "ShippingDeliveryTime",
          handlingTime: { "@type": "QuantitativeValue", minValue: 1, maxValue: 2, unitCode: "DAY" },
          transitTime: { "@type": "QuantitativeValue", minValue: 3, maxValue: 8, unitCode: "DAY" },
        },
      },
      hasMerchantReturnPolicy: {
        "@type": "MerchantReturnPolicy",
        applicableCountry: "US",
        returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
        merchantReturnDays: 30,
        returnMethod: "https://schema.org/ReturnByMail",
        returnFees: "https://schema.org/FreeReturn",
      },
    },
  };

  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Shop", item: siteUrl("/shop") },
      { "@type": "ListItem", position: 2, name: CAT_NAMES[p.category] || "Shop", item: siteUrl(`/shop?category=${p.category}`) },
      { "@type": "ListItem", position: 3, name: p.title, item: canonical },
    ],
  };

  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    images[0] ? `<meta property="og:image" content="${esc(images[0])}">` : "",
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<script type="application/ld+json">${JSON.stringify(product)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(crumbs)}</script>`,
  ].filter(Boolean).join("\n");
}

module.exports = { productPage };
