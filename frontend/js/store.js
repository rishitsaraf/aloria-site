/* ALORIA storefront — shared client. Injects the nav, keeps the bag badge
   fresh, and wraps the commerce API. Loaded on every storefront page. */

const Store = {
  COUNTRIES: [
    ["US", "United States"], ["GB", "United Kingdom"], ["SG", "Singapore"], ["IN", "India"],
    ["AE", "United Arab Emirates"], ["AU", "Australia"], ["CA", "Canada"], ["DE", "Germany"],
    ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"], ["NL", "Netherlands"], ["JP", "Japan"],
    ["KR", "South Korea"], ["HK", "Hong Kong"], ["CH", "Switzerland"], ["SE", "Sweden"],
    ["NZ", "New Zealand"], ["SA", "Saudi Arabia"], ["QA", "Qatar"],
  ],

  async api(path, { method = "GET", body } = {}) {
    const resp = await fetch(`/api/store/${path}`, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await resp.json(); } catch (_) { /* non-JSON error page */ }
    if (!resp.ok) {
      const err = new Error(data.error || `Request failed (${resp.status})`);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  money(cents, currency = "USD") {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format((cents || 0) / 100);
  },

  qs(name) {
    return new URLSearchParams(location.search).get(name);
  },

  esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  toast(msg, action) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    if (action && action.href) {
      const a = document.createElement("a");
      a.href = action.href;
      a.textContent = action.label || "Open";
      el.appendChild(a);
      el.style.pointerEvents = "auto";
    } else {
      el.style.pointerEvents = "";
    }
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), action ? 4200 : 2600);
  },

  /** Site content (announcement, hero, tiles, collections, footer pages) —
      fetched once per page and shared. */
  content() {
    if (!Store._content) {
      Store._content = Store.api("content").catch(() => ({
        announcement: { text: "", enabled: false }, hero: null, tiles: null, collections: [], pages: [],
      }));
    }
    return Store._content;
  },

  /* minimal safe markdown: escapes first, then ##/###, **bold**, *italic*,
     [text](https://…) links and blank-line paragraphs */
  mdToHtml(src) {
    const esc = Store.esc(src);
    return esc.split(/\n\s*\n/).map((block) => {
      let b = block.trim();
      if (!b) return "";
      if (b.startsWith("### ")) return `<h3 class="serif">${b.slice(4)}</h3>`;
      if (b.startsWith("## ")) return `<h2 class="serif">${b.slice(3)}</h2>`;
      b = b
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/\*([^*]+)\*/g, "<i>$1</i>")
        .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>')
        .replace(/\n/g, "<br>");
      return `<p>${b}</p>`;
    }).join("\n");
  },

  nav(active = "") {
    const links = [
      ["shop", "/shop", "Shop"],
      ["ear", "/shop?category=ear", "Ear"],
      ["neck", "/shop?category=neck", "Neck"],
      ["rings", "/shop?category=rings", "Rings"],
    ];
    const el = document.createElement("nav");
    el.className = "hub-nav";
    el.innerHTML = `
      <a class="brand" href="/shop">ALORIA</a>
      <div class="links">
        ${links.map(([id, href, label]) => `<a href="${href}" ${id === active ? 'style="color:var(--gold-ink)" aria-current="page"' : ""}>${label}</a>`).join("")}
        <a href="/account" id="navAccount">Account</a>
        <a href="/cart" class="bag-link" aria-label="Shopping bag">Bag<span class="bag-badge" id="bagBadge" aria-live="polite" aria-label="items in bag"></span></a>
      </div>`;
    document.body.prepend(el);
    const skip = document.createElement("a");
    skip.className = "skip-link";
    skip.href = "#main";
    skip.textContent = "Skip to content";
    document.body.prepend(skip);
    const mainEl = document.querySelector("main");
    if (mainEl && !mainEl.id) mainEl.id = "main";
    Store.content().then((c) => {
      // privacy-friendly analytics — only when a Plausible domain is configured
      const pd = c.integrations && c.integrations.plausibleDomain;
      if (pd && !document.querySelector("script[data-domain]")) {
        const s = document.createElement("script");
        s.defer = true;
        s.dataset.domain = pd;
        s.src = "https://plausible.io/js/script.js";
        document.head.appendChild(s);
      }
      if (c.announcement && c.announcement.enabled && c.announcement.text) {
        const bar = document.createElement("div");
        bar.className = "announce-bar";
        bar.setAttribute("role", "region");
        bar.setAttribute("aria-label", "Announcement");
        bar.textContent = c.announcement.text;
        document.body.prepend(bar);
        document.body.classList.add("has-announce");
      }
    });
    Store.refreshBadge();
    Store.api("auth/me").then(({ user }) => {
      const a = document.getElementById("navAccount");
      if (user && a) a.textContent = user.role === "admin" ? "Admin ✦" : (user.name || "Account").split(" ")[0];
      if (user && user.role === "admin" && a) a.href = "/admin";
    }).catch(() => {});
  },

  async refreshBadge() {
    try {
      const { cart } = await Store.api("cart");
      const badge = document.getElementById("bagBadge");
      if (badge) badge.textContent = cart.count ? String(cart.count) : "";
    } catch (_) { /* api not configured yet — badge stays empty */ }
  },

  footer() {
    const f = document.createElement("footer");
    f.className = "hub-footer";
    f.innerHTML = `<div class="brand">ALORIA</div><p>Stackable · Customisable · Yours</p><div class="foot-links" id="footLinks"></div>`;
    document.body.appendChild(f);
    Store.content().then((c) => {
      const links = document.getElementById("footLinks");
      if (links) {
        links.innerHTML = (c.pages || []).map((p) =>
          `<a href="/p?slug=${encodeURIComponent(p.slug)}">${Store.esc(p.title)}</a>`).join("") +
          '<a href="/wishlist">Wishlist</a><a href="/returns">Returns</a><a href="/contact">Contact</a>';
      }
    });
  },
};
