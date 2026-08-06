/* ALORIA — edge middleware: protects the hub server-side.
   Nothing under /hub, /data or /assets is served without the auth cookie.

   This file must hold the logic AND the `config` literal outright. Re-exporting
   config from another module silently drops the matcher and runs the middleware
   on every route — which redirects "/" to "/" forever and makes /api/auth
   unreachable. Keep the matcher a literal here. */

export const config = {
  matcher: ["/hub", "/hub/(.*)", "/data/(.*)", "/assets/(.*)"],
};

// Belt-and-braces copy of the matcher. If the build ever drops the config
// again, this keeps the damage to "hub inaccessible" instead of a site-wide
// redirect loop.
const PROTECTED = /^\/(hub|data|assets)(\/|$)/;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  if (!PROTECTED.test(pathname)) return undefined; // never gate "/", assets or /api

  const password = process.env.ALORIA_PASSWORD || "aloria2026";
  const expected = await sha256Hex(`aloria-salt::${password}`);
  const cookies = request.headers.get("cookie") || "";
  const match = /aloria_auth=([a-f0-9]{64})/.exec(cookies);

  if (match && match[1] === expected) return undefined; // authenticated → continue

  return new Response(null, { status: 302, headers: { Location: "/" } });
}
