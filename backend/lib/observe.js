/* Error observability — inert until SENTRY_DSN is set.
   We deliberately avoid the Sentry SDK (serverless cold-start weight); this
   posts a minimal store-API event, which is enough for alerting on faults.
   Swap in @sentry/node here later if deeper traces are wanted. */

function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) return null;
    return { endpoint: `${u.protocol}//${u.host}/api/${projectId}/store/`, key: u.username };
  } catch (_) { return null; }
}

/** Log always; forward to Sentry when configured. Never throws. */
function captureError(err, context = {}) {
  console.error("[error]", context.where || "", err && err.stack ? err.stack : err);
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || typeof fetch !== "function") return;
  const cfg = parseDsn(dsn);
  if (!cfg) return;
  const event = {
    level: "error",
    platform: "node",
    timestamp: Date.now() / 1000,
    message: String((err && err.message) || err).slice(0, 500),
    extra: context,
    exception: { values: [{ type: (err && err.name) || "Error", value: String((err && err.message) || err).slice(0, 500) }] },
  };
  fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${cfg.key}, sentry_client=aloria/1.0`,
    },
    body: JSON.stringify(event),
  }).catch(() => {});
}

module.exports = { captureError };
