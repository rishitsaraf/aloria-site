/* ALORIA CMS — single-page admin console (hash routing, no framework).
   Everything renders from the /api/store/admin/* endpoints; this file is
   pure presentation + calls. */

const $m = () => document.getElementById("adminMain");
const esc = (s) => Store.esc(s);
const fmt = (c, cur = "USD") => Store.money(c, cur);
const dt = (s) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/* ---------- boot & routing ---------- */

async function boot() {
  const { user } = await Store.api("auth/me").catch(() => ({ user: null }));
  if (!user || user.role !== "admin") {
    document.getElementById("adminLogin").hidden = false;
    document.getElementById("adminLoginForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = document.getElementById("alMsg");
      try {
        const r = await Store.api("auth/login", {
          method: "POST",
          body: { email: document.getElementById("alEmail").value.trim(), password: document.getElementById("alPass").value },
        });
        if (r.user.role !== "admin") { msg.textContent = "This account doesn't have admin access"; msg.className = "form-msg err"; return; }
        location.reload();
      } catch (e) { msg.textContent = e.message; msg.className = "form-msg err"; }
    });
    return;
  }
  document.getElementById("adminShell").hidden = false;
  document.getElementById("adminWho").textContent = user.email;
  document.getElementById("adminLogout").onclick = async () => { await Store.api("auth/logout", { method: "POST" }); location.reload(); };
  window.addEventListener("hashchange", route);
  route();
}

const ROUTES = [
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
    if (m) { fn(m).catch(showError); return; }
  }
  location.hash = "#/dashboard";
}

function showError(e) {
  $m().innerHTML = `<div class="admin-head"><h1 class="serif">Hmm.</h1></div>
    <div class="panel pad"><p class="admin-msg err">${esc(e.message)}</p></div>`;
}

const pill = (s) => `<span class="status-pill ${esc(s)}">${esc(s)}</span>`;

/* ---------- dashboard ---------- */

