/* POST /api/waitlist — collects teaser emails.
   V1: logs to Vercel function logs (visible in dashboard → Logs).
   Later: swap the TODO for Google Sheets / Airtable / Resend / DB. */
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const email = (req.body && req.body.email) || "";
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) {
    res.status(400).json({ ok: false, error: "invalid email" });
    return;
  }
  console.log(`[ALORIA WAITLIST] ${new Date().toISOString()} ${email}`);
  // TODO: persist — e.g. Airtable/Sheets webhook, Vercel KV, or email via Resend.
  res.status(200).json({ ok: true });
};
