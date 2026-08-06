/* TEMPORARY diagnostic — delete after use.
   Reports whether the deployed ALORIA_PASSWORD matches the hash we expect,
   without ever revealing the password. The hash it compares against is the
   same value already published in frontend/js/gate.js, so this leaks nothing
   that isn't already public. */
const crypto = require("crypto");

const EXPECTED = "d37a8a037c10fa05b252ca10fbe8ee7af3a2465a9e6fdeebc8082b4beadf1c40";

module.exports = async (req, res) => {
  const raw = process.env.ALORIA_PASSWORD;
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

  res.status(200).json({
    envVarPresent: typeof raw === "string" && raw.length > 0,
    length: raw ? raw.length : 0,
    matchesExpectedHash: raw ? sha(raw) === EXPECTED : false,
    matchesIfTrimmed: raw ? sha(raw.trim()) === EXPECTED : false,
    hasEdgeWhitespace: raw ? raw !== raw.trim() : false,
    isOldDefault: raw === "aloria2026",
  });
};
