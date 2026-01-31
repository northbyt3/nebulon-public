const crypto = require("crypto");
const bs58 = require("bs58");

const randomToken = () => bs58.encode(crypto.randomBytes(24));
const randomNonce = () => bs58.encode(crypto.randomBytes(16));
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

module.exports = {
  randomToken,
  randomNonce,
  hashToken,
};
