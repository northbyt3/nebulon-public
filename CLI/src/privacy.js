const crypto = require("crypto");
const bs58Module = require("bs58");
const nacl = require("tweetnacl");
const { saveConfig } = require("./config");

const bs58 =
  (bs58Module && bs58Module.encode && bs58Module) ||
  (bs58Module && bs58Module.default && bs58Module.default);

const encodeBase58 = (value) => {
  if (!bs58 || typeof bs58.encode !== "function") {
    throw new Error("Base58 encoder unavailable.");
  }
  return bs58.encode(value);
};

const decodeBase58 = (value) => {
  if (!bs58 || typeof bs58.decode !== "function") {
    throw new Error("Base58 decoder unavailable.");
  }
  return bs58.decode(value);
};

const isEncryptedPayload = (value) =>
  typeof value === "string" && value.startsWith("enc:v1:");

const encodeEncryptedPayload = (nonce, ciphertext, tag) => {
  const nonceB64 = Buffer.from(nonce).toString("base64");
  const cipherB64 = Buffer.from(ciphertext).toString("base64");
  const tagB64 = Buffer.from(tag).toString("base64");
  return `enc:v1:${nonceB64}:${cipherB64}:${tagB64}`;
};

const decodeEncryptedPayload = (payload) => {
  if (!isEncryptedPayload(payload)) {
    throw new Error("Payload is not encrypted.");
  }
  const [, , nonceB64, cipherB64, tagB64] = payload.split(":");
  if (!nonceB64 || !cipherB64 || !tagB64) {
    throw new Error("Malformed encrypted payload.");
  }
  return {
    nonce: Buffer.from(nonceB64, "base64"),
    ciphertext: Buffer.from(cipherB64, "base64"),
    tag: Buffer.from(tagB64, "base64"),
  };
};

const deriveContractKey = (selfSecretKey58, peerPublicKey58, contractId) => {
  const selfSecret = decodeBase58(selfSecretKey58);
  const peerPublic = decodeBase58(peerPublicKey58);
  const shared = nacl.scalarMult(selfSecret, peerPublic);
  const salt = Buffer.from(String(contractId), "utf8");
  const info = Buffer.from("nebulon:contract:v1", "utf8");
  return crypto.hkdfSync("sha256", Buffer.from(shared), salt, info, 32);
};

const encryptPayload = (key, plaintext, aad) => {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf8"));
  }
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return encodeEncryptedPayload(nonce, ciphertext, tag);
};

const decryptPayload = (key, payload, aad) => {
  const { nonce, ciphertext, tag } = decodeEncryptedPayload(payload);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  if (aad) {
    decipher.setAAD(Buffer.from(aad, "utf8"));
  }
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
};

const ensurePrivacyConfig = (config) => {
  config.privacy = config.privacy || {};
  config.privacy.contractKeys = config.privacy.contractKeys || {};
};

const ensureContractKeypair = (config, contractId) => {
  if (!contractId) {
    throw new Error("Missing contract ID for privacy keys.");
  }
  ensurePrivacyConfig(config);
  const existing = config.privacy.contractKeys[contractId];
  if (existing && existing.publicKey && existing.secretKey) {
    return existing;
  }
  const keypair = nacl.box.keyPair();
  const entry = {
    publicKey: encodeBase58(keypair.publicKey),
    secretKey: encodeBase58(keypair.secretKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
  config.privacy.contractKeys[contractId] = entry;
  saveConfig(config);
  return entry;
};

module.exports = {
  ensureContractKeypair,
  deriveContractKey,
  encryptPayload,
  decryptPayload,
  isEncryptedPayload,
};
