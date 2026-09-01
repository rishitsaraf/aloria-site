# Aloria — Storefront + CMS + Brand Hub

Full e-commerce site with a headless-style commerce API and built-in CMS, plus the
original password-gated brand hub. Static frontend + Vercel serverless functions +
Postgres. No framework, no build step.

## What's here

| Area | URL | What it is |
|---|---|---|
| Teaser | `/` | Coming-soon page, waitlist capture, gate into the hub |
| **Storefront** | `/shop` | CMS-driven landing (announcement bar, hero, category tiles), search, category + collection filters, PDPs with stone-color swatches + smart variant availability + cross-sell, bag, checkout with tax, order confirmation with tracking |
| Pages | `/p?slug=…` | CMS-authored static pages (shipping, returns, privacy…) linked in the footer |
| Account | `/account` | Customer sign-in / registration / password reset / 2FA-aware login / order history |
| **CMS** | `/admin` | Atelier Console — see below |
| Facets | `/shop?plating=&stone=&shape=&price=&sort=` | Variant-aware faceted filters (a piece matches only if one variant carries every selected axis value) + price bounds + featured/newest/price/rating sorting, all URL-driven |
| SEO | `/sitemap.xml`, `/robots.txt`, `/shop/product` | Sitemap/robots generated from the live catalog; the product page is server-rendered with title/canonical/OG plus schema.org Product JSON-LD (AggregateRating, OfferShippingDetails, MerchantReturnPolicy) and a BreadcrumbList |
| Brand hub | `/hub` | Private brand book (still gated by the shared password) |

## The Atelier Console (CMS)

- **Dashboard** — 7/14/30/90-day ranges with previous-period deltas, revenue trend chart, best sellers, revenue by category, conversion funnel (bags → email → checkout → paid) and abandoned-bag recovery stats.
- **Products** — editor with one-click **standard Aloria axes** (Plating: Gold/Rhodium · Stone Shape: Round/Oval/Pear/Emerald Cut/Heart · Stone Color: Crystal/Emerald/Sapphire/Ruby) feeding the variant-matrix generator; per-product SEO fields; optional product video (“worn & moving” clip on the PDP); scheduled publishing; image upload (Vercel Blob); duplicate-as-draft; bulk activate/archive/feature/price-change; catalog CSV export → spreadsheet → import.
- **Inventory** — every variant in one table with quick ±/set adjustments and a full movement log (sales, restocks, edits, imports — who, when, why).
- **Orders** — status/date/SKU filters, CSV export, manual order entry by SKU, per-order timeline (status changes, notes, emails) with internal notes, carrier + tracking number captured on fulfilment (included in the shipping email), packing-slip print view, re-send confirmation.
- **Customers** — detail pages with lifetime value, order history, tags, internal notes, and account disable.
- **Abandoned bags** — 3-touch recovery ladder (first email, 24h reminder with optional incentive code, 72h final nudge — all timings CMS-tunable), manual re-sends, recovered-revenue attribution.
- **Inbox** — storefront contact form (rate-limited, optional email forward via CONTACT_EMAIL) with an open/handled queue in the CMS.
- **Reviews** — customer reviews with star ratings, automatic verified-buyer detection (checked against paid orders), a moderation queue (approve / reject / public reply / delete), and aggregate ratings surfaced on shop cards, the PDP and its schema.org markup.
- **Discounts** — percent / fixed / free-shipping codes with start & expiry dates, total usage limits, once-per-customer, and live usage counts.
- **Content & Pages** — announcement bar, landing hero and category tiles edited in the CMS; markdown-lite static pages published to the storefront footer.
- **Settings** — shipping rates, free-shipping threshold, abandoned-cart timing, tax (default % + per-country) stored in the DB; integration status panel (payment gateway / Resend / Blob / cron).
- **Staff & security** — viewer/editor/admin roles, staff invites, an audit log of every CMS write, TOTP two-factor auth, and sign-out-everywhere.
- **Emails** — preview every transactional template with sample data and send yourself a test; waitlist CSV export + broadcast.

## Structure

```
frontend/            static site (served as web root)
  shop/  cart/  checkout/  account/  admin/    storefront + CMS pages
  css/style.css      design system (Candy Atelier)
  css/shop.css       storefront layer   css/admin.css  CMS layer
  js/store.js        shared API client + nav/badge/toast
  js/{shop,product,cart-page,checkout,thanks,account,admin}.js
backend/
  lib/db.js          pg pool + idempotent schema (self-provisions on first request)
  lib/http.js        cookies, validation, rate limiting, same-origin (CSRF) check
  lib/auth.js        scrypt password hashing, DB sessions, RBAC, admin bootstrap
  lib/email.js       Resend (or log-only) — order confirmation + cart recovery
  store/             route handlers: catalog, cart, checkout, admin CMS, seed, cron
  api/store.js       router for all /api/store/* routes
api/store/[...route].js   Vercel catch-all shim → backend/api/store.js
api/auth.js  api/waitlist.js   hub gate + waitlist (as before)
middleware.js        edge gate for /hub and /data (assets are public — the shop needs them)
scripts/dev-server.js     local Vercel emulation (static + functions)
vercel.json          cleanUrls, hourly cron sweep, security headers
```

