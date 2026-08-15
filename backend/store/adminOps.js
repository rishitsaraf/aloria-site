/* Operational admin tools: bulk product actions, duplication, catalog CSV
   export/import, manual order entry, waitlist broadcast, image uploads
   (Vercel Blob), and email template preview / test-send. */

const crypto = require("crypto");
const db = require("../lib/db");
const emailLib = require("../lib/email");
const { json, badRequest, notFound, cleanEmail, cleanInt, cleanString, slugify } = require("../lib/http");

/* ---------- bulk product actions ---------- */

async function bulkProducts(req, res) {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.map((i) => cleanInt(i, { name: "id", min: 1 })) : [];
  if (!ids.length || ids.length > 200) throw badRequest("Select between 1 and 200 products");
  const action = String(body.action || "");

  if (["activate", "archive", "draft"].includes(action)) {
    const status = action === "activate" ? "active" : action === "archive" ? "archived" : "draft";
    await db.query("UPDATE products SET status = $1, updated_at = now() WHERE id = ANY($2)", [status, ids]);
  } else if (action === "feature" || action === "unfeature") {
    await db.query("UPDATE products SET featured = $1, updated_at = now() WHERE id = ANY($2)", [action === "feature", ids]);
  } else if (action === "price") {
    // ±percent or ±cents applied to base price AND variant overrides
    const mode = body.mode === "cents" ? "cents" : "percent";
    const value = cleanInt(body.value, { name: "value", min: -100000, max: mode === "percent" ? 500 : 100000 });
    if (mode === "percent" && value <= -100) throw badRequest("A -100% change would make everything free");
    const factorSql = mode === "percent"
      ? `GREATEST(0, ROUND(price_cents * (100 + ${value}) / 100.0))::int`
      : `GREATEST(0, price_cents + ${value})`;
    await db.query(`UPDATE products SET price_cents = ${factorSql}, updated_at = now() WHERE id = ANY($1)`, [ids]);
    await db.query(
      `UPDATE variants SET price_cents = ${factorSql}, updated_at = now()
        WHERE product_id = ANY($1) AND price_cents IS NOT NULL`, [ids]);
  } else {
    throw badRequest("Unknown bulk action");
  }
  json(res, 200, { ok: true, affected: ids.length });
}

/* ---------- duplicate product ---------- */

async function duplicateProduct(req, res, params) {
  const id = cleanInt(params.id, { name: "product id", min: 1 });
  const copy = await db.tx(async (client) => {
    const pr = await client.query("SELECT * FROM products WHERE id = $1", [id]);
    const p = pr.rows[0];
    if (!p) throw notFound("Product not found");
    const slug = `${slugify(p.slug)}-copy-${Date.now().toString(36)}`;
    const np = await client.query(
      `INSERT INTO products (slug, title, subtitle, description, category, status, price_cents, currency,
                             images, options, tags, featured, seo_title, seo_description)
       VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,false,$11,$12) RETURNING *`,
      [slug, `${p.title} (copy)`, p.subtitle, p.description, p.category, p.price_cents, p.currency,
       JSON.stringify(p.images), JSON.stringify(p.options), JSON.stringify(p.tags), p.seo_title, p.seo_description]
    );
    const variants = await client.query("SELECT * FROM variants WHERE product_id = $1 ORDER BY id", [id]);
    const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
    for (const v of variants.rows) {
      await client.query(
        `INSERT INTO variants (product_id, sku, options, price_cents, compare_at_cents, stock, image, active)
         VALUES ($1,$2,$3,$4,$5,0,$6,$7)`,
        [np.rows[0].id, `${v.sku}-${suffix}`, JSON.stringify(v.options), v.price_cents, v.compare_at_cents, v.image, v.active]
      );
    }
    return np.rows[0];
  });
  json(res, 201, { product: copy });
}

/* ---------- catalog CSV export / import ---------- */

const csvCell = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;

