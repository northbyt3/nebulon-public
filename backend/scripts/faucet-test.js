const fs = require("fs");
const path = require("path");
const bs58 = require("bs58");
const nacl = require("tweetnacl");
const { Keypair } = require("@solana/web3.js");

const args = process.argv.slice(2);

const getArg = (flag, fallback) => {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return fallback;
  }
  return args[idx + 1];
};

const baseUrl = getArg(
  "--base-url",
  process.env.BASE_URL || "http://localhost:3333"
);
const keypairPath = getArg(
  "--keypair",
  process.env.ANCHOR_WALLET ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".config",
      "solana",
      "id.json"
    )
);
const walletArg = getArg("--wallet", null);

if (!fs.existsSync(keypairPath)) {
  console.error(`Keypair not found: ${keypairPath}`);
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
);
const wallet = walletArg || keypair.publicKey.toBase58();

const fetchJson = async (url, body, token) => {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || res.statusText;
    throw new Error(message);
  }
  return data;
};

const run = async () => {
  const challenge = await fetchJson(`${baseUrl}/v1/auth/challenge`, { wallet });
  const messageBytes = Buffer.from(challenge.message, "utf8");
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  const signature = bs58.encode(signatureBytes);

  const verify = await fetchJson(`${baseUrl}/v1/auth/verify`, {
    wallet,
    nonce: challenge.nonce,
    signature,
  });

  const faucet = await fetchJson(
    `${baseUrl}/v1/faucet/tusdc`,
    {},
    verify.token
  );

  console.log("wallet:", wallet);
  console.log("token:", verify.token);
  console.log("faucet:", faucet);
};

run().catch((error) => {
  console.error("faucet test error:", error.message);
  process.exit(1);
});
