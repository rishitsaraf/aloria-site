/* Shop listing — category filters via ?category=, server-side data. */

const CAT_TITLES = { ear: "Ear", neck: "Neck", rings: "Rings" };

async function loadShop() {
  const category = Store.qs("category") || "";
  document.querySelectorAll(".filter-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.cat === category);
    b.onclick = () => { location.href = b.dataset.cat ? `/shop?category=${b.dataset.cat}` : "/shop"; };
  });
  document.getElementById("shopTitle").textContent = CAT_TITLES[category] || "Shop";
  document.getElementById("shopEyebrow").textContent = category ? "The collection" : "Stackable · Customisable · Yours";

  const grid = document.getElementById("grid");
  try {
    const data = await Store.api(`products${category ? `?category=${category}` : ""}`);
    document.getElementById("shopCount").textContent = `${data.total} piece${data.total === 1 ? "" : "s"}`;
    if (!data.products.length) {
      document.getElementById("emptyState").hidden = false;
      return;
    }
    grid.innerHTML = data.products.map((p) => `
      <a class="product-card" href="/shop/product?slug=${encodeURIComponent(p.slug)}">
        <div class="ph">
          ${p.image ? `<img src="${Store.esc(p.image)}" alt="${Store.esc(p.title)}" loading="lazy">` : ""}
          ${p.hoverImage ? `<img class="hover" src="${Store.esc(p.hoverImage)}" alt="" loading="lazy">` : ""}
          ${!p.inStock ? '<span class="badge soldout">Sold out</span>' : (p.featured ? '<span class="badge featured">Signature</span>' : "")}
        </div>
        <div class="info">
          <h3 class="serif">${Store.esc(p.title)}</h3>
          <div class="sub">${Store.esc(p.subtitle)}</div>
          <div class="price">${p.priceFromCents === p.priceToCents
            ? Store.money(p.priceFromCents, p.currency)
            : `From ${Store.money(p.priceFromCents, p.currency)}`}</div>
        </div>
      </a>`).join("");
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
loadShop();
