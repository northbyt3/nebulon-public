const bs58 = require("bs58");
const nacl = require("tweetnacl");
const { PublicKey } = require("@solana/web3.js");

const isValidWallet = (wallet) => {
  try {
    new PublicKey(wallet);
    return true;
  } catch {
    return false;
  }
};

const verifySignature = (wallet, message, signature) => {
  try {
    const pubkey = new PublicKey(wallet);
    const sigBytes = bs58.decode(signature);
    const msgBytes = Buffer.from(message, "utf8");
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
  } catch {
    return false;
  }
};

module.exports = {
  isValidWallet,
  verifySignature,
};
