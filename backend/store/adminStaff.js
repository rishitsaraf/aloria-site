/* Staff management, the admin audit log, and two-factor auth.
   Roles: viewer (read-only CMS) < editor (run the shop) < admin (everything).
   Only admins reach these endpoints (router-enforced), except the TOTP
   endpoints which any staff member can use on their own account. */

const db = require("../lib/db");
const authLib = require("../lib/auth");
const emailLib = require("../lib/email");
const totp = require("../lib/totp");
const { json, badRequest, notFound, cleanEmail, cleanInt, cleanString } = require("../lib/http");

const STAFF_ROLES = ["viewer", "editor", "admin"];

async function listStaff(req, res) {
  const r = await db.query(
    `SELECT id, email, name, role, disabled, totp_enabled, created_at, last_login_at
       FROM users WHERE role IN ('viewer','editor','admin') ORDER BY id`
  );
  json(res, 200, { staff: r.rows });
}

/** Invite a staff member: creates the account with a temporary password and
    emails it (or logs it when no email provider is configured). */
async function inviteStaff(req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  const name = cleanString(body.name, { name: "Name", max: 120 });
  const role = STAFF_ROLES.includes(body.role) ? body.role : "viewer";
  const tempPassword = require("crypto").randomBytes(9).toString("base64url");

  const existing = await db.query("SELECT id, role FROM users WHERE email = $1", [email]);
  if (existing.rows.length) {
    // promote an existing account instead of failing
    await db.query("UPDATE users SET role = $1 WHERE id = $2", [role, existing.rows[0].id]);
    json(res, 200, { ok: true, promoted: true, email, role });
    return;
  }
  await db.query(
    "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4)",
    [email, authLib.hashPassword(tempPassword), name, role]
  );
  const loginUrl = emailLib.siteUrl("/admin");
  await emailLib.send({
    to: email,
    subject: "You've been invited to the Aloria Atelier Console",
    text: `You've been added to the Aloria CMS as ${role}.\n\nSign in at ${loginUrl} with:\n  email: ${email}\n  temporary password: ${tempPassword}\n\nPlease change it right away (Account → password reset).`,
    html: undefined,
  });
  json(res, 201, { ok: true, email, role });
}

async function updateStaff(req, res, params) {
  const id = cleanInt(params.id, { name: "staff id", min: 1 });
  const body = req.body || {};
  if (req.adminUser && Number(req.adminUser.id) === id && body.role && body.role !== "admin") {
    throw badRequest("You can't demote yourself — ask another admin");
  }
  const fields = {};
  if (body.role !== undefined) {
    if (![...STAFF_ROLES, "customer"].includes(body.role)) throw badRequest("Bad role");
    fields.role = body.role;
  }
  if (body.disabled !== undefined) {
    if (req.adminUser && Number(req.adminUser.id) === id && body.disabled) throw badRequest("You can't disable yourself");
    fields.disabled = Boolean(body.disabled);
  }
  if (!Object.keys(fields).length) throw badRequest("Nothing to update");
  const cols = Object.keys(fields);
  const r = await db.query(
    `UPDATE users SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING id, email, role, disabled`,
    [id, ...cols.map((c) => fields[c])]
  );
  if (!r.rows.length) throw notFound("User not found");
  if (fields.disabled || fields.role === "customer") await db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
  json(res, 200, { user: r.rows[0] });
}

/* ---------- audit log ---------- */

async function listAudit(req, res) {
  const r = await db.query(
    "SELECT email, method, path, summary, created_at FROM admin_audit ORDER BY created_at DESC LIMIT 300"
  );
  json(res, 200, { audit: r.rows });
}

/* ---------- two-factor auth (any staff member, own account only) ---------- */

async function totpSetup(req, res) {
  const user = req.adminUser;
  const secret = totp.newSecret();
  await db.query("UPDATE users SET totp_secret = $1, totp_enabled = false WHERE id = $2", [secret, user.id]);
  json(res, 200, { secret, otpauth: totp.otpauthUrl(secret, user.email) });
}

async function totpEnable(req, res) {
  const user = req.adminUser;
  const r = await db.query("SELECT totp_secret FROM users WHERE id = $1", [user.id]);
  const secret = r.rows[0] && r.rows[0].totp_secret;
  if (!secret) throw badRequest("Run setup first");
  if (!totp.verify(secret, (req.body || {}).code)) throw badRequest("That code isn't right — check your authenticator app");
  await db.query("UPDATE users SET totp_enabled = true WHERE id = $1", [user.id]);
  json(res, 200, { ok: true });
}

async function totpDisable(req, res) {
  const user = req.adminUser;
  const r = await db.query("SELECT totp_secret, totp_enabled FROM users WHERE id = $1", [user.id]);
  if (r.rows[0] && r.rows[0].totp_enabled && !totp.verify(r.rows[0].totp_secret, (req.body || {}).code)) {
    throw badRequest("Enter a current code to turn 2FA off");
  }
  await db.query("UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1", [user.id]);
  json(res, 200, { ok: true });
}

module.exports = { listStaff, inviteStaff, updateStaff, listAudit, totpSetup, totpEnable, totpDisable };
