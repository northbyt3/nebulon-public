import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintToChecked,
} from "@solana/spl-token";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";

import type { Nebulon } from "../target/types/Nebulon.ts";

const FEE_BPS = new BN(200);
const BPS_DENOMINATOR = new BN(10_000);
const FEE_RECEIVER = new PublicKey(
  "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);

const ESCROW_SEED = "escrow";
const PER_VAULT_SEED = "per-vault";
const MILESTONE_SEED = "milestone";
const TERMS_SEED = "terms";
const SESSION_TOKEN_SEED = "session_token";
const DISPUTE_SEED = "dispute";
const FIXTURE_PATH = path.join("tests", "fixtures", "nebulon_test_keys.json");

describe("Nebulon (USDC escrow)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Nebulon as Program<Nebulon>;
  const client = provider.wallet.payer;
  const contractor = anchor.web3.Keypair.generate();
  const sessionTokenManager = new SessionTokenManager(
    provider.wallet,
    provider.connection
  );
  const clientSessionSigner = anchor.web3.Keypair.generate();
  const contractorSessionSigner = anchor.web3.Keypair.generate();
  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const mintKeypair = Keypair.fromSecretKey(
    Uint8Array.from(fixtures.usdc_mint)
  );

  const escrowId = new BN(Date.now());
  const milestoneIndex = 0;
  const contractAmount = new BN(250_000); // 0.25 USDC (gross)
  const feeAmount = contractAmount.mul(FEE_BPS).div(BPS_DENOMINATOR);
  const netPayment = contractAmount.sub(feeAmount);
  const contractDeadline = new BN(
    Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  );

  let escrowPda: PublicKey;
  let milestonePda: PublicKey;
  let termsPda: PublicKey;
  let perVaultPda: PublicKey;
  let usdcMint: PublicKey;
  let clientToken: PublicKey;
  let contractorToken: PublicKey;
  let feeReceiverToken: PublicKey;
  let vaultToken: PublicKey;
  let clientSessionTokenPda: PublicKey;
  let contractorSessionTokenPda: PublicKey;

  const deriveSessionTokenPda = (signer: PublicKey, authority: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from(SESSION_TOKEN_SEED),
        program.programId.toBytes(),
        signer.toBytes(),
        authority.toBytes(),
      ],
      sessionTokenManager.program.programId
    )[0];

  const createSessionToken = async (
    signer: Keypair,
    authority: Keypair
  ): Promise<PublicKey> => {
    const sessionPda = deriveSessionTokenPda(signer.publicKey, authority.publicKey);
    const validUntil = new BN(Math.floor(Date.now() / 1000) + 3600);
    const topUpLamports = new BN(0);
    const tx = await sessionTokenManager.program.methods
      .createSession(true, validUntil, topUpLamports)
      .accounts({
        targetProgram: program.programId,
        sessionSigner: signer.publicKey,
        authority: authority.publicKey,
      })
      .transaction();
    await provider.sendAndConfirm(tx, [signer, authority]);
    return sessionPda;
  };

  before(async () => {
    usdcMint = mintKeypair.publicKey;
    const mintInfo = await provider.connection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      await createMint(
        provider.connection,
        client,
        mintKeypair.publicKey,
        null,
        6,
        mintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
    }
    console.log("USDC mint:", usdcMint.toBase58());
    clientToken = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      client,
      usdcMint,
      client.publicKey
    );
    contractorToken = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      client,
      usdcMint,
      contractor.publicKey
    );
    feeReceiverToken = await createAssociatedTokenAccountIdempotent(
      provider.connection,
      client,
      usdcMint,
      FEE_RECEIVER
    );
    await mintToChecked(
      provider.connection,
      client,
      usdcMint,
      clientToken,
      mintKeypair.publicKey,
      BigInt(contractAmount.toNumber() * 5),
      6,
      [mintKeypair],
      undefined,
      TOKEN_PROGRAM_ID
    );

    const contractorBalance = await provider.connection.getBalance(
      contractor.publicKey
    );
    if (contractorBalance < 5_000_000) {
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: client.publicKey,
        toPubkey: contractor.publicKey,
        lamports: 5_000_000,
      });
      const tx = new anchor.web3.Transaction().add(transferIx);
      await provider.sendAndConfirm(tx, []);
    }

    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(ESCROW_SEED),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    [perVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PER_VAULT_SEED), escrowPda.toBuffer()],
      program.programId
    );
    vaultToken = getAssociatedTokenAddressSync(
      usdcMint,
      escrowPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    [milestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(MILESTONE_SEED),
        escrowPda.toBuffer(),
        Buffer.from([milestoneIndex]),
      ],
      program.programId
    );
    [termsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(TERMS_SEED), escrowPda.toBuffer()],
      program.programId
    );
    clientSessionTokenPda = await createSessionToken(
      clientSessionSigner,
      client
    );
    contractorSessionTokenPda = await createSessionToken(
      contractorSessionSigner,
      contractor
    );
  });

  it("creates escrow and milestone, funds and approves payout", async () => {
    const contractorBalanceBefore = (await getAccount(
      provider.connection,
      contractorToken
    )).amount;
    const createSig = await program.methods
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
      .signers([])
      .rpc();
    console.log("createEscrow sig:", createSig);

    const initTermsSig = await program.methods
      .initPrivateTermsStub(escrowId)
      .accounts({
        payer: client.publicKey,
        escrow: escrowPda,
        terms: termsPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initPrivateTermsStub sig:", initTermsSig);

    const createTermsSig = await program.methods
      .createPrivateTerms(
        escrowId,
        Array.from(new Uint8Array(32).fill(8)) as number[],
        contractAmount,
        contractDeadline
      )
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
        perVault: perVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("createPrivateTerms sig:", createTermsSig);

    const clientSignSig = await program.methods
      .signPrivateTerms(escrowId)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("signPrivateTerms (client) sig:", clientSignSig);

    const contractorSignSig = await program.methods
      .signPrivateTerms(escrowId)
      .accounts({
        user: contractor.publicKey,
        payer: contractorSessionSigner.publicKey,
        sessionToken: contractorSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([contractorSessionSigner])
      .rpc();
    console.log("signPrivateTerms (contractor) sig:", contractorSignSig);

    const milestoneSig = await program.methods
      .addMilestone(escrowId, milestoneIndex)
      .accounts({
        actor: client.publicKey,
        escrow: escrowPda,
        milestone: milestonePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("addMilestone sig:", milestoneSig);

    const commitTermsSig = await program.methods
      .commitTerms(escrowId)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("commitTerms sig:", commitTermsSig);

    const fundSig = await program.methods
      .fundEscrow(escrowId, contractAmount)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        clientToken,
        feeReceiverToken,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("fundEscrow sig:", fundSig);

    const submitSig = await program.methods
      .submitMilestone(escrowId, milestoneIndex)
      .accounts({
        contractor: contractor.publicKey,
        escrow: escrowPda,
        milestone: milestonePda,
      })
      .signers([contractor])
      .rpc();
    console.log("submitMilestone sig:", submitSig);

    const approveSig = await program.methods
      .approveMilestone(escrowId, milestoneIndex)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        milestone: milestonePda,
      })
      .rpc();
    console.log("approveMilestone sig:", approveSig);

    const claimSig = await program.methods
      .claimFunds(escrowId)
      .accounts({
        contractor: contractor.publicKey,
        escrow: escrowPda,
        contractorToken,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([contractor])
      .rpc();
    console.log("claimFunds sig:", claimSig);

    const escrowAccount = await program.account.escrow.fetch(escrowPda);
    const milestoneAccount = await program.account.milestone.fetch(milestonePda);
    console.log("escrow state:", escrowAccount);
    console.log("milestone state:", milestoneAccount);

    const contractorBalanceAfter = (await getAccount(
      provider.connection,
      contractorToken
    )).amount;
    assert.ok(
      contractorBalanceAfter >=
        contractorBalanceBefore + BigInt(netPayment.toNumber()),
      "contractor should receive full payment after claim"
    );
  });

  it("opens and resolves a dispute", async () => {
    const escrowId2 = new BN(Date.now() + 1);
    const contractDeadline2 = new BN(
      Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
    );
    const milestoneIndex2 = 0;
    const contractAmount2 = new BN(120_000); // 0.12 USDC (gross)
    const feeAmount2 = contractAmount2.mul(FEE_BPS).div(BPS_DENOMINATOR);
    const netPayment2 = contractAmount2.sub(feeAmount2);

    const [escrow2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(ESCROW_SEED),
        client.publicKey.toBuffer(),
        escrowId2.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const vault2 = getAssociatedTokenAddressSync(
      usdcMint,
      escrow2,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const [perVault2] = PublicKey.findProgramAddressSync(
      [Buffer.from(PER_VAULT_SEED), escrow2.toBuffer()],
      program.programId
    );

    const [milestone2] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(MILESTONE_SEED),
        escrow2.toBuffer(),
        Buffer.from([milestoneIndex2]),
      ],
      program.programId
    );

    const [dispute2] = PublicKey.findProgramAddressSync(
      [Buffer.from(DISPUTE_SEED), escrow2.toBuffer()],
      program.programId
    );

    const createSig = await program.methods
      .createEscrow(escrowId2, contractor.publicKey)
      .accounts({
        client: client.publicKey,
        contractor: contractor.publicKey,
        mint: usdcMint,
        escrow: escrow2,
        vaultToken: vault2,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("createEscrow (dispute) sig:", createSig);

    const [terms2] = PublicKey.findProgramAddressSync(
      [Buffer.from(TERMS_SEED), escrow2.toBuffer()],
      program.programId
    );
    const initTermsSig = await program.methods
      .initPrivateTermsStub(escrowId2)
      .accounts({
        payer: client.publicKey,
        escrow: escrow2,
        terms: terms2,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initPrivateTermsStub (dispute) sig:", initTermsSig);

    const createTermsSig = await program.methods
      .createPrivateTerms(
        escrowId2,
        Array.from(new Uint8Array(32).fill(4)) as number[],
        contractAmount2,
        contractDeadline2
      )
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrow2,
        terms: terms2,
        perVault: perVault2,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("createPrivateTerms (dispute) sig:", createTermsSig);

    const clientSignSig = await program.methods
      .signPrivateTerms(escrowId2)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrow2,
        terms: terms2,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("signPrivateTerms (client, dispute) sig:", clientSignSig);

    const contractorSignSig = await program.methods
      .signPrivateTerms(escrowId2)
      .accounts({
        user: contractor.publicKey,
        payer: contractorSessionSigner.publicKey,
        sessionToken: contractorSessionTokenPda,
        escrow: escrow2,
        terms: terms2,
      })
      .signers([contractorSessionSigner])
      .rpc();
    console.log("signPrivateTerms (contractor, dispute) sig:", contractorSignSig);

    const milestoneSig = await program.methods
      .addMilestone(escrowId2, milestoneIndex2)
      .accounts({
        actor: client.publicKey,
        escrow: escrow2,
        milestone: milestone2,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("addMilestone (dispute) sig:", milestoneSig);

    const commitTermsSig = await program.methods
      .commitTerms(escrowId2)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrow2,
        terms: terms2,
      })
      .signers([clientSessionSigner])
      .rpc();
    console.log("commitTerms (dispute) sig:", commitTermsSig);

    const fundSig = await program.methods
      .fundEscrow(escrowId2, contractAmount2)
      .accounts({
        client: client.publicKey,
        escrow: escrow2,
        clientToken,
        feeReceiverToken,
        vaultToken: vault2,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log("fundEscrow (dispute) sig:", fundSig);

    const openSig = await program.methods
      .openDispute(escrowId2)
      .accounts({
        actor: contractor.publicKey,
        escrow: escrow2,
        dispute: dispute2,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contractor])
      .rpc();
    console.log("openDispute sig:", openSig);

    const resolveSig = await program.methods
      .resolveDispute(escrowId2, netPayment2, true)
      .accounts({
        judge: contractor.publicKey,
        escrow: escrow2,
        dispute: dispute2,
        clientToken,
        contractorToken,
        vaultToken: vault2,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([contractor])
      .rpc();
    console.log("resolveDispute sig:", resolveSig);

    const escrowAccount = await program.account.escrow.fetch(escrow2);
    const disputeAccount = await program.account.dispute.fetch(dispute2);
    console.log("escrow state (dispute):", escrowAccount);
    console.log("dispute state:", disputeAccount);
  });
});
