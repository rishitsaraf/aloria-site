/* RFC 6238 TOTP (SHA-1, 6 digits, 30s step) with base32 — plain node crypto,
   compatible with Google Authenticator / 1Password / Authy. */

const crypto = require("crypto");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const newSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** Accepts the current step ±1 to absorb clock drift. */
function verify(secretB32, code) {
  const step = Math.floor(Date.now() / 30_000);
  const given = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return false;
  for (const c of [step - 1, step, step + 1]) {
    const expected = hotp(secretB32, c);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return true;
  }
  return false;
}

const otpauthUrl = (secret, email) =>
  `otpauth://totp/Aloria:${encodeURIComponent(email)}?secret=${secret}&issuer=Aloria&algorithm=SHA1&digits=6&period=30`;

module.exports = { newSecret, verify, otpauthUrl, hotp };
