/* ALORIA hub — assembly hero, reveals, swatch play, data-driven specs, gallery */
(function () {
  // ---- soft client-side guard (server-side middleware is the real gate when deployed)
  const hasCookie = document.cookie.includes("aloria_hint=1");
  const hasSession = sessionStorage.getItem("aloria_gate") === "open";
  const isLocal = ["localhost", "127.0.0.1", ""].includes(location.hostname);
  if (!hasCookie && !hasSession && !isLocal) { location.href = "/"; return; }

  // ---- hero assembly: pieces land one by one
  const pieces = document.querySelectorAll(".piece");
  const order = [".p-e1", ".p-e2", ".p-e4", ".p-e3a", ".p-e3b", ".p-e5"];
  order.forEach((sel, i) => {
    const el = document.querySelector(sel);
    if (el) setTimeout(() => el.classList.add("landed"), 550 + i * 420);
  });

  // ---- reveal on scroll
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  // ---- swatch play
  const view = document.getElementById("swatchView");
  const row = document.getElementById("swatchRow");
  const nameEl = document.getElementById("swatchName");
  const NAMES = { ruby: "Ruby Red", sapphire: "Sapphire Blue", emerald: "Emerald Green", pink: "Pink Romance", clear: "Crystal Clear" };
  if (row) {
    row.addEventListener("click", (e) => {
      const btn = e.target.closest(".swatch-btn");
      if (!btn) return;
      const c = btn.dataset.c;
      row.querySelectorAll(".swatch-btn").forEach((b) => b.classList.toggle("active", b === btn));
      view.querySelectorAll("img").forEach((img) => img.classList.toggle("active", img.dataset.c === c));
      nameEl.textContent = NAMES[c] || c;
    });
  }

  // ---- data-driven: concepts, component cards, spec tables, master table
  fetch("/data/skus.json").then((r) => r.json()).then((data) => {
    let total = 0;
    const masterRows = [];
    data.categories.forEach((cat) => {
      const conceptEl = document.querySelector(`[data-concept="${cat.id}"]`);
      if (conceptEl) conceptEl.textContent = cat.concept;

      const grid = document.querySelector(`[data-components="${cat.id}"]`);
      const drawer = document.querySelector(`[data-specs="${cat.id}"]`);
      let rows = "";
      cat.components.forEach((c) => {
        if (c.skus > 0) total += c.skus;
        if (grid && c.code !== "R-SIZE") {
          const card = document.createElement("div");
          card.className = "comp-card reveal";
          card.innerHTML = `<span class="code">${c.code}</span><h4>${c.name}</h4><p>${c.function}</p>` +
            (c.skus ? `<div class="skus">${c.variants} — <b>${c.skus} SKUs</b></div>` : "");
          grid.appendChild(card);
          io.observe(card);
        }
        rows += `<tr><td class="code">${c.code}</td><td>${c.name}</td><td>${c.function}</td><td>${c.variants || "—"}</td><td>${c.skus || "—"}</td></tr>`;
        masterRows.push(`<tr><td class="code">${c.code}</td><td>${cat.name}</td><td>${c.name}</td><td>${c.variants || "—"}</td><td>${c.skus || "—"}</td></tr>`);
      });
      if (drawer) {
        drawer.insertAdjacentHTML("beforeend",
          `<table><thead><tr><th>Code</th><th>Component</th><th>Function</th><th>Variants</th><th>SKUs</th></tr></thead><tbody>${rows}</tbody></table>`);
      }
    });
    const master = document.querySelector("[data-master]");
    if (master) master.insertAdjacentHTML("beforeend",
      `<table><thead><tr><th>Code</th><th>Category</th><th>Component</th><th>Variants</th><th>SKUs</th></tr></thead><tbody>${masterRows.join("")}</tbody></table>`);
    const totalEl = document.getElementById("skuTotal");
    if (totalEl) totalEl.textContent = total;
  }).catch(() => {});

  // ---- reference gallery
  const GALLERY = [
    ["ear", "worn/ear/ear_worn_01"], ["ear", "worn/ear/ear_worn_02"], ["ear", "worn/ear/ear_worn_03"],
    ["ear", "worn/ear/ear_worn_04"], ["ear", "worn/ear/ear_worn_05"], ["ear", "worn/ear/ear_worn_06"],
    ["ear", "worn/ear/ear_worn_07"], ["ear", "worn/ear/ear_worn_08"],
    ["neck", "worn/neck/neck_worn_01"], ["neck", "worn/neck/neck_worn_02"], ["neck", "worn/neck/neck_worn_03"],
    ["neck", "worn/neck/neck_worn_04"], ["neck", "worn/neck/neck_worn_05"], ["neck", "worn/neck/neck_worn_06"],
    ["neck", "worn/neck/neck_worn_07"], ["neck", "worn/neck/neck_worn_08"], ["neck", "worn/neck/neck_worn_09"],
    ["rings", "worn/rings/rings_worn_01"], ["rings", "worn/rings/rings_worn_02"], ["rings", "worn/rings/rings_worn_03"],
    ["ear", "mood/ear_mood_ear-jacket-search_01"], ["rings", "mood/rings_mood_baublebar-custom-ring_01"], ["neck", "mood/neck_mood_shayjewelry-ig_01"],
  ];
  const grid = document.getElementById("gallery-grid");
  if (grid) {
    GALLERY.forEach(([cat, path]) => {
      const fig = document.createElement("figure");
      fig.dataset.cat = cat;
      fig.innerHTML = `<img src="/assets/img/${path}.webp" alt="${cat} reference" loading="lazy" data-full><figcaption>${cat}</figcaption>`;
      grid.appendChild(fig);
    });
    document.getElementById("filterRow").addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-btn");
      if (!btn) return;
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
      const f = btn.dataset.f;
      grid.querySelectorAll("figure").forEach((fig) => fig.classList.toggle("hidden", f !== "all" && fig.dataset.cat !== f));
    });
  }

  // ---- lightbox
  const lb = document.getElementById("lightbox");
  const lbImg = lb.querySelector("img");
  document.addEventListener("click", (e) => {
    const img = e.target.closest("img[data-full]");
    if (img) { lbImg.src = img.src; lb.style.display = "flex"; }
    else if (e.target === lb || e.target === lbImg) { lb.style.display = "none"; }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") lb.style.display = "none"; });
})();
