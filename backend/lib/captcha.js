/* Cloudflare Turnstile — inert until TURNSTILE_SECRET_KEY is set.
   When configured, public write endpoints (contact, registration) require a
   valid token; the storefront learns the site key from /api/store/content
   and renders the widget only then. */

const { badRequest } = require("./http");

const enabled = () => Boolean(process.env.TURNSTILE_SECRET_KEY);
const siteKey = () => process.env.TURNSTILE_SITE_KEY || "";

/** Throws 400 when Turnstile is configured and the token doesn't verify. */
async function assertHuman(token, ip) {
  if (!enabled()) return; // not configured — open by design
  if (!token) throw badRequest("Please complete the human check");
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    });
    const data = await resp.json();
    if (!data.success) throw badRequest("Human check failed — please try again");
  } catch (e) {
    if (e.statusCode) throw e;
    // verification service unreachable — fail open rather than block customers
    console.error("[turnstile]", e.message);
  }
}

module.exports = { enabled, siteKey, assertHuman };
