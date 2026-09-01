/* ALORIA CMS — single-page admin console (hash routing, no framework).
   Everything renders from the /api/store/admin/* endpoints; this file is
   pure presentation + calls. */

const $m = () => document.getElementById("adminMain");
const esc = (s) => Store.esc(s);
const fmt = (c, cur = "USD") => Store.money(c, cur);
const dt = (s) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/* ---------- boot & routing ---------- */

const STAFF_ROLES = { viewer: 1, editor: 2, admin: 3 };
let ME = null;
let INTEGRATIONS = { paymentProvider: null, resend: false, blob: false, cronSecret: false };

/** Busy-state wrapper: spinner on the button, double-click proof. */
async function withBusy(btn, fn) {
  if (!btn || btn.classList.contains("busy")) return;
  btn.classList.add("busy");
  try { await fn(); } finally { btn.classList.remove("busy"); }
}

async function boot() {
  const { user } = await Store.api("auth/me").catch(() => ({ user: null }));
  if (!user || !STAFF_ROLES[user.role]) {
    document.getElementById("adminLogin").hidden = false;
    document.getElementById("adminLoginForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById("alMsg");
      try {
        const body = { email: document.getElementById("alEmail").value.trim(), password: document.getElementById("alPass").value };
        const totpEl = document.getElementById("alTotp");
        if (totpEl && !totpEl.closest(".field").hidden) body.code = totpEl.value.trim();
        const r = await Store.api("auth/login", { method: "POST", body });
        if (r.requiresTotp) {
          // 2FA account — reveal the code field and resubmit
          let field = document.getElementById("alTotp");
          if (!field) {
            const div = document.createElement("div");
            div.className = "field";
            div.innerHTML = '<label for="alTotp">Authenticator code</label><input id="alTotp" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456">';
            document.getElementById("alPass").closest(".field").after(div);
            field = div.querySelector("input");
          }
          field.focus();
          msg.textContent = "Enter the 6-digit code from your authenticator app";
          msg.className = "form-msg ok";
          return;
        }
        if (!STAFF_ROLES[r.user.role]) { msg.textContent = "This account doesn't have CMS access"; msg.className = "form-msg err"; return; }
        location.reload();
      } catch (e) { msg.textContent = e.message; msg.className = "form-msg err"; }
    });
    return;
  }
  ME = user;
  document.getElementById("adminShell").hidden = false;
  document.getElementById("adminWho").textContent = `${user.email} · ${user.role}`;
  document.querySelectorAll("[data-min-role]").forEach((a) => {
    if (STAFF_ROLES[user.role] < STAFF_ROLES[a.dataset.minRole]) a.remove();
  });
  Store.api("admin/settings").then((r) => { INTEGRATIONS = r.integrations; }).catch(() => {});
  document.getElementById("adminLogout").onclick = async () => { await Store.api("auth/logout", { method: "POST" }); location.reload(); };
  window.addEventListener("hashchange", route);
  route();
}

