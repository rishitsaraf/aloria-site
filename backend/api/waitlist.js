/* POST /api/waitlist — collects teaser emails.
   Persists to Postgres when DATABASE_URL is configured (visible in the CMS
   under Waitlist); always logs as a fallback audit trail. */
const db = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
  if (!valid) {
    res.status(400).json({ ok: false, error: "invalid email" });
    return;
  }
  console.log(`[ALORIA WAITLIST] ${new Date().toISOString()} ${email}`);
  if (db.hasDb()) {
    try {
      await db.query("INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING", [email]);
    } catch (e) {
      console.error("[ALORIA WAITLIST] db insert failed:", e.message);
    }
  }
  res.status(200).json({ ok: true });
};
