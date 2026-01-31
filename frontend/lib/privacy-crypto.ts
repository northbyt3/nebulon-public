import nacl from 'tweetnacl';
import bs58 from 'bs58';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const isEncryptedPayload = (value?: string | null) =>
  typeof value === 'string' && value.startsWith('enc:v1:');

const decodeBase64 = (value: string) =>
  Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));

const decodeEncryptedPayload = (payload: string) => {
  if (!isEncryptedPayload(payload)) {
    throw new Error('Payload is not encrypted.');
  }
  const [, , nonceB64, cipherB64, tagB64] = payload.split(':');
  if (!nonceB64 || !cipherB64 || !tagB64) {
    throw new Error('Malformed encrypted payload.');
  }
  return {
    nonce: decodeBase64(nonceB64),
    ciphertext: decodeBase64(cipherB64),
    tag: decodeBase64(tagB64),
  };
};

const encodeBase64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value));

const encodeEncryptedPayload = (nonce: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array) => {
  const nonceB64 = encodeBase64(nonce);
  const cipherB64 = encodeBase64(ciphertext);
  const tagB64 = encodeBase64(tag);
  return `enc:v1:${nonceB64}:${cipherB64}:${tagB64}`;
};

export const buildPrivacyContext = (scope: string, contractId: string, index?: number) => {
  const tail = index === undefined ? '' : `:${index}`;
  return `nebulon:${scope}:v1:${contractId}${tail}`;
};

export const deriveContractKey = async (
  selfSecretKey58: string,
  peerPublicKey58: string,
  contractId: string
) => {
  const selfSecret = bs58.decode(selfSecretKey58);
  const peerPublic = bs58.decode(peerPublicKey58);
  const shared = nacl.scalarMult(selfSecret, peerPublic);
  const salt = textEncoder.encode(String(contractId));
  const info = textEncoder.encode('nebulon:contract:v1');
  const baseKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    256
  );
  return new Uint8Array(bits);
};

export const decryptPayload = async (keyBytes: Uint8Array, payload: string, aad?: string) => {
  const { nonce, ciphertext, tag } = decodeEncryptedPayload(payload);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const additionalData = aad ? textEncoder.encode(aad) : undefined;
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 },
    key,
    combined
  );
  return textDecoder.decode(plaintext);
};

export const encryptPayload = async (keyBytes: Uint8Array, plaintext: string, aad?: string) => {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const additionalData = aad ? textEncoder.encode(aad) : undefined;
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128 },
    key,
    textEncoder.encode(plaintext)
  );
  const encryptedBytes = new Uint8Array(encrypted);
  const tagLength = 16;
  const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - tagLength);
  const tag = encryptedBytes.slice(encryptedBytes.length - tagLength);
  return encodeEncryptedPayload(nonce, ciphertext, tag);
};
