/* ALORIA — edge middleware: protects the hub server-side.
   Nothing under /hub or /data is served without the auth cookie. */

export const config = {
  matcher: ["/hub/:path*", "/hub", "/data/:path*", "/assets/:path*"],
};

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async function middleware(request) {
  const password = process.env.ALORIA_PASSWORD || "aloria2026";
  const expected = await sha256Hex(`aloria-salt::${password}`);
  const cookies = request.headers.get("cookie") || "";
  const match = /aloria_auth=([a-f0-9]{64})/.exec(cookies);

  if (match && match[1] === expected) return undefined; // authenticated → continue

  return new Response(null, { status: 302, headers: { Location: "/" } });
}
