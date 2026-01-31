const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");

const FIXTURE_PATH = path.join(__dirname, "..", "tests", "fixtures", "nebulon_test_keys.json");

const destinationArg = process.argv[2];
const destination = new PublicKey(
  destinationArg || "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);
const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";

const loadKeypair = (key) => Keypair.fromSecretKey(Uint8Array.from(key));

const main = async () => {
  const connection = new Connection(rpcUrl, "confirmed");
  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const sources = [
    loadKeypair(fixtures.client),
    loadKeypair(fixtures.contractor),
  ];
  if (fixtures.er_payer) {
    sources.push(loadKeypair(fixtures.er_payer));
  }

  for (const source of sources) {
    if (source.publicKey.equals(destination)) {
      continue;
    }
    const balance = await connection.getBalance(source.publicKey, "confirmed");
    if (balance === 0) {
      console.log(`skip ${source.publicKey.toBase58()} (0 SOL)`);
      continue;
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: source.publicKey,
        toPubkey: destination,
        lamports: 1,
      })
    );
    tx.feePayer = source.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const fee = (await connection.getFeeForMessage(tx.compileMessage())) ?? 5000;
    const transferable = balance - fee;
    if (transferable <= 0) {
      console.log(`skip ${source.publicKey.toBase58()} (balance too low)`);
      continue;
    }

    const sweepTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: source.publicKey,
        toPubkey: destination,
        lamports: transferable,
      })
    );
    const sig = await connection.sendTransaction(sweepTx, [source], {
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    console.log(
      `swept ${transferable} lamports from ${source.publicKey.toBase58()} -> ${destination.toBase58()} (${sig})`
    );
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
