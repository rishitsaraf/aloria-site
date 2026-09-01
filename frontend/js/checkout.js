/* Checkout — totals always come from POST /checkout/quote (server-priced);
   placing the order completes a test payment or hands off to the configured
   payment gateway (see backend/lib/payments). */

let appliedCode = "";
let quoting = null;

const $ = (id) => document.getElementById(id);

async function refreshQuote() {
  const country = $("coCountry") && $("coCountry").value;
  const my = (quoting = Store.api("checkout/quote", { method: "POST", body: { discountCode: appliedCode, country } }));
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
  syncPayChoices(q.payments && q.payments.online);
  $("miniLines").innerHTML = q.cart.items.filter((i) => i.purchasable).map((i) => `
    <div class="mini-line">
      ${i.image ? `<img src="${Store.esc(i.image)}" alt="">` : ""}
      <div class="ml-t">${Store.esc(i.title)} ×${i.qty}<span class="ml-v">${Store.esc(i.variantLabel)}</span></div>
      <div class="ml-p">${Store.money(i.lineCents, q.cart.currency)}</div>
    </div>`).join("");
  $("sumSubtotal").textContent = Store.money(q.cart.subtotalCents, q.cart.currency);
  $("sumShipping").textContent = q.shippingCents ? Store.money(q.shippingCents, q.cart.currency) : "Free";
  $("taxRow").hidden = !q.taxCents;
  $("taxLabel").textContent = q.taxPct ? `Tax (${q.taxPct}%)` : "Tax";
  $("sumTax").textContent = Store.money(q.taxCents, q.cart.currency);
  $("sumTotal").textContent = Store.money(q.totalCents, q.cart.currency);
  $("discountRow").hidden = !q.discountCents;
  $("sumDiscount").textContent = `−${Store.money(q.discountCents, q.cart.currency)}`;
  if (q.discountCode) {
    $("discountMsg").textContent = `${q.discountCode} applied`;
    $("discountMsg").className = "form-msg ok";
  }
  if (q.cart.email && !$("coEmail").value) $("coEmail").value = q.cart.email;
}

/* Only show payment options the server can actually honour — the online
   option appears once a gateway adapter is configured (PAYMENT_PROVIDER). */
function syncPayChoices(onlineEnabled) {
  const onlineLabel = document.querySelector('input[name="pay"][value="online"]').closest("label");
  const testInput = document.querySelector('input[name="pay"][value="test"]');
  onlineLabel.hidden = !onlineEnabled;
  if (!onlineEnabled) testInput.checked = true;
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
      location.href = r.checkoutUrl; // gateway-hosted payment page
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
  $("coCountry").innerHTML = Store.COUNTRIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
  try { const saved = localStorage.getItem("aloria_country"); if (saved) $("coCountry").value = saved; } catch (_) {}

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
  $("coCountry").addEventListener("change", refreshQuote); // tax can differ by country
  $("coEmail").addEventListener("blur", captureEmailEarly);
  $("checkoutForm").addEventListener("submit", placeOrder);
})();
