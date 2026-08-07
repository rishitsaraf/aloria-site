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

  // ---- horizontally scrollable table shells
  // A wide data table inside a plain block would widen the document. Wrapping it in a
  // block-level element with overflow-x:auto keeps the wrapper at its containing block's
  // width and absorbs the excess as internal scroll, so the page can never scroll sideways.
  // The wrapper (not the table) is the scroll container, so table semantics stay intact.
  const SCROLL_MQ = window.matchMedia("(max-width: 900px)");
  const scrollers = [];
  let syncPending = 0;

  function tableShell(label, tableHTML) {
    // .table-hint is a sibling of .table-wrap, not a child: the wrapper's right-edge
    // fade is drawn over the wrapper's full height and would wash out the hint text.
    return '<div class="table-wrap">' +
      '<div class="table-scroll" role="region" aria-label="' + label + '" tabindex="0">' + tableHTML + "</div>" +
      "</div>" +
      '<p class="table-hint" aria-hidden="true">Scroll for more &rarr;</p>';
  }

  function syncScroller(box) {
    const wrap = box.parentElement;
    if (!wrap) return;
    if (!SCROLL_MQ.matches) { // desktop: no scroll container, no affordance, no extra tab stop
      wrap.classList.remove("is-scrollable", "at-end");
      box.removeAttribute("tabindex");
      return;
    }
    if (!box.clientWidth) return; // inside a closed <details>: measurement is meaningless
    const slack = box.scrollWidth - box.clientWidth;
    const scrollable = slack > 2;
    wrap.classList.toggle("is-scrollable", scrollable);
    wrap.classList.toggle("at-end", box.scrollLeft >= slack - 2);
    if (scrollable) box.setAttribute("tabindex", "0"); else box.removeAttribute("tabindex");
  }

  function syncScrollers() {
    if (syncPending) return;
    syncPending = requestAnimationFrame(() => { syncPending = 0; scrollers.forEach((b) => syncScroller(b)); });
  }

  function registerScroller(box) {
    if (!box) return;
    scrollers.push(box);
    box.addEventListener("scroll", syncScrollers, { passive: true });
    const drawer = box.closest("details");
    if (drawer) drawer.addEventListener("toggle", syncScrollers); // closed drawers measure as 0
    syncScrollers();
  }

  window.addEventListener("resize", syncScrollers);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncScrollers).catch(() => {});

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
        rows += `<tr><td class="code">${c.code}</td><td class="c-name">${c.name}</td><td class="c-fn">${c.function}</td><td class="c-var">${c.variants || "—"}</td><td class="c-sku">${c.skus || "—"}</td></tr>`;
        masterRows.push(`<tr><td class="code">${c.code}</td><td class="c-cat">${cat.name}</td><td class="c-name">${c.name}</td><td class="c-var">${c.variants || "—"}</td><td class="c-sku">${c.skus || "—"}</td></tr>`);
      });
      if (drawer) {
        drawer.insertAdjacentHTML("beforeend", tableShell(`${cat.name} variant matrix — scrollable table`,
          `<table><thead><tr><th>Code</th><th class="c-name">Component</th><th class="c-fn">Function</th><th class="c-var">Variants</th><th class="c-sku">SKUs</th></tr></thead><tbody>${rows}</tbody></table>`));
        registerScroller(drawer.querySelector(".table-scroll"));
      }
    });
    const master = document.querySelector("[data-master]");
    if (master) {
      master.insertAdjacentHTML("beforeend", tableShell("Master component table — scrollable table",
        `<table><thead><tr><th>Code</th><th class="c-cat">Category</th><th class="c-name">Component</th><th class="c-var">Variants</th><th class="c-sku">SKUs</th></tr></thead><tbody>${masterRows.join("")}</tbody></table>`));
      registerScroller(master.querySelector(".table-scroll"));
    }
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
