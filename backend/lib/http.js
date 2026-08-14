/* ALORIA commerce — HTTP plumbing shared by every API route.
   Cookies, JSON responses, typed errors, input validation, an origin check
   for CSRF defence, and a small DB-backed rate limiter. */

const crypto = require("crypto");
const db = require("./db");

class HttpError extends Error {
  constructor(statusCode, message, extra = {}) {
    super(message);
    this.statusCode = statusCode;
    this.expose = true;
    this.extra = extra;
  }
}

const badRequest = (msg, extra) => new HttpError(400, msg, extra);
const unauthorized = (msg = "Not signed in") => new HttpError(401, msg);
const forbidden = (msg = "Not allowed") => new HttpError(403, msg);
const notFound = (msg = "Not found") => new HttpError(404, msg);
const tooMany = (msg = "Too many attempts — try again shortly") => new HttpError(429, msg);

function json(res, status, payload) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(payload);
}

/* ---------- cookies ---------- */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return (req.headers["x-forwarded-proto"] || "https") === "https";
}

function cookieString(req, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure(req)) parts.push("Secure");
  if (maxAgeSeconds === 0) parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  else if (maxAgeSeconds) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

/** Append a Set-Cookie without clobbering ones already set on the response. */
function setCookie(req, res, name, value, maxAgeSeconds) {
  const prev = res.getHeader("Set-Cookie");
  const next = cookieString(req, name, value, maxAgeSeconds);
  res.setHeader("Set-Cookie", prev ? [].concat(prev, next) : next);
}

/* ---------- tokens ---------- */

const randomToken = () => crypto.randomBytes(32).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------- CSRF defence ----------
   Session cookies are SameSite=Lax, which blocks cross-site POSTs in modern
   browsers; as defence in depth every state-changing request must also come
   from our own origin. */
function assertSameOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.origin || "";
  if (!origin) return; // non-browser clients (curl, tests) have no Origin
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  let originHost = "";
  try { originHost = new URL(origin).host; } catch (_) { /* malformed */ }
  if (originHost !== host) throw forbidden("Cross-origin request rejected");
}

/* ---------- rate limiting (DB-backed, fixed window) ---------- */

async function rateLimit(key, limit, windowSeconds) {
  const r = await db.query(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count        = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [key.slice(0, 200), windowSeconds]
  );
  if (r.rows[0].count > limit) throw tooMany();
}

function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "");
  return fwd.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

/* ---------- validation ---------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function cleanEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw badRequest("Enter a valid email address");
  return email;
}

function cleanString(raw, { name = "field", max = 500, required = false } = {}) {
  const s = String(raw == null ? "" : raw).trim();
  if (required && !s) throw badRequest(`${name} is required`);
  if (s.length > max) throw badRequest(`${name} is too long (max ${max} characters)`);
  return s;
}

function cleanInt(raw, { name = "value", min = 0, max = 1_000_000_000 } = {}) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

/* ---------- route matching ----------
   Tiny matcher: pattern segments, ":name" captures. */
function matchRoute(pattern, segments) {
  const parts = pattern.split("/").filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

module.exports = {
  HttpError, badRequest, unauthorized, forbidden, notFound, tooMany,
  json, parseCookies, setCookie, randomToken, sha256,
  assertSameOrigin, rateLimit, clientIp,
  cleanEmail, cleanString, cleanInt, slugify, matchRoute,
};
