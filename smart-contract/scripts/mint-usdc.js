const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  mintToChecked,
  createMint,
} = require("@solana/spl-token");

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "nebulon_test_keys.json"
);
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const DECIMALS = 6;

const amountArg = process.argv[2];
const targetArg = process.argv[3];

if (!amountArg || !targetArg) {
  console.error("Usage: node scripts/mint-usdc.js <amount> <walletPubkey>");
  console.error("Example: node scripts/mint-usdc.js 10.5 7YByrD...");
  process.exit(1);
}

const amount = Number(amountArg);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error("Amount must be a positive number.");
  process.exit(1);
}

const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(fixtures.client));
const mintKeypair = Keypair.fromSecretKey(Uint8Array.from(fixtures.usdc_mint));
const mint = mintKeypair.publicKey;
const target = new PublicKey(targetArg);

const run = async () => {
  const connection = new Connection(RPC, "confirmed");
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    await createMint(
      connection,
      payer,
      mintKeypair.publicKey,
      null,
      DECIMALS,
      mintKeypair,
      undefined,
      TOKEN_PROGRAM_ID
    );
  }

  const ata = await createAssociatedTokenAccountIdempotent(
    connection,
    payer,
    mint,
    target,
    undefined,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const rawAmount = BigInt(Math.round(amount * 10 ** DECIMALS));
  const sig = await mintToChecked(
    connection,
    payer,
    mint,
    ata,
    mintKeypair.publicKey,
    rawAmount,
    DECIMALS,
    [mintKeypair],
    undefined,
    TOKEN_PROGRAM_ID
  );

  console.log("mint:", mint.toBase58());
  console.log("tokenAccount:", ata.toBase58());
  console.log("amount:", amount);
  console.log("sig:", sig);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
