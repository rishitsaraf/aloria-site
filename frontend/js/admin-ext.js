/* ALORIA CMS — extension views (round 3). Loaded before admin.js, which
   merges EXT_ROUTES into its router. Uses admin.js globals ($m, esc, fmt,
   dt, pill) at call time. */

/* ================= Inventory ================= */

async function viewInventory() {
  const state = viewInventory.state || (viewInventory.state = { q: "", low: false });
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.low) params.set("low", "1");
  const { variants, totals } = await Store.api(`admin/inventory?${params}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Inventory</h1>
      <span class="mono" style="font-size:0.62rem;color:var(--ink-soft)">${totals.units} units · ${totals.low} low · ${totals.out} out</span></div>
    <div class="panel">
      <div class="panel-head">
        <div class="toolbar">
          <input id="invQ" placeholder="SKU or product…" value="${esc(state.q)}">
          <button class="filter-btn ${state.low ? "active" : ""}" id="invLow" type="button" style="border-radius:100px">Low stock</button>
        </div>
        <a class="mono" href="#/inventory/movements" style="font-size:0.62rem">Movement log →</a>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>SKU</th><th>Product</th><th>Variant</th><th>Stock</th><th>Adjust</th><th></th></tr></thead>
        <tbody>${variants.map((v) => `
          <tr>
            <td class="mono-cell">${esc(v.sku)}</td>
            <td>${esc(v.title)}${v.product_status !== "active" || !v.active ? ` ${pill(v.product_status !== "active" ? v.product_status : "inactive")}` : ""}</td>
            <td class="mono-cell" style="color:var(--ink-soft)">${Object.values(v.options || {}).join(" · ")}</td>
            <td class="mono-cell" ${v.stock === 0 ? 'style="color:var(--ruby)"' : (v.stock <= 3 ? 'style="color:var(--gold)"' : "")}><b>${v.stock}</b></td>
            <td><div style="display:flex;gap:0.35rem;align-items:center">
              <input class="w-num" data-adj="${v.id}" inputmode="numeric" placeholder="±n or =n" style="max-width:100px">
              <input data-adj-note="${v.id}" placeholder="note" style="min-width:110px">
            </div></td>
            <td><button class="btn ghost small" data-adj-go="${v.id}" type="button">Apply</button></td>
          </tr>`).join("") || '<tr><td colspan="6" style="color:var(--ink-soft)">No variants match</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.getElementById("invQ").onchange = (e) => { state.q = e.target.value; viewInventory(); };
  document.getElementById("invLow").onclick = () => { state.low = !state.low; viewInventory(); };
  document.querySelectorAll("[data-adj-go]").forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.adjGo;
      const raw = document.querySelector(`[data-adj="${id}"]`).value.trim();
      const note = document.querySelector(`[data-adj-note="${id}"]`).value.trim();
      if (!raw) return;
      const body = raw.startsWith("=") ? { set: parseInt(raw.slice(1), 10), note } : { delta: parseInt(raw, 10), note };
      try {
        await Store.api(`admin/inventory/${id}`, { method: "PATCH", body });
        Store.toast("Stock adjusted");
        viewInventory();
      } catch (e) { Store.toast(e.message); }
    };
  });
}

async function viewMovements() {
  const { movements } = await Store.api("admin/inventory/movements");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Stock movements</h1><a class="btn ghost small" href="#/inventory">← Inventory</a></div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>When</th><th>SKU</th><th>Δ</th><th>Reason</th><th>Order</th><th>By</th><th>Note</th></tr></thead>
      <tbody>${movements.map((mv) => `
        <tr><td class="mono-cell">${dt(mv.created_at)}</td><td class="mono-cell">${esc(mv.sku)}</td>
        <td class="mono-cell" style="color:${mv.delta < 0 ? "var(--ruby)" : "var(--emerald)"}">${mv.delta > 0 ? "+" : ""}${mv.delta}</td>
        <td>${esc(mv.reason)}</td><td class="mono-cell">${esc(mv.order_number || "")}</td>
        <td class="mono-cell">${esc(mv.actor || "system")}</td><td style="color:var(--ink-soft)">${esc(mv.note || "")}</td></tr>`).join("") ||
        '<tr><td colspan="7" style="color:var(--ink-soft)">No movements yet</td></tr>'}
      </tbody></table></div></div>`;
}

