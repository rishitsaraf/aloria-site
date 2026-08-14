/* POST /api/store/admin/seed — provisions the launch catalog from the Aloria
   brand system (2 platings × 5 stone shapes × 4 stone colors, matching
   frontend/data/skus.json). Idempotent: refuses to run if products exist
   unless {force:true}, and force only adds missing slugs — it never deletes. */

const db = require("../lib/db");
const { json, badRequest } = require("../lib/http");

const PLATINGS = ["Gold", "Rhodium"];
const SHAPES = ["Round", "Oval", "Pear", "Emerald Cut", "Heart"];
const COLORS = ["Crystal", "Emerald", "Sapphire", "Ruby"];

const CODE = {
  Gold: "GLD", Rhodium: "RHD",
  Round: "RND", Oval: "OVL", Pear: "PER", "Emerald Cut": "EMC", Heart: "HRT",
  Crystal: "CRY", Emerald: "EMD", Sapphire: "SAP", Ruby: "RBY",
  Plain: "PLN", "Pavé": "PAV", Short: "SHT", Long: "LNG", Thin: "THN", Wide: "WDE",
};

const FULL_MATRIX = [
  { name: "Plating", values: PLATINGS },
  { name: "Stone Shape", values: SHAPES },
  { name: "Stone Color", values: COLORS },
];

const CATALOG = [
  {
    slug: "primary-stem-stud", code: "E1", category: "ear", price: 5800, featured: true,
    title: "Primary Stem Stud", subtitle: "The anchor of every ear stack",
    description: "The base piercing of the Aloria system. A fixed stone in a minimal prong setting on a 925 silver post — every other ear component threads, clips or cuffs onto it.",
    options: FULL_MATRIX,
    images: ["/assets/img/components/e1_emerald-stud.webp", "/assets/img/worn/ear/ear_worn_01.webp", "/assets/img/worn/ear/ear_worn_02.webp"],
  },
  {
    slug: "press-on-ear-cuff", code: "E2", category: "ear", price: 6400, featured: true,
    title: "Press-On Ear Cuff", subtitle: "The look of a second piercing — without one",
    description: "A sculpted cuff with an embedded focal stone that presses gently onto the ear. Stack it above the Stem Stud for a curated piercing look, no needle required.",
    options: FULL_MATRIX,
    images: ["/assets/img/components/e2_ear-cuff.webp", "/assets/img/worn/ear/ear_worn_03.webp", "/assets/img/worn/ear/ear_worn_04.webp"],
  },
  {
    slug: "detachable-drop-charm", code: "E3", category: "ear", price: 4800,
    title: "Detachable Drop Charm", subtitle: "Swap the story behind your ear",
    description: "A key-loop stone drop that hangs behind the ear from a stud post, or clips onto any hoop. Interchangeable in seconds.",
    options: FULL_MATRIX,
    images: ["/assets/img/components/e3_drop-charm-pear.webp", "/assets/img/components/e3_drop-charm-baguette.webp", "/assets/img/worn/ear/ear_worn_05.webp"],
  },
  {
    slug: "orbit-hoop-jacket", code: "E4", category: "ear", price: 7200,
    title: "Orbit Hoop Jacket", subtitle: "A halo that orbits below the lobe",
    description: "A semi-circle halo that attaches to the back of the Stem Stud post and drops below the lobe. Plain for everyday polish, pavé for full sparkle.",
    options: [{ name: "Plating", values: PLATINGS }, { name: "Texture", values: ["Plain", "Pavé"] }],
    priceFor: (o) => (o.Texture === "Pavé" ? 8600 : 7200),
    images: ["/assets/img/components/e4_orbit-hoop.webp", "/assets/img/worn/ear/ear_worn_06.webp"],
  },
  {
    slug: "linking-chain", code: "E5", category: "ear", price: 3800,
    title: "Linking Chain", subtitle: "The thread that ties the stack together",
    description: "A delicate chain with loops on both ends — thread it onto a stud post and loop it over a cuff to draw the whole ear into one look.",
    options: [{ name: "Plating", values: PLATINGS }, { name: "Length", values: ["Short", "Long"] }],
    images: ["/assets/img/components/e5_chain-cuff.webp", "/assets/img/worn/ear/ear_worn_07.webp"],
  },
  {
    slug: "primary-pendant-necklace", code: "N1", category: "neck", price: 7800, featured: true,
    title: "Primary Pendant Necklace", subtitle: "The anchor layer",
    description: "The anchor of the neck system: a fixed stone pendant on a fine 925 silver chain. Layer extenders, charms and halos around it.",
    options: FULL_MATRIX,
    images: ["/assets/img/worn/neck/neck_worn_01.webp", "/assets/img/worn/neck/neck_worn_02.webp", "/assets/img/design/neck/neck_design_lumiere-necklace-stack_01.webp"],
  },
  {
    slug: "solo-choker-necklace", code: "N2", category: "neck", price: 7400,
    title: "Solo Choker Necklace", subtitle: "The close layer",
    description: "A standalone choker that sits high and close — the top line of any layered stack, or a clean statement on its own.",
    options: FULL_MATRIX,
    images: ["/assets/img/worn/neck/neck_worn_03.webp", "/assets/img/worn/neck/neck_worn_04.webp"],
  },
  {
    slug: "linking-extender-chain", code: "N5", category: "neck", price: 4200,
    title: "Linking Extender Chain", subtitle: "One necklace, every length",
    description: "Converts lengths in seconds — choker to drop, short to lariat. The quiet hero of the layering system.",
    options: [{ name: "Plating", values: PLATINGS }, { name: "Length", values: ["Short", "Long"] }],
    images: ["/assets/img/worn/neck/neck_worn_05.webp", "/assets/img/worn/neck/neck_worn_06.webp"],
  },
  {
    slug: "primary-solitaire-ring", code: "R1", category: "rings", price: 6800, featured: true,
    title: "Primary Solitaire Ring", subtitle: "The anchor ring",
    description: "A fixed stone solitaire that anchors the ring stack. Clip a shank charm onto the band, circle it with an orbit halo, or flank it with stackers.",
    options: FULL_MATRIX,
    images: ["/assets/img/worn/rings/rings_worn_01.webp", "/assets/img/worn/rings/rings_worn_02.webp", "/assets/img/design/rings/rings_design_lumiere-ring-stacks_01.webp"],
  },
  {
    slug: "adjustable-slip-on-ring", code: "R2", category: "rings", price: 5200,
    title: "Adjustable Slip-On Ring", subtitle: "Fits every finger",
    description: "A non-sized, gently sprung band with a set stone — slides onto any finger, including playful pinky placements.",
    options: [{ name: "Plating", values: PLATINGS }, { name: "Stone Color", values: COLORS }],
    images: ["/assets/img/worn/rings/rings_worn_03.webp", "/assets/img/design/rings/rings_design_lumiere-ring-stacks_02.webp"],
  },
  {
    slug: "linking-stacker-band", code: "R5", category: "rings", price: 3600,
    title: "Linking Stacker Band", subtitle: "Stacks flush, plays well with others",
    description: "A thin band designed to sit flush against the Solitaire — thin for whisper stacks, wide for statement rows.",
    options: [{ name: "Plating", values: PLATINGS }, { name: "Width", values: ["Thin", "Wide"] }],
    images: ["/assets/img/design/rings/rings_design_overview-collage_01.webp", "/assets/img/design/rings/rings_design_lumiere-starfall-rings_01.webp"],
  },
];

