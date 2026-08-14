/* Vercel catch-all: every /api/store/* request routes through the commerce
   API entry — the real logic lives in backend/api/store.js. */
module.exports = require("../../backend/api/store.js");
