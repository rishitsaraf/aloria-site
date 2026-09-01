/* ALORIA commerce — transactional email.
   Sends through Resend when RESEND_API_KEY is set; otherwise logs the message
   so flows stay testable without a provider. EMAIL_FROM sets the sender. */

const money = (cents, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format((cents || 0) / 100);

function siteUrl(path = "/") {
  const base = process.env.SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:8080");
  return base.replace(/\/$/, "") + path;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#faf7f2;padding:32px 16px;font-family:Georgia,serif;color:#14120f;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e9e4dc;border-radius:8px;padding:36px;">
    <div style="text-align:center;letter-spacing:0.3em;font-size:20px;margin-bottom:6px;">ALORIA</div>
    <div style="text-align:center;font-size:11px;letter-spacing:0.2em;color:#b08d3e;text-transform:uppercase;margin-bottom:28px;">${escapeHtml(title)}</div>
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #e9e4dc;font-size:11px;color:#55504a;text-align:center;">
      Stackable · Customisable · Yours
    </div>
  </div></body></html>`;
}

async function send({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Aloria <onboarding@resend.dev>";
  if (!key) {
    console.log(`[ALORIA EMAIL:log-only] to=${to} subject="${subject}"\n${text || ""}`);
    return { ok: true, delivered: false };
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!resp.ok) {
    console.error(`[ALORIA EMAIL] send failed ${resp.status}: ${await resp.text()}`);
    return { ok: false, delivered: false };
  }
  return { ok: true, delivered: true };
}

function itemRows(items, currency) {
  return items.map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f0ece4;font-family:Helvetica,Arial,sans-serif;font-size:13px;">
        ${escapeHtml(it.product_title)}${it.variant_label ? `<br><span style="color:#55504a;font-size:11px;">${escapeHtml(it.variant_label)}</span>` : ""}
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ece4;text-align:center;font-family:Helvetica,Arial,sans-serif;font-size:13px;">×${it.qty}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f0ece4;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:13px;">${money(it.unit_price_cents * it.qty, currency)}</td>
    </tr>`).join("");
}

function buildOrderConfirmation(order, items) {
  const html = layout(`Order ${order.number} confirmed`, `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Thank you${order.shipping_name ? `, ${escapeHtml(order.shipping_name.split(" ")[0])}` : ""} — your order is confirmed.
      We'll email you again when it ships.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;">${itemRows(items, order.currency)}
      <tr><td colspan="2" style="padding:10px 0 2px;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#55504a;">Subtotal</td>
          <td style="padding:10px 0 2px;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;">${money(order.subtotal_cents, order.currency)}</td></tr>
      ${order.discount_cents ? `<tr><td colspan="2" style="padding:2px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#55504a;">Discount${order.discount_code ? ` (${escapeHtml(order.discount_code)})` : ""}</td>
          <td style="padding:2px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;">−${money(order.discount_cents, order.currency)}</td></tr>` : ""}
      <tr><td colspan="2" style="padding:2px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#55504a;">Shipping</td>
          <td style="padding:2px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:12px;">${order.shipping_cents ? money(order.shipping_cents, order.currency) : "Free"}</td></tr>
      <tr><td colspan="2" style="padding:8px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:14px;"><b>Total</b></td>
          <td style="padding:8px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:14px;"><b>${money(order.total_cents, order.currency)}</b></td></tr>
    </table>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${siteUrl(`/checkout/thanks?order=${encodeURIComponent(order.number)}&key=${encodeURIComponent(order.public_token)}`)}"
         style="background:#14120f;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">View order</a>
    </p>`);
  const text = `Your Aloria order ${order.number} is confirmed. Total ${money(order.total_cents, order.currency)}.`;
  return { subject: `Your Aloria order ${order.number}`, html, text };
}

async function sendOrderConfirmation(order, items) {
  return send({ to: order.email, ...buildOrderConfirmation(order, items) });
}

