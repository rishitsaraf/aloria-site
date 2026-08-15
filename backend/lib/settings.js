/* Store configuration — DB-backed key/value with sane defaults, editable in
   the CMS (Settings + Content views). Env vars remain a fallback so existing
   deployments keep working; DB values win once set. Cached per instance. */

const db = require("./db");

const envInt = (name, dflt) => parseInt(process.env[name], 10) || dflt;

const DEFAULTS = {
  "shipping.flat_cents": () => envInt("SHIPPING_FLAT_CENTS", 800),
  "shipping.free_threshold_cents": () => envInt("FREE_SHIPPING_CENTS", 7500),
  "abandoned.minutes": () => envInt("ABANDONED_AFTER_MINUTES", 120),
  "abandoned.second_reminder_hours": () => 0, // 0 = off
  "tax.default_pct": () => 0,
  "tax.by_country": () => ({}),               // {"GB": 20, "DE": 19}
  "content.announcement": () => ({ text: "", enabled: false }),
  "content.hero": () => ({
    title: "Build a stack that's |yours|.",   // |…| renders italic gold
    tagline: "Two platings · Five shapes · Four stones",
    image: "/assets/img/worn/neck/neck_worn_01.webp",
  }),
  "content.tiles": () => ([
    { category: "ear", image: "/assets/img/worn/ear/ear_worn_02.webp" },
    { category: "neck", image: "/assets/img/worn/neck/neck_worn_03.webp" },
    { category: "rings", image: "/assets/img/worn/rings/rings_worn_01.webp" },
  ]),
};

let cache = null;
let cacheAt = 0;
const TTL_MS = 15_000;

async function loadAll() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  const r = await db.query("SELECT key, value FROM settings");
  cache = Object.fromEntries(r.rows.map((row) => [row.key, row.value]));
  cacheAt = Date.now();
  return cache;
}

async function get(key) {
  const all = await loadAll();
  if (all[key] !== undefined) return all[key];
  const dflt = DEFAULTS[key];
  return dflt ? dflt() : undefined;
}

/** All known settings merged over defaults — what the CMS edits. */
async function getAll() {
  const stored = await loadAll();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = stored[key] !== undefined ? stored[key] : DEFAULTS[key]();
  }
  return out;
}

async function put(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue; // only known keys are storable
    await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  cache = null;
}

module.exports = { get, getAll, put, DEFAULTS };
