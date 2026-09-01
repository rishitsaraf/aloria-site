/* /api/store/auth/* — register, login, logout, me.
   Login errors are deliberately generic so accounts can't be enumerated,
   and both endpoints are rate-limited per IP and per email. */

const db = require("../lib/db");
const auth = require("../lib/auth");
const emailLib = require("../lib/email");
const totp = require("../lib/totp");
const captcha = require("../lib/captcha");
const { json, badRequest, cleanEmail, cleanString, rateLimit, clientIp, randomToken, sha256 } = require("../lib/http");
const cartLib = require("./cartLib");

async function register(req, res) {
  await rateLimit(`reg:${clientIp(req)}`, 10, 900);
  const body = req.body || {};
  await captcha.assertHuman(body.turnstileToken, clientIp(req)); // no-op unless configured
  const email = cleanEmail(body.email);
  const name = cleanString(body.name, { name: "Name", max: 120 });
  const password = String(body.password || "");
  if (password.length < 8) throw badRequest("Password must be at least 8 characters");
  if (password.length > 200) throw badRequest("Password is too long");

  await auth.ensureAdminBootstrap();
  const r = await db.query(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role`,
    [email, auth.hashPassword(password), name]
  );
  if (r.rows.length === 0) throw badRequest("An account with this email already exists — sign in instead");
  const user = r.rows[0];
  await auth.createSession(req, res, user.id);
  await cartLib.attachCartToUser(req, user);
  emailLib.sendWelcome(user.email, user.name).catch(() => {}); // best-effort, never blocks signup
  json(res, 201, { ok: true, user: publicUser(user) });
}

async function login(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  await rateLimit(`login:${clientIp(req)}`, 20, 900);
  await rateLimit(`login:${email}`, 10, 900);

  await auth.ensureAdminBootstrap();
  const r = await db.query(
    "SELECT id, email, name, role, password_hash, disabled, totp_enabled, totp_secret FROM users WHERE email = $1",
    [email]
  );
  const user = r.rows[0];
  // Hash even when the user is missing so timing doesn't reveal existence.
  const ok = user
    ? auth.verifyPassword(body.password, user.password_hash)
    : (auth.verifyPassword(body.password, "scrypt$00000000000000000000000000000000$00"), false);
  if (!ok) throw badRequest("Incorrect email or password");
  if (user.disabled) throw badRequest("This account has been disabled — contact us if that seems wrong");

  // Second factor for accounts that enabled it (password re-verified above).
  if (user.totp_enabled) {
    if (!body.code) {
      json(res, 200, { ok: false, requiresTotp: true });
      return;
    }
    await rateLimit(`totp:${email}`, 10, 900);
    if (!totp.verify(user.totp_secret, body.code)) throw badRequest("That authentication code isn't right");
  }

  await auth.createSession(req, res, user.id);
  await cartLib.attachCartToUser(req, user);
  json(res, 200, { ok: true, user: publicUser(user) });
}

/** Revoke every session for the signed-in user (incl. this one). */
async function logoutAll(req, res) {
  const user = await auth.requireUser(req);
  await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
  await auth.destroySession(req, res);
  json(res, 200, { ok: true });
}

async function logout(req, res) {
  await auth.destroySession(req, res);
  json(res, 200, { ok: true });
}

async function me(req, res) {
  const user = await auth.currentUser(req);
  json(res, 200, { user: user ? publicUser(user) : null });
}

/** Request a reset link. Always answers 200 — never reveals whether the
    account exists. */
async function forgot(req, res) {
  await rateLimit(`forgot:${clientIp(req)}`, 10, 900);
  const email = cleanEmail((req.body || {}).email);
  await rateLimit(`forgot:${email}`, 5, 900);
  const r = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rows.length) {
    const token = randomToken();
    await db.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [sha256(token), r.rows[0].id]
    );
    try { await emailLib.sendPasswordReset(email, token); }
    catch (e) { console.error("[auth] reset email failed:", e.message); }
  }
  json(res, 200, { ok: true, message: "If that account exists, a reset link is on its way" });
}

/** Redeem a reset token: new password, all old sessions and tokens revoked,
    fresh session issued. */
async function reset(req, res) {
  await rateLimit(`reset:${clientIp(req)}`, 10, 900);
  const body = req.body || {};
  const token = String(body.token || "");
  if (!/^[a-f0-9]{64}$/.test(token)) throw badRequest("This reset link is invalid");
  const password = String(body.password || "");
  if (password.length < 8) throw badRequest("Password must be at least 8 characters");
  if (password.length > 200) throw badRequest("Password is too long");

  const r = await db.query(
    `SELECT pr.user_id, u.email, u.name, u.role FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1 AND pr.expires_at > now()`,
    [sha256(token)]
  );
  const row = r.rows[0];
  if (!row) throw badRequest("This reset link has expired — request a new one");

  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [auth.hashPassword(password), row.user_id]);
  await db.query("DELETE FROM password_resets WHERE user_id = $1", [row.user_id]);
  await db.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
  await auth.createSession(req, res, row.user_id);
  json(res, 200, { ok: true, user: publicUser({ id: row.user_id, email: row.email, name: row.name, role: row.role }) });
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: Boolean(u.totp_enabled) };
}

module.exports = { register, login, logout, logoutAll, me, forgot, reset, publicUser };