function buildCartRecovery(cart, items, totalCents, opts = {}) {
  const link = siteUrl(`/cart?recover=${encodeURIComponent(cart.recovery_token)}`);
  const incentive = opts.incentiveCode
    ? `<p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;text-align:center;border:1px dashed #b08d3e;border-radius:4px;padding:10px 14px;margin:14px 0;">
         A little something for coming back — use code <b style="letter-spacing:0.1em;">${escapeHtml(opts.incentiveCode)}</b> at checkout.
       </p>` : "";
  const html = layout("You left something sparkling behind", `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Your Aloria stack is still waiting in your bag — we saved it for you.
    </p>
    ${incentive}
    <table style="width:100%;border-collapse:collapse;margin:18px 0;">${itemRows(items, cart.currency)}
      <tr><td colspan="2" style="padding:10px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:14px;"><b>Bag total</b></td>
          <td style="padding:10px 0;text-align:right;font-family:Helvetica,Arial,sans-serif;font-size:14px;"><b>${money(totalCents, cart.currency)}</b></td></tr>
    </table>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${link}" style="background:#b08d3e;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">Return to your bag</a>
    </p>`);
  const text = `Your Aloria bag is saved. Pick up where you left off: ${link}`;
  return { subject: "Your Aloria bag is waiting", html, text };
}

async function sendCartRecovery(cart, items, totalCents, opts = {}) {
  return send({ to: cart.email, ...buildCartRecovery(cart, items, totalCents, opts) });
}

function buildPasswordReset(token) {
  const link = siteUrl(`/account?reset=${encodeURIComponent(token)}`);
  const html = layout("Reset your password", `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Someone asked to reset the password for this Aloria account. If that was you,
      the link below works for one hour. If it wasn't, you can safely ignore this email.
    </p>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${link}" style="background:#14120f;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">Choose a new password</a>
    </p>`);
  return { subject: "Reset your Aloria password", html, text: `Reset your Aloria password (valid 1 hour): ${link}` };
}

async function sendPasswordReset(to, token) {
  return send({ to, ...buildPasswordReset(token) });
}

function buildShippingConfirmation(order, items) {
  const html = layout(`Order ${order.number} is on its way`, `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Good news${order.shipping_name ? `, ${escapeHtml(order.shipping_name.split(" ")[0])}` : ""} —
      your pieces have left the atelier and are on their way to you.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;">${itemRows(items, order.currency)}</table>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${siteUrl(`/checkout/thanks?order=${encodeURIComponent(order.number)}&key=${encodeURIComponent(order.public_token)}`)}"
         style="background:#b08d3e;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">View order</a>
    </p>`);
  return { subject: `Your Aloria order ${order.number} has shipped`, html, text: `Your Aloria order ${order.number} has shipped.` };
}

async function sendShippingConfirmation(order, items) {
  return send({ to: order.email, ...buildShippingConfirmation(order, items) });
}

function buildWelcome(name) {
  const first = escapeHtml(String(name || "").split(" ")[0] || "there");
  const html = layout("Welcome to the atelier", `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Hi ${first} — welcome to Aloria. Two platings, five stone shapes, four stone
      colors: every piece is a component, and every stack is yours to compose.
    </p>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${siteUrl("/shop")}" style="background:#14120f;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">Start your stack</a>
    </p>`);
  return { subject: "Welcome to Aloria", html, text: `Welcome to Aloria. Start your stack: ${siteUrl("/shop")}` };
}

async function sendWelcome(to, name) {
  return send({ to, ...buildWelcome(name) });
}

function buildReviewRequest(order, items) {
  const first = escapeHtml(String(order.shipping_name || "").split(" ")[0] || "there");
  const links = items.map((i) =>
    `<li style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.9;">
       <a href="${siteUrl(`/shop/product?slug=${encodeURIComponent(i.slug)}`)}" style="color:#8a6d2f;">${escapeHtml(i.product_title)}</a></li>`).join("");
  const html = layout("How are they wearing?", `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Hi ${first} — your pieces from order ${escapeHtml(order.number)} should be settled
      into the rotation by now. A short review helps other stackers choose well.
    </p>
    <ul style="padding-left:18px;margin:14px 0;">${links}</ul>`);
  return {
    subject: "How are your Aloria pieces wearing?",
    html,
    text: `How are your pieces from order ${order.number}? Leave a review: ${siteUrl("/shop")}`,
  };
}

