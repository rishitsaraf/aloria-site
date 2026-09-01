/* Browser walk-through: shop → PDP → variant select → add to bag → cart →
   checkout → thanks; then admin login → dashboard → product editor → variants;
   screenshots along the way. */
let chromium;
try { ({ chromium } = require("playwright")); } catch (_) { ({ chromium } = require("playwright-core")); }
const assert = require("assert");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const fs = require("fs");
const SHOT_DIR = process.env.SHOT_DIR || `${__dirname}/shots`;
fs.mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => `${SHOT_DIR}/${n}.png`;

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); // no internet in test env
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  // --- shop listing
  await page.goto(`${BASE}/shop`, { waitUntil: "networkidle" });
  await page.waitForSelector(".product-card");
  const cards = await page.$$(".product-card");
  assert.ok(cards.length >= 10, `expected seeded cards, got ${cards.length}`);
  assert.ok(await page.$(".shop-hero"), "landing hero present on bare /shop");
  assert.equal((await page.$$(".cat-tile")).length, 3, "three category tiles");
  await page.screenshot({ path: SHOT("01-shop") , fullPage: false });
  console.log(`✓ shop landing: hero + category tiles + ${cards.length} products`);

  // C4: facet selects drive the URL and narrow the grid
  await page.selectOption("#fPlating", "Gold");
  await page.waitForURL(/plating=Gold/);
  await page.waitForSelector(".product-card");
  assert.ok(await page.$("#fClear:not([hidden])"), "clear button appears");
  assert.equal(await page.inputValue("#fPlating"), "Gold", "facet state survives reload");
  await page.selectOption("#fSort", "price_asc");
  await page.waitForURL(/sort=price_asc/);
  await page.waitForSelector(".product-card");
  const shown = await page.$$eval(".product-card .price", (els) => els.map((e) => e.textContent));
  assert.ok(shown.length > 0, "sorted grid renders");
  await page.click("#fClear");
  await page.waitForURL((u) => !u.search.includes("plating"));
  await page.waitForSelector(".product-card");
  console.log("✓ facets: plating filter + sort in URL, clear resets");

  // Core Web Vitals discipline: hero is high-priority, first cards not lazy
  assert.equal(await page.getAttribute(".shop-hero img", "fetchpriority"), "high", "hero fetchpriority");
  assert.ok(await page.$('link[rel="preload"][as="image"]'), "hero preload link");
  const firstCardImg = await page.$(".product-card .ph img");
  assert.notEqual(await firstCardImg.getAttribute("loading"), "lazy", "first card image loads eagerly");
  console.log("✓ CWV: hero preload + eager above-the-fold images");

  // search
  await page.fill("#searchInput", "choker");
  await page.press("#searchInput", "Enter");
  await page.waitForURL(/q=choker/);
  await page.waitForSelector(".product-card");
  const searchCount = (await page.$$(".product-card")).length;
  assert.ok(searchCount >= 1, "search finds the choker");
  assert.ok(!(await page.$("#landing:not([hidden])")), "landing hidden during search");
  console.log(`✓ search: "choker" → ${searchCount} result(s)`);

  // category filter
  await page.goto(`${BASE}/shop?category=rings`, { waitUntil: "networkidle" });
  await page.waitForSelector(".product-card");
  const ringTitle = await page.textContent("#shopTitle");
  assert.equal(ringTitle.trim(), "Rings");
  console.log("✓ category filter page");

  // --- PDP
  await page.goto(`${BASE}/shop/product?slug=primary-stem-stud`, { waitUntil: "networkidle" });
  await page.waitForSelector(".opt-btn");
  assert.equal(await page.textContent("#pTitle"), "Primary Stem Stud");
  // pick Gold / Round / Emerald
  for (const val of ["Gold", "Round", "Emerald"]) {
    await page.click(`.opt-btn[data-val="${val}"]`);
  }
  await page.waitForSelector("#addBtn:not([disabled])");
  assert.ok(await page.$(".opt-btn.swatch.sw-emerald.active"), "stone color renders as swatch");
  assert.ok(await page.$("#crumbs a"), "breadcrumb rendered");
  await page.waitForSelector("#related:not([hidden]) .product-card");
  assert.ok(await page.$eval('script[type="application/ld+json"]', (el) => JSON.parse(el.textContent)["@type"] === "Product"), "JSON-LD product markup");
  const price = await page.textContent("#pPrice");
  assert.ok(price.includes("58"), `price shows ${price}`);
  await page.screenshot({ path: SHOT("02-pdp") });
  // C2 depth: trust strip renders (with the CMS shipping threshold) + image zoom
  await page.waitForSelector(".trust-strip");
  await page.waitForSelector("#trustShip:not([hidden])");
  assert.ok((await page.textContent("#trustShip")).includes("Free shipping"), "trust strip shows threshold");
  await page.click("#mainWrap");
  assert.ok(await page.$("#mainWrap.zoomed"), "click zooms the gallery image");
  await page.click("#mainWrap");
  await page.click("#addBtn");
  await page.waitForSelector(".toast.show");
  await page.waitForFunction(() => document.getElementById("bagBadge").textContent === "1");
  console.log("✓ PDP: swatches, breadcrumb, trust strip, zoom, JSON-LD, add to bag");

  // C3: the PDP HTML itself (no JS) carries title, canonical and 2026 schema
  {
    const resp = await ctx.request.get(`${BASE}/shop/product?slug=primary-stem-stud`);
    const raw = await resp.text();
    assert.ok(raw.includes("<title>Primary Stem Stud"), "server-rendered <title>");
    assert.ok(raw.includes('rel="canonical"'), "canonical link");
    assert.ok(raw.includes("hasMerchantReturnPolicy"), "MerchantReturnPolicy in server JSON-LD");
    assert.ok(raw.includes("OfferShippingDetails"), "shippingDetails in server JSON-LD");
    assert.ok(raw.includes("BreadcrumbList"), "BreadcrumbList in server JSON-LD");
    const missing = await ctx.request.get(`${BASE}/shop/product?slug=not-a-real-piece`);
    assert.equal(missing.status(), 404, "unknown slug → 404 with noindex");
    // client must not double-inject structured data over the server's
    const seoPage = await ctx.newPage();
    await seoPage.goto(`${BASE}/shop/product?slug=primary-stem-stud`, { waitUntil: "networkidle" });
    assert.equal((await seoPage.$$('script[type="application/ld+json"]')).length, 2, "exactly two JSON-LD blocks");
    await seoPage.close();
    console.log("✓ SEO: server-rendered PDP head + schema, 404 for unknown slugs, no double-inject");
  }

  // D1: recently-viewed rail appears on the next PDP visited
  await page.goto(`${BASE}/shop/product?slug=press-on-ear-cuff`, { waitUntil: "networkidle" });
  await page.waitForSelector("#recent:not([hidden]) .product-card");
  assert.ok((await page.textContent("#recentGrid")).includes("Primary Stem Stud"), "earlier PDP remembered");
  assert.ok(await page.$("#related:not([hidden])"), "complete-the-stack rail present");
  const relCats = await page.$$eval("#relatedGrid .product-card", (els) => els.map((e) => e.getAttribute("href")));
  assert.ok(relCats.length === 4, "four cross-sell cards");
  console.log("✓ D1: recently viewed rail + component-aware cross-sell");

  // D2: returns portal guards its lookup
  await page.goto(`${BASE}/returns`, { waitUntil: "networkidle" });
  await page.fill("#rlNumber", "ALR-9999");
  await page.fill("#rlEmail", "nobody@example.com");
  await page.click("#rlGo");
  await page.waitForSelector("#rlMsg.err");
  console.log("✓ returns portal: bad lookup rejected with a clear message");

  // contact page round-trips into the CMS inbox
  await page.goto(`${BASE}/contact`, { waitUntil: "networkidle" });
  await page.fill("#cfName", "Browser Visitor");
  await page.fill("#cfEmail", "visitor@example.com");
  await page.fill("#cfSubject", "Stacking advice");
  await page.fill("#cfMessage", "Which stones pair with rhodium?");
  await page.click("#cfSend");
  await page.waitForSelector("#cfMsg.ok");
  console.log("✓ contact page: form submits");

  // --- cart
  await page.goto(`${BASE}/cart`, { waitUntil: "networkidle" });
  await page.waitForSelector(".cart-line");
  await page.click('[data-act="plus"]');
  await page.waitForFunction(() => document.querySelector("[data-qty]") && document.querySelector("[data-qty]").value === "2");
  await page.screenshot({ path: SHOT("03-cart") });
  console.log("✓ cart: line qty + → 2");

  // --- checkout
  await page.goto(`${BASE}/checkout`, { waitUntil: "networkidle" });
  await page.waitForSelector("#checkoutForm:not([hidden])");
  await page.fill("#coEmail", "browser@example.com");
  await page.fill("#coName", "Browser Shopper");
  await page.fill("#coLine1", "10 Downing Street");
  await page.fill("#coCity", "London");
  await page.fill("#coPostal", "SW1A 2AA");
  await page.selectOption("#coCountry", "GB");
  await page.fill("#discountInput", "WELCOME10");
  await page.click("#discountBtn");
  await page.waitForFunction(() => !document.getElementById("discountRow").hidden);
  await page.check('input[name="pay"][value="test"]');
  await page.screenshot({ path: SHOT("04-checkout") });
  await page.click("#placeBtn");
  await page.waitForURL(/checkout\/thanks/, { timeout: 15000 });
  await page.waitForSelector("#thanksWrap:not([hidden])");
  const orderNum = await page.textContent("#thanksNumber");
  assert.ok(/^ALR-\d+/.test(orderNum.trim()), orderNum);
  const status = await page.textContent("#thanksStatus");
  assert.equal(status.trim(), "paid");
  await page.screenshot({ path: SHOT("05-thanks") });
  console.log(`✓ checkout with WELCOME10 → ${orderNum.trim()} (paid)`);

  // --- account register + order history
  await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  await page.waitForSelector("#authView:not([hidden])");
  // forgot-password card toggles
  await page.click("#forgotLink");
  await page.waitForSelector("#forgotForm:not([hidden])");
  await page.click("#backToLogin");
  await page.waitForSelector("#authForm:not([hidden])");
  console.log("✓ forgot-password card toggles");
  await page.click("#tabRegister");
  await page.fill("#authName", "Browser Shopper");
  await page.fill("#authEmail", `browser-${Date.now()}@example.com`);
  await page.fill("#authPass", "longpassword1");
  await page.click("#authBtn");
  await page.waitForSelector("#accountView:not([hidden])", { timeout: 10000 });
  console.log("✓ account register → signed-in view");

  // --- admin
  const admin = await ctx.newPage();
  admin.on("pageerror", (e) => errors.push(`admin pageerror: ${e.message}`));
  await admin.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await admin.waitForSelector("#adminLogin:not([hidden])");
  await admin.fill("#alEmail", "admin@aloria.test");
  await admin.fill("#alPass", "super-secret-admin");
  await admin.click('#adminLoginForm button[type="submit"]');
  await admin.waitForSelector("#adminShell:not([hidden])", { timeout: 10000 });
  await admin.waitForSelector(".tile");
  await admin.screenshot({ path: SHOT("06-admin-dashboard") });
  const revenueTile = await admin.textContent(".tile .v");
  await admin.waitForSelector("#revChart svg");
  await admin.hover("#revChart");
  console.log(`✓ admin dashboard: tiles + revenue trend chart (revenue ${revenueTile.trim()})`);

  // products list → editor → variants table
  await admin.click('[data-nav="products"]');
  await admin.waitForSelector("tr.click");
  await admin.click('tr.click:has-text("Primary Stem Stud")');
  await admin.waitForSelector("#varTable");
  const varRows = await admin.$$("#varTable tbody tr");
  assert.ok(varRows.length >= 40, `variant rows ${varRows.length}`);
  await admin.screenshot({ path: SHOT("07-admin-editor"), fullPage: true });
  console.log(`✓ admin product editor with ${varRows.length} variant rows`);

  // edit stock of first variant and save
  await admin.fill('#varTable [data-v="0"][data-f="stock"]', "42");
  await admin.click("#saveVariants");
  await admin.waitForSelector(".toast.show");
  await admin.waitForSelector('#varTable [data-v="0"][data-f="stock"]');
  const savedStock = await admin.inputValue('#varTable [data-v="0"][data-f="stock"]');
  assert.equal(savedStock, "42");
  console.log("✓ variant stock edit persists through save");

  // orders view shows the browser order
  await admin.click('[data-nav="orders"]');
  await admin.waitForSelector("tr.click");
  const ordersHtml = await admin.textContent("table.tbl");
  assert.ok(ordersHtml.includes("browser@example.com"), "order visible in admin");
  assert.ok(await admin.$("#csvBtn:not([disabled])"), "CSV export button");
  await admin.screenshot({ path: SHOT("08-admin-orders") });
  console.log("✓ admin orders list + CSV export button");

  // abandoned view loads
  await admin.click('[data-nav="carts"]');
  await admin.waitForSelector(".admin-head h1");
  console.log("✓ admin abandoned-bags view loads");


  // --- round 3: storefront content (announcement bar, collection chip, footer pages)
  await page.goto(`${BASE}/shop`, { waitUntil: "networkidle" });
  await page.waitForSelector(".announce-bar");
  const annText = await page.textContent(".announce-bar");
  assert.ok(annText.includes("Free shipping"), "announcement bar renders CMS text");
  await page.waitForSelector(".filter-btn.coll");
  assert.ok(await page.$('#footLinks a'), "footer page links");
  await page.click(".filter-btn.coll");
  await page.waitForURL(/collection=/);
  await page.waitForSelector(".product-card");
  console.log("✓ storefront: announcement bar + collection chip + footer pages");

  // static page renders
  await page.goto(`${BASE}/p?slug=shipping-returns`, { waitUntil: "networkidle" });
  await page.waitForSelector("#pageWrap:not([hidden])");
  assert.ok((await page.textContent("#pageBody")).includes("Worldwide"), "page body renders markdown");
  console.log("✓ static page /p renders");

  // --- round 3: CMS views
  const view = async (hash, sel, label) => {
    await admin.evaluate((h) => { location.hash = h; }, hash.slice(1));
    await admin.waitForSelector(sel, { timeout: 10000 });
    console.log(`✓ CMS ${label}`);
  };
  await view("#/dashboard", ".funnel-row", "dashboard: funnel + best sellers");
  assert.ok(await admin.$(".range-chips button.active"), "range chips");
  await admin.click('.range-chips button[data-days="30"]');
  await admin.waitForFunction(() => document.querySelector(".tile .k") && document.querySelector(".tile .k").textContent.includes("30d"));
  console.log("✓ CMS dashboard: 30d range switch");
  await view("#/inventory", "[data-adj-go]", "inventory screen");
  await view("#/inventory/movements", "table.tbl", "movement log");
  await view("#/collections", "[data-coll-save]", "collections editor");
  await view("#/content", "#annText", "content editor");
  await view("#/pages", "tr.click", "pages list");
  await admin.click("tr.click");
  await admin.waitForSelector("#pePreview h2");
  console.log("✓ CMS page editor with live preview");
  await view("#/settings", "#sTaxByCountry", "settings screen");
  await view("#/staff", "[data-staff-save]", "staff + audit view");
  await view("#/security", "#totpStart, #totpOff", "security (2FA) view");
  await view("#/emails", "#emFrame", "email preview view");
  await view("#/orders/new", "#moCreate", "manual order form");

  // order detail: timeline + packing slip button + tracking inputs
  await admin.evaluate(() => { location.hash = "#/orders"; });
  await admin.waitForSelector("tr.click");
  await admin.click("tr.click");
  await admin.waitForSelector("#odSlip");
  await admin.waitForSelector(".tl-item");
  assert.ok(await admin.$("#odTracking"), "tracking input present");
  console.log("✓ CMS order detail: timeline + packing slip + tracking");

  // product editor: standard Aloria axes preset on a new product
  await admin.evaluate(() => { location.hash = "#/products/new"; });
  await admin.waitForSelector("[data-preset]");
  await admin.click('[data-preset="*"]');
  await admin.waitForFunction(() => document.querySelectorAll("[data-opt-name]").length === 3);
  const optNames = await admin.$$eval("[data-opt-name]", (els) => els.map((e) => e.value));
  assert.deepStrictEqual(optNames, ["Plating", "Stone Shape", "Stone Color"], `standard axes ${optNames}`);
  const optVals = await admin.$$eval("[data-opt-values]", (els) => els.map((e) => e.value));
  assert.ok(optVals[0].includes("Gold") && optVals[1].includes("Emerald Cut") && optVals[2].includes("Sapphire"), "canonical values");
  await admin.screenshot({ path: SHOT("09-editor-presets") });
  console.log("✓ product editor captures the Aloria base/shape/stone axes in one click");

  // products bulk bar appears on selection
  await admin.evaluate(() => { location.hash = "#/products"; });
  await admin.waitForSelector("[data-sel]");
  await admin.check("[data-sel]");
  await admin.waitForSelector("#bulkBar:not([hidden])");
  console.log("✓ products bulk bar + CSV buttons");
  await admin.screenshot({ path: SHOT("10-admin-dashboard-r3"), fullPage: false });

  const realErrors = errors.filter((e) => !/favicon|net::ERR|404/.test(e));
  if (realErrors.length) {
    console.error("PAGE ERRORS:", realErrors);
    process.exit(1);
  }
  await browser.close();
  console.log("\nBROWSER WALKTHROUGH PASSED");
  process.exit(0);
})().catch((e) => { console.error("BROWSER TEST FAILED:", e); process.exit(1); });
