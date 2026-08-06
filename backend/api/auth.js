/* POST /api/auth — checks the shared password, sets auth cookies.
   Password comes from the ALORIA_PASSWORD env var (Vercel dashboard);
   falls back to the launch default. */
const crypto = require("crypto");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const password = process.env.ALORIA_PASSWORD || "aloria2026";
  const attempt = (req.body && req.body.password) || "";

  if (attempt !== password) {
    res.status(401).json({ ok: false });
    return;
  }

  const token = crypto.createHash("sha256").update(`aloria-salt::${password}`).digest("hex");
  const thirtyDays = 60 * 60 * 24 * 30;
  res.setHeader("Set-Cookie", [
    `aloria_auth=${token}; Path=/; Max-Age=${thirtyDays}; HttpOnly; SameSite=Lax; Secure`,
    `aloria_hint=1; Path=/; Max-Age=${thirtyDays}; SameSite=Lax; Secure`,
  ]);
  res.status(200).json({ ok: true });
};
