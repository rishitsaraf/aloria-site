/* The built-in "test" payment provider — no gateway, no money movement.
   Keeps every flow (checkout, confirmation, refunds, emails, reports)
   fully working before a real gateway is configured, with orders clearly
   stamped payment_method "test". Also the reference implementation for
   writing a real adapter. */

module.exports = {
  name: "test",

  capabilities() {
    return { online: false, refunds: true, webhooks: false };
  },

  // Never called for test mode (checkout completes immediately), but
  // implemented so the contract is fully demonstrated.
  async createPayment(order) {
    return { ref: `test-${order.number}` };
  },

  async verifyPayment(order) {
    // No external truth to consult — an order this provider touched is
    // paid exactly when our own DB says so.
    return { paid: ["paid", "fulfilled"].includes(order.status), ref: order.payment_ref };
  },

  async refund(order, amountCents) {
    return { ok: true, ref: `test-refund-${order.number}-${amountCents}` };
  },

  async parseWebhook() {
    return { ok: false, events: [] };
  },
};
