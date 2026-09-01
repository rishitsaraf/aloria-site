/* GET /api/store/health — uptime probe. 200 with db:true when Postgres
   answers; 503 (still JSON) when it doesn't, so monitors can alert. */

const db = require("../lib/db");
const payments = require("../lib/payments");
const { json } = require("../lib/http");

async function health(req, res) {
  let dbOk = false;
  let error;
  try {
    await db.query("SELECT 1");
    dbOk = true;
  } catch (e) {
    error = e.message;
  }
  res.setHeader("Cache-Control", "no-store");
  json(res, dbOk ? 200 : 503, {
    ok: dbOk,
    db: dbOk,
    paymentProvider: payments.active().name,
    time: new Date().toISOString(),
    ...(error ? { error } : {}),
  });
}

module.exports = { health };
