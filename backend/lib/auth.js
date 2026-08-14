/* ALORIA commerce — accounts & sessions.
   - Passwords: scrypt (N=16384, r=8, p=1) with a per-user 16-byte salt,
     compared with timingSafeEqual. No plaintext ever stored or logged.
   - Sessions: 32-byte random bearer token in an HttpOnly cookie; only its
     sha256 is stored server-side, so a DB leak can't replay sessions.
   - Admin bootstrap: set ADMIN_EMAIL + ADMIN_PASSWORD in the environment and
     the account is created (or promoted) on first use — no signup backdoor. */

const crypto = require("crypto");
const db = require("./db");
const { sha256, randomToken, parseCookies, setCookie, unauthorized, forbidden } = require("./http");

const SESSION_COOKIE = "aloria_session";
const SESSION_DAYS = 30;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_OPTS).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hex] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !salt || !hex) return false;
    const candidate = crypto.scryptSync(String(password), salt, 64, SCRYPT_OPTS);
    return crypto.timingSafeEqual(candidate, Buffer.from(hex, "hex"));
  } catch (_) {
    return false;
  }
}

/** Create the env-configured admin account if it doesn't exist yet. */
async function ensureAdminBootstrap() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) return;
  const existing = await db.query("SELECT id, role FROM users WHERE email = $1", [email]);
  if (existing.rows.length === 0) {
    await db.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT (email) DO NOTHING",
      [email, hashPassword(password), "Aloria Admin"]
    );
  } else if (existing.rows[0].role !== "admin") {
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [existing.rows[0].id]);
  }
}

async function createSession(req, res, userId) {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
     VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(token), userId, SESSION_DAYS, String(req.headers["user-agent"] || "").slice(0, 300)]
  );
  await db.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  setCookie(req, res, SESSION_COOKIE, token, SESSION_DAYS * 86400);
}

async function destroySession(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  setCookie(req, res, SESSION_COOKIE, "", 0);
}

/** Returns the signed-in user row or null. Never throws for guests. */
async function currentUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const r = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return r.rows[0] || null;
}

async function requireUser(req) {
  const user = await currentUser(req);
  if (!user) throw unauthorized();
  return user;
}

async function requireAdmin(req) {
  const user = await requireUser(req);
  if (user.role !== "admin") throw forbidden("Admin access required");
  return user;
}

/** Opportunistic cleanup of expired sessions (cheap, run from cron). */
async function pruneSessions() {
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  await db.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
}

module.exports = {
  SESSION_COOKIE, hashPassword, verifyPassword, ensureAdminBootstrap,
  createSession, destroySession, currentUser, requireUser, requireAdmin, pruneSessions,
};
