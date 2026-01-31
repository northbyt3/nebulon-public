import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import nacl from "tweetnacl";
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

const ESCROW_SEED = "escrow";
const PER_VAULT_SEED = "per-vault";
const MILESTONE_SEED = "milestone";
const TERMS_SEED = "terms";
const SESSION_TOKEN_SEED = "session_token";

const FEE_BPS = new BN(200);
const BPS_DENOMINATOR = new BN(10_000);
const NET_BPS = BPS_DENOMINATOR.sub(FEE_BPS);
const FEE_RECEIVER = new PublicKey(
  "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);
const USDC_DECIMALS = 6;

const FIXTURE_PATH = path.join("tests", "fixtures", "nebulon_test_keys.json");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadKeypair = (key: number[]) =>
  Keypair.fromSecretKey(Uint8Array.from(key));

const getTokenAmount = async (
  connection: anchor.web3.Connection,
  account: PublicKey
) => {
  try {
    const balance = await connection.getTokenAccountBalance(
      account,
      "confirmed"
    );
    return BigInt(balance.value.amount);
  } catch (error) {
    return 0n;
  }
};

const waitForAccount = async (
  connection: anchor.web3.Connection,
  account: PublicKey,
  attempts = 10
) => {
  for (let i = 0; i < attempts; i += 1) {
    const info = await connection.getAccountInfo(account, "confirmed");
    if (info) {
      return;
    }
    await sleep(500);
  }
};

describe("Nebulon Scenario (USDC escrow)", () => {
  const connection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const client = loadKeypair(fixtures.client);
  const contractor = loadKeypair(fixtures.contractor);
  const mintKeypair = loadKeypair(fixtures.usdc_mint);
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(client),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace.Nebulon as Program<Nebulon>;
  const sessionTokenManager = new SessionTokenManager(
    provider.wallet,
    provider.connection
  );
  const clientSessionSigner = Keypair.generate();
  const contractorSessionSigner = Keypair.generate();

  const logTokenBalances = async (label: string) => {
    const [clientAmt, contractorAmt, vaultAmt, feeAmt] = await Promise.all([
      getTokenAmount(connection, clientToken),
      getTokenAmount(connection, contractorToken),
      getTokenAmount(connection, vaultToken),
      getTokenAmount(connection, feeReceiverToken),
    ]);
    console.log(
      `${label} token balances: client=${clientAmt.toString()} contractor=${contractorAmt.toString()} vault=${vaultAmt.toString()} fee=${feeAmt.toString()}`
    );
  };

  const escrowId = new BN(Date.now());
  const contractDeadline = new BN(
    Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  );
  const grossFunding = new BN(250_000); // 0.25 USDC (gross)
  const feeAmount = grossFunding.mul(FEE_BPS).div(BPS_DENOMINATOR);
  const netFunding = grossFunding.sub(feeAmount);
  const milestone0 = new BN(100_000); // 0.1 USDC
  const milestone1 = netFunding.sub(milestone0); // remainder

  let escrowPda: PublicKey;
  let perVaultPda: PublicKey;
  let milestone0Pda: PublicKey;
  let milestone1Pda: PublicKey;
  let termsPda: PublicKey;
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
    const minBalance = 50_000_000; // 0.05 SOL for fees
    const clientBalance = await connection.getBalance(client.publicKey);
    if (clientBalance < minBalance) {
      console.log(
        "Fund client wallet to continue:",
        client.publicKey.toBase58()
      );
      console.log(
        "Required SOL:",
        (minBalance / LAMPORTS_PER_SOL).toFixed(3)
      );
      await sleep(10_000);
    }
    const clientBalanceAfter = await connection.getBalance(client.publicKey);
    assert.ok(
      clientBalanceAfter >= minBalance,
      "client wallet needs more SOL to run the scenario test"
    );

    const contractorBalance = await connection.getBalance(contractor.publicKey);
    if (contractorBalance < 20_000_000) {
      const transferIx = anchor.web3.SystemProgram.transfer({
        fromPubkey: client.publicKey,
        toPubkey: contractor.publicKey,
        lamports: 20_000_000,
      });
      const tx = new anchor.web3.Transaction().add(transferIx);
      const sig = await provider.sendAndConfirm(tx, [client]);
      console.log("fund contractor sig:", sig);
    }

    usdcMint = mintKeypair.publicKey;
    const mintInfo = await connection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      await createMint(
        connection,
        client,
        mintKeypair.publicKey,
        null,
        USDC_DECIMALS,
        mintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
    }
    console.log("USDC mint:", usdcMint.toBase58());

    clientToken = await createAssociatedTokenAccountIdempotent(
      connection,
      client,
      usdcMint,
      client.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    contractorToken = await createAssociatedTokenAccountIdempotent(
      connection,
      client,
      usdcMint,
      contractor.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    feeReceiverToken = await createAssociatedTokenAccountIdempotent(
      connection,
      client,
      usdcMint,
      FEE_RECEIVER,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    console.log("client token:", clientToken.toBase58());
    console.log("contractor token:", contractorToken.toBase58());
    console.log("fee token:", feeReceiverToken.toBase58());

    await mintToChecked(
      connection,
      client,
      usdcMint,
      clientToken,
      mintKeypair.publicKey,
      BigInt(grossFunding.toNumber() * 5),
      USDC_DECIMALS,
      [mintKeypair],
      undefined,
      TOKEN_PROGRAM_ID
    );

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
    console.log("escrow PDA:", escrowPda.toBase58());
    console.log("vault token:", vaultToken.toBase58());

    [milestone0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [milestone1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([1])],
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

  it("runs a full client-dev escrow scenario", async () => {
    const contractorBalanceBefore = (await getAccount(connection, contractorToken))
      .amount;
    console.log("invite dev:", contractor.publicKey.toBase58());

    const terms = `Nebulon contract ${escrowId.toString()}: milestones ${milestone0.toString()} + ${milestone1.toString()} (base units), deadline ${contractDeadline.toString()}`;
    const termsBytes = Buffer.from(terms, "utf8");
    const clientSig = nacl.sign.detached(termsBytes, client.secretKey);
    const contractorSig = nacl.sign.detached(termsBytes, contractor.secretKey);
    console.log(
      "terms signed by client:",
      Buffer.from(clientSig).toString("base64")
    );
    console.log(
      "terms signed by contractor:",
      Buffer.from(contractorSig).toString("base64")
    );

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
      .signers([client])
      .rpc();
    console.log("createEscrow sig:", createSig);
    await connection.confirmTransaction(createSig, "confirmed");
    await waitForAccount(connection, vaultToken);
    await logTokenBalances("after create");

    const initTermsSig = await program.methods
      .initPrivateTermsStub(escrowId)
      .accounts({
        payer: client.publicKey,
        escrow: escrowPda,
        terms: termsPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    console.log("initPrivateTermsStub sig:", initTermsSig);

    const createTermsSig = await program.methods
      .createPrivateTerms(
        escrowId,
        Array.from(new Uint8Array(32).fill(7)) as number[],
        grossFunding,
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

    const addMilestone0Sig = await program.methods
      .addMilestone(escrowId, 0)
      .accounts({
        actor: client.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    console.log("addMilestone (client) sig:", addMilestone0Sig);

    const addMilestone1Sig = await program.methods
      .addMilestone(escrowId, 1)
      .accounts({
        actor: contractor.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([contractor])
      .rpc();
    console.log("addMilestone (contractor) sig:", addMilestone1Sig);

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
      .fundEscrow(escrowId, grossFunding)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        clientToken,
        feeReceiverToken,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([client])
      .rpc();
    console.log("fundEscrow sig:", fundSig);
    await connection.confirmTransaction(fundSig, "confirmed");
    const fundTx = await connection.getTransaction(fundSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("fundEscrow token balances:", {
      pre: fundTx?.meta?.preTokenBalances,
      post: fundTx?.meta?.postTokenBalances,
    });
    await sleep(500);
    await logTokenBalances("after fund");

    const submit0Sig = await program.methods
      .submitMilestone(escrowId, 0)
      .accounts({
        contractor: contractor.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
      })
      .signers([contractor])
      .rpc();
    console.log("submitMilestone 0 sig:", submit0Sig);

    const approve0Sig = await program.methods
      .approveMilestone(escrowId, 0)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
      })
      .signers([client])
      .rpc();
    console.log("approveMilestone 0 sig:", approve0Sig);
    await connection.confirmTransaction(approve0Sig, "confirmed");
    await sleep(500);
    await logTokenBalances("after approve 0");

    const submit1Sig = await program.methods
      .submitMilestone(escrowId, 1)
      .accounts({
        contractor: contractor.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
      })
      .signers([contractor])
      .rpc();
    console.log("submitMilestone 1 sig:", submit1Sig);

    const approve1Sig = await program.methods
      .approveMilestone(escrowId, 1)
      .accounts({
        client: client.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
      })
      .signers([client])
      .rpc();
    console.log("approveMilestone 1 sig:", approve1Sig);
    await connection.confirmTransaction(approve1Sig, "confirmed");
    await sleep(500);
    await logTokenBalances("after approve 1");

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

    const contractorBalanceAfter = await getTokenAmount(
      connection,
      contractorToken
    );
    assert.ok(
      contractorBalanceAfter >=
        contractorBalanceBefore + BigInt(netFunding.toNumber()),
      "contractor should receive net escrowed USDC (minus fees)"
    );
  });
});
