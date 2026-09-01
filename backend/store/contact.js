/* Contact form — public submissions land in an inbox the CMS reads, and
   (when email is configured) a copy is forwarded to the shop's address. */

const db = require("../lib/db");
const emailLib = require("../lib/email");
const {
  json, notFound, cleanEmail, cleanInt, cleanString, rateLimit, clientIp,
} = require("../lib/http");

async function submit(req, res) {
  await rateLimit(`contact:${clientIp(req)}`, 5, 3600);
  const body = req.body || {};
  const name = cleanString(body.name, { name: "name", max: 80, required: true });
  const email = cleanEmail(body.email);
  const subject = cleanString(body.subject, { name: "subject", max: 140 });
  const message = cleanString(body.message, { name: "message", max: 4000, required: true });

  await db.query(
    "INSERT INTO contact_messages (name, email, subject, message) VALUES ($1, $2, $3, $4)",
    [name, email, subject, message]
  );
  const to = process.env.CONTACT_EMAIL || process.env.ADMIN_EMAIL;
  if (to) {
    await emailLib.send({
      to,
      subject: `[Contact] ${subject || "New message"} — ${name}`,
      text: `From: ${name} <${email}>\n\n${message}`,
    }).catch(() => {}); // the inbox row is the source of truth
  }
  json(res, 200, { ok: true });
}

async function adminList(req, res) {
  const q = req.query || {};
  const onlyOpen = q.open === "1";
  const r = await db.query(
    `SELECT * FROM contact_messages ${onlyOpen ? "WHERE NOT handled" : ""}
      ORDER BY created_at DESC LIMIT 200`
  );
  const open = await db.query("SELECT COUNT(*)::int AS n FROM contact_messages WHERE NOT handled");
  json(res, 200, { messages: r.rows, openCount: open.rows[0].n });
}

async function adminUpdate(req, res, params) {
  const id = cleanInt(params.id, { name: "id", min: 1 });
  const handled = Boolean((req.body || {}).handled);
  const r = await db.query("UPDATE contact_messages SET handled = $2 WHERE id = $1 RETURNING id", [id, handled]);
  if (!r.rows[0]) throw notFound("Message not found");
  json(res, 200, { ok: true });
}

async function adminDelete(req, res, params) {
  const id = cleanInt(params.id, { name: "id", min: 1 });
  const r = await db.query("DELETE FROM contact_messages WHERE id = $1 RETURNING id", [id]);
  if (!r.rows[0]) throw notFound("Message not found");
  json(res, 200, { ok: true });
}

module.exports = { submit, adminList, adminUpdate, adminDelete };