async function viewDashboard() {
  const m = await Store.api("admin/metrics");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Dashboard</h1>
      ${m.totalProducts === 0 ? '<button class="btn gold" id="seedBtn">Seed launch catalog</button>' : ""}
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">Revenue</div><div class="v">${fmt(m.revenueCents)}</div><div class="s">${m.paidOrders} paid orders</div></div>
      <div class="tile"><div class="k">Average order</div><div class="v">${fmt(m.aovCents)}</div><div class="s">${m.pendingOrders} pending</div></div>
      <div class="tile"><div class="k">Recovered revenue</div><div class="v">${fmt(m.recoveredRevenueCents)}</div><div class="s">${m.recoveredOrders} rescued orders</div></div>
      <div class="tile"><div class="k">Abandoned bags</div><div class="v">${m.abandonedCarts}</div><div class="s">${fmt(m.abandonedValueCents)} waiting</div></div>
      <div class="tile"><div class="k">Live products</div><div class="v">${m.activeProducts}<span style="font-size:1rem;color:var(--ink-soft)">/${m.totalProducts}</span></div><div class="s">${m.lowStockVariants} variants low on stock</div></div>
      <div class="tile"><div class="k">Customers</div><div class="v">${m.customers}</div><div class="s">&nbsp;</div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2 class="serif">Latest orders</h2><a class="mono" href="#/orders" style="font-size:0.62rem">All orders →</a></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Order</th><th>Email</th><th>Status</th><th>Total</th><th>When</th></tr></thead>
        <tbody>${m.recentOrders.map((o) => `
          <tr><td class="mono-cell">${esc(o.number)}</td><td>${esc(o.email)}</td>
          <td>${pill(o.status)}</td><td class="mono-cell">${fmt(o.total_cents, o.currency)}</td>
          <td class="mono-cell">${dt(o.created_at)}</td></tr>`).join("") || '<tr><td colspan="5" style="color:var(--ink-soft)">No orders yet</td></tr>'}
        </tbody></table></div>
    </div>`;
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

/* ---------- products ---------- */

async function viewProducts() {
  const state = viewProducts.state || (viewProducts.state = { q: "", status: "", category: "" });
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.status) params.set("status", state.status);
  if (state.category) params.set("category", state.category);
  const { products } = await Store.api(`admin/products?${params}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Products</h1><a class="btn" href="#/products/new">＋ New product</a></div>
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
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th></th><th>Product</th><th>Category</th><th>Status</th><th>Base price</th><th>Variants</th><th>Stock</th></tr></thead>
        <tbody>${products.map((p) => `
          <tr class="click" data-id="${p.id}">
            <td>${(p.images || [])[0] ? `<img class="thumb" src="${esc(p.images[0])}" alt="">` : ""}</td>
            <td><b>${esc(p.title)}</b><br><span class="mono-cell" style="color:var(--ink-soft)">/${esc(p.slug)}</span></td>
            <td>${esc(p.category)}</td><td>${pill(p.status)}</td>
            <td class="mono-cell">${fmt(p.price_cents, p.currency)}</td>
            <td class="mono-cell">${p.variant_count}</td>
            <td class="mono-cell" ${p.total_stock <= 5 ? 'style="color:var(--ruby)"' : ""}>${p.total_stock}</td>
          </tr>`).join("") || '<tr><td colspan="7" style="color:var(--ink-soft)">No products — hit “New product” or seed the catalog from the dashboard.</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/products/${tr.dataset.id}`; }; });
  document.getElementById("pQ").onchange = (e) => { state.q = e.target.value; viewProducts(); };
  document.getElementById("pStatus").onchange = (e) => { state.status = e.target.value; viewProducts(); };
  document.getElementById("pCat").onchange = (e) => { state.category = e.target.value; viewProducts(); };
}

/* ---------- product editor ---------- */

let ed = null; // { product, variants, isNew }

async function viewProductEditor(idOrNew) {
  if (idOrNew === "new") {
    ed = {
      isNew: true,
      product: { title: "", subtitle: "", slug: "", description: "", category: "ear", status: "draft", price_cents: 0, images: [], options: [], featured: false },
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
        </div>
        ${ed.isNew ? "" : renderVariantsPanel()}
      </div>
      <div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Images</h2>
          <div id="imgRows">${(p.images || []).map((src, i) => imgRow(src, i)).join("")}</div>
          <button class="btn ghost small" id="addImg" type="button">＋ Add image path</button>
          <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.7rem">Paths under /assets/img/… or full https:// URLs. First image is the card image.</p>
        </div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Options</h2>
          <div id="optRows">${(p.options || []).map((o, i) => optRow(o, i)).join("")}</div>
          <button class="btn ghost small" id="addOpt" type="button" ${(p.options || []).length >= 3 ? "disabled" : ""}>＋ Add option</button>
          <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.7rem">Up to 3 options (e.g. Plating / Stone Shape / Stone Color). Save the product, then generate the variant matrix below.</p>
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
  p.images = [...document.querySelectorAll("[data-img-input]")].map((i) => i.value.trim()).filter(Boolean);
  p.options = [...document.querySelectorAll("[data-opt]")].map((row) => {
    const idx = row.dataset.opt;
    return {
      name: row.querySelector(`[data-opt-name="${idx}"]`).value.trim(),
      values: row.querySelector(`[data-opt-values="${idx}"]`).value.split(",").map((v) => v.trim()).filter(Boolean),
    };
  }).filter((o) => o.name && o.values.length);
}

async function saveProduct() {
  collectEditorFields();
  const p = ed.product;
  const body = {
    title: p.title, subtitle: p.subtitle, description: p.description,
    category: p.category, status: p.status, price_cents: p.price_cents,
    images: p.images, options: p.options, featured: p.featured,
  };
  if (p.slug) body.slug = p.slug;
  const msg = document.getElementById("eMsg");
  try {
    if (ed.isNew) {
      const r = await Store.api("admin/products", { method: "POST", body });
      Store.toast("Product created — now build its variants");
      location.hash = `#/products/${r.product.id}`;
    } else {
      const r = await Store.api(`admin/products/${p.id}`, { method: "PATCH", body });
      ed.product = r.product;
      Store.toast("Saved");
      renderEditor();
    }
  } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
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

function skuBase(p) {
  return (p.title || "SKU").split(/\s+/).map((w) => w[0]).join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "SKU";
}
const valCode = (v) => String(v).normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 3) || "X";

function renderVariantsPanel() {
  const optionNames = (ed.product.options || []).map((o) => o.name);
  return `
    <div class="panel">
      <div class="panel-head">
        <h2 class="serif">Variants <span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">${ed.variants.length}</span></h2>
        <div class="toolbar">
          <button class="btn ghost small" id="genMatrix" type="button">Generate matrix</button>
          <button class="btn small" id="saveVariants" type="button">Save variants</button>
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
    ${optionNames.map((n) => `<td class="mono-cell">${esc((v.options || {})[n] || "—")}</td>`).join("")}
    <td><input class="w-sku" value="${esc(v.sku || "")}" data-v="${i}" data-f="sku"></td>
    <td><input class="w-num" value="${v.price_cents == null ? "" : v.price_cents}" data-v="${i}" data-f="price_cents" inputmode="numeric" placeholder="base"></td>
    <td><input class="w-num" value="${v.stock == null ? 0 : v.stock}" data-v="${i}" data-f="stock" inputmode="numeric"></td>
    <td><input class="w-img" value="${esc(v.image || "")}" data-v="${i}" data-f="image" placeholder="/assets/img/…"></td>
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
  document.getElementById("saveVariants").onclick = async () => {
    collectVariantRows();
    const msg = document.getElementById("vMsg");
    try {
      const r = await Store.api(`admin/products/${ed.product.id}/variants`, {
        method: "PUT",
        body: { variants: ed.variants.map((v) => ({ ...v, image: v.image || null })) },
      });
      ed.variants = r.variants;
      Store.toast("Variants saved");
      renderEditor();
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  };
  document.querySelectorAll("[data-rm-v]").forEach((b) => {
    b.onclick = () => { collectVariantRows(); ed.variants.splice(Number(b.dataset.rmV), 1); renderEditor(); };
  });
}

/* ---------- orders ---------- */

async function viewOrders() {
  const state = viewOrders.state || (viewOrders.state = { status: "", q: "" });
  const params = new URLSearchParams();
  if (state.status) params.set("status", state.status);
  if (state.q) params.set("q", state.q);
  const { orders } = await Store.api(`admin/orders?${params}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Orders</h1></div>
    <div class="panel">
      <div class="panel-head">
        <div class="toolbar">
          <input id="oQ" placeholder="Order # or email…" value="${esc(state.q)}">
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
  document.getElementById("oStatus").onchange = (e) => { state.status = e.target.value; viewOrders(); };
}

async function viewOrderDetail(id) {
  const { order, items } = await Store.api(`admin/orders/${id}`);
  const a = order.shipping_address || {};
  $m().innerHTML = `
    <div class="admin-head">
      <h1 class="serif">${esc(order.number)}</h1>
      <div class="toolbar">
        <select id="odStatus">${["pending", "paid", "fulfilled", "cancelled", "refunded"].map((s) => `<option ${order.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
        <button class="btn small" id="odUpdate">Update status</button>
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
          ${order.from_recovered_cart ? "<dt>Source</dt><dd>✦ Recovered abandoned bag</dd>" : ""}
        </dl>
      </div>
    </div>
    <div class="admin-msg" id="odMsg"></div>`;
  document.getElementById("odUpdate").onclick = async () => {
    try {
      await Store.api(`admin/orders/${id}`, { method: "PATCH", body: { status: document.getElementById("odStatus").value } });
      Store.toast("Order updated (cancel/refund restocks inventory)");
      viewOrderDetail(id);
    } catch (e) {
      const msg = document.getElementById("odMsg");
      msg.textContent = e.message; msg.className = "admin-msg err";
    }
  };
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
    <div class="admin-head"><h1 class="serif">Customers</h1></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Orders</th><th>Lifetime spend</th><th>Joined</th><th>Last seen</th></tr></thead>
      <tbody>${customers.map((c) => `
        <tr><td>${esc(c.email)}</td><td>${esc(c.name)}</td><td>${esc(c.role)}</td>
        <td class="mono-cell">${c.orders}</td><td class="mono-cell">${fmt(Number(c.spent_cents))}</td>
        <td class="mono-cell">${new Date(c.created_at).toLocaleDateString()}</td>
        <td class="mono-cell">${c.last_login_at ? dt(c.last_login_at) : "—"}</td></tr>`).join("") ||
        '<tr><td colspan="7" style="color:var(--ink-soft)">No accounts yet</td></tr>'}
      </tbody></table></div></div>`;
}

/* ---------- discounts ---------- */

async function viewDiscounts() {
  const { discounts } = await Store.api("admin/discounts");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Discounts</h1></div>
    <div class="panel pad">
      <div class="toolbar">
        <input id="dCode" placeholder="CODE">
        <select id="dKind"><option value="percent">% off</option><option value="fixed">Fixed ¢ off</option></select>
        <input id="dValue" placeholder="Value" inputmode="numeric" style="max-width:110px">
        <input id="dMin" placeholder="Min bag ¢ (opt.)" inputmode="numeric" style="max-width:150px">
        <button class="btn small" id="dCreate" type="button">Create</button>
      </div>
      <div class="admin-msg" id="dMsg"></div>
    </div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Code</th><th>Type</th><th>Value</th><th>Min bag</th><th>Active</th><th>Expires</th><th></th></tr></thead>
      <tbody>${discounts.map((d) => `
        <tr><td class="mono-cell">${esc(d.code)}</td><td>${d.kind}</td>
        <td class="mono-cell">${d.kind === "percent" ? `${d.value}%` : fmt(d.value)}</td>
        <td class="mono-cell">${d.min_cents ? fmt(d.min_cents) : "—"}</td>
        <td>${d.active ? pill("active") : pill("archived")}</td>
        <td class="mono-cell">${d.expires_at ? dt(d.expires_at) : "never"}</td>
        <td>${d.active ? `<button class="btn ghost small" data-off="${esc(d.code)}" type="button">Deactivate</button>` : ""}</td></tr>`).join("") ||
        '<tr><td colspan="7" style="color:var(--ink-soft)">No codes yet — WELCOME10 is created by the catalog seed.</td></tr>'}
      </tbody></table></div></div>`;
  document.getElementById("dCreate").onclick = async () => {
    const msg = document.getElementById("dMsg");
    try {
      await Store.api("admin/discounts", { method: "POST", body: {
        code: document.getElementById("dCode").value,
        kind: document.getElementById("dKind").value,
        value: parseInt(document.getElementById("dValue").value, 10),
        min_cents: parseInt(document.getElementById("dMin").value, 10) || 0,
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
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Waitlist</h1></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Joined</th></tr></thead>
      <tbody>${waitlist.map((w) => `<tr><td>${esc(w.email)}</td><td class="mono-cell">${dt(w.created_at)}</td></tr>`).join("") ||
        '<tr><td colspan="2" style="color:var(--ink-soft)">No signups yet (emails also land in Vercel logs)</td></tr>'}
      </tbody></table></div></div>`;
}

boot();
