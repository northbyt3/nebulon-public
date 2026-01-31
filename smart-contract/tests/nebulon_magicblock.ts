import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ConnectionMagicRouter,
  GetCommitmentSignature,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import type { Nebulon } from "../target/types/Nebulon.ts";

const ESCROW_SEED = "escrow";
const PER_VAULT_SEED = "per-vault";
const FIXTURE_PATH = path.join("tests", "fixtures", "nebulon_test_keys.json");

const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
);
const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111"
);
const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111"
);
describe("Nebulon MagicBlock", () => {
  const baseConnection = new anchor.web3.Connection(
    process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com"
  );
  const routerConnection = new ConnectionMagicRouter(
    process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app/",
    {
      wsEndpoint:
        process.env.WS_ROUTER_ENDPOINT || "wss://devnet-router.magicblock.app/",
    }
  );
  const provider = anchor.AnchorProvider.env();
  let providerEphemeralRollup: anchor.AnchorProvider;
  let validatorIdentity: PublicKey;
  let validatorFqdn: string;
  anchor.setProvider(provider);

  const program = anchor.workspace.Nebulon as Program<Nebulon>;
  const client = provider.wallet.payer;
  const contractor = anchor.web3.Keypair.generate();
  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const mintKeypair = Keypair.fromSecretKey(Uint8Array.from(fixtures.usdc_mint));

  const escrowId = new BN(Date.now());
  let escrowPda: PublicKey;
  let usdcMint: PublicKey;
  let vaultToken: PublicKey;
  let perVaultPda: PublicKey;
  let baseCommitSig: string | undefined;

  const confirmSignature = async (
    conn: anchor.web3.Connection,
    signature: string,
    label: string
  ) => {
    const status = await conn.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    console.log(`${label} confirm:`, status?.value);
  };

  before(async () => {
    console.log("magicblock setup: funding contractor");
    const contractorBalance = await provider.connection.getBalance(
      contractor.publicKey
    );
    if (contractorBalance < LAMPORTS_PER_SOL) {
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: client.publicKey,
        toPubkey: contractor.publicKey,
        lamports: Math.floor(0.12 * LAMPORTS_PER_SOL),
      });
      const tx = new anchor.web3.Transaction().add(transferIx);
      await provider.sendAndConfirm(tx, []);
    }

    console.log("magicblock setup: deriving PDAs");
    const [escrow] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(ESCROW_SEED),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    escrowPda = escrow;
    [perVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PER_VAULT_SEED), escrowPda.toBuffer()],
      program.programId
    );
    usdcMint = mintKeypair.publicKey;
    const mintInfo = await provider.connection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      await createMint(
        provider.connection,
        client,
        client.publicKey,
        null,
        6,
        mintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
    }
    console.log("USDC mint:", usdcMint.toBase58());
    vaultToken = getAssociatedTokenAddressSync(
      usdcMint,
      escrowPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    console.log("magicblock setup: createEscrow");
    const createIx = await program.methods
      .createEscrow(escrowId, contractor.publicKey)
      .accounts({
        client: client.publicKey,
        contractor: contractor.publicKey,
        mint: usdcMint,
        escrow: escrowPda,
        perVault: perVaultPda,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .transaction();
    await provider.sendAndConfirm(createIx, [provider.wallet.payer], {
      skipPreflight: true,
      commitment: "confirmed",
    });

    const validator = await routerConnection.getClosestValidator();
    validatorIdentity = new PublicKey(validator.identity);
    validatorFqdn = validator.fqdn;
    const erConnection = new anchor.web3.Connection(validatorFqdn);
    providerEphemeralRollup = new anchor.AnchorProvider(
      erConnection,
      anchor.Wallet.local()
    );
  });

  it("delegates escrow PDA to MagicBlock ER validator", async () => {
    const bufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
      escrowPda,
      program.programId
    );
    const delegationRecordPda =
      delegationRecordPdaFromDelegatedAccount(escrowPda);
    const delegationMetadataPda =
      delegationMetadataPdaFromDelegatedAccount(escrowPda);

    const sig = await program.methods
      .delegateEscrow(escrowId)
      .accounts({
        payer: client.publicKey,
        bufferPda,
        delegationRecordPda,
        delegationMetadataPda,
        pda: escrowPda,
        client: client.publicKey,
        ownerProgram: program.programId,
        delegationProgram: DELEGATION_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: validatorIdentity,
          isWritable: false,
          isSigner: false,
        },
      ])
      .rpc();

    console.log("delegateEscrow sig:", sig);
    await confirmSignature(baseConnection, sig, "delegateEscrow");
  });

  it("commits delegated escrow to MagicBlock context", async () => {
    const start = Date.now();
    let tx = await program.methods
      .commitAccount()
      .accounts({
        payer: providerEphemeralRollup.wallet.publicKey,
        pda: escrowPda,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT_ID,
      })
      .transaction();
    tx.feePayer = providerEphemeralRollup.wallet.publicKey;
    tx.recentBlockhash = (
      await providerEphemeralRollup.connection.getLatestBlockhash()
    ).blockhash;
    tx = await providerEphemeralRollup.wallet.signTransaction(tx);

    try {
    const sig = await providerEphemeralRollup.sendAndConfirm(tx);
    const duration = Date.now() - start;
    console.log(`${duration}ms (ER) commitAccount sig: ${sig}`);

    baseCommitSig = await GetCommitmentSignature(
      sig,
      providerEphemeralRollup.connection
    );
    console.log("(Base Layer) commitAccount sig:", baseCommitSig);
    await confirmSignature(providerEphemeralRollup.connection, sig, "commitAccount (ER)");
    if (baseCommitSig) {
      await confirmSignature(baseConnection, baseCommitSig, "commitAccount (Base Layer)");
    }
    } catch (error) {
      const sim = await providerEphemeralRollup.connection.simulateTransaction(
        tx
      );
      console.log("commitAccount logs:", sim.value.logs);
      throw error;
    }
  });
});