async function sendReviewRequest(order, items) {
  return send({ to: order.email, ...buildReviewRequest(order, items) });
}

function buildStockAlert(row) {
  const label = Object.values(row.options || {}).join(" · ");
  const link = siteUrl(`/shop/product?slug=${encodeURIComponent(row.slug)}`);
  const html = layout(`${escapeHtml(row.title)} is back`, `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      The piece you asked us to watch — <b>${escapeHtml(row.title)}</b>${label ? ` (${escapeHtml(label)})` : ""} —
      is back in stock. Pieces like this tend not to wait around.
    </p>
    <p style="text-align:center;margin:26px 0 6px;">
      <a href="${link}" style="background:#b08d3e;color:#ffffff;text-decoration:none;padding:12px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;">Claim yours</a>
    </p>`);
  return { subject: `Back in stock — ${row.title}`, html, text: `${row.title}${label ? ` (${label})` : ""} is back in stock: ${link}` };
}

async function sendStockAlert(to, row) {
  return send({ to, ...buildStockAlert(row) });
}

const RMA_COPY = {
  requested: {
    subject: (rma) => `Return ${rma.rma_number} received`,
    body: () => "We've received your return request and will review it within one working day. You'll hear from us at this address.",
  },
  approved: {
    subject: (rma) => `Return ${rma.rma_number} approved`,
    body: () => "Your return is approved. Pack the pieces in their original pouch, include a note with your RMA number, and post them to the address in your order confirmation. We'll refund as soon as they arrive back at the atelier.",
  },
  rejected: {
    subject: (rma) => `Return ${rma.rma_number} — update`,
    body: (rma) => rma.admin_note || "We couldn't approve this return. Reply to this email if you'd like to talk it through.",
  },
  refunded: {
    subject: (rma) => `Return ${rma.rma_number} refunded`,
    body: () => "Your pieces made it back and the refund is on its way to your original payment method. Depending on your bank it can take 5–10 working days to appear.",
  },
};

function buildRmaUpdate(rma, order) {
  const copy = RMA_COPY[rma.status] || RMA_COPY.requested;
  const items = (rma.items || []).map((i) =>
    `<li style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.9;">${escapeHtml(i.title)}${i.label ? ` — ${escapeHtml(i.label)}` : ""} × ${i.qty}</li>`).join("");
  const html = layout(copy.subject(rma), `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">${escapeHtml(copy.body(rma))}</p>
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#55504a;">Order ${escapeHtml(order.number)} · ${escapeHtml(rma.rma_number)}</p>
    <ul style="padding-left:18px;margin:10px 0;">${items}</ul>`);
  return { subject: copy.subject(rma), html, text: `${copy.subject(rma)}: ${copy.body(rma)} (order ${order.number})` };
}

async function sendRmaUpdate(rma, order) {
  return send({ to: rma.email, ...buildRmaUpdate(rma, order) });
}

/* Broadcast/announcement wrapper — plain message in the brand frame. */
function buildAnnouncement(subject, message) {
  const paragraphs = String(message).split(/\n\s*\n/).map((p) =>
    `<p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  return { subject, html: layout(subject, paragraphs), text: message };
}

module.exports = {
  send, siteUrl,
  sendOrderConfirmation, sendCartRecovery, sendPasswordReset, sendShippingConfirmation, sendStockAlert,
  sendWelcome, sendReviewRequest, sendRmaUpdate,
  buildOrderConfirmation, buildCartRecovery, buildPasswordReset, buildShippingConfirmation, buildAnnouncement,
  buildStockAlert, buildWelcome, buildReviewRequest,
};
