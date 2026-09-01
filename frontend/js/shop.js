/* Shop listing — landing sections on the bare /shop, category filters via
   ?category=, live search via ?q=, and cursorless load-more pagination. */

const CAT_TITLES = { ear: "Ear", neck: "Neck", rings: "Rings" };
let page = 1;

function cardHtml(p) {
  return `
    <a class="product-card" href="/shop/product?slug=${encodeURIComponent(p.slug)}">
      <div class="ph">
        ${p.image ? `<img src="${Store.esc(p.image)}" alt="${Store.esc(p.title)}" loading="lazy">` : ""}
        ${p.hoverImage ? `<img class="hover" src="${Store.esc(p.hoverImage)}" alt="" loading="lazy">` : ""}
        ${!p.inStock ? '<span class="badge soldout">Sold out</span>' : (p.featured ? '<span class="badge featured">Signature</span>' : "")}
      </div>
      <div class="info">
        <h3 class="serif">${Store.esc(p.title)}</h3>
        <div class="sub">${Store.esc(p.subtitle)}</div>
        ${p.ratingCount ? `<div class="card-rating" aria-label="Rated ${p.ratingAvg.toFixed(1)} out of 5 from ${p.ratingCount} reviews">
          <span class="stars">${"★".repeat(Math.round(p.ratingAvg))}${"☆".repeat(5 - Math.round(p.ratingAvg))}</span> <span class="n">(${p.ratingCount})</span></div>` : ""}
        <div class="price">${p.priceFromCents === p.priceToCents
          ? Store.money(p.priceFromCents, p.currency)
          : `From ${Store.money(p.priceFromCents, p.currency)}`}</div>
      </div>
    </a>`;
}

/* Landing hero + tiles are CMS content; |word| in the hero title renders
   italic gold. Collections appear as extra filter chips. */
async function applyContent() {
  const c = await Store.content();
  if (c.hero) {
    const heroTitle = Store.esc(c.hero.title || "").replace(/\|([^|]+)\|/g, "<em>$1</em>");
    document.querySelector(".shop-hero h2").innerHTML = heroTitle;
    document.querySelector(".shop-hero p").textContent = c.hero.tagline || "";
    if (c.hero.image) document.querySelector(".shop-hero img").src = c.hero.image;
  }
  if (Array.isArray(c.tiles)) {
    document.querySelectorAll(".cat-tile").forEach((tile, i) => {
      const t = c.tiles[i];
      if (t && t.image) tile.querySelector("img").src = t.image;
    });
  }
  const activeCollection = Store.qs("collection") || "";
  if (c.collections && c.collections.length) {
    const row = document.getElementById("filterRow");
    for (const coll of c.collections) {
      const b = document.createElement("button");
      b.className = `filter-btn coll ${activeCollection === coll.slug ? "active" : ""}`;
      b.textContent = coll.title;
      b.onclick = () => { location.href = `/shop?collection=${encodeURIComponent(coll.slug)}`; };
      row.appendChild(b);
    }
    if (activeCollection) {
      const found = c.collections.find((x) => x.slug === activeCollection);
      if (found) document.getElementById("shopTitle").textContent = found.title;
    }
  }
}

async function loadShop({ append = false } = {}) {
  const category = Store.qs("category") || "";
  const q = Store.qs("q") || "";
  const collection = Store.qs("collection") || "";
  const landing = !category && !q && !collection;

  document.getElementById("landing").hidden = !landing;
  document.querySelectorAll(".filter-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.cat === category);
    b.onclick = () => { location.href = b.dataset.cat ? `/shop?category=${b.dataset.cat}` : "/shop"; };
  });
  document.getElementById("shopTitle").textContent = q ? `“${q}”` : (CAT_TITLES[category] || "Shop");
  document.getElementById("shopEyebrow").textContent = q ? "Search" : (category ? "The collection" : "Stackable · Customisable · Yours");
  document.getElementById("searchInput").value = q;

  const grid = document.getElementById("grid");
  const more = document.getElementById("loadMore");
  try {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (q) params.set("q", q);
    if (collection) params.set("collection", collection);
    params.set("page", String(page));
    const data = await Store.api(`products?${params}`);
    document.getElementById("shopCount").textContent = `${data.total} piece${data.total === 1 ? "" : "s"}`;
    if (!data.products.length && page === 1) {
      grid.innerHTML = "";
      const empty = document.getElementById("emptyState");
      empty.hidden = false;
      if (q) {
        empty.querySelector(".big").textContent = "No pieces match";
        empty.querySelector("p").innerHTML = 'Try another word, or <a href="/shop">browse everything</a>.';
      }
      more.hidden = true;
      return;
    }
    document.getElementById("emptyState").hidden = true;
    const html = data.products.map(cardHtml).join("");
    if (append) grid.insertAdjacentHTML("beforeend", html);
    else grid.innerHTML = html;
    more.hidden = page >= data.pageCount;
  } catch (e) {
    grid.innerHTML = "";
    const empty = document.getElementById("emptyState");
    empty.hidden = false;
    empty.querySelector(".big").textContent = "The boutique is warming up";
    empty.querySelector("p").textContent = e.message;
  }
}

Store.nav("shop");
Store.footer();
applyContent();
loadShop();
document.getElementById("loadMore").onclick = () => { page += 1; loadShop({ append: true }); };
document.getElementById("searchForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = document.getElementById("searchInput").value.trim();
  location.href = q ? `/shop?q=${encodeURIComponent(q)}` : "/shop";
});
