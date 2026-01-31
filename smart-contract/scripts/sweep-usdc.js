const fs = require("fs");
const path = require("path");
const { Connection, Keypair } = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  getAccount,
  getAssociatedTokenAddressSync,
  transfer,
} = require("@solana/spl-token");

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "nebulon_test_keys.json"
);
const TARGET = new PublicKey(
  process.env.SWEEP_TARGET ||
    "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);
const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const keypairs = [
  Keypair.fromSecretKey(Uint8Array.from(fixtures.client)),
  Keypair.fromSecretKey(Uint8Array.from(fixtures.contractor)),
];
const mint = Keypair.fromSecretKey(
  Uint8Array.from(fixtures.usdc_mint)
).publicKey;

const run = async () => {
  const connection = new Connection(RPC, "confirmed");
  const targetAta = await createAssociatedTokenAccountIdempotent(
    connection,
    keypairs[0],
    mint,
    TARGET,
    undefined,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  for (const kp of keypairs) {
    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      kp.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    let account;
    try {
      account = await getAccount(connection, sourceAta);
    } catch (error) {
      console.log("skip", kp.publicKey.toBase58(), "no token account");
      continue;
    }
    if (account.amount === 0n) {
      console.log("skip", kp.publicKey.toBase58(), "zero balance");
      continue;
    }
    const sig = await transfer(
      connection,
      kp,
      sourceAta,
      targetAta,
      kp.publicKey,
      account.amount
    );
    console.log(
      "sweep",
      kp.publicKey.toBase58(),
      "amount",
      account.amount.toString(),
      "sig",
      sig
    );
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
