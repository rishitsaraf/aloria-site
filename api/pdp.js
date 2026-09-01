/* Vercel auto-detects functions in /api — the real logic lives in backend/store/. */
module.exports = require("../backend/store/seoPage.js").productPage;
