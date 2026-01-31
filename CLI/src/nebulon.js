const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, SystemProgram } = require("@solana/web3.js");

const IDL_PATH = path.join(__dirname, "..", "idl", "nebulon.json");
const IDL = require(IDL_PATH);

const ESCROW_SEED = "escrow";
const MILESTONE_SEED = "milestone";
const PRIVATE_MILESTONE_SEED = "private-milestone";
const TERMS_SEED = "terms";
const PER_VAULT_SEED = "per-vault";
const DISPUTE_SEED = "dispute";

const getProgramId = (config) => new PublicKey(config.programId);

const getProvider = (endpoint, keypair, wsEndpoint) => {
  const connection = wsEndpoint
    ? new Connection(endpoint, { commitment: "confirmed", wsEndpoint })
    : new Connection(endpoint, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  return new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
};

const getProgram = (config, keypair, options = {}) => {
  const endpoint =
    options.endpoint ||
    (options.useEphemeral
      ? config.ephemeralProviderUrl || config.rpcUrl
      : config.rpcUrl);
  const provider = getProvider(endpoint, keypair, options.wsEndpoint);
  const programId = getProgramId(config);
  const idl = JSON.parse(JSON.stringify(IDL));
  idl.address = programId.toBase58();
  const program = new anchor.Program(idl, provider);
  return { program, provider, connection: provider.connection, programId };
};

const deriveEscrowPda = (client, escrowId, programId) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from(ESCROW_SEED),
      client.toBuffer(),
      Buffer.from(
        Uint8Array.from(
          (anchor.BN.isBN && anchor.BN.isBN(escrowId)
            ? escrowId
            : new anchor.BN(escrowId)
          ).toArray("le", 8)
        )
      ),
    ],
    programId
  )[0];

const deriveMilestonePda = (escrowPda, index, programId) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from(MILESTONE_SEED),
      escrowPda.toBuffer(),
      Buffer.from([index]),
    ],
    programId
  )[0];

const derivePrivateMilestonePda = (escrowPda, index, programId) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from(PRIVATE_MILESTONE_SEED),
      escrowPda.toBuffer(),
      Buffer.from([index]),
    ],
    programId
  )[0];

const deriveTermsPda = (escrowPda, programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(TERMS_SEED), escrowPda.toBuffer()],
    programId
  )[0];

const derivePerVaultPda = (escrowPda, programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(PER_VAULT_SEED), escrowPda.toBuffer()],
    programId
  )[0];

const deriveDisputePda = (escrowPda, programId) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(DISPUTE_SEED), escrowPda.toBuffer()],
    programId
  )[0];

const textToHash = (text) => {
  const bytes = Buffer.alloc(32);
  const encoded = Buffer.from(text, "utf8");
  bytes.set(encoded.subarray(0, 32));
  return Array.from(bytes);
};

module.exports = {
  IDL,
  ESCROW_SEED,
  MILESTONE_SEED,
  PRIVATE_MILESTONE_SEED,
  TERMS_SEED,
  PER_VAULT_SEED,
  DISPUTE_SEED,
  SystemProgram,
  getProgram,
  getProgramId,
  deriveEscrowPda,
  deriveMilestonePda,
  derivePrivateMilestonePda,
  deriveTermsPda,
  derivePerVaultPda,
  deriveDisputePda,
  textToHash,
};
