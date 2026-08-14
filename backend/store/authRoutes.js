/* /api/store/auth/* — register, login, logout, me.
   Login errors are deliberately generic so accounts can't be enumerated,
   and both endpoints are rate-limited per IP and per email. */

const db = require("../lib/db");
const auth = require("../lib/auth");
const { json, badRequest, cleanEmail, cleanString, rateLimit, clientIp } = require("../lib/http");
const cartLib = require("./cartLib");

async function register(req, res) {
  await rateLimit(`reg:${clientIp(req)}`, 10, 900);
  const body = req.body || {};
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
  json(res, 201, { ok: true, user: publicUser(user) });
}

async function login(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  await rateLimit(`login:${clientIp(req)}`, 20, 900);
  await rateLimit(`login:${email}`, 10, 900);

  await auth.ensureAdminBootstrap();
  const r = await db.query("SELECT id, email, name, role, password_hash FROM users WHERE email = $1", [email]);
  const user = r.rows[0];
  // Hash even when the user is missing so timing doesn't reveal existence.
  const ok = user
    ? auth.verifyPassword(body.password, user.password_hash)
    : (auth.verifyPassword(body.password, "scrypt$00000000000000000000000000000000$00"), false);
  if (!ok) throw badRequest("Incorrect email or password");

  await auth.createSession(req, res, user.id);
  await cartLib.attachCartToUser(req, user);
  json(res, 200, { ok: true, user: publicUser(user) });
}

async function logout(req, res) {
  await auth.destroySession(req, res);
  json(res, 200, { ok: true });
}

async function me(req, res) {
  const user = await auth.currentUser(req);
  json(res, 200, { user: user ? publicUser(user) : null });
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

module.exports = { register, login, logout, me, publicUser };