const SWATCH = {
  Crystal: "/assets/img/swatches/variant_clear.webp",
  Emerald: "/assets/img/swatches/variant_emerald.webp",
  Sapphire: "/assets/img/swatches/variant_sapphire.webp",
  Ruby: "/assets/img/swatches/variant_ruby.webp",
};

function combos(options) {
  return options.reduce(
    (acc, group) => acc.flatMap((row) => group.values.map((v) => ({ ...row, [group.name]: v }))),
    [{}]
  );
}

async function seed(req, res) {
  const force = Boolean((req.body || {}).force);
  const existing = await db.query("SELECT COUNT(*)::int AS n FROM products");
  if (existing.rows[0].n > 0 && !force) {
    throw badRequest(`Catalog already has ${existing.rows[0].n} products. Pass {"force":true} to add any missing seed products (nothing is overwritten).`);
  }
  let productsCreated = 0;
  let variantsCreated = 0;
  for (const def of CATALOG) {
    const clash = await db.query("SELECT id FROM products WHERE slug = $1", [def.slug]);
    if (clash.rows.length) continue;
    const pr = await db.query(
      `INSERT INTO products (slug, title, subtitle, description, category, status, price_cents, images, options, featured)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9) RETURNING id`,
      [def.slug, def.title, def.subtitle, def.description, def.category, def.price,
       JSON.stringify(def.images), JSON.stringify(def.options), Boolean(def.featured)]
    );
    const productId = pr.rows[0].id;
    productsCreated++;
    let i = 0;
    for (const options of combos(def.options)) {
      const sku = [def.code, ...Object.values(options).map((v) => CODE[v] || v.slice(0, 3).toUpperCase())].join("-");
      const price = def.priceFor ? def.priceFor(options) : null; // null → product base price
      const stock = 6 + ((i * 7) % 15); // deterministic, varied launch stock
      const image = options["Stone Color"] ? SWATCH[options["Stone Color"]] : null;
      await db.query(
        `INSERT INTO variants (product_id, sku, options, price_cents, stock, image, active)
         VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (sku) DO NOTHING`,
        [productId, sku, JSON.stringify(options), price, stock, image]
      );
      variantsCreated++;
      i++;
    }
  }
  await db.query(
    `INSERT INTO discounts (code, kind, value, min_cents) VALUES ('WELCOME10', 'percent', 10, 0)
     ON CONFLICT (code) DO NOTHING`
  );
  json(res, 200, { ok: true, productsCreated, variantsCreated });
}

module.exports = { seed };