/* ================= Collections ================= */

async function viewCollections() {
  const [{ collections }, { products }] = await Promise.all([
    Store.api("admin/collections"),
    Store.api("admin/products"),
  ]);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Collections</h1></div>
    <div class="panel pad">
      <div class="toolbar">
        <input id="collTitle" placeholder="New collection title…">
        <button class="btn small" id="collCreate" type="button">Create</button>
      </div>
    </div>
    ${collections.map((c) => `
      <div class="panel" data-coll="${c.id}">
        <div class="panel-head">
          <h2 class="serif">${esc(c.title)} <span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">/shop?collection=${esc(c.slug)}</span></h2>
          <div class="toolbar">
            <button class="btn small" data-coll-save="${c.id}" type="button">Save</button>
            <button class="btn ghost small" data-coll-del="${c.id}" type="button" style="border-color:var(--ruby);color:var(--ruby)">Delete</button>
          </div>
        </div>
        <div class="pad">
          <div class="form-row">
            <div class="field"><label>Title</label><input data-cf="title" value="${esc(c.title)}"></div>
            <div class="field"><label>Image path</label><input data-cf="image" value="${esc(c.image || "")}"></div>
          </div>
          <div class="field"><label>Description</label><input data-cf="description" value="${esc(c.description)}"></div>
          <div class="field"><label>Products (${(c.product_ids || []).length} selected)</label>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0.3rem;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:4px;padding:0.6rem">
              ${products.map((p) => `
                <label style="display:flex;gap:0.4rem;align-items:center;font-size:0.8rem;text-transform:none;letter-spacing:0">
                  <input type="checkbox" data-cp="${p.id}" ${(c.product_ids || []).includes(p.id) ? "checked" : ""} style="width:auto"> ${esc(p.title)}
                </label>`).join("")}
            </div>
          </div>
        </div>
      </div>`).join("") || '<p class="admin-msg">No collections yet — create one above (e.g. "Lumière Link Set").</p>'}`;
  document.getElementById("collCreate").onclick = async () => {
    const title = document.getElementById("collTitle").value.trim();
    if (!title) return;
    try { await Store.api("admin/collections", { method: "POST", body: { title } }); viewCollections(); }
    catch (e) { Store.toast(e.message); }
  };
  document.querySelectorAll("[data-coll-save]").forEach((b) => {
    b.onclick = async () => {
      const wrap = document.querySelector(`[data-coll="${b.dataset.collSave}"]`);
      const val = (f) => wrap.querySelector(`[data-cf="${f}"]`).value.trim();
      const productIds = [...wrap.querySelectorAll("[data-cp]:checked")].map((cb) => Number(cb.dataset.cp));
      try {
        await Store.api(`admin/collections/${b.dataset.collSave}`, {
          method: "PATCH",
          body: { title: val("title"), image: val("image"), description: val("description"), productIds },
        });
        Store.toast("Collection saved");
        viewCollections();
      } catch (e) { Store.toast(e.message); }
    };
  });
  document.querySelectorAll("[data-coll-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this collection? Products are not affected.")) return;
      await Store.api(`admin/collections/${b.dataset.collDel}`, { method: "DELETE" });
      viewCollections();
    };
  });
}

/* ================= Content (hero / tiles / announcement) ================= */

async function viewContent() {
  const c = await Store.api("content");
  const settingsData = await Store.api("admin/settings").catch(() => null);
  const blobOn = settingsData && settingsData.integrations.blob;
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Storefront content</h1><button class="btn small" id="contentSave" type="button">Save content</button></div>
    <div class="edit-grid">
      <div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Announcement bar</h2>
          <div class="field"><label style="display:flex;gap:0.5rem;align-items:center;text-transform:none">
            <input type="checkbox" id="annOn" style="width:auto" ${c.announcement.enabled ? "checked" : ""}> Show the bar on every storefront page</label></div>
          <div class="field"><label>Text</label><input id="annText" value="${esc(c.announcement.text)}" placeholder="Free shipping over $75 ✦"></div>
        </div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Landing hero</h2>
          <div class="field"><label>Title — wrap a word in | | for italic gold</label><input id="heroTitle" value="${esc(c.hero.title)}"></div>
          <div class="field"><label>Tagline</label><input id="heroTag" value="${esc(c.hero.tagline)}"></div>
          <div class="field"><label>Image path</label><input id="heroImg" value="${esc(c.hero.image)}"></div>
        </div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Category tiles</h2>
        ${c.tiles.map((t, i) => `
          <div class="field"><label>${esc(t.category)} tile image</label><input data-tile="${i}" value="${esc(t.image)}"></div>`).join("")}
        <p class="mono" style="font-size:0.58rem;color:var(--ink-soft)">
          Paths under /assets/img/… or uploaded URLs.${blobOn ? "" : " Enable Vercel Blob for direct uploads (Settings shows integration status)."}</p>
      </div>
    </div>
    <div class="admin-msg" id="contentMsg"></div>`;
  document.getElementById("contentSave").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const msg = document.getElementById("contentMsg");
    try {
      await Store.api("admin/content", {
        method: "PUT",
        body: {
          announcement: { enabled: document.getElementById("annOn").checked, text: document.getElementById("annText").value },
          hero: {
            title: document.getElementById("heroTitle").value,
            tagline: document.getElementById("heroTag").value,
            image: document.getElementById("heroImg").value,
          },
          tiles: ["ear", "neck", "rings"].map((cat, i) => ({ category: cat, image: document.querySelector(`[data-tile="${i}"]`).value })),
        },
      });
      Store.toast("Content saved — live within a minute");
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
}

/* ================= Pages ================= */

async function viewPages() {
  const { pages } = await Store.api("admin/pages");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Pages</h1>
      <div class="toolbar"><input id="pgTitle" placeholder="New page title…"><button class="btn small" id="pgCreate" type="button">Create</button></div></div>
    <p style="color:var(--ink-soft);font-size:0.85rem;margin-bottom:1rem">Published pages appear in the storefront footer at /p?slug=…
      Recommended for launch: Shipping &amp; Returns, Privacy, Terms.</p>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${pages.map((p) => `
        <tr class="click" data-id="${p.id}"><td><b>${esc(p.title)}</b></td>
        <td class="mono-cell">/p?slug=${esc(p.slug)}</td>
        <td>${p.published ? pill("active") : pill("draft")}</td>
        <td class="mono-cell">${dt(p.updated_at)}</td></tr>`).join("") ||
        '<tr><td colspan="4" style="color:var(--ink-soft)">No pages yet</td></tr>'}
      </tbody></table></div></div>`;
  document.getElementById("pgCreate").onclick = async () => {
    const title = document.getElementById("pgTitle").value.trim();
    if (!title) return;
    const r = await Store.api("admin/pages", { method: "POST", body: { title } });
    location.hash = `#/pages/${r.page.id}`;
  };
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/pages/${tr.dataset.id}`; }; });
}

async function viewPageEditor(id) {
  const { page } = await Store.api(`admin/pages/${id}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">${esc(page.title)}</h1>
      <div class="toolbar">
        <a class="btn ghost small" href="/p?slug=${encodeURIComponent(page.slug)}" target="_blank" rel="noopener">View ↗</a>
        <button class="btn ghost small" id="pgDelete" type="button" style="border-color:var(--ruby);color:var(--ruby)">Delete</button>
        <button class="btn small" id="pgSave" type="button">Save page</button>
      </div></div>
    <div class="edit-grid">
      <div class="panel pad">
        <div class="form-row">
          <div class="field"><label>Title</label><input id="peTitle" value="${esc(page.title)}"></div>
          <div class="field"><label>Slug</label><input id="peSlug" value="${esc(page.slug)}"></div>
        </div>
        <div class="field"><label>Body — supports ## headings, **bold**, *italic*, [links](https://…), blank line = new paragraph</label>
          <textarea id="peBody" rows="18" style="font-family:var(--mono);font-size:0.8rem">${esc(page.body)}</textarea></div>
        <div class="field"><label style="display:flex;gap:0.5rem;align-items:center;text-transform:none">
          <input type="checkbox" id="pePublished" style="width:auto" ${page.published ? "checked" : ""}> Published (visible in footer + /p)</label></div>
        <div class="admin-msg" id="peMsg"></div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Preview</h2>
        <div class="page-body" id="pePreview"></div>
      </div>
    </div>`;
  const preview = () => { document.getElementById("pePreview").innerHTML = Store.mdToHtml(document.getElementById("peBody").value); };
  preview();
  document.getElementById("peBody").addEventListener("input", preview);
  document.getElementById("pgSave").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const msg = document.getElementById("peMsg");
    try {
      await Store.api(`admin/pages/${id}`, { method: "PATCH", body: {
        title: document.getElementById("peTitle").value,
        slug: document.getElementById("peSlug").value,
        body: document.getElementById("peBody").value,
        published: document.getElementById("pePublished").checked,
      } });
      Store.toast("Page saved");
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
  document.getElementById("pgDelete").onclick = async () => {
    if (!confirm("Delete this page?")) return;
    await Store.api(`admin/pages/${id}`, { method: "DELETE" });
    location.hash = "#/pages";
  };
}

/* ================= Settings ================= */

async function viewSettings() {
  const { settings: s, integrations } = await Store.api("admin/settings");
  const integ = (on, name, hint) => `
    <div class="sum-row"><span>${name}</span><span>${on ? '<span class="status-pill paid">connected</span>' : `<span class="status-pill pending">not set</span>`}</span></div>
    ${on ? "" : `<p class="mono" style="font-size:0.56rem;color:var(--ink-soft);margin:-0.2rem 0 0.5rem">${hint}</p>`}`;
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Settings</h1><button class="btn small" id="setSave" type="button">Save settings</button></div>
    <div class="edit-grid">
      <div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Shipping</h2>
          <div class="form-row">
            <div class="field"><label>Flat rate (cents)</label><input id="sFlat" inputmode="numeric" value="${s["shipping.flat_cents"]}"></div>
            <div class="field"><label>Free over (cents)</label><input id="sFree" inputmode="numeric" value="${s["shipping.free_threshold_cents"]}"></div>
          </div>
        </div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Abandoned bags — 3-touch ladder</h2>
          <div class="form-row">
            <div class="field"><label>Abandon after (minutes — 30-60 converts best)</label><input id="sAbMin" inputmode="numeric" value="${s["abandoned.minutes"]}"></div>
            <div class="field"><label>2nd email after (hours, 0 = off)</label><input id="sAb2" inputmode="numeric" value="${s["abandoned.second_reminder_hours"]}"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>3rd email after 2nd (hours, 0 = off)</label><input id="sAb3" inputmode="numeric" value="${s["abandoned.third_reminder_hours"]}"></div>
            <div class="field"><label>Incentive code from email 2 (optional)</label><input id="sAbCode" value="${esc(s["abandoned.incentive_code"] || "")}" placeholder="e.g. COMEBACK10"></div>
          </div>
        </div>
        <div class="panel pad">
          <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Tax</h2>
          <div class="field"><label>Default rate (%)</label><input id="sTaxDef" inputmode="decimal" value="${s["tax.default_pct"]}"></div>
          <div class="field"><label>Per-country rates (JSON, e.g. {"GB": 20, "DE": 19})</label>
            <textarea id="sTaxByCountry" rows="3" style="font-family:var(--mono);font-size:0.75rem">${esc(JSON.stringify(s["tax.by_country"]))}</textarea></div>
        </div>
        <div class="admin-msg" id="setMsg"></div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Integrations</h2>
        ${integrations.paymentProvider
          ? integ(true, `Payments — ${esc(integrations.paymentProvider)}`, "")
          : integ(false, "Payment gateway", "Pick a gateway, add its adapter under backend/lib/payments/, set PAYMENT_PROVIDER — checkout runs in test mode until then")}
        ${integ(integrations.resend, "Resend email", "Set RESEND_API_KEY — emails are logged, not delivered, until then")}
        ${integ(integrations.blob, "Vercel Blob uploads", "Add a Blob store to the project for image uploads")}
        ${integ(integrations.cronSecret, "Cron secret", "Set CRON_SECRET to lock the hourly sweep")}
      </div>
    </div>`;
  document.getElementById("setSave").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const msg = document.getElementById("setMsg");
    try {
      let byCountry;
      try { byCountry = JSON.parse(document.getElementById("sTaxByCountry").value || "{}"); }
      catch (_) { throw new Error("Per-country tax must be valid JSON"); }
      await Store.api("admin/settings", { method: "PUT", body: { settings: {
        "shipping.flat_cents": parseInt(document.getElementById("sFlat").value, 10),
        "shipping.free_threshold_cents": parseInt(document.getElementById("sFree").value, 10),
        "abandoned.minutes": parseInt(document.getElementById("sAbMin").value, 10),
        "abandoned.second_reminder_hours": parseInt(document.getElementById("sAb2").value, 10),
        "abandoned.third_reminder_hours": parseInt(document.getElementById("sAb3").value, 10),
        "abandoned.incentive_code": document.getElementById("sAbCode").value,
        "tax.default_pct": parseFloat(document.getElementById("sTaxDef").value) || 0,
        "tax.by_country": byCountry,
      } } });
      Store.toast("Settings saved");
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
}

/* ================= Staff & audit ================= */

async function viewStaff() {
  const [{ staff }, { audit }] = await Promise.all([Store.api("admin/staff"), Store.api("admin/audit")]);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Staff</h1></div>
    <div class="panel pad">
      <div class="toolbar">
        <input id="stEmail" type="email" placeholder="email@…">
        <input id="stName" placeholder="Name">
        <select id="stRole"><option>viewer</option><option>editor</option><option>admin</option></select>
        <button class="btn small" id="stInvite" type="button">Invite</button>
      </div>
      <p class="mono" style="font-size:0.58rem;color:var(--ink-soft);margin-top:0.6rem">
        viewer = read-only · editor = run the shop · admin = settings, staff &amp; destructive actions.
        Invites get a temporary password by email (logged when Resend isn't configured).</p>
      <div class="admin-msg" id="stMsg"></div>
    </div>
    <div class="panel"><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>2FA</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
      <tbody>${staff.map((u) => `
        <tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td>
        <td><select data-role="${u.id}">${["viewer", "editor", "admin", "customer"].map((r) => `<option ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td>
        <td>${u.totp_enabled ? "✓" : "—"}</td>
        <td>${u.disabled ? pill("archived") : pill("active")}</td>
        <td class="mono-cell">${u.last_login_at ? dt(u.last_login_at) : "never"}</td>
        <td><button class="btn ghost small" data-staff-save="${u.id}" type="button">Apply</button></td></tr>`).join("")}
      </tbody></table></div></div>
    <div class="panel">
      <div class="panel-head"><h2 class="serif">Audit log</h2><span class="mono" style="font-size:0.6rem;color:var(--ink-soft)">every CMS write, newest first</span></div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>
        <tbody>${audit.map((a) => `
          <tr><td class="mono-cell">${dt(a.created_at)}</td><td>${esc(a.email)}</td>
          <td class="mono-cell">${esc(a.method)} ${esc(a.path)}</td></tr>`).join("") ||
          '<tr><td colspan="3" style="color:var(--ink-soft)">Nothing yet</td></tr>'}
        </tbody></table></div>
    </div>`;
  document.getElementById("stInvite").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const msg = document.getElementById("stMsg");
    try {
      const r = await Store.api("admin/staff", { method: "POST", body: {
        email: document.getElementById("stEmail").value,
        name: document.getElementById("stName").value,
        role: document.getElementById("stRole").value,
      } });
      Store.toast(r.promoted ? "Existing account promoted" : "Invite sent");
      viewStaff();
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
  document.querySelectorAll("[data-staff-save]").forEach((b) => {
    b.onclick = async () => {
      try {
        await Store.api(`admin/staff/${b.dataset.staffSave}`, { method: "PATCH", body: {
          role: document.querySelector(`[data-role="${b.dataset.staffSave}"]`).value,
        } });
        Store.toast("Updated");
        viewStaff();
      } catch (e) { Store.toast(e.message); }
    };
  });
}

/* ================= Security (own account 2FA) ================= */

async function viewSecurity() {
  const { user } = await Store.api("auth/me");
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Security</h1></div>
    <div class="edit-grid">
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Two-factor authentication</h2>
        <p style="font-size:0.88rem;color:var(--ink-soft)">Status: <b style="color:var(--ink)">${user.totpEnabled ? "enabled ✓" : "off"}</b></p>
        <div id="totpFlow" style="margin-top:1rem">
          ${user.totpEnabled
            ? `<div class="field"><label>Current code (to turn off)</label><input id="totpCode" inputmode="numeric" placeholder="123 456"></div>
               <button class="btn ghost small" id="totpOff" type="button" style="border-color:var(--ruby);color:var(--ruby)">Disable 2FA</button>`
            : `<button class="btn small" id="totpStart" type="button">Set up 2FA</button>
               <div id="totpSetupBox" hidden>
                 <p style="font-size:0.85rem;color:var(--ink-soft);margin-top:1rem">Add this secret to your authenticator app (manual entry), then confirm with a code:</p>
                 <div class="secret-box" id="totpSecret"></div>
                 <div class="field"><label>Code from the app</label><input id="totpCode" inputmode="numeric" placeholder="123 456"></div>
                 <button class="btn small" id="totpConfirm" type="button">Confirm &amp; enable</button>
               </div>`}
        </div>
        <div class="admin-msg" id="totpMsg"></div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Sessions</h2>
        <p style="font-size:0.88rem;color:var(--ink-soft)">Signed in as ${esc(user.email)} (${esc(user.role)}).</p>
        <button class="btn ghost small" id="signOutAll" type="button" style="margin-top:1rem">Sign out everywhere</button>
      </div>
    </div>`;
  const msg = document.getElementById("totpMsg");
  const startBtn = document.getElementById("totpStart");
  if (startBtn) startBtn.onclick = async () => {
    const r = await Store.api("admin/totp/setup", { method: "POST", body: {} });
    document.getElementById("totpSecret").textContent = r.secret;
    document.getElementById("totpSetupBox").hidden = false;
    startBtn.disabled = true;
  };
  const confirmBtn = document.getElementById("totpConfirm");
  if (confirmBtn) confirmBtn.onclick = async () => {
    try {
      await Store.api("admin/totp/enable", { method: "POST", body: { code: document.getElementById("totpCode").value } });
      Store.toast("2FA enabled — you'll need a code at every sign-in");
      viewSecurity();
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  };
  const offBtn = document.getElementById("totpOff");
  if (offBtn) offBtn.onclick = async () => {
    try {
      await Store.api("admin/totp/disable", { method: "POST", body: { code: document.getElementById("totpCode").value } });
      Store.toast("2FA disabled");
      viewSecurity();
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  };
  document.getElementById("signOutAll").onclick = async () => {
    await Store.api("auth/logout-all", { method: "POST" });
    location.reload();
  };
}

/* ================= Emails ================= */

async function viewEmails() {
  const templates = ["order_confirmation", "shipping_confirmation", "cart_recovery", "password_reset"];
  const state = viewEmails.state || (viewEmails.state = { current: templates[0] });
  const { subject, html } = await Store.api(`admin/emails/${state.current}/preview`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Emails</h1>
      <button class="btn small" id="emTest" type="button">Send test to me</button></div>
    <div class="panel">
      <div class="panel-head">
        <div class="range-chips">${templates.map((t) => `
          <button data-em="${t}" class="${state.current === t ? "active" : ""}" type="button">${t.replace(/_/g, " ")}</button>`).join("")}
        </div>
        <span class="mono" style="font-size:0.62rem;color:var(--ink-soft)">Subject: ${esc(subject)}</span>
      </div>
      <div class="pad"><iframe class="email-frame" id="emFrame" title="Email preview"></iframe></div>
    </div>`;
  document.getElementById("emFrame").srcdoc = html;
  document.querySelectorAll("[data-em]").forEach((b) => {
    b.onclick = () => { state.current = b.dataset.em; viewEmails(); };
  });
  document.getElementById("emTest").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const r = await Store.api(`admin/emails/${state.current}/test`, { method: "POST", body: {} });
    Store.toast(r.delivered ? `Test sent to ${r.to}` : `Logged only (no RESEND_API_KEY) — would go to ${r.to}`);
  });
}

/* ================= Customer detail ================= */

async function viewCustomerDetail(id) {
  const { customer, orders, stats } = await Store.api(`admin/customers/${id}`);
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">${esc(customer.name || customer.email)}</h1>
      <a class="btn ghost small" href="#/customers">← Customers</a></div>
    <div class="tiles">
      <div class="tile"><div class="k">Lifetime spend</div><div class="v">${fmt(stats.lifetimeCents)}</div></div>
      <div class="tile"><div class="k">Orders</div><div class="v">${stats.orders}</div></div>
      <div class="tile"><div class="k">Customer since</div><div class="v" style="font-size:1.1rem">${new Date(customer.created_at).toLocaleDateString()}</div></div>
    </div>
    <div class="edit-grid">
      <div class="panel">
        <div class="panel-head"><h2 class="serif">Orders</h2></div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Order</th><th>Status</th><th>Total</th><th>When</th></tr></thead>
          <tbody>${orders.map((o) => `
            <tr class="click" data-id="${o.id}"><td class="mono-cell">${esc(o.number)}</td>
            <td>${pill(o.status)}</td><td class="mono-cell">${fmt(o.total_cents, o.currency)}</td>
            <td class="mono-cell">${dt(o.created_at)}</td></tr>`).join("") ||
            '<tr><td colspan="4" style="color:var(--ink-soft)">No orders</td></tr>'}
          </tbody></table></div>
      </div>
      <div class="panel pad">
        <h2 class="serif" style="font-size:1.05rem;margin-bottom:0.9rem">Profile</h2>
        <dl class="kv" style="margin-bottom:1rem">
          <dt>Email</dt><dd>${esc(customer.email)}</dd>
          <dt>Role</dt><dd>${esc(customer.role)}</dd>
          <dt>2FA</dt><dd>${customer.totp_enabled ? "enabled" : "off"}</dd>
        </dl>
        <div class="field"><label>Tags (comma separated)</label><input id="cdTags" value="${esc((customer.tags || []).join(", "))}"></div>
        <div class="field"><label>Internal notes</label><textarea id="cdNotes" rows="4">${esc(customer.notes)}</textarea></div>
        <div class="field"><label style="display:flex;gap:0.5rem;align-items:center;text-transform:none">
          <input type="checkbox" id="cdDisabled" style="width:auto" ${customer.disabled ? "checked" : ""}> Account disabled (blocks sign-in)</label></div>
        <button class="btn small" id="cdSave" type="button">Save</button>
        <div class="admin-msg" id="cdMsg"></div>
      </div>
    </div>`;
  document.querySelectorAll("tr.click").forEach((tr) => { tr.onclick = () => { location.hash = `#/orders/${tr.dataset.id}`; }; });
  document.getElementById("cdSave").onclick = async () => {
    const msg = document.getElementById("cdMsg");
    try {
      await Store.api(`admin/customers/${id}`, { method: "PATCH", body: {
        tags: document.getElementById("cdTags").value.split(",").map((t) => t.trim()).filter(Boolean),
        notes: document.getElementById("cdNotes").value,
        disabled: document.getElementById("cdDisabled").checked,
      } });
      Store.toast("Customer saved");
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  };
}

/* ================= Manual order ================= */

async function viewManualOrder() {
  $m().innerHTML = `
    <div class="admin-head"><h1 class="serif">Manual order</h1><a class="btn ghost small" href="#/orders">← Orders</a></div>
    <div class="edit-grid">
      <div class="panel pad">
        <div class="form-row">
          <div class="field"><label>Customer email</label><input id="moEmail" type="email"></div>
          <div class="field"><label>Name</label><input id="moName"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Address</label><input id="moLine1"></div>
          <div class="field"><label>City</label><input id="moCity"></div>
        </div>
        <div class="form-row">
          <div class="field"><label>Postal</label><input id="moPostal"></div>
          <div class="field"><label>Country (2 letters)</label><input id="moCountry" value="US" maxlength="2"></div>
        </div>
        <h2 class="serif" style="font-size:1.05rem;margin:1rem 0 0.7rem">Lines</h2>
        <div id="moLines"></div>
        <button class="btn ghost small" id="moAddLine" type="button">＋ Add line</button>
        <div class="field" style="margin-top:1.2rem"><label style="display:flex;gap:0.5rem;align-items:center;text-transform:none">
          <input type="checkbox" id="moPaid" checked style="width:auto"> Mark paid immediately (sends confirmation email)</label></div>
        <button class="btn gold" id="moCreate" type="button">Create order</button>
        <div class="admin-msg" id="moMsg"></div>
      </div>
      <div class="panel pad">
        <p style="font-size:0.88rem;color:var(--ink-soft)">For phone / DM / in-person sales. Lines are looked up by SKU
          (find them under Inventory), stock is reserved exactly like a storefront order, and the sale lands in every report.</p>
      </div>
    </div>`;
  const linesEl = document.getElementById("moLines");
  const addLine = () => {
    const row = document.createElement("div");
    row.className = "form-row";
    row.innerHTML = `
      <div class="field"><label>SKU</label><input data-mo-sku style="font-family:var(--mono)"></div>
      <div class="field"><label>Qty</label><input data-mo-qty inputmode="numeric" value="1"></div>`;
    linesEl.appendChild(row);
  };
  addLine();
  document.getElementById("moAddLine").onclick = addLine;
  document.getElementById("moCreate").onclick = async (ev) => await withBusy(ev.currentTarget, async () => {
    const msg = document.getElementById("moMsg");
    const items = [...linesEl.querySelectorAll("[data-mo-sku]")].map((input, i) => ({
      sku: input.value.trim(),
      qty: parseInt(linesEl.querySelectorAll("[data-mo-qty]")[i].value, 10) || 1,
    })).filter((l) => l.sku);
    try {
      const r = await Store.api("admin/orders", { method: "POST", body: {
        email: document.getElementById("moEmail").value,
        name: document.getElementById("moName").value,
        address: {
          line1: document.getElementById("moLine1").value, city: document.getElementById("moCity").value,
          postal: document.getElementById("moPostal").value, country: document.getElementById("moCountry").value,
        },
        items,
        markPaid: document.getElementById("moPaid").checked,
      } });
      Store.toast(`Order ${r.order.number} created`);
      location.hash = `#/orders/${r.order.id}`;
    } catch (e) { msg.textContent = e.message; msg.className = "admin-msg err"; }
  });
}

/* routes merged into admin.js's table */
window.EXT_ROUTES = [
  [/^#\/inventory$/, viewInventory],
  [/^#\/inventory\/movements$/, viewMovements],
  [/^#\/collections$/, viewCollections],
  [/^#\/content$/, viewContent],
  [/^#\/pages$/, viewPages],
  [/^#\/pages\/(\d+)$/, (m) => viewPageEditor(m[1])],
  [/^#\/settings$/, viewSettings],
  [/^#\/staff$/, viewStaff],
  [/^#\/security$/, viewSecurity],
  [/^#\/emails$/, viewEmails],
  [/^#\/customers\/(\d+)$/, (m) => viewCustomerDetail(m[1])],
  [/^#\/orders\/new$/, viewManualOrder],
];
