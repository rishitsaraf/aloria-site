/* Order confirmation. For Stripe returns the page first confirms payment
   with the server (which verifies against Stripe directly), then renders. */

const $ = (id) => document.getElementById(id);

(async () => {
  Store.nav("");
  Store.footer();
  const number = Store.qs("order"), key = Store.qs("key");
  if (!number || !key) { $("thanksEmpty").hidden = false; return; }

  let order = null;
  try {
    const confirmed = await Store.api("checkout/confirm", { method: "POST", body: { order: number, key } });
    order = confirmed.order;
  } catch (_) {
    try {
      const looked = await Store.api(`orders/lookup?number=${encodeURIComponent(number)}&key=${encodeURIComponent(key)}`);
      order = looked.order;
    } catch (_) { /* fall through */ }
  }
  if (!order) { $("thanksEmpty").hidden = false; return; }

  $("thanksWrap").hidden = false;
  $("thanksName").textContent = order.shippingName ? `, ${order.shippingName.split(" ")[0]}` : "";
  $("thanksNumber").textContent = order.number;
  $("thanksEmail").textContent = order.email;
  const pill = $("thanksStatus");
  pill.textContent = order.status === "pending" ? "payment processing" : order.status;
  pill.className = `status-pill ${order.status}`;

  $("thanksLines").innerHTML = order.items.map((i) => `
    <div class="mini-line">
      ${i.image ? `<img src="${Store.esc(i.image)}" alt="">` : ""}
      <div class="ml-t">${Store.esc(i.title)} ×${i.qty}<span class="ml-v">${Store.esc(i.variantLabel)}</span></div>
      <div class="ml-p">${Store.money(i.unitCents * i.qty, order.currency)}</div>
    </div>`).join("");
  $("tSubtotal").textContent = Store.money(order.subtotalCents, order.currency);
  $("tShipping").textContent = order.shippingCents ? Store.money(order.shippingCents, order.currency) : "Free";
  $("tDiscountRow").hidden = !order.discountCents;
  $("tDiscount").textContent = `−${Store.money(order.discountCents, order.currency)}`;
  $("tTotal").textContent = Store.money(order.totalCents, order.currency);
  Store.refreshBadge(); // cart converted → badge clears
})();
