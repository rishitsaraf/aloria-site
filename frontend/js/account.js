/* Account — sign in / register / order history. */

let mode = "login";
const $ = (id) => document.getElementById(id);

function setMode(m) {
  mode = m;
  $("tabLogin").classList.toggle("active", m === "login");
  $("tabRegister").classList.toggle("active", m === "register");
  $("nameField").hidden = m === "login";
  $("authTitle").textContent = m === "login" ? "Sign in" : "Create account";
  $("authBtn").textContent = m === "login" ? "Sign in" : "Create account";
  $("authPass").autocomplete = m === "login" ? "current-password" : "new-password";
  $("authMsg").textContent = "";
}

async function submitAuth(ev) {
  ev.preventDefault();
  const btn = $("authBtn");
  btn.disabled = true;
  try {
    const body = { email: $("authEmail").value.trim(), password: $("authPass").value };
    if (mode === "register") body.name = $("authName").value.trim();
    await Store.api(`auth/${mode}`, { method: "POST", body });
    location.reload();
  } catch (e) {
    $("authMsg").textContent = e.message;
    $("authMsg").className = "form-msg err";
    btn.disabled = false;
  }
}

function orderCard(o) {
  const date = new Date(o.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return `
    <div class="order-card">
      <div class="oc-head">
        <span class="num"><a href="/checkout/thanks?order=${encodeURIComponent(o.number)}&key=${encodeURIComponent(o.key)}" style="color:var(--gold)">${o.number}</a>
          <span style="color:var(--ink-soft)"> · ${date}</span></span>
        <span><span class="status-pill ${o.status}">${o.status}</span>
          <b style="font-family:var(--mono);font-size:0.8rem;margin-left:0.8rem">${Store.money(o.totalCents, o.currency)}</b></span>
      </div>
      <div class="items">${o.items.map((i) => `${Store.esc(i.title)}${i.variantLabel ? ` (${Store.esc(i.variantLabel)})` : ""} ×${i.qty}`).join(" · ")}</div>
    </div>`;
}

(async () => {
  Store.nav("");
  Store.footer();
  const { user } = await Store.api("auth/me").catch(() => ({ user: null }));
  if (!user) {
    $("authView").hidden = false;
    $("tabLogin").onclick = () => setMode("login");
    $("tabRegister").onclick = () => setMode("register");
    $("authForm").addEventListener("submit", submitAuth);
    return;
  }
  $("accountView").hidden = false;
  $("helloTitle").textContent = `Hello, ${(user.name || user.email).split(" ")[0]}`;
  $("accountEmail").textContent = user.email + (user.role === "admin" ? " · admin — open /admin for the CMS" : "");
  $("logoutBtn").onclick = async () => { await Store.api("auth/logout", { method: "POST" }); location.reload(); };

  const { orders } = await Store.api("orders").catch(() => ({ orders: [] }));
  if (!orders.length) $("ordersEmpty").hidden = false;
  else $("ordersList").innerHTML = orders.map(orderCard).join("");
})();
