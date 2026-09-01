/* ALORIA payments — gateway-agnostic adapter layer.
   ============================================================
   The store is not tied to any payment provider. Which gateway runs is
   chosen at deploy time with the PAYMENT_PROVIDER env var; until one is
   configured the built-in "test" provider keeps the whole flow working
   (orders complete instantly, clearly marked as test payments).

   HOW TO INTEGRATE THE GATEWAY YOU PICK (Razorpay, PayU, Adyen, PayPal,
   Cashfree, checkout.com, …):
     1. Create backend/lib/payments/<name>.js exporting the contract below.
     2. Add it to PROVIDERS here.
     3. Set PAYMENT_PROVIDER=<name> plus the gateway's own keys
        (e.g. <NAME>_KEY_ID / <NAME>_KEY_SECRET) in the environment.
   Nothing else changes: checkout, the thanks page, webhooks, refunds and
   the CMS all talk to this interface only.

   THE ADAPTER CONTRACT — every provider module exports:
     name          string, matches the PAYMENT_PROVIDER value
     capabilities() -> { online, refunds, webhooks }
     createPayment(order, { successUrl, cancelUrl })
        Called right after the order row exists (status "pending").
        Return { redirectUrl } to send the buyer to a hosted page, or
        { clientPayload } for an on-page SDK flow (the checkout page
        passes it through to your front-end snippet), plus optional
        { ref } stored as orders.payment_ref.
     verifyPayment(order) -> { paid: bool, ref?: string }
        Server-to-server truth check. The thanks page calls this, so a
        buyer can never forge a paid state; also used by reconciliation.
     refund(order, amountCents) -> { ok: bool, ref?: string }
        Move money back for a refunded order. amountCents <= order total.
     parseWebhook(req) -> { ok: bool, events: [{ id, type, orderNumber, ref }] }
        MUST verify the gateway's signature (reject with ok:false).
        type is one of "paid" | "failed" | "refunded". Every event id is
        deduplicated in payment_events, so redelivery is always safe. */

const testProvider = require("./test");

const PROVIDERS = {
  test: testProvider,
  // razorpay: require("./razorpay"),   <- add your gateway here
};

function active() {
  const name = (process.env.PAYMENT_PROVIDER || "test").toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) {
    console.error(`[payments] PAYMENT_PROVIDER="${name}" has no adapter — falling back to test mode`);
    return testProvider;
  }
  return provider;
}

/** True once a real gateway (anything but test) is configured. */
function onlineEnabled() {
  const p = active();
  return p.name !== "test" && p.capabilities().online;
}

module.exports = { active, onlineEnabled, PROVIDERS };