## Environment variables (Vercel → Project → Settings)

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string (Neon / Vercel Postgres / Supabase). Use a **pooled** connection string. Schema auto-creates on first request. |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | **yes** | Bootstrap the CMS admin account (created/promoted on first login). There is no signup path to admin. |
| `SITE_URL` | recommended | Canonical base URL used in emails and payment-gateway redirects, e.g. `https://aloria.example` |
| `PAYMENT_PROVIDER` | later | Names the payment-gateway adapter to use (see `backend/lib/payments/`). Until set, checkout runs in "test order" mode so the whole flow still works. Gateway-specific keys ride alongside it. |
| `RESEND_API_KEY` + `EMAIL_FROM` | optional | Transactional email (order confirmations, abandoned-bag recovery). Without it, emails are logged to Vercel logs instead of sent. |
| `BLOB_READ_WRITE_TOKEN` | optional | Set automatically when you add a Vercel Blob store — enables image uploads from the CMS. |
| `CRON_SECRET` | recommended | Protects `/api/store/cron/sweep`; Vercel sends it automatically as a Bearer token. |
| `ALORIA_PASSWORD` | yes (hub) | Shared password for the private brand hub (unchanged). |
| `ABANDONED_AFTER_MINUTES` | optional | Minutes of inactivity before a bag counts as abandoned (default 120). |
| `FREE_SHIPPING_CENTS` / `SHIPPING_FLAT_CENTS` | optional | Shipping rules (defaults: free ≥ $75, else $8). |

## First-run checklist

1. Create a Postgres database and set `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
2. Deploy (`vercel --prod`). The schema provisions itself.
3. Open `/admin`, sign in with the admin credentials → Dashboard → **Seed launch catalog**
   (11 products / 264 variants generated from the brand system, plus a `WELCOME10` code).
4. Optionally add `RESEND_API_KEY` for delivered emails. When you pick a payment gateway,
   add its adapter under `backend/lib/payments/` (contract documented there) and set
   `PAYMENT_PROVIDER` — until then checkout runs in clearly-marked test mode.

## Commerce model

- **Products** own up to 3 option groups (e.g. Plating × Stone Shape × Stone Color);
  **variants** are the sellable rows (SKU, price override, stock, image, active). The CMS
  generates the full matrix from the options and merges edits non-destructively; variants
  with sales history are archived, never deleted.
- **Carts** live server-side against an HttpOnly cookie token; signing in attaches the cart
  to the account. Prices are never trusted from the client.
- **Checkout** computes totals server-side, applies discount codes, reserves stock inside a
  transaction with row locks (no overselling), then completes a test payment or hands off to
  the configured payment gateway. Payments are **gateway-agnostic**: any provider (Razorpay,
  PayU, Adyen, PayPal, …) plugs in by adding one adapter file under `backend/lib/payments/`
  and setting `PAYMENT_PROVIDER` — checkout, webhooks (idempotent, signature-verified by the
  adapter), refunds and the thanks-page confirmation all go through the same interface.
- **Abandoned bags**: any bag with a known email (account, checkout email field, or the
  "save your bag" box) that goes quiet is marked abandoned by the hourly cron, gets one
  automatic recovery email with a tokenized restore link, and appears in the CMS for manual
  re-sends. Recovered conversions are tracked and reported on the dashboard.
- **Orders**: `pending → paid → fulfilled`, or `cancelled`/`refunded` (both restock).
  Marking an order fulfilled sends a shipping-confirmation email. Customers see history
  under `/account`; guests get a tokenized order link by email.
- **Password reset**: `/account` → "Forgot your password?" — tokenized one-hour links,
  single-use, no account enumeration, and all existing sessions are revoked on reset.

## Security notes

- Passwords: scrypt with per-user salt, constant-time compare. Sessions: random 256-bit
  tokens stored only as SHA-256 hashes, HttpOnly + Secure + SameSite=Lax cookies.
- All state-changing requests pass a same-origin check (CSRF defence in depth).
- Auth and checkout endpoints are rate-limited (DB-backed, per IP and per email).
- Every SQL statement is parameterized. Admin routes require the `admin` role.
- Security headers (HSTS, nosniff, frame-deny, referrer policy) are set site-wide;
  `/hub`, `/data` and `/admin` are noindex. The public shop is indexable.

## Run locally

```bash
npm install
DATABASE_URL=postgres://… ADMIN_EMAIL=you@x.com ADMIN_PASSWORD=… node scripts/dev-server.js
# open http://localhost:8080/shop  (hub password check falls back to client-side locally)
```

## Brand hub (unchanged)

`/hub`, protected by the edge middleware + `ALORIA_PASSWORD`. Hub content updates:
edit `frontend/data/skus.json`, drop WebP files into `frontend/assets/img/…`.
Note: `/assets` is now public because the storefront uses the same imagery.
