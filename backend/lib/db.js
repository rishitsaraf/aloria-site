/* ALORIA commerce — Postgres data layer.
   Works with any Postgres (Neon / Vercel Postgres / Supabase / RDS) via
   DATABASE_URL. Schema is applied idempotently on cold start, so a fresh
   database self-provisions on first request — no separate migrate step.

   Serverless notes:
   - one small Pool per lambda instance (max 3); prefer a pooled connection
     string (e.g. Neon's `-pooler` host) in DATABASE_URL.
   - every query is parameterized; no string-built SQL anywhere. */

const { Pool } = require("pg");

let pool = null;
let migrated = null; // promise — run schema at most once per instance

function connectionError() {
  const err = new Error(
    "DATABASE_URL is not configured. Create a Postgres database (Neon, Vercel Postgres, Supabase…) and set DATABASE_URL in the Vercel project settings."
  );
  err.statusCode = 503;
  err.expose = true;
  return err;
}

function getPool() {
  if (!process.env.DATABASE_URL) throw connectionError();
  if (!pool) {
    const url = process.env.DATABASE_URL;
    const local = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
    pool.on("error", (e) => console.error("[db] idle client error", e.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'customer', -- customer | admin
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,             -- sha256 of the cookie token
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  subtitle    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT 'ear',  -- ear | neck | rings
  status      TEXT NOT NULL DEFAULT 'draft',-- draft | active | archived
  price_cents INTEGER NOT NULL DEFAULT 0,   -- base price; variants may override
  currency    TEXT NOT NULL DEFAULT 'USD',
  images      JSONB NOT NULL DEFAULT '[]',  -- ["/assets/img/…", …]
  options     JSONB NOT NULL DEFAULT '[]',  -- [{name, values:[…]}, …] max 3
  tags        JSONB NOT NULL DEFAULT '[]',
  featured    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_status_cat ON products(status, category);

CREATE TABLE IF NOT EXISTS variants (
  id               BIGSERIAL PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku              TEXT NOT NULL UNIQUE,
  options          JSONB NOT NULL DEFAULT '{}', -- {"Plating":"Gold", …}
  price_cents      INTEGER,                     -- null → product.price_cents
  compare_at_cents INTEGER,
  stock            INTEGER NOT NULL DEFAULT 0,
  image            TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants(product_id);

CREATE TABLE IF NOT EXISTS carts (
  id               BIGSERIAL PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,     -- sha256 of the cart cookie token
  user_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  email            TEXT,                     -- captured for recovery
  status           TEXT NOT NULL DEFAULT 'active', -- active | converted | abandoned
  currency         TEXT NOT NULL DEFAULT 'USD',
  recovery_token   TEXT UNIQUE,
  recovery_sent_at TIMESTAMPTZ,
  recovered        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carts_status ON carts(status, updated_at);

CREATE TABLE IF NOT EXISTS cart_items (
  id         BIGSERIAL PRIMARY KEY,
  cart_id    BIGINT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id BIGINT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cart_id, variant_id)
);

CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS orders (
  id               BIGSERIAL PRIMARY KEY,
  number           TEXT NOT NULL UNIQUE,      -- ALR-1001
  public_token     TEXT NOT NULL UNIQUE,      -- unguessable key for the thanks page
  user_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  cart_id          BIGINT REFERENCES carts(id) ON DELETE SET NULL,
  email            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | paid | fulfilled | cancelled | refunded
  payment_method   TEXT NOT NULL DEFAULT 'test',    -- test | stripe
  payment_ref      TEXT,                            -- stripe checkout session id
  subtotal_cents   INTEGER NOT NULL DEFAULT 0,
  shipping_cents   INTEGER NOT NULL DEFAULT 0,
  discount_cents   INTEGER NOT NULL DEFAULT 0,
  discount_code    TEXT,
  total_cents      INTEGER NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  shipping_name    TEXT NOT NULL DEFAULT '',
  shipping_address JSONB NOT NULL DEFAULT '{}',
  from_recovered_cart BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id               BIGSERIAL PRIMARY KEY,
  order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id       BIGINT REFERENCES variants(id) ON DELETE SET NULL,
  product_title    TEXT NOT NULL,
  variant_label    TEXT NOT NULL DEFAULT '',
  sku              TEXT NOT NULL DEFAULT '',
  image            TEXT,
  unit_price_cents INTEGER NOT NULL,
  qty              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discounts (
  code        TEXT PRIMARY KEY,               -- stored uppercase
  kind        TEXT NOT NULL DEFAULT 'percent',-- percent | fixed
  value       INTEGER NOT NULL,               -- percent (1-100) or cents
  min_cents   INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id         BIGSERIAL PRIMARY KEY,
  variant_id BIGINT REFERENCES variants(id) ON DELETE SET NULL,
  sku        TEXT NOT NULL DEFAULT '',
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'manual', -- sale | restock | manual | import
  note       TEXT NOT NULL DEFAULT '',
  order_id   BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moves_variant ON inventory_movements(variant_id, created_at);

CREATE TABLE IF NOT EXISTS order_events (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL, -- placed | status | note | email
  data       JSONB NOT NULL DEFAULT '{}',
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id, created_at);

CREATE TABLE IF NOT EXISTS collections (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_collections (
  product_id    BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  collection_id BIGINT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, collection_id)
);

CREATE TABLE IF NOT EXISTS pages (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  published  BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  email      TEXT NOT NULL DEFAULT '',
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(created_at);

-- column additions for existing deployments (idempotent)
ALTER TABLE products  ADD COLUMN IF NOT EXISTS seo_title TEXT NOT NULL DEFAULT '';
ALTER TABLE products  ADD COLUMN IF NOT EXISTS seo_description TEXT NOT NULL DEFAULT '';
ALTER TABLE products  ADD COLUMN IF NOT EXISTS publish_at TIMESTAMPTZ;
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS tracking_carrier TEXT NOT NULL DEFAULT '';
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS tracking_number TEXT NOT NULL DEFAULT '';
ALTER TABLE orders    ADD COLUMN IF NOT EXISTS tax_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS max_uses INTEGER;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS once_per_customer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discounts ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE users     ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';
ALTER TABLE users     ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users     ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE carts     ADD COLUMN IF NOT EXISTS recovery_sent_count INTEGER NOT NULL DEFAULT 0;
`;

async function migrate() {
  const p = getPool();
  if (!migrated) {
    migrated = p.query(SCHEMA).catch((e) => {
      migrated = null; // allow retry on next request
      throw e;
    });
  }
  return migrated;
}

/** Run a parameterized query (after ensuring schema). */
async function query(text, params = []) {
  await migrate();
  return getPool().query(text, params);
}

/** Run fn inside a transaction with a dedicated client. */
async function tx(fn) {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) { /* connection gone */ }
    throw e;
  } finally {
    client.release();
  }
}

const hasDb = () => Boolean(process.env.DATABASE_URL);

module.exports = { query, tx, hasDb, migrate };
