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
    if (!$("totpField").hidden) body.code = $("authTotp").value.trim();
    const r = await Store.api(`auth/${mode}`, { method: "POST", body });
    if (r.requiresTotp) {
      // account has 2FA — ask for the authenticator code and resubmit
      $("totpField").hidden = false;
      $("authTotp").focus();
      $("authMsg").textContent = "Enter the 6-digit code from your authenticator app";
      $("authMsg").className = "form-msg ok";
      btn.disabled = false;
      return;
    }
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

function showAuthCard(which) {
  $("authForm").hidden = which !== "auth";
  $("forgotForm").hidden = which !== "forgot";
  $("resetForm").hidden = which !== "reset";
  document.querySelector(".auth-tabs").style.display = which === "auth" ? "" : "none";
  $("authTitle").textContent = which === "forgot" ? "Reset password"
    : which === "reset" ? "New password"
    : (mode === "login" ? "Sign in" : "Create account");
}

function bindResetFlows() {
  $("forgotLink").onclick = (ev) => { ev.preventDefault(); showAuthCard("forgot"); };
  $("backToLogin").onclick = (ev) => { ev.preventDefault(); showAuthCard("auth"); };
  $("forgotForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = $("forgotMsg");
    try {
      const r = await Store.api("auth/forgot", { method: "POST", body: { email: $("forgotEmail").value.trim() } });
      msg.textContent = r.message || "If that account exists, a reset link is on its way";
      msg.className = "form-msg ok";
    } catch (e) { msg.textContent = e.message; msg.className = "form-msg err"; }
  });
  $("resetForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const msg = $("resetMsg");
    try {
      await Store.api("auth/reset", { method: "POST", body: { token: Store.qs("reset"), password: $("resetPass").value } });
      location.href = "/account";
    } catch (e) { msg.textContent = e.message; msg.className = "form-msg err"; }
  });
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
    bindResetFlows();
    if (Store.qs("reset")) showAuthCard("reset");
    return;
  }
  $("accountView").hidden = false;
  $("helloTitle").textContent = `Hello, ${(user.name || user.email).split(" ")[0]}`;
  $("accountEmail").textContent = user.email + (user.role === "admin" ? " · admin — open /admin for the CMS" : "");
  $("logoutBtn").onclick = async () => { await Store.api("auth/logout", { method: "POST" }); location.reload(); };
  const outAll = document.createElement("button");
  outAll.className = "btn ghost small";
  outAll.style.marginLeft = "0.5rem";
  outAll.textContent = "Sign out everywhere";
  outAll.onclick = async () => { await Store.api("auth/logout-all", { method: "POST" }); location.reload(); };
  $("logoutBtn").after(outAll);

  const { orders } = await Store.api("orders").catch(() => ({ orders: [] }));
  if (!orders.length) $("ordersEmpty").hidden = false;
  else $("ordersList").innerHTML = orders.map(orderCard).join("");
})();
