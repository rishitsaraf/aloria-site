/* Checkout — totals always come from POST /checkout/quote (server-priced);
   placing the order either completes a test payment or redirects to Stripe. */

const COUNTRIES = [
  ["US", "United States"], ["GB", "United Kingdom"], ["SG", "Singapore"], ["IN", "India"],
  ["AE", "United Arab Emirates"], ["AU", "Australia"], ["CA", "Canada"], ["DE", "Germany"],
  ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"], ["NL", "Netherlands"], ["JP", "Japan"],
  ["KR", "South Korea"], ["HK", "Hong Kong"], ["CH", "Switzerland"], ["SE", "Sweden"],
  ["NZ", "New Zealand"], ["SA", "Saudi Arabia"], ["QA", "Qatar"],
];

let appliedCode = "";
let quoting = null;

const $ = (id) => document.getElementById(id);

async function refreshQuote() {
  const my = (quoting = Store.api("checkout/quote", { method: "POST", body: { discountCode: appliedCode } }));
  let q;
  try {
    q = await my;
  } catch (e) {
    if (appliedCode) { // bad code — show why, requote clean
      $("discountMsg").textContent = e.message;
      $("discountMsg").className = "form-msg err";
      appliedCode = "";
      return refreshQuote();
    }
    $("coEmpty").hidden = false;
    $("checkoutForm").hidden = true;
    return;
  }
  if (quoting !== my) return; // a newer quote superseded this one

  if (!q.cart.items.filter((i) => i.purchasable).length) {
    $("coEmpty").hidden = false;
    $("checkoutForm").hidden = true;
    return;
  }
  $("checkoutForm").hidden = false;
  $("miniLines").innerHTML = q.cart.items.filter((i) => i.purchasable).map((i) => `
    <div class="mini-line">
      ${i.image ? `<img src="${Store.esc(i.image)}" alt="">` : ""}
      <div class="ml-t">${Store.esc(i.title)} ×${i.qty}<span class="ml-v">${Store.esc(i.variantLabel)}</span></div>
      <div class="ml-p">${Store.money(i.lineCents, q.cart.currency)}</div>
    </div>`).join("");
  $("sumSubtotal").textContent = Store.money(q.cart.subtotalCents, q.cart.currency);
  $("sumShipping").textContent = q.shippingCents ? Store.money(q.shippingCents, q.cart.currency) : "Free";
  $("sumTotal").textContent = Store.money(q.totalCents, q.cart.currency);
  $("discountRow").hidden = !q.discountCents;
  $("sumDiscount").textContent = `−${Store.money(q.discountCents, q.cart.currency)}`;
  if (q.discountCode) {
    $("discountMsg").textContent = `${q.discountCode} applied`;
    $("discountMsg").className = "form-msg ok";
  }
  if (q.cart.email && !$("coEmail").value) $("coEmail").value = q.cart.email;
}

async function captureEmailEarly() {
  // The moment we know the email, the bag becomes recoverable if abandoned.
  const email = $("coEmail").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  try { await Store.api("cart/email", { method: "POST", body: { email } }); } catch (_) {}
}

async function placeOrder(ev) {
  ev.preventDefault();
  const btn = $("placeBtn"), msg = $("coMsg");
  btn.disabled = true;
  msg.textContent = "";
  try {
    const body = {
      email: $("coEmail").value.trim(),
      name: $("coName").value.trim(),
      address: {
        line1: $("coLine1").value, line2: $("coLine2").value,
        city: $("coCity").value, region: $("coRegion").value,
        postal: $("coPostal").value, country: $("coCountry").value,
        phone: $("coPhone").value,
      },
      discountCode: appliedCode,
      paymentMethod: document.querySelector('input[name="pay"]:checked').value,
    };
    const r = await Store.api("checkout", { method: "POST", body });
    if (r.checkoutUrl) {
      location.href = r.checkoutUrl; // Stripe hosted checkout
    } else {
      location.href = `/checkout/thanks?order=${encodeURIComponent(r.orderNumber)}&key=${encodeURIComponent(r.key)}`;
    }
  } catch (e) {
    msg.textContent = e.message;
    msg.className = "form-msg err";
    btn.disabled = false;
    refreshQuote(); // stock may have changed
  }
}

(async () => {
  Store.nav("");
  Store.footer();
  $("coCountry").innerHTML = COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");

  // Hide the Stripe option when payments aren't configured yet: probe by
  // checking /auth/me works and defaulting sensibly — the server decides
  // anyway (falls back to test mode when Stripe isn't configured).
  if (Store.qs("cancelled")) Store.toast("Payment cancelled — your bag is untouched");

  const { user } = await Store.api("auth/me").catch(() => ({ user: null }));
  if (user) {
    $("coEmail").value = user.email;
    $("coName").value = user.name || "";
  }
  await refreshQuote();

  $("discountBtn").onclick = () => {
    appliedCode = $("discountInput").value.trim();
    $("discountMsg").textContent = "";
    refreshQuote();
  };
  $("coEmail").addEventListener("blur", captureEmailEarly);
  $("checkoutForm").addEventListener("submit", placeOrder);
})();