async function exportCatalog(req, res) {
  const r = await db.query(
    `SELECT p.slug, p.title, p.subtitle, p.category, p.status, p.price_cents AS base_price_cents, p.featured,
            v.sku, v.options, v.price_cents, v.stock, v.active, v.image
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
      ORDER BY p.id, v.id`
  );
  const header = ["slug", "title", "subtitle", "category", "status", "base_price_cents", "featured",
    "sku", "options_json", "variant_price_cents", "stock", "variant_active", "variant_image"];
  const lines = [header.join(",")];
  for (const row of r.rows) {
    lines.push([
      row.slug, row.title, row.subtitle, row.category, row.status, row.base_price_cents, row.featured,
      row.sku || "", row.sku ? JSON.stringify(row.options || {}) : "",
      row.price_cents == null ? "" : row.price_cents,
      row.sku ? row.stock : "", row.sku ? row.active : "", row.image || "",
    ].map(csvCell).join(","));
  }
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="aloria-catalog.csv"`);
  res.end("﻿" + lines.join("\r\n"));
}

/** Tiny CSV parser (quoted cells, CRLF) — no dependency. */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", inQ = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** Import the same shape the export produces. Products match by slug,
    variants by SKU; prices/stock/status update, nothing is deleted.
    Stock changes are logged as 'import' movements. */
async function importCatalog(req, res) {
  const csv = String((req.body || {}).csv || "");
  if (!csv.trim()) throw badRequest("Paste or upload the CSV content as {csv}");
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest("CSV has no data rows");
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  for (const required of ["slug", "title", "sku"]) {
    if (col(required) === -1) throw badRequest(`CSV is missing the "${required}" column`);
  }
  let productsTouched = 0, variantsTouched = 0;
  const seenSlugs = new Set();
  await db.tx(async (client) => {
    for (const r of rows.slice(1)) {
      const get = (name) => (col(name) === -1 ? "" : String(r[col(name)] || "").trim());
      const slug = slugify(get("slug"));
      if (!slug) continue;

      if (!seenSlugs.has(slug)) {
        seenSlugs.add(slug);
        const title = cleanString(get("title"), { name: "title", max: 160 }) || slug;
        const category = ["ear", "neck", "rings"].includes(get("category")) ? get("category") : "ear";
        const status = ["draft", "active", "archived"].includes(get("status")) ? get("status") : "draft";
        const base = parseInt(get("base_price_cents"), 10);
        const featured = get("featured") === "true";
        const up = await client.query(
          `INSERT INTO products (slug, title, subtitle, category, status, price_cents, featured)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (slug) DO UPDATE SET title=$2, subtitle=$3, category=$4, status=$5,
             price_cents=$6, featured=$7, updated_at=now()`,
          [slug, title, get("subtitle"), category, status, Number.isFinite(base) ? base : 0, featured]
        );
        productsTouched += up.rowCount;
      }
      const sku = get("sku").toUpperCase();
      if (!sku) continue;
      let options = {};
      try { options = JSON.parse(get("options_json") || "{}"); } catch (_) { /* keep {} */ }
      const priceRaw = get("variant_price_cents");
      const price = priceRaw === "" ? null : parseInt(priceRaw, 10);
      const stock = Math.max(0, parseInt(get("stock"), 10) || 0);
      const active = get("variant_active") !== "false";
      const image = get("variant_image") || null;
      const prev = await client.query("SELECT id, stock FROM variants WHERE sku = $1", [sku]);
      await client.query(
        `INSERT INTO variants (product_id, sku, options, price_cents, stock, image, active)
         SELECT p.id, $2, $3, $4, $5, $6, $7 FROM products p WHERE p.slug = $1
         ON CONFLICT (sku) DO UPDATE SET options=$3, price_cents=$4, stock=$5, image=$6, active=$7, updated_at=now()`,
        [slug, sku, JSON.stringify(options), Number.isFinite(price) ? price : null, stock, image, active]
      );
      if (prev.rows.length && prev.rows[0].stock !== stock) {
        await client.query(
          `INSERT INTO inventory_movements (variant_id, sku, delta, reason, note, user_id)
           VALUES ($1,$2,$3,'import','catalog csv import',$4)`,
          [prev.rows[0].id, sku, stock - prev.rows[0].stock, req.adminUser ? req.adminUser.id : null]
        );
      }
      variantsTouched++;
    }
  });
  json(res, 200, { ok: true, productsTouched, variantsTouched });
}

/* ---------- manual order creation (phone / DM orders) ---------- */

async function createManualOrder(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  const name = cleanString(body.name, { name: "Name", max: 140, required: true });
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length || lines.length > 50) throw badRequest("Add 1–50 line items (sku + qty)");
  const address = {
    line1: cleanString((body.address || {}).line1, { name: "Address", max: 200 }),
    city: cleanString((body.address || {}).city, { name: "City", max: 100 }),
    postal: cleanString((body.address || {}).postal, { name: "Postal", max: 20 }),
    country: cleanString((body.address || {}).country, { name: "Country", max: 2 }).toUpperCase() || "US",
  };
  const markPaid = body.markPaid !== false;

  const order = await db.tx(async (client) => {
    let subtotal = 0;
    const resolved = [];
    for (const line of lines) {
      const sku = cleanString(line.sku, { name: "sku", max: 60, required: true }).toUpperCase();
      const qty = cleanInt(line.qty == null ? 1 : line.qty, { name: "qty", min: 1, max: 100 });
      const vr = await client.query(
        `SELECT v.id, v.sku, v.stock, v.options, v.image AS v_image, p.title, p.images, p.currency,
                COALESCE(v.price_cents, p.price_cents) AS unit_cents
           FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku = $1 FOR UPDATE OF v`,
        [sku]
      );
      const v = vr.rows[0];
      if (!v) throw badRequest(`No variant with SKU ${sku}`);
      if (v.stock < qty) throw badRequest(`Only ${v.stock} in stock for ${sku}`);
      resolved.push({ ...v, qty });
      subtotal += v.unit_cents * qty;
    }
    const num = await client.query("SELECT nextval('order_number_seq') AS n");
    const number = `ALR-${num.rows[0].n}`;
    const or = await client.query(
      `INSERT INTO orders (number, public_token, email, status, payment_method,
                           subtotal_cents, shipping_cents, discount_cents, tax_cents, total_cents,
                           currency, shipping_name, shipping_address)
       VALUES ($1,$2,$3,$4,'manual',$5,0,0,0,$5,$6,$7,$8) RETURNING *`,
      [number, crypto.randomBytes(24).toString("hex"), email, markPaid ? "paid" : "pending",
       subtotal, resolved[0].currency, name, JSON.stringify(address)]
    );
    const orderId = or.rows[0].id;
    for (const v of resolved) {
      await client.query("UPDATE variants SET stock = stock - $1, updated_at = now() WHERE id = $2", [v.qty, v.id]);
      await client.query(
        "INSERT INTO inventory_movements (variant_id, sku, delta, reason, order_id, user_id) VALUES ($1,$2,$3,'sale',$4,$5)",
        [v.id, v.sku, -v.qty, orderId, req.adminUser ? req.adminUser.id : null]
      );
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, product_title, variant_label, sku, image, unit_price_cents, qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [orderId, v.id, v.title, Object.values(v.options || {}).join(" · "), v.sku,
         v.v_image || (v.images || [])[0] || null, v.unit_cents, v.qty]
      );
    }
    await client.query(
      "INSERT INTO order_events (order_id, kind, data, user_id) VALUES ($1, 'placed', $2, $3)",
      [orderId, JSON.stringify({ paymentMethod: "manual", totalCents: subtotal, manual: true }), req.adminUser ? req.adminUser.id : null]
    );
    return or.rows[0];
  });
  if (markPaid && body.sendConfirmation !== false) {
    const items = (await db.query("SELECT * FROM order_items WHERE order_id = $1", [order.id])).rows;
    try { await emailLib.sendOrderConfirmation(order, items); } catch (e) { console.error("[manual order] email failed:", e.message); }
  }
  json(res, 201, { ok: true, order });
}

/* ---------- waitlist broadcast ---------- */

async function broadcastWaitlist(req, res) {
  const body = req.body || {};
  const subject = cleanString(body.subject, { name: "Subject", max: 150, required: true });
  const message = cleanString(body.message, { name: "Message", max: 10000, required: true });
  if (body.confirm !== true) throw badRequest('Pass {"confirm": true} — this emails the whole waitlist');
  const r = await db.query("SELECT email FROM waitlist ORDER BY created_at LIMIT 2000");
  if (!r.rows.length) throw badRequest("The waitlist is empty");
  const msg = emailLib.buildAnnouncement(subject, message);
  let sent = 0, failed = 0;
  for (const row of r.rows) {
    const result = await emailLib.send({ to: row.email, ...msg });
    if (result.ok) sent++; else failed++;
  }
  json(res, 200, { ok: true, recipients: r.rows.length, sent, failed });
}

/* ---------- image uploads (Vercel Blob) ---------- */

async function upload(req, res) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw badRequest("Image uploads need Vercel Blob: add a Blob store to the project so BLOB_READ_WRITE_TOKEN is set");
  const body = req.body || {};
  const filename = cleanString(body.filename, { name: "filename", max: 120, required: true })
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  if (!/\.(webp|jpe?g|png|avif|gif|svg)$/.test(filename)) throw badRequest("Only image files (webp/jpg/png/avif/gif/svg)");
  const data = String(body.data || "");
  const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const buf = Buffer.from(base64, "base64");
  if (!buf.length) throw badRequest("Empty file");
  if (buf.length > 4 * 1024 * 1024) throw badRequest("Image too large (max 4MB)");
  const type = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", avif: "image/avif", gif: "image/gif", svg: "image/svg+xml" }[filename.split(".").pop()];

  const pathname = `aloria/${Date.now().toString(36)}-${filename}`;
  const resp = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-content-type": type,
      "x-api-version": "7",
      "x-add-random-suffix": "0",
    },
    body: buf,
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok || !result.url) {
    console.error("[upload] blob PUT failed", resp.status, result);
    throw badRequest("Upload failed — check the Blob store configuration");
  }
  json(res, 201, { ok: true, url: result.url });
}

/* ---------- email preview / test send ---------- */

function sampleData() {
  const order = {
    number: "ALR-1042", public_token: "sample", email: "you@example.com",
    shipping_name: "Aria Example", currency: "USD",
    subtotal_cents: 12200, shipping_cents: 0, discount_cents: 1220, discount_code: "WELCOME10",
    tax_cents: 0, total_cents: 10980,
    tracking_carrier: "DHL Express", tracking_number: "JD014600003SG",
  };
  const items = [
    { product_title: "Primary Stem Stud", variant_label: "Gold · Round · Emerald", qty: 1, unit_price_cents: 5800 },
    { product_title: "Press-On Ear Cuff", variant_label: "Gold · Pear · Crystal", qty: 1, unit_price_cents: 6400 },
  ];
  return { order, items };
}

const TEMPLATES = {
  order_confirmation: () => { const { order, items } = sampleData(); return emailLib.buildOrderConfirmation(order, items); },
  shipping_confirmation: () => { const { order, items } = sampleData(); return emailLib.buildShippingConfirmation(order, items); },
  cart_recovery: () => {
    const { items } = sampleData();
    return emailLib.buildCartRecovery({ email: "you@example.com", currency: "USD", recovery_token: "sample" }, items, 12200);
  },
  password_reset: () => emailLib.buildPasswordReset("sample-token"),
};

async function previewEmail(req, res, params) {
  const build = TEMPLATES[params.template];
  if (!build) throw notFound(`Unknown template — one of: ${Object.keys(TEMPLATES).join(", ")}`);
  const msg = build();
  json(res, 200, { template: params.template, subject: msg.subject, html: msg.html });
}

async function testEmail(req, res, params) {
  const build = TEMPLATES[params.template];
  if (!build) throw notFound(`Unknown template — one of: ${Object.keys(TEMPLATES).join(", ")}`);
  const result = await emailLib.send({ to: req.adminUser.email, ...build() });
  json(res, 200, { ok: result.ok, delivered: result.delivered, to: req.adminUser.email });
}

module.exports = {
  bulkProducts, duplicateProduct, exportCatalog, importCatalog,
  createManualOrder, broadcastWaitlist, upload, previewEmail, testEmail,
};
