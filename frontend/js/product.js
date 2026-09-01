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
  const pressed = selection[o.name] === val ? "true" : "false";
  const availNote = avail ? "" : " (unavailable in this combination)";
  if (swatch) {
    return `<button type="button" class="opt-btn swatch ${swatch} ${active} ${avail}" aria-pressed="${pressed}"
      data-opt="${Store.esc(o.name)}" data-val="${Store.esc(val)}"
      title="${Store.esc(val)}" aria-label="${Store.esc(val)}${availNote}">${Store.esc(val)}</button>`;
  }
  return `<button type="button" class="opt-btn ${active} ${avail}" aria-pressed="${pressed}"
    data-opt="${Store.esc(o.name)}" data-val="${Store.esc(val)}"
    aria-label="${Store.esc(val)}${availNote}">${Store.esc(val)}</button>`;
}

function renderOptions() {
  $("optGroups").innerHTML = product.options.map((o) => `
    <div class="opt-group" data-opt="${Store.esc(o.name)}" role="group" aria-label="${Store.esc(o.name)}">
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
  $("mainImg").alt = product ? product.title : "";
  document.querySelectorAll(".pdp-thumbs button").forEach((t) => t.classList.toggle("active", t.dataset.src === src));
}

function renderGallery() {
  const imgs = product.images.length ? product.images : [];
  if (imgs.length) setMainImage(imgs[0]);
  $("thumbs").innerHTML = imgs.map((src, i) => `
    <button type="button" data-src="${Store.esc(src)}" class="${i === 0 ? "active" : ""}" aria-label="View image ${i + 1} of ${imgs.length}">
      <img src="${Store.esc(src)}" alt="${Store.esc(product.title)} — view ${i + 1}" loading="lazy">
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

  loadReviews();
  initZoom();
  if (product.videoUrl) {
    $("pdpVideo").hidden = false;
    $("pdpVideoEl").src = product.videoUrl;
  }
  Store.content().then((c) => {
    const t = c.shipping && c.shipping.freeThresholdCents;
    if (t > 0) {
      $("trustShip").hidden = false;
      $("trustShip").textContent = `◈ Free shipping over ${Store.money(t, product.currency)}`;
    }
  }).catch(() => {});
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
    ...(product.rating && product.rating.count > 0 ? {
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: product.rating.avg.toFixed(1),
        reviewCount: product.rating.count,
        bestRating: 5,
      },
    } : {}),
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

/* Image zoom — hover magnifies around the cursor; click (or tap) toggles,
   so it works for touch and keyboard too. */
function initZoom() {
  const wrap = $("mainWrap"), img = $("mainImg");
  if (!wrap || !img) return;
  wrap.classList.add("zoomable");
  wrap.setAttribute("tabindex", "0");
  wrap.setAttribute("role", "button");
  wrap.setAttribute("aria-label", "Zoom product image");
  const setOrigin = (e) => {
    const r = wrap.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 100;
    const y = ((e.clientY - r.top) / r.height) * 100;
    img.style.transformOrigin = `${x}% ${y}%`;
  };
  wrap.addEventListener("mousemove", (e) => { if (wrap.classList.contains("zoomed")) setOrigin(e); });
  wrap.addEventListener("click", (e) => { setOrigin(e); wrap.classList.toggle("zoomed"); });
  wrap.addEventListener("mouseleave", () => wrap.classList.remove("zoomed"));
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); wrap.classList.toggle("zoomed"); }
    if (e.key === "Escape") wrap.classList.remove("zoomed");
  });
}

/* ---------------- Reviews ---------------- */

function starsHtml(n) {
  const full = Math.round(n);
  return "★".repeat(full) + "☆".repeat(5 - full);
}

async function loadReviews() {
  let data;
  try {
    data = await Store.api(`products/${encodeURIComponent(product.slug)}/reviews`);
  } catch (_) { return; } // reviews are optional decoration
  const { summary, reviews } = data;
  $("reviews").hidden = false;

  if (summary.count > 0) {
    $("revSummary").hidden = false;
    $("revAvg").textContent = summary.avg.toFixed(1);
    $("revStars").textContent = starsHtml(summary.avg);
    $("revCount").textContent = `${summary.count} review${summary.count === 1 ? "" : "s"}`;
    $("revBars").innerHTML = [5, 4, 3, 2, 1].map((s) => {
      const n = summary.histogram[s] || 0;
      const pct = summary.count ? Math.round((n / summary.count) * 100) : 0;
      return `<div class="rev-bar-row"><span class="lbl">${s}★</span>
        <div class="bar" role="img" aria-label="${n} ${s}-star review${n === 1 ? "" : "s"}"><i style="width:${pct}%"></i></div>
        <span class="n">${n}</span></div>`;
    }).join("");
  }

  $("revEmpty").hidden = reviews.length > 0;
  $("revList").innerHTML = reviews.map((r) => `
    <article class="review-card">
      <div class="rev-head">
        <span class="stars" aria-label="${r.rating} out of 5 stars">${starsHtml(r.rating)}</span>
        ${r.title ? `<b>${Store.esc(r.title)}</b>` : ""}
      </div>
      <p>${Store.esc(r.body)}</p>
      <div class="rev-meta">${Store.esc(r.author)}${r.verified ? ' · <span class="verified">✓ Verified buyer</span>' : ""}
        · ${new Date(r.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</div>
      ${r.reply ? `<div class="rev-reply"><b>ALORIA</b> ${Store.esc(r.reply)}</div>` : ""}
    </article>`).join("");

  // form wiring (hide email field when logged in — we already know it)
  Store.api("auth/me").then(({ user }) => {
    if (user) {
      $("revEmailWrap").hidden = true;
      if (!$("revName").value) $("revName").value = (user.name || "").split(" ")[0];
    }
  }).catch(() => {});
  $("revWriteBtn").onclick = () => {
    const f = $("revForm");
    f.hidden = !f.hidden;
    if (!f.hidden) $("revName").focus();
  };
  $("revForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = $("revMsg");
    $("revSubmit").disabled = true;
    try {
      const r = await Store.api(`products/${encodeURIComponent(product.slug)}/reviews`, {
        method: "POST",
        body: {
          rating: parseInt($("revRating").value, 10),
          name: $("revName").value,
          email: $("revEmail").value || undefined,
          title: $("revTitle").value,
          body: $("revBody").value,
        },
      });
      msg.textContent = "";
      $("revForm").reset();
      $("revForm").hidden = true;
      Store.toast(r.verified
        ? "Thank you — your verified review is awaiting moderation"
        : "Thank you — your review is awaiting moderation");
    } catch (err) {
      msg.className = "form-msg err";
      msg.textContent = err.message;
    } finally {
      $("revSubmit").disabled = false;
    }
  };
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
