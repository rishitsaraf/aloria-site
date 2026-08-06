# Aloria — Password-Gated Brand Hub

Two-layer site: public teaser + password gate → private brand hub
(vision, design language, component systems, variant matrices, CAD atelier, references, SKU master).

## Structure
```
frontend/          all static site files (served as web root)
  index.html       teaser + gate
  hub/index.html   the private hub
  css/ js/ data/   design system, interactions, skus.json
  assets/img/      all web-ready imagery (WebP)
middleware.js      edge check — /hub, /data, /assets need the auth cookie.
                   Logic + `config` must both live here: Vercel reads the
                   matcher statically at build time, so re-exporting it from
                   another file drops it and runs middleware on every route.
backend/           API source
  api/auth.js      POST password → sets HttpOnly cookie
  api/waitlist.js  teaser email capture (logs to Vercel for now)
api/               root shims → backend/api/
vercel.json        static config: frontend/ as output dir
```

## Run locally
```bash
cd frontend && python3 -m http.server 8080
# open http://localhost:8080  — password check runs client-side locally
```

## Deploy (Vercel)
```bash
npm i -g vercel
cd aloria-site
vercel          # first deploy, accept defaults
vercel --prod
```
Then in Vercel dashboard → Project → Settings → Environment Variables:
- `ALORIA_PASSWORD` = your real password (default if unset: `aloria2026`)

If you change the password, also update the local-preview hash in
`frontend/js/gate.js` (`LOCAL_HASH`): `echo -n "newpassword" | shasum -a 256`

## Security model
- Deployed: middleware checks an HttpOnly cookie server-side before serving
  /hub, /data or /assets — content never reaches the browser without auth.
- Local preview: client-side SHA-256 fallback (obfuscation only, fine for previews).

## Content updates
- SKU/variant data: edit `frontend/data/skus.json` — tables re-render automatically.
- New images: drop WebP files in `frontend/assets/img/...` and reference them.
- Waitlist emails: Vercel dashboard → Logs (search "ALORIA WAITLIST"). Swap the
  TODO in backend/api/waitlist.js for Airtable/Sheets/Resend when ready.
# aloria-site
