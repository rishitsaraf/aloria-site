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

function buildCartRecovery(cart, items, totalCents) {
  const link = siteUrl(`/cart?recover=${encodeURIComponent(cart.recovery_token)}`);
  const html = layout("You left something sparkling behind", `
    <p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">
      Your Aloria stack is still waiting in your bag — we saved it for you.
    </p>
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

async function sendCartRecovery(cart, items, totalCents) {
  return send({ to: cart.email, ...buildCartRecovery(cart, items, totalCents) });
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

/* Broadcast/announcement wrapper — plain message in the brand frame. */
function buildAnnouncement(subject, message) {
  const paragraphs = String(message).split(/\n\s*\n/).map((p) =>
    `<p style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  return { subject, html: layout(subject, paragraphs), text: message };
}

module.exports = {
  send, siteUrl,
  sendOrderConfirmation, sendCartRecovery, sendPasswordReset, sendShippingConfirmation,
  buildOrderConfirmation, buildCartRecovery, buildPasswordReset, buildShippingConfirmation, buildAnnouncement,
};
