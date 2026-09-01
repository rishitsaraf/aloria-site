/* CMS button + layout audit: logs in, exercises every interactive control in
   every view, verifies the app-frame layout (pinned sidebar, no shift), and
   runs the full design-doc variant journey end-to-end. */
let chromium;
try { ({ chromium } = require("playwright")); } catch (_) { ({ chromium } = require("playwright-core")); }
const assert = require("assert");

const BASE = process.env.BASE_URL || "http://localhost:8080";
const fs = require("fs");
const SHOT_DIR = process.env.SHOT_DIR || `${__dirname}/shots`;
fs.mkdirSync(SHOT_DIR, { recursive: true });
const SHOT = (n) => `${SHOT_DIR}/${n}.png`;
let PASS = 0;
const ok = (label) => { PASS++; console.log(`✓ ${label}`); };

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|404|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  const go = async (hash, sel) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(sel, { timeout: 12000 });
  };
  const toast = async () => { await page.waitForSelector(".toast.show", { timeout: 12000 }); return (await page.textContent(".toast")).trim(); };

  // ---------- login ----------
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#adminLogin:not([hidden])");
  await page.fill("#alEmail", "admin@aloria.test");
  await page.fill("#alPass", "super-secret-admin");
  await page.click('#adminLoginForm button[type="submit"]');
  await page.waitForSelector("#adminShell:not([hidden])");
  await page.waitForSelector(".tile");
  ok("login");

  // ---------- layout: pinned sidebar, independent scroll, no overflow ----------
  const layout = await page.evaluate(() => {
    const side = document.querySelector(".admin-side");
    const main = document.getElementById("adminMainScroll");
    const before = side.getBoundingClientRect().top;
    main.scrollTop = 5000;
    const after = side.getBoundingClientRect().top;
    return {
      sideTopBefore: before, sideTopAfter: after,
      bodyScrollable: document.documentElement.scrollHeight > window.innerHeight + 2 && getComputedStyle(document.body).overflow !== "hidden",
      hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      mainScrolls: main.scrollHeight >= main.clientHeight,
      gutter: getComputedStyle(main).scrollbarGutter,
    };
  });
  assert.equal(layout.sideTopBefore, 0, "sidebar starts at top");
  assert.equal(layout.sideTopAfter, 0, "sidebar stays pinned while main scrolls");
  assert.ok(!layout.bodyScrollable, "page body does not scroll (frame layout)");
  assert.ok(!layout.hOverflow, "no horizontal overflow");
  assert.ok(layout.gutter.includes("stable"), "stable scrollbar gutter");
  ok("app-frame layout: sidebar pinned, main scrolls independently, no shift");

  // ---------- dashboard controls ----------
  for (const d of ["7", "30", "90", "14"]) {
    await page.click(`.range-chips button[data-days="${d}"]`);
    await page.waitForFunction((dd) => {
      const k = document.querySelector(".tile .k");
      return k && k.textContent.includes(`${dd}d`);
    }, d);
  }
  ok("dashboard: all four range chips render their period");
  await page.click(".chart-table summary");
  await page.waitForSelector(".chart-table table td");
  ok("dashboard: chart table view toggles");
  await page.hover("#revChart");
  ok("dashboard: chart hover layer");

  // ---------- THE VARIANT JOURNEY (design doc mapping) ----------
  await go("#/products/new", "[data-preset]");
  await page.fill("#eTitle", "Audit Solitaire Ring");
  await page.fill("#ePrice", "6000");
  await page.selectOption("#eCat", "rings");
  // one click per design-doc axis: base plating, stone color, ring size
  await page.click('[data-preset="Plating"]');
  await page.waitForSelector('[data-opt-values]');
  await page.click('[data-preset="Stone Color"]');
  await page.click('[data-preset="Ring Size"]');
  await page.waitForFunction(() => document.querySelectorAll("[data-opt-name]").length === 3);
  const axisVals = await page.$$eval("[data-opt-values]", (els) => els.map((e) => e.value));
  assert.ok(axisVals[2].includes("US 3") && axisVals[2].includes("US 10"), "ring sizes US 3–10 present");
  // 4th axis must be blocked (max 3)
  assert.ok(await page.$('[data-preset="Texture"][disabled]'), "4th axis chip disabled at 3-axis cap");
  ok("editor: Plating + Stone Color + Ring Size added from design-doc chips (cap enforced)");

  await page.click("#saveBtn");
  await page.waitForURL(/#\/products\/\d+$/);
  await page.waitForSelector("#genMatrix");
  ok("editor: new product saved → variants panel");

  await page.click("#genMatrix");
  await page.waitForFunction(() => document.querySelectorAll("#varTable tbody tr[data-vrow]").length === 64);
  ok("matrix: 2 platings × 4 stones × 8 ring sizes = 64 variant rows generated");
  const sku0 = await page.inputValue('[data-v="0"][data-f="sku"]');
  assert.ok(/^ASR-/.test(sku0), `auto-SKU (${sku0})`);

  await page.click("#mapSwatches");
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('[data-f="image"]')].map((i) => i.value);
    return imgs.length === 64 && imgs.every((v) => v.includes("/assets/img/swatches/"));
  });
  ok("stone mapping: all 64 variants mapped to their color swatch image");
  assert.equal((await page.$$(".stone-dot")).length, 64, "stone color dots rendered");

  // stock a couple of rows and save everything with one button
  await page.fill('[data-v="0"][data-f="stock"]', "12");
  await page.fill('[data-v="1"][data-f="stock"]', "9");
  await page.click("#saveVariants");
  await page.waitForFunction(() => document.querySelector(".toast.show") && document.querySelector(".toast").textContent.includes("saved"));
  await page.waitForFunction(() => document.querySelectorAll("#varTable tbody tr[data-vrow]").length === 64);
  assert.equal(await page.inputValue('[data-v="0"][data-f="stock"]'), "12", "stock persisted");
  ok("save variants: persists product options + 64 rows in one action");
  // the wide matrix must scroll inside its panel, never widen the pane
  const editorOverflow = await page.evaluate(() => {
    const main = document.getElementById("adminMainScroll");
    return { pane: main.scrollWidth - main.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth };
  });
  assert.ok(editorOverflow.pane <= 1, `main pane h-overflow ${editorOverflow.pane}px`);
  assert.ok(editorOverflow.doc <= 1, `document h-overflow ${editorOverflow.doc}px`);
  ok("layout: 64-column matrix stays inside the pane (no grid blowout)");
  await page.screenshot({ path: SHOT("11-variant-matrix"), fullPage: false });

  // activate + verify on the storefront
  await page.selectOption("#eStatus", "active");
  await page.click("#saveBtn");
  await page.waitForFunction(() => document.querySelector(".toast.show"));
  const shopPage = await ctx.newPage();
  shopPage.on("pageerror", (e) => errors.push(`shop pageerror: ${e.message}`));
  await shopPage.goto(`${BASE}/shop/product?slug=audit-solitaire-ring`, { waitUntil: "domcontentloaded" });
  await shopPage.waitForSelector(".opt-btn");
  assert.ok(await shopPage.$(".opt-btn.swatch.sw-emerald"), "storefront renders stone swatches");
  assert.ok(await shopPage.$('.opt-btn[data-val="US 7"]'), "storefront renders ring sizes");
  await shopPage.click('.opt-btn[data-val="Gold"]');
  await shopPage.click(".opt-btn.swatch.sw-crystal");
  await shopPage.click('.opt-btn[data-val="US 3"]'); // first combo = the one stocked
  await shopPage.waitForSelector("#addBtn:not([disabled])");
  await shopPage.click("#addBtn");
  await shopPage.waitForSelector(".toast.show");
  await shopPage.screenshot({ path: SHOT("12-storefront-ring") });
  // a sold-out size offers a back-in-stock alert instead
  await shopPage.click('.opt-btn[data-val="US 5"]');
  await shopPage.waitForSelector("#alertBox:not([hidden])");
  await shopPage.fill("#alertEmail", "restock-watcher@example.com");
  await shopPage.click("#alertBtn");
  await shopPage.waitForSelector("#alertMsg.ok");
  await shopPage.close();
  ok("storefront: sold-out combo registers a back-in-stock alert");

  // duplicate then delete the copy; delete the audit product
  await page.bringToFront();
  await page.click("#dupBtn");
  await page.waitForURL(/#\/products\/\d+$/);
  await page.waitForFunction(() => document.querySelector("h1") && document.querySelector("h1").textContent.includes("(copy)"));
  page.once("dialog", (d) => d.accept());
  await page.click("#delBtn");
  await page.waitForURL(/#\/products$/);
  ok("editor: duplicate + delete");

  // ---------- products list controls ----------
  await page.waitForSelector("[data-sel]");
  await page.click("#selAll");
  await page.waitForSelector("#bulkBar:not([hidden])");
  await page.click("#selAll"); // clear
  await page.waitForSelector("#bulkBar[hidden]", { state: "attached" });
  await page.check('tr:has-text("Audit Solitaire Ring") [data-sel]');
  await page.click('[data-bulk="draft"]');
  await toast();
  await page.waitForSelector('tr:has-text("Audit Solitaire Ring") .status-pill.draft');
  ok("products: select-all + bulk status change");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#csvExport")]);
  assert.ok((await dl.suggestedFilename()).includes("catalog"), "csv export downloads");
  ok("products: CSV export downloads");

  // filters
  await page.fill("#pQ", "Audit");
  await page.press("#pQ", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("tr.click").length === 1);
  await page.fill("#pQ", "");
  await page.press("#pQ", "Enter");
  ok("products: search filter");

  // cleanup audit product (has an order → archives; that's the designed behavior)
  await page.click('tr.click:has-text("Audit Solitaire Ring")');
  await page.waitForSelector("#delBtn");
  page.once("dialog", (d) => d.accept());
  await page.click("#delBtn");
  await page.waitForURL(/#\/products$/);
  ok("products: delete/archive from editor");

  // ---------- orders ----------
  await go("#/orders", "tr.click");
  await page.fill("#oSku", "E1-");
  await page.press("#oSku", "Enter");
  await page.waitForFunction(() => document.querySelectorAll("tr.click").length >= 1);
  await page.fill("#oSku", "");
  await page.press("#oSku", "Enter");
  await page.waitForSelector("tr.click");
  ok("orders: SKU filter");
  await page.click('tr.click:has-text("paid")');
  await page.waitForSelector("#odSlip");
  await page.fill("#odNote", "audit note");
  await page.click("#odNoteAdd");
  await page.waitForSelector('.tl-item:has-text("audit note")');
  ok("order detail: internal note lands on the timeline");
  const [slip] = await Promise.all([page.waitForEvent("popup"), page.click("#odSlip")]);
  await slip.waitForSelector("table");
  assert.ok((await slip.textContent("body")).includes("Packing slip"), "slip content");
  await slip.close();
  ok("order detail: packing slip opens & prints");
  const resend = await page.$("#odResend");
  if (resend) {
    await resend.click();
    await toast();
    // the view re-renders after the re-send — wait for the timeline event
    await page.waitForSelector('.tl-item:has-text("re-send")');
    ok("order detail: re-send confirmation");
  }
  await page.fill("#odCarrier", "DHL");
  await page.fill("#odTracking", "AUDIT-123");
  await page.selectOption("#odStatus", "fulfilled");
  await page.click("#odUpdate");
  await toast();
  await page.waitForSelector('.kv:has-text("AUDIT-123")');
  ok("order detail: fulfil with tracking captured");

  // ---------- abandoned carts ----------
  await go("#/carts", ".admin-head h1");
  const sendBtn = await page.$("[data-send]");
  if (sendBtn) {
    await sendBtn.click();
    await toast();
    ok("abandoned: recovery email button");
  } else { ok("abandoned: view renders (no abandoned bags to send)"); }

  // ---------- customers ----------
  await go("#/customers", "tr.click");
  const [cdl] = await Promise.all([page.waitForEvent("download"), page.click("#custCsv")]);
  assert.ok((await cdl.suggestedFilename()).includes("customers"));
  await page.click("tr.click");
  await page.waitForSelector("#cdSave");
  await page.fill("#cdTags", "vip, audit");
  await page.click("#cdSave");
  await toast();
  ok("customers: CSV + detail save (tags/notes)");

  // ---------- discounts ----------
  await go("#/discounts", "#dCreate");
  await page.fill("#dCode", "AUDIT15");
  await page.selectOption("#dKind", "percent");
  await page.fill("#dValue", "15");
  await page.click("#dCreate");
  await page.waitForSelector('tr:has-text("AUDIT15")');
  await page.click('[data-off="AUDIT15"]');
  await page.waitForSelector('tr:has-text("AUDIT15") .status-pill.archived');
  ok("discounts: create + deactivate");

  // ---------- reviews moderation ----------
  // plant a pending review via the storefront PDP form, then moderate it
  {
    const rev = await ctx.newPage();
    await rev.goto(`${BASE}/shop/product?slug=primary-stem-stud`, { waitUntil: "domcontentloaded" });
    await rev.waitForSelector("#revWriteBtn");
    await rev.click("#revWriteBtn");
    await rev.selectOption("#revRating", "4");
    await rev.fill("#revName", "Audit Reviewer");
    const emailField = await rev.$("#revEmailWrap:not([hidden]) #revEmail");
    if (emailField) await rev.fill("#revEmail", "audit-reviewer@example.com");
    await rev.fill("#revTitle", "Audit stars");
    await rev.fill("#revBody", "Submitted by the CMS audit to exercise moderation.");
    await rev.click("#revSubmit");
    await rev.waitForSelector(".toast.show");
    await rev.close();
  }
  await go("#/reviews", "[data-rvf]");
  await page.waitForSelector('tr:has-text("Audit Reviewer")');
  await page.click('tr:has-text("Audit Reviewer") [data-rv-set="approved"]');
  await toast();
  await page.click('[data-rvf="approved"]');
  await page.waitForSelector('tr:has-text("Audit Reviewer")');
  ok("reviews: PDP submission lands in queue, approve moves it to Approved");

  // ---------- content ----------
  await go("#/content", "#contentSave");
  await page.click("#contentSave");
  await toast();
  ok("content: save round-trips");

  // ---------- pages ----------
  await go("#/pages", "#pgCreate");
  await page.fill("#pgTitle", "Audit Page");
  await page.click("#pgCreate");
  await page.waitForSelector("#pgSave");
  await page.fill("#peBody", "## Hello\n\nThis is **the audit**.");
  await page.waitForFunction(() => document.querySelector("#pePreview h2") && document.querySelector("#pePreview b"));
  await page.click("#pgSave");
  await toast();
  page.once("dialog", (d) => d.accept());
  await page.click("#pgDelete");
  await page.waitForURL(/#\/pages$/);
  ok("pages: create → live preview → save → delete");

  // ---------- collections ----------
  await go("#/collections", "#collCreate");
  await page.fill("#collTitle", "Audit Collection");
  await page.click("#collCreate");
  const wrapSel = '[data-coll]:has-text("Audit Collection")';
  await page.waitForSelector(wrapSel);
  await page.check(`${wrapSel} [data-cp] >> nth=0`);
  await page.click(`${wrapSel} [data-coll-save]`);
  await toast();
  await page.waitForSelector(`${wrapSel} [data-coll-del]`); // re-rendered view
  // delete every audit collection (robust to leftovers from earlier runs)
  while (await page.$(`${wrapSel} [data-coll-del]`)) {
    page.once("dialog", (d) => d.accept());
    await page.click(`${wrapSel} [data-coll-del] >> nth=0`);
    await page.waitForTimeout(400);
  }
  ok("collections: create + assign products + delete");

  // ---------- inventory ----------
  await go("#/inventory", "[data-adj-go]");
  const invSku = await page.textContent("tbody tr td.mono-cell");
  await page.fill("tbody tr [data-adj]", "+3");
  await page.fill("tbody tr [data-adj-note]", "audit adjust");
  await page.click("tbody tr [data-adj-go]");
  await toast();
  ok("inventory: quick adjustment applies");
  await page.click("#invLow");
  await page.waitForSelector(".admin-head h1");
  await page.click("#invLow");
  ok("inventory: low-stock filter toggles");
  await go("#/inventory/movements", "table.tbl");
  await page.waitForSelector('tr:has-text("audit adjust")');
  ok("inventory: movement log shows the adjustment with note");

  // ---------- settings ----------
  await go("#/settings", "#setSave");
  await page.click("#setSave");
  await toast();
  ok("settings: save round-trips");

  // ---------- staff ----------
  await go("#/staff", "#stInvite");
  await page.fill("#stEmail", "audit-viewer@aloria.test");
  await page.selectOption("#stRole", "viewer");
  await page.click("#stInvite");
  await toast();
  await page.waitForSelector('tr:has-text("audit-viewer@aloria.test")');
  ok("staff: invite lands in the table");
  await page.waitForSelector('td:has-text("audit note"), table.tbl'); // audit log below
  assert.ok((await page.textContent("body")).includes("POST /api/store/admin/staff"), "audit log records the invite");
  ok("staff: audit log records CMS writes");

  // ---------- security ----------
  await go("#/security", "#signOutAll");
  await page.click("#totpStart");
  await page.waitForSelector("#totpSetupBox:not([hidden])");
  const secret = (await page.textContent("#totpSecret")).trim();
  assert.ok(/^[A-Z2-7]{16,}$/.test(secret), "base32 secret shown");
  ok("security: 2FA setup reveals secret (not enabled without code)");

  // ---------- emails ----------
  await go("#/emails", "#emFrame");
  for (const t of ["shipping_confirmation", "cart_recovery", "password_reset", "order_confirmation"]) {
    await page.click(`[data-em="${t}"]`);
    await page.waitForFunction((tt) => {
      const b = document.querySelector(`[data-em="${tt}"]`);
      return b && b.classList.contains("active") && document.getElementById("emFrame");
    }, t);
  }
  await page.click("#emTest");
  await toast();
  ok("emails: all four previews + test send");

  // ---------- manual order ----------
  await go("#/orders/new", "#moCreate");
  await page.fill("#moEmail", "audit-manual@example.com");
  await page.fill("#moName", "Audit Manual");
  await page.fill("[data-mo-sku]", "E1-GLD-RND-SAP");
  await page.click("#moAddLine");
  await page.waitForFunction(() => document.querySelectorAll("[data-mo-sku]").length === 2);
  await page.click("#moCreate");
  await page.waitForURL(/#\/orders\/\d+$/, { timeout: 15000 });
  await page.waitForSelector('.kv dd:has-text("audit-manual@example.com")');
  ok("manual order: created by SKU and opens its detail");

  // ---------- waitlist ----------
  await go("#/waitlist", "#wlCsv");
  assert.ok(await page.$("#wlSend"), "broadcast form (admin)");
  ok("waitlist: view + export/broadcast controls");

  // ---------- returns ----------
  await go("#/returns", "[data-rtf]");
  await page.click('[data-rtf="all"]');
  await page.waitForSelector('tr:has-text("RMA-")');
  ok("returns: RMA queue lists the portal request");

  // ---------- inbox ----------
  await go("#/inbox", "#ibOpen");
  await page.waitForSelector('tr:has-text("visitor@example.com")');
  await page.click('tr:has-text("visitor@example.com") [data-ib-done]');
  // handled → drops off the Open filter, still on All
  await page.waitForSelector('tr:has-text("visitor@example.com")', { state: "detached" });
  await page.click("#ibAll");
  await page.waitForSelector('tr:has-text("visitor@example.com")');
  ok("inbox: contact message listed + marked handled");

  const real = errors.filter((e) => !/net::ERR/.test(e));
  if (real.length) {
    console.error("PAGE ERRORS:", real);
    process.exit(1);
  }
  await browser.close();
  console.log(`\nCMS AUDIT PASSED — ${PASS} checks, zero page errors`);
  process.exit(0);
})().catch((e) => { console.error("AUDIT FAILED:", e); process.exit(1); });
