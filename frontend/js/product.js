/* Product detail — variant selection over the option matrix.
   The selected combination resolves to exactly one variant; unavailable
   combinations are visible but marked. Price/stock always reflect the
   resolved variant. */

let product = null;
let selection = {};

const $ = (id) => document.getElementById(id);

function variantFor(sel) {
  return product.variants.find((v) => product.options.every((o) => v.options[o.name] === sel[o.name]));
}

function anyVariantWith(partialSel) {
  return product.variants.some((v) =>
    Object.entries(partialSel).every(([k, val]) => v.options[k] === val) && v.available);
}

function renderOptions() {
  $("optGroups").innerHTML = product.options.map((o) => `
    <div class="opt-group" data-opt="${Store.esc(o.name)}">
      <div class="opt-name">${Store.esc(o.name)} — <b>${Store.esc(selection[o.name] || "choose")}</b></div>
      <div class="opt-values">
        ${o.values.map((val) => {
          const probe = { ...selection, [o.name]: val };
          const cls = [
            "opt-btn",
            selection[o.name] === val ? "active" : "",
            anyVariantWith({ [o.name]: val }) ? "" : "unavailable",
          ].join(" ").trim();
          return `<button type="button" class="${cls}" data-opt="${Store.esc(o.name)}" data-val="${Store.esc(val)}">${Store.esc(val)}</button>`;
        }).join("")}
      </div>
    </div>`).join("");
  document.querySelectorAll(".opt-btn").forEach((b) => {
    b.onclick = () => {
      selection[b.dataset.opt] = b.dataset.val;
      renderOptions();
      syncState();
    };
  });
}

function syncState() {
  const complete = product.options.every((o) => selection[o.name]);
  const v = complete ? variantFor(selection) : null;
  const price = $("pPrice"), note = $("stockNote"), btn = $("addBtn"), compare = $("pCompare");

  if (v && v.image) setMainImage(v.image);

  if (!complete) {
    const min = Math.min(...product.variants.map((x) => x.priceCents));
    const max = Math.max(...product.variants.map((x) => x.priceCents));
    price.textContent = min === max ? Store.money(min, product.currency) : `${Store.money(min, product.currency)} – ${Store.money(max, product.currency)}`;
    compare.textContent = "";
    note.textContent = "";
    note.className = "stock-note";
    btn.disabled = true;
    btn.textContent = "Select options";
    return;
  }
  if (!v) {
    price.textContent = "—";
    note.textContent = "This combination isn't made";
    note.className = "stock-note low";
    btn.disabled = true;
    btn.textContent = "Unavailable";
    return;
  }
  price.textContent = Store.money(v.priceCents, product.currency);
  compare.textContent = v.compareAtCents ? Store.money(v.compareAtCents, product.currency) : "";
  if (!v.available) {
    note.textContent = "Sold out — check back soon";
    note.className = "stock-note low";
    btn.disabled = true;
    btn.textContent = "Sold out";
  } else {
    note.textContent = v.lowStock ? "Only a few left" : `In stock · ${v.sku}`;
    note.className = v.lowStock ? "stock-note low" : "stock-note ok";
    btn.disabled = false;
    btn.textContent = "Add to bag";
  }
}

function setMainImage(src) {
  $("mainImg").src = src;
  document.querySelectorAll(".pdp-thumbs button").forEach((t) => t.classList.toggle("active", t.dataset.src === src));
}

function renderGallery() {
  const imgs = product.images.length ? product.images : [];
  if (imgs.length) setMainImage(imgs[0]);
  $("thumbs").innerHTML = imgs.map((src, i) => `
    <button type="button" data-src="${Store.esc(src)}" class="${i === 0 ? "active" : ""}" aria-label="View image ${i + 1}">
      <img src="${Store.esc(src)}" alt="" loading="lazy">
    </button>`).join("");
  document.querySelectorAll(".pdp-thumbs button").forEach((t) => { t.onclick = () => setMainImage(t.dataset.src); });
}

async function addToBag() {
  const v = variantFor(selection);
  if (!v) return;
  const qty = Math.max(1, Math.min(10, parseInt($("qtyInput").value, 10) || 1));
  const btn = $("addBtn");
  btn.disabled = true;
  try {
    await Store.api("cart/items", { method: "POST", body: { variantId: v.id, qty } });
    Store.refreshBadge();
    Store.toast(`Added to your bag — ${product.title}`);
    $("pdpMsg").textContent = "";
  } catch (e) {
    $("pdpMsg").textContent = e.message;
    $("pdpMsg").className = "form-msg err";
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  const slug = Store.qs("slug");
  try {
    if (!slug) throw new Error("no slug");
    const data = await Store.api(`products/${encodeURIComponent(slug)}`);
    product = data.product;
  } catch (_) {
    $("pdpEmpty").hidden = false;
    return;
  }
  document.title = `${product.title} — ALORIA`;
  $("pdp").hidden = false;
  $("pCat").textContent = { ear: "01 · Ear", neck: "02 · Neck", rings: "03 · Rings" }[product.category] || "";
  $("pTitle").textContent = product.title;
  $("pSub").textContent = product.subtitle;
  $("pDesc").textContent = product.description;

  // preselect single-value options; leave real choices open
  for (const o of product.options) if (o.values.length === 1) selection[o.name] = o.values[0];
  renderGallery();
  renderOptions();
  syncState();

  $("addBtn").onclick = addToBag;
  $("qtyMinus").onclick = () => { $("qtyInput").value = Math.max(1, (parseInt($("qtyInput").value, 10) || 1) - 1); };
  $("qtyPlus").onclick = () => { $("qtyInput").value = Math.min(10, (parseInt($("qtyInput").value, 10) || 1) + 1); };
}

Store.nav("shop");
Store.footer();
init();
