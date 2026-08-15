/* ALORIA storefront — shared client. Injects the nav, keeps the bag badge
   fresh, and wraps the commerce API. Loaded on every storefront page. */

const Store = {
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
        ${links.map(([id, href, label]) => `<a href="${href}" ${id === active ? 'style="color:var(--gold)"' : ""}>${label}</a>`).join("")}
        <a href="/account" id="navAccount">Account</a>
        <a href="/cart" class="bag-link">Bag<span class="bag-badge" id="bagBadge"></span></a>
      </div>`;
    document.body.prepend(el);
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
    f.innerHTML = `<div class="brand">ALORIA</div><p>Stackable · Customisable · Yours</p>`;
    document.body.appendChild(f);
  },
};
