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

/* A value is offered if an in-stock variant matches it PLUS everything else
   already selected — so choosing Gold greys out combinations Gold can't make. */
function valueAvailable(groupName, val) {
  return product.variants.some((v) =>
    v.available &&
    v.options[groupName] === val &&
    product.options.every((o) =>
      o.name === groupName || !selection[o.name] || v.options[o.name] === selection[o.name]));
}

const SWATCHES = {
  crystal: "sw-crystal", emerald: "sw-emerald", sapphire: "sw-sapphire",
  ruby: "sw-ruby", pink: "sw-pink",
};

function optionButton(o, val) {
  const active = selection[o.name] === val ? "active" : "";
  const avail = valueAvailable(o.name, val) ? "" : "unavailable";
  const swatch = /color/i.test(o.name) && SWATCHES[val.toLowerCase()];
  if (swatch) {
    return `<button type="button" class="opt-btn swatch ${swatch} ${active} ${avail}"
      data-opt="${Store.esc(o.name)}" data-val="${Store.esc(val)}"
      title="${Store.esc(val)}" aria-label="${Store.esc(val)}">${Store.esc(val)}</button>`;
  }
  return `<button type="button" class="opt-btn ${active} ${avail}"
    data-opt="${Store.esc(o.name)}" data-val="${Store.esc(val)}">${Store.esc(val)}</button>`;
}

function renderOptions() {
  $("optGroups").innerHTML = product.options.map((o) => `
    <div class="opt-group" data-opt="${Store.esc(o.name)}">
      <div class="opt-name">${Store.esc(o.name)} — <b>${Store.esc(selection[o.name] || "choose")}</b></div>
      <div class="opt-values">${o.values.map((val) => optionButton(o, val)).join("")}</div>
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
    Store.toast(`Added — ${product.title}`, { href: "/cart", label: "View bag →" });
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
  document.title = product.seoTitle || `${product.title} — ALORIA`;
  injectSeo();
  const catName = { ear: "Ear", neck: "Neck", rings: "Rings" }[product.category] || "Shop";
  const crumbs = $("crumbs");
  crumbs.hidden = false;
  crumbs.innerHTML = `<a href="/shop">Shop</a><span class="sep">/</span>` +
    `<a href="/shop?category=${product.category}">${catName}</a><span class="sep">/</span>` +
    `<span aria-current="page">${Store.esc(product.title)}</span>`;
  $("pdp").hidden = false;
  $("pCat").textContent = { ear: "01 · Ear", neck: "02 · Neck", rings: "03 · Rings" }[product.category] || "";
  $("pTitle").textContent = product.title;
  $("pSub").textContent = product.subtitle;
  $("pDesc").textContent = product.description;
  loadRelated();

  // preselect single-value options; leave real choices open
  for (const o of product.options) if (o.values.length === 1) selection[o.name] = o.values[0];
  renderGallery();
  renderOptions();
  syncState();

  $("addBtn").onclick = addToBag;
  $("qtyMinus").onclick = () => { $("qtyInput").value = Math.max(1, (parseInt($("qtyInput").value, 10) || 1) - 1); };
  $("qtyPlus").onclick = () => { $("qtyInput").value = Math.min(10, (parseInt($("qtyInput").value, 10) || 1) + 1); };
}

/* Meta description + schema.org Product markup (crawlers render JS). */
function injectSeo() {
  const meta = document.createElement("meta");
  meta.name = "description";
  meta.content = product.seoDescription || `${product.subtitle}. ${product.description}`.slice(0, 155);
  document.head.appendChild(meta);
  const prices = product.variants.map((v) => v.priceCents / 100);
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.description,
    image: product.images.map((i) => new URL(i, location.origin).href),
    brand: { "@type": "Brand", name: "Aloria" },
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: product.currency,
      lowPrice: Math.min(...prices).toFixed(2),
      highPrice: Math.max(...prices).toFixed(2),
      offerCount: product.variants.length,
      availability: product.variants.some((v) => v.available)
        ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    },
  };
  const s = document.createElement("script");
  s.type = "application/ld+json";
  s.textContent = JSON.stringify(ld);
  document.head.appendChild(s);
}

/* "Complete the stack" — other pieces from the same modular system. */
async function loadRelated() {
  try {
    const data = await Store.api(`products?category=${encodeURIComponent(product.category)}`);
    const others = data.products.filter((p) => p.slug !== product.slug).slice(0, 4);
    if (!others.length) return;
    $("relatedMore").href = `/shop?category=${product.category}`;
    $("relatedGrid").innerHTML = others.map((p) => `
      <a class="product-card" href="/shop/product?slug=${encodeURIComponent(p.slug)}">
        <div class="ph">${p.image ? `<img src="${Store.esc(p.image)}" alt="${Store.esc(p.title)}" loading="lazy">` : ""}</div>
        <div class="info">
          <h3 class="serif">${Store.esc(p.title)}</h3>
          <div class="price">${p.priceFromCents === p.priceToCents
            ? Store.money(p.priceFromCents, p.currency)
            : `From ${Store.money(p.priceFromCents, p.currency)}`}</div>
        </div>
      </a>`).join("");
    $("related").hidden = false;
  } catch (_) { /* cross-sell is optional */ }
}

Store.nav("shop");
Store.footer();
init();