const ROUTES = [
  ...(window.EXT_ROUTES || []), // round-3 views (admin-ext.js) — matched first
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/products$/, viewProducts],
  [/^#\/products\/(new|\d+)$/, (m) => viewProductEditor(m[1])],
  [/^#\/orders$/, viewOrders],
  [/^#\/orders\/(\d+)$/, (m) => viewOrderDetail(m[1])],
  [/^#\/carts$/, viewCarts],
  [/^#\/customers$/, viewCustomers],
  [/^#\/discounts$/, viewDiscounts],
  [/^#\/waitlist$/, viewWaitlist],
];

function route() {
  const hash = location.hash || "#/dashboard";
  document.querySelectorAll("[data-nav]").forEach((a) =>
    a.classList.toggle("active", hash.startsWith(`#/${a.dataset.nav}`)));
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      const loader = document.getElementById("routeLoader");
      const scroller = document.getElementById("adminMainScroll");
      // freeze current height while loading so the frame never jumps
      $m().style.minHeight = `${$m().offsetHeight}px`;
      if (loader) loader.classList.add("on");
      fn(m).catch(showError).finally(() => {
        if (loader) loader.classList.remove("on");
        $m().style.minHeight = "";
        if (scroller) scroller.scrollTop = 0;
      });
      return;
    }
  }
  location.hash = "#/dashboard";
}

function showError(e) {
  $m().innerHTML = `<div class="admin-head"><h1 class="serif">Hmm.</h1></div>
    <div class="panel pad"><p class="admin-msg err">${esc(e.message)}</p></div>`;
}

const pill = (s) => `<span class="status-pill ${esc(s)}">${esc(s)}</span>`;

/* ---------- dashboard ---------- */

function deltaHtml(cur, prev, isMoney) {
  if (!prev) return '<div class="delta flat">— vs previous period</div>';
  const pct = Math.round(((cur - prev) / prev) * 100);
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "—";
  return `<div class="delta ${cls}">${arrow} ${Math.abs(pct)}% vs previous ${isMoney ? "" : ""}period</div>`;
}

async function viewDashboard() {
  const state = viewDashboard.state || (viewDashboard.state = { days: 14 });
  const m = await Store.api(`admin/metrics?days=${state.days}`);
  const p = m.previous || {};
  const funnelRow = (label, value, max, suffix = "") => `
    <div class="funnel-row"><span class="fl">${label}</span>
      <div class="funnel-bar"><i style="width:${max ? Math.max(1, (value / max) * 100) : 0}%"></i></div>
      <span class="fv">${value}${suffix}</span></div>`;
  const f = m.funnel;
  const catMax = Math.max(1, ...m.byCategory.map((c) => c.revenueCents));
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Dashboard</h1>
      <div class="range-chips">${[7, 14, 30, 90].map((d) => `
        <button class="${state.days === d ? "active" : ""}" data-days="${d}" type="button">${d}d</button>`).join("")}
      </div>
      ${m.totalProducts === 0 ? '<button class="btn gold" id="seedBtn">Seed launch catalog</button>' : ""}
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Revenue (${m.days}d)</div><div class="v">${fmt(m.revenueCents)}</div>${deltaHtml(m.revenueCents, p.revenueCents, true)}</div>
      <div class="tile"><div class="k">Paid orders</div><div class="v">${m.paidOrders}</div>${deltaHtml(m.paidOrders, p.paidOrders)}</div>
      <div class="tile"><div class="k">Average order</div><div class="v">${fmt(m.aovCents)}</div>${deltaHtml(m.aovCents, p.aovCents, true)}</div>
      <div class="tile"><div class="k">Recovered revenue</div><div class="v">${fmt(m.recoveredRevenueCents)}</div><div class="s">${m.recoveredOrders} rescued orders</div></div>
      <div class="tile"><div class="k">Abandoned bags</div><div class="v">${m.abandonedCarts}</div><div class="s">${fmt(m.abandonedValueCents)} waiting</div></div>
      <div class="tile"><div class="k">Live products</div><div class="v">${m.activeProducts}<span style="font-size:1rem;color:var(--ink-soft)">/${m.totalProducts}</span></div><div class="s">${m.lowStockVariants} low-stock · <a href="#/inventory">inventory →</a></div></div>
    </div>
    ${revenueChartHtml(m.revenueByDay || [])}
    <div class="split-2">
      <div class="panel">
        <div class="panel-head"><h2 class="serif">Best sellers (${m.days}d)</h2></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Piece</th><th>SKU</th><th>Units</th><th>Revenue</th></tr></thead>
          <tbody>${m.topProducts.map((t) => `
            <tr><td>${esc(t.title)}</td><td class="mono-cell">${esc(t.sku)}</td>
            <td class="mono-cell">${t.units}</td><td class="mono-cell">${fmt(t.revenueCents)}</td></tr>`).join("") ||
            '<tr><td colspan="4" style="color:var(--ink-soft)">No sales in this period</td></tr>'}
          </tbody></table></div>
        <div class="cat-bars">
          ${m.byCategory.map((c) => `
            <div class="cat-bar-row"><span class="fl mono" style="font-size:0.6rem;text-transform:uppercase;color:var(--ink-soft)">${esc(c.category)}</span>
              <div class="funnel-bar"><i style="width:${Math.max(2, (c.revenueCents / catMax) * 100)}%"></i></div>
              <span class="mono-cell">${fmt(c.revenueCents)}</span></div>`).join("")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2 class="serif">Funnel (${m.days}d)</h2>
          <span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">${f.checkouts ? Math.round((f.paid / Math.max(1, f.cartsCreated)) * 100) : 0}% bag → paid</span></div>
        <div class="funnel">
          ${funnelRow("Bags created", f.cartsCreated, f.cartsCreated)}
          ${funnelRow("Email captured", f.cartsWithEmail, f.cartsCreated)}
          ${funnelRow("Reached checkout", f.checkouts, f.cartsCreated)}
          ${funnelRow("Paid", f.paid, f.cartsCreated)}
          <div style="border-top:1px solid var(--line);margin:0.8rem 0 0.7rem"></div>
          ${funnelRow("Recovery emails", f.recoveryEmails, Math.max(f.recoveryEmails, f.recoveredPaid))}
          ${funnelRow("Rescued orders", f.recoveredPaid, Math.max(f.recoveryEmails, f.recoveredPaid))}
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2 class="serif">Latest orders</h2><a class="mono" href="#/orders" style="font-size:0.62rem">All orders →</a></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Order</th><th>Email</th><th>Status</th><th>Total</th><th>When</th></tr></thead>
        <tbody>${m.recentOrders.map((o) => `
          <tr class="click" data-id="${o.id}"><td class="mono-cell">${esc(o.number)}</td><td>${esc(o.email)}</td>
          <td>${pill(o.status)}</td><td class="mono-cell">${fmt(o.total_cents, o.currency)}</td>
          <td class="mono-cell">${dt(o.created_at)}</td></tr>`).join("") || '<tr><td colspan="5" style="color:var(--ink-soft)">No orders yet</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.querySelectorAll("[data-days]").forEach((b) => {
    b.onclick = () => { state.days = Number(b.dataset.days); viewDashboard(); };
  });
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/orders/${tr.dataset.id}`; }; });
  bindRevenueChart(m.revenueByDay || []);
  const seedBtn = document.getElementById("seedBtn");
  if (seedBtn) seedBtn.onclick = async () => {
    seedBtn.disabled = true;
    try {
      const r = await Store.api("admin/seed", { method: "POST", body: {} });
      Store.toast(`Seeded ${r.productsCreated} products, ${r.variantsCreated} variants`);
      viewDashboard();
    } catch (e) { Store.toast(e.message); seedBtn.disabled = false; }
  };
}

/* ---------- revenue trend (single gold series; line + soft area;
   crosshair + tooltip on hover; table view for accessibility) ---------- */

const CH = { w: 720, h: 160, padX: 10, padTop: 18, padBot: 24 };

function chartGeom(days) {
  const max = Math.max(1, ...days.map((d) => d.revenueCents));
  const innerW = CH.w - CH.padX * 2;
  const innerH = CH.h - CH.padTop - CH.padBot;
  const x = (i) => CH.padX + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const y = (v) => CH.padTop + innerH - (v / max) * innerH;
  return { max, x, y, innerW, innerH };
}

function revenueChartHtml(days) {
  if (!days.length) return "";
  const { max, x, y } = chartGeom(days);
  const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d.revenueCents).toFixed(1)}`);
  const area = `M${pts[0]} L${pts.slice(1).join(" L")} L${x(days.length - 1).toFixed(1)},${(CH.h - CH.padBot).toFixed(1)} L${x(0).toFixed(1)},${(CH.h - CH.padBot).toFixed(1)} Z`;
  const last = days[days.length - 1];
  const fmtDay = (s) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const gridYs = [0.25, 0.5, 0.75].map((f) => (CH.padTop + (1 - f) * (CH.h - CH.padTop - CH.padBot)).toFixed(1));
  return `
    <div class="panel chart-panel">
      <div class="panel-head"><h2 class="serif">Revenue — last ${days.length} days</h2>
        <span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">peak ${fmt(max)}</span></div>
      <div class="pad">
        <div class="chart-wrap" id="revChart">
          <svg viewBox="0 0 ${CH.w} ${CH.h}" role="img" aria-label="Daily revenue for the last 14 days, peaking at ${fmt(max)}">
            ${gridYs.map((gy) => `<line x1="${CH.padX}" x2="${CH.w - CH.padX}" y1="${gy}" y2="${gy}" stroke="#e9e4dc" stroke-width="1"/>`).join("")}
            <line x1="${CH.padX}" x2="${CH.w - CH.padX}" y1="${CH.h - CH.padBot}" y2="${CH.h - CH.padBot}" stroke="#d9d2c6" stroke-width="1"/>
            <path d="${area}" fill="#b08d3e" opacity="0.10"/>
            <polyline points="${pts.join(" ")}" fill="none" stroke="#b08d3e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="${x(days.length - 1).toFixed(1)}" cy="${y(last.revenueCents).toFixed(1)}" r="4" fill="#b08d3e" stroke="#ffffff" stroke-width="2"/>
            <text x="${CH.padX}" y="${CH.h - 7}" font-size="10" font-family="monospace" fill="#55504a">${fmtDay(days[0].day)}</text>
            <text x="${CH.w - CH.padX}" y="${CH.h - 7}" font-size="10" font-family="monospace" fill="#55504a" text-anchor="end">${fmtDay(last.day)}</text>
            <line id="revCross" y1="${CH.padTop}" y2="${CH.h - CH.padBot}" stroke="#14120f" stroke-width="1" opacity="0"/>
            <circle id="revDot" r="4" fill="#b08d3e" stroke="#ffffff" stroke-width="2" opacity="0"/>
          </svg>
          <div class="chart-tip" id="revTip"></div>
        </div>
      </div>
      <details class="chart-table">
        <summary>View as table</summary>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Day</th><th>Revenue</th><th>Orders</th></tr></thead>
          <tbody>${days.map((d) => `<tr><td class="mono-cell">${fmtDay(d.day)}</td><td class="mono-cell">${fmt(d.revenueCents)}</td><td class="mono-cell">${d.orders}</td></tr>`).join("")}</tbody>
        </table></div>
      </details>
    </div>`;
}

function bindRevenueChart(days) {
  const wrap = document.getElementById("revChart");
  if (!wrap || !days.length) return;
  const svg = wrap.querySelector("svg");
  const tip = document.getElementById("revTip");
  const cross = document.getElementById("revCross");
  const dot = document.getElementById("revDot");
  const { x, y } = chartGeom(days);
  const fmtDay = (s) => new Date(s).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  function show(ev) {
    const rect = svg.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * CH.w;
    let best = 0;
    for (let i = 1; i < days.length; i++) if (Math.abs(x(i) - relX) < Math.abs(x(best) - relX)) best = i;
    const d = days[best];
    cross.setAttribute("x1", x(best)); cross.setAttribute("x2", x(best)); cross.setAttribute("opacity", "0.25");
    dot.setAttribute("cx", x(best)); dot.setAttribute("cy", y(d.revenueCents)); dot.setAttribute("opacity", "1");
    tip.innerHTML = `${fmtDay(d.day)} · <b>${fmt(d.revenueCents)}</b> · ${d.orders} order${d.orders === 1 ? "" : "s"}`;
    tip.style.left = `${(x(best) / CH.w) * rect.width}px`;
    tip.style.top = `${(y(d.revenueCents) / CH.h) * rect.height}px`;
    tip.style.opacity = "1";
  }
  function hide() {
    tip.style.opacity = "0";
    cross.setAttribute("opacity", "0");
    dot.setAttribute("opacity", "0");
  }
  wrap.addEventListener("mousemove", show);
  wrap.addEventListener("mouseleave", hide);
}

/* ---------- products ---------- */

async function viewProducts() {
  const state = viewProducts.state || (viewProducts.state = { q: "", status: "", category: "" });
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.status) params.set("status", state.status);
  if (state.category) params.set("category", state.category);
  const { products } = await Store.api(`admin/products?${params}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Products</h1>
      <div class="toolbar">
        <button class="btn ghost small" id="csvExport" type="button">Export CSV</button>
        <button class="btn ghost small" id="csvImport" type="button">Import CSV</button>
        <a class="btn" href="#/products/new">＋ New product</a>
      </div></div>
    <div class="panel">
      <div class="panel-head">
        <div class="toolbar">
          <input id="pQ" placeholder="Search…" value="${esc(state.q)}">
          <select id="pStatus">
            <option value="">All statuses</option>
            ${["draft", "active", "archived"].map((s) => `<option ${state.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <select id="pCat">
            <option value="">All categories</option>
            ${["ear", "neck", "rings"].map((s) => `<option ${state.category === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <span class="mono" style="font-size:0.62rem;color:var(--ink-soft)">${products.length} shown</span>
      </div>
      <div class="bulk-bar" id="bulkBar" hidden>
        <span class="mono" id="bulkCount"></span>
        <button class="btn ghost small" data-bulk="activate" type="button">Activate</button>
        <button class="btn ghost small" data-bulk="draft" type="button">Draft</button>
        <button class="btn ghost small" data-bulk="archive" type="button">Archive</button>
        <button class="btn ghost small" data-bulk="feature" type="button">Feature</button>
        <button class="btn ghost small" data-bulk="unfeature" type="button">Unfeature</button>
        <span class="mono">price:</span>
        <input id="bulkPriceVal" inputmode="numeric" placeholder="±10 (%) or ±500 (¢)" style="border:1px solid var(--line);border-radius:100px;padding:0.4rem 0.9rem;font-family:var(--mono);font-size:0.66rem;max-width:150px">
        <select id="bulkPriceMode" style="border:1px solid var(--line);border-radius:100px;padding:0.4rem 0.7rem;font-family:var(--mono);font-size:0.66rem"><option value="percent">%</option><option value="cents">¢</option></select>
        <button class="btn ghost small" data-bulk="price" type="button">Apply price change</button>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th><input type="checkbox" id="selAll" style="width:auto;min-width:0"></th><th></th><th>Product</th><th>Category</th><th>Status</th><th>Base price</th><th>Variants</th><th>Stock</th></tr></thead>
        <tbody>${products.map((p) => `
          <tr class="click" data-id="${p.id}">
            <td><input type="checkbox" data-sel="${p.id}" style="width:auto;min-width:0"></td>
            <td>${(p.images || [])[0] ? `<img class="thumb" src="${esc(p.images[0])}" alt="">` : ""}</td>
            <td><b>${esc(p.title)}</b><br><span class="mono-cell" style="color:var(--ink-soft)">/${esc(p.slug)}</span></td>
            <td>${esc(p.category)}</td><td>${pill(p.status)}</td>
            <td class="mono-cell">${fmt(p.price_cents, p.currency)}</td>
            <td class="mono-cell">${p.variant_count}</td>
            <td class="mono-cell" ${p.total_stock <= 5 ? 'style="color:var(--ruby)"' : ""}>${p.total_stock}</td>
          </tr>`).join("") || '<tr><td colspan="8" style="color:var(--ink-soft)">No products — hit “New product” or seed the catalog from the dashboard.</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.querySelectorAll("tr.click").forEach((tr) => {
    tr.onclick = (ev) => {
      if (ev.target.closest("input")) return; // checkbox clicks don't navigate
      location.hash = `#/products/${tr.dataset.id}`;
    };
  });
  document.getElementById("pQ").onchange = (e) => { state.q = e.target.value; viewProducts(); };
  document.getElementById("pStatus").onchange = (e) => { state.status = e.target.value; viewProducts(); };
  document.getElementById("pCat").onchange = (e) => { state.category = e.target.value; viewProducts(); };

  // selection + bulk actions
  const selected = () => [...document.querySelectorAll("[data-sel]:checked")].map((cb) => Number(cb.dataset.sel));
  const syncBulk = () => {
    const n = selected().length;
    document.getElementById("bulkBar").hidden = n === 0;
    document.getElementById("bulkCount").textContent = `${n} selected`;
  };
  document.querySelectorAll("[data-sel]").forEach((cb) => { cb.onchange = syncBulk; });
  document.getElementById("selAll").onchange = (e) => {
    document.querySelectorAll("[data-sel]").forEach((cb) => { cb.checked = e.target.checked; });
    syncBulk();
  };
  document.querySelectorAll("[data-bulk]").forEach((b) => {
    b.onclick = async () => {
      const body = { ids: selected(), action: b.dataset.bulk };
      if (b.dataset.bulk === "price") {
        body.mode = document.getElementById("bulkPriceMode").value;
        body.value = parseInt(document.getElementById("bulkPriceVal").value, 10);
        if (!Number.isFinite(body.value)) { Store.toast("Enter a price change value"); return; }
      }
      try {
        const r = await Store.api("admin/products/bulk", { method: "POST", body });
        Store.toast(`${r.affected} products updated`);
        viewProducts();
      } catch (e) { Store.toast(e.message); }
    };
  });

  // catalog CSV round-trip
  document.getElementById("csvExport").onclick = async () => {
    const resp = await fetch("/api/store/admin/catalog/export", { credentials: "same-origin" });
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "aloria-catalog.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  document.getElementById("csvImport").onclick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const r = await Store.api("admin/catalog/import", { method: "POST", body: { csv: await file.text() } });
        Store.toast(`Imported: ${r.productsTouched} products, ${r.variantsTouched} variants`);
        viewProducts();
      } catch (e) { Store.toast(e.message); }
    };
    input.click();
  };
}

/* ---------- product editor ---------- */

/* The Aloria design-doc axis library (frontend/data/skus.json). Every
   variation the brand system defines is addable with one click:
   - Base:       Plating (925 silver in Gold / Rhodium)
   - Stones:     Stone Shape × Stone Color (primary pieces E1-3/N1-3/R1-3)
   - Components: Texture (orbit jackets E4/N4/R4), Length (chains E5/N5),
                 Width (stacker R5)
   - Rings:      Ring Size US 3–10 (R-SIZE) */
const ALORIA_AXES = [
  { group: "Base", name: "Plating", values: ["Gold", "Rhodium"] },
  { group: "Stones", name: "Stone Shape", values: ["Round", "Oval", "Pear", "Emerald Cut", "Heart"] },
  { group: "Stones", name: "Stone Color", values: ["Crystal", "Emerald", "Sapphire", "Ruby"] },
  { group: "Components", name: "Texture", values: ["Plain", "Pavé"] },
  { group: "Components", name: "Length", values: ["Short", "Long"] },
  { group: "Components", name: "Width", values: ["Thin", "Wide"] },
  { group: "Rings", name: "Ring Size", values: ["US 3", "US 4", "US 5", "US 6", "US 7", "US 8", "US 9", "US 10"] },
];

/* stone colors → dot color + swatch imagery for one-click image mapping */
const STONE_META = {
  crystal: { dot: "#cfc9e2", swatch: "/assets/img/swatches/variant_clear.webp" },
  emerald: { dot: "#0f7a4d", swatch: "/assets/img/swatches/variant_emerald.webp" },
  sapphire: { dot: "#1e4fc2", swatch: "/assets/img/swatches/variant_sapphire.webp" },
  ruby: { dot: "#c0143c", swatch: "/assets/img/swatches/variant_ruby.webp" },
  pink: { dot: "#e0619b", swatch: "/assets/img/swatches/variant_pink.webp" },
};

let ed = null; // { product, variants, isNew }

async function viewProductEditor(idOrNew) {
  if (idOrNew === "new") {
    ed = {
      isNew: true,
      product: { title: "", subtitle: "", slug: "", description: "", category: "ear", status: "draft", price_cents: 0, images: [], options: [], featured: false, seo_title: "", seo_description: "", video_url: "", publish_at: null },
      variants: [],
    };
  } else {
    const r = await Store.api(`admin/products/${idOrNew}`);
    ed = { isNew: false, product: r.product, variants: r.variants };
  }
  renderEditor();
}

function renderEditor() {
  const p = ed.product;
  $m().innerHTML = `
    <div class="admin-head">
      <h1 class="serif">${ed.isNew ? "New product" : esc(p.title)}</h1>
      <div class="toolbar">
        ${!ed.isNew ? `<a class="btn ghost small" href="/shop/product?slug=${encodeURIComponent(p.slug)}" target="_blank" rel="noopener">View ↗</a>` : ""}
        ${!ed.isNew ? '<button class="btn ghost small" id="dupBtn" type="button">Duplicate</button>' : ""}
        ${!ed.isNew ? '<button class="btn ghost small" id="delBtn" style="border-color:var(--ruby);color:var(--ruby)">Delete</button>' : ""}
        <button class="btn small" id="saveBtn">Save product</button>
      </div>
    </div>
    <div class="edit-grid">
      <div>
        <div class="panel pad">
          <div class="field"><label>Title</label><input id="eTitle" value="${esc(p.title)}"></div>
          <div class="form-row">
            <div class="field"><label>Slug (URL)</label><input id="eSlug" value="${esc(p.slug)}" placeholder="auto from title"></div>
            <div class="field"><label>Base price (cents)</label><input id="ePrice" inputmode="numeric" value="${p.price_cents}"></div>
          </div>
          <div class="field"><label>Subtitle</label><input id="eSubtitle" value="${esc(p.subtitle)}"></div>
          <div class="field"><label>Description</label><textarea id="eDesc" rows="4">${esc(p.description)}</textarea></div>
          <div class="form-row">
            <div class="field"><label>Category</label>
              <select id="eCat">${["ear", "neck", "rings"].map((c) => `<option ${p.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
            <div class="field"><label>Status</label>
              <select id="eStatus">${["draft", "active", "archived"].map((c) => `<option ${p.status === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
          </div>
          <div class="field"><label style="display:flex;gap:0.5rem;align-items:center;text-transform:none;letter-spacing:0.05em">
            <input type="checkbox" id="eFeatured" style="width:auto" ${p.featured ? "checked" : ""}> Featured (Signature badge, sorts first)</label></div>
          <div class="form-row">
            <div class="field"><label>SEO title (optional)</label><input id="eSeoTitle" value="${esc(p.seo_title || "")}" maxlength="70"></div>
            <div class="field"><label>Publish at (drafts go live automatically)</label><input id="ePublishAt" type="datetime-local" value="${p.publish_at ? toLocalInput(p.publish_at) : ""}"></div>
          </div>
          <div class="field"><label>SEO description (optional)</label><input id="eSeoDesc" value="${esc(p.seo_description || "")}" maxlength="170"></div>
          <div class="field"><label>Video URL (optional — "worn &amp; moving" clip on the product page)</label><input id="eVideoUrl" value="${esc(p.video_url || "")}" placeholder="https://… or /assets/video/…"></div>
        </div>
        ${ed.isNew ? "" : renderVariantsPanel()}
      </div>
      <div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Images</h2>
          <div id="imgRows">${(p.images || []).map((src, i) => imgRow(src, i)).join("")}</div>
          <button class="btn ghost small" id="addImg" type="button">＋ Add image path</button>
          <label class="btn ghost small upload-btn" style="margin-left:0.4rem;${INTEGRATIONS.blob ? "" : "opacity:0.45;pointer-events:none"}"
            title="${INTEGRATIONS.blob ? "Upload an image file" : "Connect Vercel Blob to enable uploads (Settings → Integrations); asset paths still work"}">
            Upload…<input type="file" id="imgUpload" accept="image/*" ${INTEGRATIONS.blob ? "" : "disabled"}></label>
          <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.7rem">Paths under /assets/img/… or full https:// URLs. First image is the card image.</p>
        </div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Options</h2>
          <div class="axis-lib" id="presetChips">
            ${["Base", "Stones", "Components", "Rings"].map((group) => `
              <div class="axis-group-label">${group}</div>
              <div class="preset-chips">
                ${ALORIA_AXES.filter((a) => a.group === group).map((axis) => {
                  const has = (p.options || []).some((o) => o.name.toLowerCase() === axis.name.toLowerCase());
                  const full = (p.options || []).length >= 3;
                  return `<button type="button" data-preset="${esc(axis.name)}" ${has || full ? "disabled" : ""}
                    title="${esc(axis.values.join(" · "))}">＋ ${esc(axis.name)}</button>`;
                }).join("")}
                ${group === "Stones" ? `<button type="button" data-preset="*" ${(p.options || []).length >= 3 ? "disabled" : ""}
                  title="Plating × Stone Shape × Stone Color — the full 40-SKU primary matrix">✦ Full matrix</button>` : ""}
              </div>`).join("")}
          </div>
          <div id="optRows">${(p.options || []).map((o, i) => optRow(o, i)).join("")}</div>
          <button class="btn ghost small" id="addOpt" type="button" ${(p.options || []).length >= 3 ? "disabled" : ""}>＋ Custom option</button>
          <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.7rem">Every axis from the design doc, one click each — platings, stone shapes &amp; colors, jacket textures, chain lengths, band widths, US ring sizes. Up to 3 axes per product; “Generate matrix” below builds every combination.</p>
        </div>
      </div>
    </div>
    <div class="admin-msg" id="eMsg"></div>`;

  document.getElementById("saveBtn").onclick = saveProduct;
  const del = document.getElementById("delBtn");
  if (del) del.onclick = deleteProduct;
  document.getElementById("addImg").onclick = () => {
    collectEditorFields();
    ed.product.images.push("");
    renderEditor();
  };
  document.getElementById("addOpt").onclick = () => {
    collectEditorFields();
    ed.product.options.push({ name: "", values: [] });
    renderEditor();
  };
  // one-click design-doc axes ("*" = Plating × Stone Shape × Stone Color)
  const CORE_MATRIX = ["Plating", "Stone Shape", "Stone Color"];
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = () => {
      collectEditorFields();
      const wanted = b.dataset.preset === "*"
        ? ALORIA_AXES.filter((a) => CORE_MATRIX.includes(a.name))
        : ALORIA_AXES.filter((a) => a.name === b.dataset.preset);
      for (const axis of wanted) {
        const exists = ed.product.options.some((o) => o.name.toLowerCase() === axis.name.toLowerCase());
        if (!exists && ed.product.options.length < 3) {
          ed.product.options.push({ name: axis.name, values: [...axis.values] });
        }
      }
      renderEditor();
      Store.toast("Axis added — Generate matrix builds every combination");
    };
  });
  const dupBtn = document.getElementById("dupBtn");
  if (dupBtn) dupBtn.onclick = async () => {
    try {
      const r = await Store.api(`admin/products/${ed.product.id}/duplicate`, { method: "POST", body: {} });
      Store.toast("Duplicated as draft (variants copied, stock 0)");
      location.hash = `#/products/${r.product.id}`;
    } catch (e) { Store.toast(e.message); }
  };
  const uploadInput = document.getElementById("imgUpload");
  if (uploadInput) uploadInput.onchange = async () => {
    const file = uploadInput.files[0];
    if (!file) return;
    try {
      const data = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await Store.api("admin/uploads", { method: "POST", body: { filename: file.name, data } });
      collectEditorFields();
      ed.product.images.push(r.url);
      renderEditor();
      Store.toast("Image uploaded");
    } catch (e) { Store.toast(e.message); }
  };
  bindRowRemovers();
  if (!ed.isNew) bindVariantEvents();
}

const imgRow = (src, i) => `
  <div class="img-row" data-img="${i}">
    ${src ? `<img src="${esc(src)}" alt="">` : '<div style="width:44px;height:44px;border:1px dashed var(--line);border-radius:4px"></div>'}
    <input value="${esc(src)}" data-img-input="${i}" placeholder="/assets/img/…">
    <button class="icon-btn" data-rm-img="${i}" type="button" aria-label="Remove image">×</button>
  </div>`;

const optRow = (o, i) => `
  <div class="opt-row" data-opt="${i}">
    <input value="${esc(o.name)}" data-opt-name="${i}" placeholder="Option (Plating)">
    <input value="${esc((o.values || []).join(", "))}" data-opt-values="${i}" placeholder="Values, comma separated (Gold, Rhodium)">
    <button class="icon-btn" data-rm-opt="${i}" type="button" aria-label="Remove option">×</button>
  </div>`;

function bindRowRemovers() {
  document.querySelectorAll("[data-rm-img]").forEach((b) => {
    b.onclick = () => { collectEditorFields(); ed.product.images.splice(Number(b.dataset.rmImg), 1); renderEditor(); };
  });
  document.querySelectorAll("[data-rm-opt]").forEach((b) => {
    b.onclick = () => { collectEditorFields(); ed.product.options.splice(Number(b.dataset.rmOpt), 1); renderEditor(); };
  });
}

function collectEditorFields() {
  const p = ed.product;
  p.title = document.getElementById("eTitle").value;
  p.slug = document.getElementById("eSlug").value;
  p.price_cents = parseInt(document.getElementById("ePrice").value, 10) || 0;
  p.subtitle = document.getElementById("eSubtitle").value;
  p.description = document.getElementById("eDesc").value;
  p.category = document.getElementById("eCat").value;
  p.status = document.getElementById("eStatus").value;
  p.featured = document.getElementById("eFeatured").checked;
  p.seo_title = document.getElementById("eSeoTitle").value;
  p.seo_description = document.getElementById("eSeoDesc").value;
  p.video_url = document.getElementById("eVideoUrl").value.trim();
  p.publish_at = document.getElementById("ePublishAt").value || null;
  p.images = [...document.querySelectorAll("[data-img-input]")].map((i) => i.value.trim()).filter(Boolean);
  p.options = [...document.querySelectorAll("[data-opt]")].map((row) => {
    const idx = row.dataset.opt;
    return {
      name: row.querySelector(`[data-opt-name="${idx}"]`).value.trim(),
      values: row.querySelector(`[data-opt-values="${idx}"]`).value.split(",").map((v) => v.trim()).filter(Boolean),
    };
  }).filter((o) => o.name && o.values.length);
}

function productBody() {
  const p = ed.product;
  const body = {
    title: p.title, subtitle: p.subtitle, description: p.description,
    category: p.category, status: p.status, price_cents: p.price_cents,
    images: p.images, options: p.options, featured: p.featured,
    seo_title: p.seo_title, seo_description: p.seo_description, video_url: p.video_url || "",
    publish_at: p.publish_at ? new Date(p.publish_at).toISOString() : null,
  };
  if (p.slug) body.slug = p.slug;
  return body;
}

/** Persist the product form (fields + options). Used by both save buttons so
    the variant matrix can never run against stale options. */
async function persistProduct() {
  collectEditorFields();
  const r = await Store.api(`admin/products/${ed.product.id}`, { method: "PATCH", body: productBody() });
  ed.product = r.product;
  return r.product;
}

async function saveProduct() {
  const msg = document.getElementById("eMsg");
  await withBusy(document.getElementById("saveBtn"), async () => {
    try {
      if (ed.isNew) {
        collectEditorFields();
        const r = await Store.api("admin/products", { method: "POST", body: productBody() });
        Store.toast("Product created — now build its variants");
        location.hash = `#/products/${r.product.id}`;
      } else {
        await persistProduct();
        Store.toast("Saved");
        renderEditor();
      }
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
}

async function deleteProduct() {
  if (!confirm(`Delete "${ed.product.title}"? Sold products are archived instead.`)) return;
  try {
    const r = await Store.api(`admin/products/${ed.product.id}`, { method: "DELETE" });
    Store.toast(r.archived ? "Product archived (it has sales history)" : "Product deleted");
    location.hash = "#/products";
  } catch (e) { Store.toast(e.message); }
}

/* ---------- variants matrix ---------- */

/* datetime-local wants local wall time, not UTC */
function toLocalInput(iso) {
  const t = new Date(iso);
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function skuBase(p) {
  return (p.title || "SKU").split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "SKU";
}
const valCode = (v) => String(v).normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 3) || "X";

function renderVariantsPanel() {
  const optionNames = (ed.product.options || []).map((o) => o.name);
  const hasColorAxis = optionNames.some((n) => /color/i.test(n));
  return `
    <div class="panel">
      <div class="panel-head">
        <h2 class="serif">Variants <span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">${ed.variants.length}</span></h2>
        <div class="toolbar">
          <button class="btn ghost small" id="genMatrix" type="button" title="Build every combination of the options above">Generate matrix</button>
          ${hasColorAxis ? '<button class="btn ghost small" id="mapSwatches" type="button" title="Fill empty variant images with the matching stone swatch (Crystal/Emerald/Sapphire/Ruby)">Map stone swatches</button>' : ""}
          <button class="btn small" id="saveVariants" type="button" title="Saves the product options and every variant row together">Save variants</button>
        </div>
      </div>
      <div class="tbl-wrap"><table class="tbl" id="varTable">
        <thead><tr>${optionNames.map((n) => `<th>${esc(n)}</th>`).join("")}
          <th>SKU</th><th>Price ¢ <span style="text-transform:none">(blank = base)</span></th><th>Stock</th><th>Image</th><th>Active</th><th></th></tr></thead>
        <tbody>${ed.variants.map((v, i) => variantRow(v, i, optionNames)).join("") ||
          `<tr><td colspan="${optionNames.length + 6}" style="color:var(--ink-soft)">No variants yet — define options, save, then “Generate matrix”. A product needs at least one variant to be purchasable.</td></tr>`}
        </tbody></table></div>
      <div class="pad admin-msg" id="vMsg" style="margin-top:0"></div>
    </div>`;
}

function variantRow(v, i, optionNames) {
  return `<tr data-vrow="${i}">
    ${optionNames.map((n) => {
      const val = (v.options || {})[n];
      const meta = val && /color/i.test(n) && STONE_META[String(val).toLowerCase()];
      return `<td class="mono-cell">${meta ? `<i class="stone-dot" style="background:${meta.dot}"></i>` : ""}${esc(val || "—")}</td>`;
    }).join("")}
    <td><input class="w-sku" value="${esc(v.sku || "")}" data-v="${i}" data-f="sku"></td>
    <td><input class="w-num" value="${v.price_cents == null ? "" : v.price_cents}" data-v="${i}" data-f="price_cents" inputmode="numeric" placeholder="base"></td>
    <td><input class="w-num" value="${v.stock == null ? 0 : v.stock}" data-v="${i}" data-f="stock" inputmode="numeric"></td>
    <td><div style="display:flex;gap:0.3rem;align-items:center">
      <button class="row-upload" data-vup="${i}" type="button" ${INTEGRATIONS.blob ? "" : "disabled"}
        title="${INTEGRATIONS.blob ? "Upload an image for this variant" : "Connect Vercel Blob to upload (Settings → Integrations); paths still work"}"
        aria-label="Upload variant image">↥</button>
      <input class="w-img" value="${esc(v.image || "")}" data-v="${i}" data-f="image" placeholder="/assets/img/…">
    </div></td>
    <td style="text-align:center"><input type="checkbox" style="width:auto;min-width:0" data-v="${i}" data-f="active" ${v.active !== false ? "checked" : ""}></td>
    <td><button class="icon-btn" data-rm-v="${i}" type="button" aria-label="Remove variant">×</button></td>
  </tr>`;
}

function collectVariantRows() {
  document.querySelectorAll("[data-v]").forEach((input) => {
    const v = ed.variants[Number(input.dataset.v)];
    if (!v) return;
    const f = input.dataset.f;
    if (f === "active") v.active = input.checked;
    else if (f === "price_cents") v.price_cents = input.value.trim() === "" ? null : parseInt(input.value, 10) || 0;
    else if (f === "stock") v.stock = parseInt(input.value, 10) || 0;
    else v[f] = input.value.trim();
  });
}

function bindVariantEvents() {
  const gen = document.getElementById("genMatrix");
  if (!gen) return;
  gen.onclick = () => {
    collectEditorFields();
    collectVariantRows();
    const opts = ed.product.options || [];
    if (!opts.length) { Store.toast("Define options first (then save the product)"); return; }
    const combos = opts.reduce((acc, g) => acc.flatMap((row) => g.values.map((val) => ({ ...row, [g.name]: val }))), [{}]);
    const sig = (o) => JSON.stringify(opts.map((g) => (o || {})[g.name]));
    const existing = new Map(ed.variants.map((v) => [sig(v.options), v]));
    ed.variants = combos.map((options) =>
      existing.get(sig(options)) || {
        sku: [skuBase(ed.product), ...Object.values(options).map(valCode)].join("-"),
        options, price_cents: null, stock: 0, image: "", active: true,
      });
    renderEditor();
    Store.toast(`${ed.variants.length} variant rows — review and save`);
  };
  document.getElementById("saveVariants").onclick = async (ev) => {
    await withBusy(ev.currentTarget, async () => {
      collectVariantRows();
      const msg = document.getElementById("vMsg");
      try {
        await persistProduct(); // options + fields first, so the matrix always validates
        const r = await Store.api(`admin/products/${ed.product.id}/variants`, {
          method: "PUT",
          body: { variants: ed.variants.map((v) => ({ ...v, image: v.image || null })) },
        });
        ed.variants = r.variants;
        Store.toast("Product + variants saved");
        renderEditor();
      } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
    });
  };
  // fill empty images with the matching stone swatch, per the design doc
  const mapBtn = document.getElementById("mapSwatches");
  if (mapBtn) mapBtn.onclick = () => {
    collectVariantRows();
    const colorAxis = (ed.product.options || []).map((o) => o.name).find((n) => /color/i.test(n));
    let mapped = 0;
    for (const v of ed.variants) {
      const meta = colorAxis && STONE_META[String((v.options || {})[colorAxis] || "").toLowerCase()];
      if (meta && !v.image) { v.image = meta.swatch; mapped++; }
    }
    renderEditor();
    Store.toast(mapped ? `${mapped} swatch images mapped — hit Save variants` : "Nothing to map (images already set)");
  };
  // per-row image upload (shared picker)
  let vupTarget = null;
  let vupInput = document.getElementById("vupInput");
  if (!vupInput) {
    vupInput = document.createElement("input");
    vupInput.type = "file";
    vupInput.accept = "image/*";
    vupInput.id = "vupInput";
    vupInput.hidden = true;
    document.body.appendChild(vupInput);
  }
  vupInput.onchange = async () => {
    const file = vupInput.files[0];
    vupInput.value = "";
    if (!file || vupTarget == null) return;
    try {
      const data = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await Store.api("admin/uploads", { method: "POST", body: { filename: file.name, data } });
      collectVariantRows();
      if (ed.variants[vupTarget]) ed.variants[vupTarget].image = r.url;
      renderEditor();
      Store.toast("Variant image uploaded — hit Save variants");
    } catch (e) { Store.toast(e.message); }
  };
  document.querySelectorAll("[data-vup]").forEach((b) => {
    b.onclick = () => { vupTarget = Number(b.dataset.vup); vupInput.click(); };
  });
  document.querySelectorAll("[data-rm-v]").forEach((b) => {
    b.onclick = () => { collectVariantRows(); ed.variants.splice(Number(b.dataset.rmV), 1); renderEditor(); };
  });
}

/* ---------- orders ---------- */

async function viewOrders() {
  const state = viewOrders.state || (viewOrders.state = { status: "", q: "", sku: "", from: "", to: "" });
  const params = new URLSearchParams();
  for (const k of ["status", "q", "sku", "from", "to"]) if (state[k]) params.set(k, state[k]);
  const { orders } = await Store.api(`admin/orders?${params}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Orders</h1>
      <div class="toolbar">
        <a class="btn ghost small" href="#/orders/new">＋ Manual order</a>
        <button class="btn ghost small" id="csvBtn" type="button" ${orders.length ? "" : "disabled"}>Export CSV</button>
      </div></div>
    <div class="panel">
      <div class="panel-head">
        <div class="toolbar">
          <input id="oQ" placeholder="Order # or email…" value="${esc(state.q)}" style="max-width:170px">
          <input id="oSku" placeholder="SKU…" value="${esc(state.sku)}" style="max-width:120px">
          <input id="oFrom" type="date" value="${esc(state.from)}" title="From date">
          <input id="oTo" type="date" value="${esc(state.to)}" title="To date">
          <select id="oStatus"><option value="">All statuses</option>
            ${["pending", "paid", "fulfilled", "cancelled", "refunded"].map((s) => `<option ${state.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <span class="mono" style="font-size:0.62rem;color:var(--ink-soft)">${orders.length} shown</span>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Order</th><th>Email</th><th>Status</th><th>Payment</th><th>Total</th><th>When</th></tr></thead>
        <tbody>${orders.map((o) => `
          <tr class="click" data-id="${o.id}">
            <td class="mono-cell">${esc(o.number)}${o.from_recovered_cart ? ' <span title="Recovered from abandoned bag" style="color:var(--gold)">✦</span>' : ""}</td>
            <td>${esc(o.email)}</td><td>${pill(o.status)}</td>
            <td class="mono-cell">${esc(o.payment_method)}</td>
            <td class="mono-cell">${fmt(o.total_cents, o.currency)}</td>
            <td class="mono-cell">${dt(o.created_at)}</td>
          </tr>`).join("") || '<tr><td colspan="6" style="color:var(--ink-soft)">No orders yet</td></tr>'}
        </tbody></table></div>
    </div>
    <p class="mono" style="font-size:0.6rem;color:var(--ink-soft)">✦ = recovered from an abandoned bag</p>`;
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/orders/${tr.dataset.id}`; }; });
  document.getElementById("oQ").onchange = (e) => { state.q = e.target.value; viewOrders(); };
  document.getElementById("oSku").onchange = (e) => { state.sku = e.target.value; viewOrders(); };
  document.getElementById("oFrom").onchange = (e) => { state.from = e.target.value; viewOrders(); };
  document.getElementById("oTo").onchange = (e) => { state.to = e.target.value; viewOrders(); };
  document.getElementById("oStatus").onchange = (e) => { state.status = e.target.value; viewOrders(); };
  document.getElementById("csvBtn").onclick = () => exportOrdersCsv(orders);
}

function exportOrdersCsv(orders) {
  const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const rows = [
    ["number", "email", "status", "payment_method", "total", "currency", "recovered_cart", "created_at"],
    ...orders.map((o) => [o.number, o.email, o.status, o.payment_method,
      (o.total_cents / 100).toFixed(2), o.currency, o.from_recovered_cart ? "yes" : "no", o.created_at]),
  ];
  const csv = rows.map((r) => r.map(q).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = `aloria-orders-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function viewOrderDetail(id) {
  const { order, items, events } = await Store.api(`admin/orders/${id}`);
  const a = order.shipping_address || {};
  const eventLine = (e) => {
    const who = e.actor ? ` · ${esc(e.actor)}` : "";
    if (e.kind === "placed") return `Order placed (${esc((e.data || {}).paymentMethod || "")})`;
    if (e.kind === "status") return `Status → <b>${esc((e.data || {}).to)}</b>${(e.data || {}).trackingNumber ? ` · tracking ${esc(e.data.trackingNumber)}` : ""}`;
    if (e.kind === "note") return esc((e.data || {}).note);
    if (e.kind === "email") return `Email sent: ${esc((e.data || {}).template)}${(e.data || {}).resend ? " (re-send)" : ""}`;
    return esc(e.kind);
  };
  $m().innerHTML = `
    <div class="admin-head">
      <h1 class="serif">${esc(order.number)}</h1>
      <div class="toolbar">
        <button class="btn ghost small" id="odSlip" type="button">Packing slip</button>
        ${["paid", "fulfilled"].includes(order.status) ? '<button class="btn ghost small" id="odResend" type="button">Re-send confirmation</button>' : ""}
        <select id="odStatus">${["pending", "paid", "fulfilled", "cancelled", "refunded"].map((s) => `<option ${order.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input id="odCarrier" placeholder="Carrier" value="${esc(order.tracking_carrier || "")}" style="border:1px solid var(--line);border-radius:100px;padding:0.45rem 0.9rem;font-family:var(--mono);font-size:0.66rem;max-width:110px">
        <input id="odTracking" placeholder="Tracking #" value="${esc(order.tracking_number || "")}" style="border:1px solid var(--line);border-radius:100px;padding:0.45rem 0.9rem;font-family:var(--mono);font-size:0.66rem;max-width:150px">
        <button class="btn small" id="odUpdate">Update</button>
      </div>
    </div>
    <div class="edit-grid">
      <div class="panel">
        <div class="panel-head"><h2 class="serif">Items</h2>${pill(order.status)}</div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th></th><th>Item</th><th>SKU</th><th>Qty</th><th>Unit</th><th>Line</th></tr></thead>
          <tbody>${items.map((i) => `
            <tr><td>${i.image ? `<img class="thumb" src="${esc(i.image)}" alt="">` : ""}</td>
            <td>${esc(i.product_title)}<br><span class="mono-cell" style="color:var(--ink-soft)">${esc(i.variant_label)}</span></td>
            <td class="mono-cell">${esc(i.sku)}</td><td class="mono-cell">${i.qty}</td>
            <td class="mono-cell">${fmt(i.unit_price_cents, order.currency)}</td>
            <td class="mono-cell">${fmt(i.unit_price_cents * i.qty, order.currency)}</td></tr>`).join("")}
          </tbody></table></div>
        <div class="pad">
          <div class="sum-row"><span>Subtotal</span><span>${fmt(order.subtotal_cents, order.currency)}</span></div>
          ${order.discount_cents ? `<div class="sum-row"><span>Discount ${esc(order.discount_code || "")}</span><span>−${fmt(order.discount_cents, order.currency)}</span></div>` : ""}
          <div class="sum-row"><span>Shipping</span><span>${order.shipping_cents ? fmt(order.shipping_cents, order.currency) : "Free"}</span></div>
          <div class="sum-row total"><span>Total</span><span>${fmt(order.total_cents, order.currency)}</span></div>
        </div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:1rem">Customer</h2>
        <dl class="kv">
          <dt>Email</dt><dd>${esc(order.email)}</dd>
          <dt>Name</dt><dd>${esc(order.shipping_name)}</dd>
          <dt>Address</dt><dd>${[a.line1, a.line2, a.city, a.region, a.postal, a.country].filter(Boolean).map(esc).join(", ")}</dd>
          ${a.phone ? `<dt>Phone</dt><dd>${esc(a.phone)}</dd>` : ""}
          <dt>Payment</dt><dd>${esc(order.payment_method)}${order.payment_ref ? ` · <span class="mono-cell">${esc(order.payment_ref)}</span>` : ""}</dd>
          <dt>Placed</dt><dd>${dt(order.created_at)}</dd>
          ${order.tracking_number ? `<dt>Tracking</dt><dd>${esc(order.tracking_carrier)} ${esc(order.tracking_number)}</dd>` : ""}
          ${order.tax_cents ? `<dt>Tax</dt><dd>${fmt(order.tax_cents, order.currency)}</dd>` : ""}
          ${order.from_recovered_cart ? "<dt>Source</dt><dd>✦ Recovered abandoned bag</dd>" : ""}
        </dl>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2 class="serif">Timeline</h2></div>
      <div class="timeline">
        <div style="display:flex;gap:0.6rem;margin-bottom:1.1rem">
          <input id="odNote" placeholder="Add an internal note…" style="flex:1;border:1px solid var(--line);border-radius:4px;padding:0.6rem 0.8rem;font-size:0.85rem">
          <button class="btn ghost small" id="odNoteAdd" type="button">Add note</button>
        </div>
        ${events.map((e) => `
          <div class="tl-item">
            <div class="tl-dot ${esc(e.kind)}"></div>
            <div class="tl-body">${eventLine(e)}
              <div class="tl-meta">${dt(e.created_at)}${e.actor ? ` · ${esc(e.actor)}` : ""}</div></div>
          </div>`).join("") || '<p style="color:var(--ink-soft);font-size:0.85rem">No events recorded (order predates the timeline)</p>'}
      </div>
    </div>
    <div class="admin-msg" id="odMsg"></div>`;
  document.getElementById("odUpdate").onclick = async () => {
    try {
      await Store.api(`admin/orders/${id}`, { method: "PATCH", body: {
        status: document.getElementById("odStatus").value,
        trackingCarrier: document.getElementById("odCarrier").value,
        trackingNumber: document.getElementById("odTracking").value,
      } });
      Store.toast("Order updated (fulfilled sends the shipping email; cancel/refund restocks)");
      viewOrderDetail(id);
    } catch (e) {
      const msg = document.getElementById("odMsg");
      msg.textContent = e.message; msg.className = "admin-msg err";
    }
  };
  document.getElementById("odNoteAdd").onclick = async () => {
    const note = document.getElementById("odNote").value.trim();
    if (!note) return;
    await Store.api(`admin/orders/${id}/notes`, { method: "POST", body: { note } });
    viewOrderDetail(id);
  };
  const resendBtn = document.getElementById("odResend");
  if (resendBtn) resendBtn.onclick = async () => {
    const r = await Store.api(`admin/orders/${id}/resend-confirmation`, { method: "POST", body: {} });
    Store.toast(r.delivered ? "Confirmation re-sent" : "Logged only — configure RESEND_API_KEY to deliver");
    viewOrderDetail(id);
  };
  document.getElementById("odSlip").onclick = () => packingSlip(order, items);
}

/** Printable packing slip in a new window. */
function packingSlip(order, items) {
  const a = order.shipping_address || {};
  const w = window.open("", "_blank", "width=720,height=900");
  w.document.write(`<!DOCTYPE html><html><head><title>${esc(order.number)} — packing slip</title>
    <style>
      body { font-family: Georgia, serif; color: #14120f; padding: 40px; max-width: 640px; margin: 0 auto; }
      .brand { letter-spacing: 0.3em; font-size: 22px; text-align: center; }
      .sub { text-align: center; font-family: monospace; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: #b08d3e; margin: 4px 0 30px; }
      table { width: 100%; border-collapse: collapse; margin: 20px 0; font-family: Helvetica, sans-serif; font-size: 13px; }
      th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #777; border-bottom: 1px solid #ddd; padding: 6px 0; }
      td { padding: 8px 0; border-bottom: 1px solid #eee; }
      .meta { font-family: Helvetica, sans-serif; font-size: 13px; line-height: 1.6; }
      .foot { margin-top: 40px; text-align: center; font-size: 11px; color: #999; }
      @media print { body { padding: 10px; } }
    </style></head><body>
    <div class="brand">ALORIA</div>
    <div class="sub">Packing slip · ${esc(order.number)}</div>
    <div class="meta"><b>${esc(order.shipping_name)}</b><br>
      ${[a.line1, a.line2, a.city, a.region, a.postal, a.country].filter(Boolean).map(esc).join("<br>")}</div>
    <table><thead><tr><th>Item</th><th>SKU</th><th style="text-align:right">Qty</th></tr></thead>
      <tbody>${items.map((i) => `<tr><td>${esc(i.product_title)}${i.variant_label ? ` — ${esc(i.variant_label)}` : ""}</td>
        <td style="font-family:monospace">${esc(i.sku)}</td><td style="text-align:right">${i.qty}</td></tr>`).join("")}</tbody></table>
    ${order.tracking_number ? `<div class="meta">Ship via <b>${esc(order.tracking_carrier)}</b> · ${esc(order.tracking_number)}</div>` : ""}
    <div class="foot">Stackable · Customisable · Yours</div>
    <script>window.print()<\/script></body></html>`);
  w.document.close();
}

/* ---------- abandoned carts ---------- */

async function viewCarts() {
  const { carts } = await Store.api("admin/carts/abandoned");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Abandoned bags</h1></div>
    <p style="color:var(--ink-soft);font-size:0.85rem;margin-bottom:1.2rem">
      Bags with a known email that went quiet. The hourly sweep emails each one automatically (once);
      you can also re-send manually. Recovered checkouts are marked ✦ in Orders.</p>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Items</th><th>Value</th><th>Status</th><th>Recovery email</th><th>Last activity</th><th></th></tr></thead>
      <tbody>${carts.map((c) => `
        <tr><td>${esc(c.email || "—")}</td>
        <td style="max-width:280px">${(c.items || []).map((i) => `${esc(i.title)} ×${i.qty}`).join(", ")}</td>
        <td class="mono-cell">${fmt(Number(c.value_cents), c.currency)}</td>
        <td>${pill(c.status)}${c.recovered ? " ✦" : ""}</td>
        <td class="mono-cell">${c.recovery_sent_at ? dt(c.recovery_sent_at) : "not sent"}</td>
        <td class="mono-cell">${dt(c.updated_at)}</td>
        <td><button class="btn ghost small" data-send="${c.id}" type="button">${c.recovery_sent_at ? "Re-send" : "Send now"}</button></td></tr>`).join("") ||
        '<tr><td colspan="7" style="color:var(--ink-soft)">No abandoned bags — either the shop is quiet or everyone is checking out. Both fine.</td></tr>'}
      </tbody></table></div></div>`;
  document.querySelectorAll("[data-send]").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await Store.api(`admin/carts/${b.dataset.send}/recovery-email`, { method: "POST", body: {} });
        Store.toast(r.delivered ? "Recovery email sent" : "Recovery recorded (email logged — configure RESEND_API_KEY to deliver)");
        viewCarts();
      } catch (e) { Store.toast(e.message); b.disabled = false; }
    };
  });
}

/* ---------- customers ---------- */

async function viewCustomers() {
  const { customers } = await Store.api("admin/customers");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Customers</h1>
      <button class="btn ghost small" id="custCsv" type="button" ${customers.length ? "" : "disabled"}>Export CSV</button></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Orders</th><th>Lifetime spend</th><th>Joined</th><th>Last seen</th></tr></thead>
      <tbody>${customers.map((c) => `
        <tr class="click" data-id="${c.id}"><td>${esc(c.email)}</td><td>${esc(c.name)}</td><td>${esc(c.role)}</td>
        <td class="mono-cell">${c.orders}</td><td class="mono-cell">${fmt(Number(c.spent_cents))}</td>
        <td class="mono-cell">${new Date(c.created_at).toLocaleDateString()}</td>
        <td class="mono-cell">${c.last_login_at ? dt(c.last_login_at) : "—"}</td></tr>`).join("") ||
        '<tr><td colspan="7" style="color:var(--ink-soft)">No accounts yet</td></tr>'}
      </tbody></table></div></div>`;
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/customers/${tr.dataset.id}`; }; });
  document.getElementById("custCsv").onclick = () => {
    const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
    const rows = [["email", "name", "role", "orders", "lifetime_spend", "joined"],
      ...customers.map((c) => [c.email, c.name, c.role, c.orders, (Number(c.spent_cents) / 100).toFixed(2), c.created_at])];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "aloria-customers.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

/* ---------- discounts ---------- */

async function viewDiscounts() {
  const { discounts } = await Store.api("admin/discounts");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Discounts</h1></div>
    <div class="panel pad">
      <div class="toolbar">
        <input id="dCode" placeholder="CODE">
        <select id="dKind"><option value="percent">% off</option><option value="fixed">Fixed ¢ off</option><option value="free_shipping">Free shipping</option></select>
        <input id="dValue" placeholder="Value" inputmode="numeric" style="max-width:100px">
        <input id="dMin" placeholder="Min bag ¢" inputmode="numeric" style="max-width:110px">
        <input id="dMaxUses" placeholder="Max uses" inputmode="numeric" style="max-width:100px">
        <label class="mono" style="font-size:0.62rem;display:flex;gap:0.3rem;align-items:center">
          <input type="checkbox" id="dOnce" style="width:auto"> once/customer</label>
        <input id="dStarts" type="date" title="Starts">
        <input id="dExpires" type="date" title="Expires">
        <button class="btn small" id="dCreate" type="button">Create</button>
      </div>
      <div class="admin-msg" id="dMsg"></div>
    </div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Min bag</th><th>Used</th><th>Limits</th><th>Window</th><th>Active</th><th></th></tr></thead>
      <tbody>${discounts.map((d) => `
        <tr><td class="mono-cell">${esc(d.code)}</td><td>${d.kind.replace("_", " ")}</td>
        <td class="mono-cell">${d.kind === "percent" ? `${d.value}%` : d.kind === "free_shipping" ? "ship $0" : fmt(d.value)}</td>
        <td class="mono-cell">${d.min_cents ? fmt(d.min_cents) : "—"}</td>
        <td class="mono-cell">${d.uses || 0}${d.max_uses ? `/${d.max_uses}` : ""}</td>
        <td class="mono-cell">${d.once_per_customer ? "1×/customer" : "—"}</td>
        <td class="mono-cell">${d.starts_at ? new Date(d.starts_at).toLocaleDateString() : "now"} → ${d.expires_at ? new Date(d.expires_at).toLocaleDateString() : "∞"}</td>
        <td>${d.active ? pill("active") : pill("archived")}</td>
        <td>${d.active ? `<button class="btn ghost small" data-off="${esc(d.code)}" type="button">Deactivate</button>` : ""}</td></tr>`).join("") ||
        '<tr><td colspan="9" style="color:var(--ink-soft)">No codes yet — WELCOME10 is created by the catalog seed.</td></tr>'}
      </tbody></table></div></div>`;
  document.getElementById("dCreate").onclick = async () => {
    const msg = document.getElementById("dMsg");
    try {
      await Store.api("admin/discounts", { method: "POST", body: {
        code: document.getElementById("dCode").value,
        kind: document.getElementById("dKind").value,
        value: parseInt(document.getElementById("dValue").value, 10) || 0,
        min_cents: parseInt(document.getElementById("dMin").value, 10) || 0,
        max_uses: document.getElementById("dMaxUses").value || null,
        once_per_customer: document.getElementById("dOnce").checked,
        starts_at: document.getElementById("dStarts").value || null,
        expires_at: document.getElementById("dExpires").value || null,
      } });
      Store.toast("Discount saved");
      viewDiscounts();
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  };
  document.querySelectorAll("[data-off]").forEach((b) => {
    b.onclick = async () => {
      await Store.api(`admin/discounts/${encodeURIComponent(b.dataset.off)}`, { method: "DELETE" });
      viewDiscounts();
    };
  });
}

/* ---------- waitlist ---------- */

async function viewWaitlist() {
  const { waitlist } = await Store.api("admin/waitlist");
  const isAdmin = ME && ME.role === "admin";
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Waitlist</h1>
      <button class="btn ghost small" id="wlCsv" type="button" ${waitlist.length ? "" : "disabled"}>Export CSV</button></div>
    ${isAdmin ? `
    <div class="panel pad">
      <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Broadcast to the waitlist (${waitlist.length} recipients)</h2>
      <div class="field"><label>Subject</label><input id="wlSubject" placeholder="Aloria is open ✦"></div>
      <div class="field"><label>Message (plain text, blank line = new paragraph)</label><textarea id="wlBody" rows="5"></textarea></div>
      <button class="btn gold small" id="wlSend" type="button" ${waitlist.length ? "" : "disabled"}>Send broadcast</button>
      <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.6rem">Only email people who expect to hear from you. Without RESEND_API_KEY messages are logged, not delivered.</p>
      <div class="admin-msg" id="wlMsg"></div>
    </div>` : ""}
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Joined</th></tr></thead>
      <tbody>${waitlist.map((w) => `<tr><td>${esc(w.email)}</td><td class="mono-cell">${dt(w.created_at)}</td></tr>`).join("") ||
        '<tr><td colspan="2" style="color:var(--ink-soft)">No signups yet (emails also land in Vercel logs)</td></tr>'}
      </tbody></table></div></div>`;
  document.getElementById("wlCsv").onclick = () => {
    const rows = [["email", "joined"], ...waitlist.map((w) => [w.email, w.created_at])];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "aloria-waitlist.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const sendBtn = document.getElementById("wlSend");
  if (sendBtn) sendBtn.onclick = async () => {
    const msg = document.getElementById("wlMsg");
    const subject = document.getElementById("wlSubject").value.trim();
    const message = document.getElementById("wlBody").value.trim();
    if (!subject || !message) { msg.textContent = "Subject and message are required"; msg.className = "admin-msg err"; return; }
    if (!confirm(`Email all ${waitlist.length} waitlist signups?`)) return;
    sendBtn.disabled = true;
    try {
      const r = await Store.api("admin/waitlist/broadcast", { method: "POST", body: { subject, message, confirm: true } });
      msg.textContent = `Sent ${r.sent}/${r.recipients}${r.failed ? ` (${r.failed} failed)` : ""}`;
      msg.className = "admin-msg ok";
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
    sendBtn.disabled = false;
  };
}

boot();
