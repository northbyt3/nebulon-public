import nacl from 'tweetnacl';
import bs58 from 'bs58';

const CONTRACT_KEYS_STORAGE = 'nebulon_contract_keys';

export type ContractKeyEntry = {
  publicKey: string;
  secretKey: string;
  createdAt: number;
};

export const loadContractKeys = (): Record<string, ContractKeyEntry> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CONTRACT_KEYS_STORAGE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const saveContractKeys = (keys: Record<string, ContractKeyEntry>) => {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONTRACT_KEYS_STORAGE, JSON.stringify(keys));
};

export const ensureContractKeypair = (contractId: string) => {
  const keys = loadContractKeys();
  const existing = keys[contractId];
  if (existing?.publicKey && existing?.secretKey) {
    return { entry: existing, created: false };
  }
  const keypair = nacl.box.keyPair();
  const entry = {
    publicKey: bs58.encode(keypair.publicKey),
    secretKey: bs58.encode(keypair.secretKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
  keys[contractId] = entry;
  saveContractKeys(keys);
  return { entry, created: true };
};

export const importContractKeypair = (contractId: string, secretKey58: string) => {
  const secretKey = bs58.decode(secretKey58);
  if (secretKey.length !== 32) {
    throw new Error('Invalid secret key length.');
  }
  const keypair = nacl.box.keyPair.fromSecretKey(secretKey);
  const entry = {
    publicKey: bs58.encode(keypair.publicKey),
    secretKey: secretKey58,
    createdAt: Math.floor(Date.now() / 1000),
  };
  const keys = loadContractKeys();
  keys[contractId] = entry;
  saveContractKeys(keys);
  return entry;
};
