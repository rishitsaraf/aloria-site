/* Bag page — line management + abandoned-bag email capture + recovery links.
   /cart?recover=TOKEN restores an emailed bag into this browser. */

const FREE_SHIP_CENTS = 7500;

async function handleRecovery() {
  const token = Store.qs("recover");
  if (!token) return;
  try {
    await Store.api("cart/recover", { method: "POST", body: { token } });
    Store.toast("Welcome back — your bag is just as you left it");
  } catch (e) {
    Store.toast(e.message);
  }
  history.replaceState(null, "", "/cart"); // don't re-fire on refresh
}

function lineHtml(item, currency) {
  return `
    <div class="cart-line ${item.purchasable ? "" : "dead"}">
      ${item.image ? `<img src="${Store.esc(item.image)}" alt="">` : "<div></div>"}
      <div>
        <div class="t"><a href="/shop/product?slug=${encodeURIComponent(item.productSlug)}" style="color:inherit">${Store.esc(item.title)}</a></div>
        <div class="v">${Store.esc(item.variantLabel)}${item.purchasable ? "" : " · no longer available"}</div>
        <button class="rm" data-id="${item.id}">Remove</button>
      </div>
      <div>
        <div class="qty-box" style="margin-bottom:0.5rem">
          <button data-act="minus" data-id="${item.id}" aria-label="Decrease">−</button>
          <input value="${item.qty}" data-qty="${item.id}" inputmode="numeric" aria-label="Quantity">
          <button data-act="plus" data-id="${item.id}" aria-label="Increase">+</button>
        </div>
        <div class="p">${Store.money(item.lineCents || item.unitCents * item.qty, currency)}</div>
      </div>
    </div>`;
}

function render(cart) {
  const has = cart.items.length > 0;
  document.getElementById("cartLayout").hidden = !has;
  document.getElementById("cartEmpty").hidden = has;
  document.getElementById("bagCount").textContent = has ? `${cart.count} item${cart.count === 1 ? "" : "s"}` : "";
  if (!has) return;

  document.getElementById("cartLines").innerHTML = cart.items.map((i) => lineHtml(i, cart.currency)).join("");
  document.getElementById("sumSubtotal").textContent = Store.money(cart.subtotalCents, cart.currency);
  document.getElementById("sumTotal").textContent = Store.money(cart.subtotalCents, cart.currency);

  const remaining = FREE_SHIP_CENTS - cart.subtotalCents;
  document.getElementById("shipNote").textContent = remaining > 0
    ? `${Store.money(remaining, cart.currency)} away from free shipping`
    : "Free shipping unlocked ✦";
  document.getElementById("shipMeter").style.width = `${Math.min(100, (cart.subtotalCents / FREE_SHIP_CENTS) * 100)}%`;
  if (cart.email) document.getElementById("saveEmail").placeholder = cart.email;

  document.querySelectorAll(".rm").forEach((b) => { b.onclick = () => mutate(`cart/items/${b.dataset.id}`, "DELETE"); });
  document.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = () => {
      const input = document.querySelector(`[data-qty="${b.dataset.id}"]`);
      const cur = parseInt(input.value, 10) || 1;
      const qty = b.dataset.act === "plus" ? cur + 1 : cur - 1;
      mutate(`cart/items/${b.dataset.id}`, "PATCH", { qty: Math.max(0, Math.min(10, qty)) });
    };
  });
  document.querySelectorAll("[data-qty]").forEach((input) => {
    input.onchange = () => {
      const qty = Math.max(0, Math.min(10, parseInt(input.value, 10) || 1));
      mutate(`cart/items/${input.dataset.qty}`, "PATCH", { qty });
    };
  });
}

async function mutate(path, method, body) {
  try {
    const data = await Store.api(path, { method, body });
    render(data.cart);
    Store.refreshBadge();
  } catch (e) {
    Store.toast(e.message);
  }
}

async function saveEmail() {
  const email = document.getElementById("saveEmail").value.trim();
  const msg = document.getElementById("saveMsg");
  try {
    await Store.api("cart/email", { method: "POST", body: { email } });
    msg.textContent = "Saved — we'll hold your bag";
    msg.className = "form-msg ok";
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "form-msg err";
  }
}

(async () => {
  Store.nav("");
  Store.footer();
  await handleRecovery();
  try {
    const { cart } = await Store.api("cart");
    render(cart);
  } catch (e) {
    document.getElementById("cartEmpty").hidden = false;
  }
  document.getElementById("saveEmailBtn").onclick = saveEmail;
})();
