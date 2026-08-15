/* Local dev server — emulates just enough of Vercel to run the whole site:
   static files from frontend/ (with cleanUrls), /api/auth, /api/waitlist and
   /api/store/* through the real handlers, JSON body parsing, req.query.

     DATABASE_URL=postgres://… node scripts/dev-server.js
     open http://localhost:8080

   (The edge middleware that gates /hub is NOT emulated — locally the hub
   falls back to its client-side gate, same as before.) */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "frontend");
const PORT = process.env.PORT || 8080;

const storeHandler = require("../backend/api/store.js");
const authHandler = require("../backend/api/auth.js");
const waitlistHandler = require("../backend/api/waitlist.js");

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function decorate(req, res, body) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  req.query = Object.fromEntries(url.searchParams);
  if (body && body.length) {
    try { req.body = JSON.parse(body.toString("utf8")); } catch (_) { req.body = {}; }
  } else req.body = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith("/")) p += "index.html";
  let file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (fs.existsSync(file + ".html")) file += ".html";                       // cleanUrls
    else if (fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
    else { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    decorate(req, res, Buffer.concat(chunks));
    // vercel.json rewrites
    if (req.url === "/sitemap.xml") req.url = "/api/store/sitemap";
    if (req.url === "/robots.txt") req.url = "/api/store/robots";
    try {
      if (req.url.startsWith("/api/store")) await storeHandler(req, res);
      else if (req.url.startsWith("/api/auth")) await authHandler(req, res);
      else if (req.url.startsWith("/api/waitlist")) await waitlistHandler(req, res);
      else serveStatic(req, res);
    } catch (e) {
      console.error(e);
      if (!res.writableEnded) { res.writeHead(500); res.end("server error"); }
    }
  });
}).listen(PORT, () => {
  console.log(`Aloria dev server → http://localhost:${PORT}`);
  if (!process.env.DATABASE_URL) console.log("⚠ DATABASE_URL not set — the shop API will answer 503 until it is.");
});
