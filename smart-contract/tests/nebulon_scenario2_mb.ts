import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import BN from "bn.js";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import nacl from "tweetnacl";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ConnectionMagicRouter,
  createDelegatePermissionInstruction,
  getAuthToken,
  getPermissionStatus,
  waitUntilPermissionActive,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  PERMISSION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { SessionTokenManager } from "@magicblock-labs/gum-sdk";

import type { Nebulon } from "../target/types/Nebulon.ts";

const ESCROW_SEED = "escrow";
const TERMS_SEED = "terms";
const PRIVATE_MILESTONE_SEED = "private-milestone";
const PER_VAULT_SEED = "per-vault";
const FIXTURE_PATH = path.join("tests", "fixtures", "nebulon_test_keys.json");

describe("Nebulon Privacy Scenario (PER)", () => {
  const baseConnection = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"
  );
  const routerConnection = new ConnectionMagicRouter(
    process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app/",
    {
      wsEndpoint:
        process.env.WS_ROUTER_ENDPOINT || "wss://devnet-router.magicblock.app/",
    }
  );
  const baseProvider = anchor.AnchorProvider.env();
  anchor.setProvider(baseProvider);
  const program = anchor.workspace.Nebulon as Program<Nebulon>;
  const client = baseProvider.wallet.payer;

  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  if (!fixtures.er_payer) {
    const erKeypair = Keypair.generate();
    fixtures.er_payer = Array.from(erKeypair.secretKey);
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixtures, null, 2));
  }
  const mintKeypair = Keypair.fromSecretKey(
    Uint8Array.from(fixtures.usdc_mint)
  );
  const escrowId = new BN(Date.now());
  const contractDeadline = new BN(
    Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  );

  let escrowPda: PublicKey;
  let vaultToken: PublicKey;
  let usdcMint: PublicKey;
  let termsPda: PublicKey;
  let privateMilestonePda: PublicKey;
  let perVaultPda: PublicKey;
  let erProvider: anchor.AnchorProvider;
  const erPayer = Keypair.fromSecretKey(Uint8Array.from(fixtures.er_payer));
  if (!fixtures.session_signer) {
    const sessionSigner = Keypair.generate();
    fixtures.session_signer = Array.from(sessionSigner.secretKey);
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixtures, null, 2));
  }
  let sessionKeypair = Keypair.fromSecretKey(
    Uint8Array.from(fixtures.session_signer)
  );
  const sessionTokenManager = new SessionTokenManager(
    baseProvider.wallet,
    baseProvider.connection
  );
  const sessionTokenManagerRouter = new SessionTokenManager(
    baseProvider.wallet,
    routerConnection
  );
  const SESSION_TOKEN_SEED = "session_token";
  let sessionTokenPda = PublicKey.findProgramAddressSync(
    [
      Buffer.from(SESSION_TOKEN_SEED),
      program.programId.toBytes(),
      sessionKeypair.publicKey.toBytes(),
      client.publicKey.toBytes(),
    ],
    sessionTokenManager.program.programId
  )[0];
  let validatorIdentity: PublicKey;
  const decodeAccount = (name: string, data: Buffer) =>
    program.coder.accounts.decode(name, data);
  const waitForAccount = async (
    connection: anchor.web3.Connection,
    pubkey: PublicKey,
    label: string
  ) => {
    const timeoutMs = 6000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await connection.getAccountInfo(pubkey, "confirmed");
      if (info) {
        return info;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label} account`);
  };
  const waitForSessionToken = async (label: string, timeoutMs = 15_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const token = await sessionTokenManagerRouter.get(sessionTokenPda);
        if (token) {
          return token;
        }
      } catch (error) {
        // ignore until timeout
      }
      try {
        const token = await sessionTokenManager.get(sessionTokenPda);
        if (token) {
          return token;
        }
      } catch (error) {
        // ignore until timeout
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label} session token`);
  };
  const ensureFunding = async (
    label: string,
    pubkey: PublicKey,
    minLamports: number
  ) => {
    let balance = await baseConnection.getBalance(pubkey, "confirmed");
    if (balance >= minLamports) {
      return true;
    }
    console.log(`${label} needs funding: ${pubkey.toBase58()}`);
    console.log(
      `Required SOL: ${(minLamports / LAMPORTS_PER_SOL).toFixed(3)}`
    );
    await new Promise((resolve) => setTimeout(resolve, 6000));
    balance = await baseConnection.getBalance(pubkey, "confirmed");
    return balance >= minLamports;
  };
  const withTimeout = async <T>(label: string, ms: number, fn: () => Promise<T>) => {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
      ),
    ]);
  };
  const recomputeSessionTokenPda = () => {
    sessionTokenPda = PublicKey.findProgramAddressSync(
      [
        Buffer.from(SESSION_TOKEN_SEED),
        program.programId.toBytes(),
        sessionKeypair.publicKey.toBytes(),
        client.publicKey.toBytes(),
      ],
      sessionTokenManager.program.programId
    )[0];
  };
  const buildCreateSessionTx = (
    validUntil: BN,
    topUpLamports: BN
  ): Promise<anchor.web3.Transaction> =>
    sessionTokenManager.program.methods
      .createSession(true, validUntil, topUpLamports)
      .accounts({
        targetProgram: program.programId,
        sessionSigner: sessionKeypair.publicKey,
        authority: client.publicKey,
      })
      .transaction();
  const sendErTx = async (
    ix: anchor.web3.TransactionInstruction,
    signers: Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction().add(ix);
    tx.feePayer = sessionKeypair.publicKey;
    tx.recentBlockhash = (await routerConnection.getLatestBlockhash()).blockhash;
    tx.sign(sessionKeypair, ...signers);
    const sig = await routerConnection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await routerConnection.confirmTransaction(sig, "confirmed");
    const txInfo = await routerConnection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (txInfo?.meta?.err) {
      const logs = txInfo.meta.logMessages || [];
      throw new Error(
        `ER tx failed: ${sig}\n${JSON.stringify(txInfo.meta.err)}\n${logs.join("\n")}`
      );
    }
    return sig;
  };
  const sendRouterTx = async (
    tx: anchor.web3.Transaction,
    signers: Keypair[]
  ) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await routerConnection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = latest.blockhash;
      tx.feePayer = signers[signers.length - 1].publicKey;
      tx.sign(...signers);
      const sig = await routerConnection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      try {
        await routerConnection.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );
        return sig;
      } catch (error) {
        if (attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("Failed to send base layer transaction");
  };
  const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/$/, "");
  const diagnoseAuthEndpoint = async (baseUrl: string) => {
    try {
      const challengeUrl = `${baseUrl}/auth/challenge?pubkey=${baseProvider.wallet.publicKey.toBase58()}`;
      const response = await fetch(challengeUrl);
      const contentType = response.headers.get("content-type") || "unknown";
      const bodyText = await response.text();
      console.warn("auth challenge status:", response.status);
      console.warn("auth challenge content-type:", contentType);
      console.warn(
        "auth challenge body head:",
        bodyText.slice(0, 200).replace(/\s+/g, " ")
      );
    } catch (error) {
      console.warn("auth challenge diagnostics failed:", error);
    }
  };
  const buildPermissionEndpoint = async (baseUrl: string) => {
    const signMessage =
      baseProvider.wallet.signMessage ??
      (async (message: Uint8Array) =>
        nacl.sign.detached(
          message,
          baseProvider.wallet.payer.secretKey
        ));
    try {
      const auth = await getAuthToken(
        baseUrl,
        baseProvider.wallet.publicKey,
        (message) => signMessage(message)
      );
      return `${baseUrl}?token=${auth.token}`;
    } catch (error) {
      console.warn("permission token fetch failed:", error);
      await diagnoseAuthEndpoint(baseUrl);
      return baseUrl;
    }
  };

  before(async () => {
    usdcMint = mintKeypair.publicKey;
    const mintInfo = await baseConnection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      await createMint(
        baseConnection,
        client,
        mintKeypair.publicKey,
        null,
        6,
        mintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
    }

    [escrowPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from(ESCROW_SEED),
        client.publicKey.toBuffer(),
        escrowId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    vaultToken = getAssociatedTokenAddressSync(
      usdcMint,
      escrowPda,
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    [termsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(TERMS_SEED), escrowPda.toBuffer()],
      program.programId
    );
    [privateMilestonePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PRIVATE_MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [perVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PER_VAULT_SEED), escrowPda.toBuffer()],
      program.programId
    );

    const createSig = await program.methods
      .createEscrow(escrowId, client.publicKey)
      .accounts({
        client: client.publicKey,
        contractor: client.publicKey,
        mint: usdcMint,
        escrow: escrowPda,
        perVault: perVaultPda,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
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
    await baseProvider.connection.confirmTransaction(initTermsSig, "confirmed");

    const initMilestoneSig = await program.methods
      .initPrivateMilestoneStub(escrowId, 0)
      .accounts({
        payer: client.publicKey,
        escrow: escrowPda,
        privateMilestone: privateMilestonePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("initPrivateMilestoneStub sig:", initMilestoneSig);
    await baseProvider.connection.confirmTransaction(
      initMilestoneSig,
      "confirmed"
    );

    const nowSecs = Math.floor(Date.now() / 1000);
    const sessionInfo = await sessionTokenManager
      .get(sessionTokenPda)
      .catch(() => null);
    if (sessionInfo) {
      const validUntil =
        sessionInfo.validUntil ?? sessionInfo.valid_until ?? 0;
      if (Number(validUntil) <= nowSecs + 30) {
        console.warn("Session token expired; rotating signer.");
        sessionKeypair = Keypair.generate();
        fixtures.session_signer = Array.from(sessionKeypair.secretKey);
        fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixtures, null, 2));
        recomputeSessionTokenPda();
      }
    }

    const clientFunded = await ensureFunding(
      "Client wallet",
      client.publicKey,
      0.05 * LAMPORTS_PER_SOL
    );
    const sessionFunded = await ensureFunding(
      "Session signer",
      sessionKeypair.publicKey,
      0.02 * LAMPORTS_PER_SOL
    );
    if (!clientFunded || !sessionFunded) {
      console.log("Funding missing; exiting test early.");
      process.exit(0);
    }

    console.log("getClosestValidator: start");
    const validator = await withTimeout(
      "getClosestValidator",
      20_000,
      () => routerConnection.getClosestValidator()
    );
    console.log("getClosestValidator: done");
    validatorIdentity = new PublicKey(validator.identity);
    const erConnection = new anchor.web3.Connection(validator.fqdn);
    erProvider = new anchor.AnchorProvider(erConnection, new anchor.Wallet(erPayer), {
      commitment: "confirmed",
    });
    try {
      console.log("revokeSession: start");
      const revokeTx = await sessionTokenManager.program.methods
        .revokeSession()
        .accounts({
          sessionToken: sessionTokenPda,
          authority: client.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .transaction();
      await withTimeout("revokeSession", 20_000, () =>
        baseProvider.sendAndConfirm(revokeTx, [client])
      );
      console.log("revokeSession: done");
    } catch (error) {
      console.log("revokeSession: skipped");
    }

    let existingSession: any = null;
    try {
      existingSession = await sessionTokenManager.get(sessionTokenPda);
    } catch (error) {
      existingSession = null;
    }
    const nowSecsCreate = Math.floor(Date.now() / 1000);
    const existingValidUntil =
      existingSession?.validUntil ?? existingSession?.valid_until ?? null;
    if (existingSession && Number(existingValidUntil) > nowSecsCreate + 30) {
      console.log("createSession: existing session token is valid; skipping.");
    } else {
    const validUntil = new BN(Math.floor(Date.now() / 1000) + 3600);
      const topUpLamports = new BN(0.0005 * LAMPORTS_PER_SOL);
      const sessionLamports = await baseConnection.getBalance(
        sessionKeypair.publicKey
      );
      if (sessionLamports < 0.02 * LAMPORTS_PER_SOL) {
        const fundAmount = 0.02 * LAMPORTS_PER_SOL - sessionLamports;
        const fundIx = anchor.web3.SystemProgram.transfer({
          fromPubkey: client.publicKey,
          toPubkey: sessionKeypair.publicKey,
          lamports: Math.ceil(fundAmount),
        });
        await baseProvider.sendAndConfirm(
          new anchor.web3.Transaction().add(fundIx),
          [client]
        );
      }
      console.log("createSession: start");
      const tx = await buildCreateSessionTx(validUntil, topUpLamports);
      console.log("router endpoint:", routerConnection.rpcEndpoint);
      let sessionSig: string | null = null;
      const tryCreateSession = async () => {
        console.log("createSession: submit");
        let sig: string;
        try {
          sig = await withTimeout("createSession", 45_000, () =>
            baseProvider.sendAndConfirm(tx, [sessionKeypair, client])
          );
        } catch (error) {
          throw error;
        }
        await waitForSessionToken("createSession", 30_000);
        console.log("createSession: token ready");
        return sig;
      };
      try {
        sessionSig = await tryCreateSession();
        console.log("createSession sig:", sessionSig);
      } catch (error: any) {
        const sig =
          typeof error?.signature === "string" ? error.signature : null;
        if (sig) {
          const txInfo = await routerConnection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          });
          const logs = txInfo?.meta?.logMessages || [];
          if (logs.length) {
            console.error("createSession logs:\n" + logs.join("\n"));
            if (logs.some((line) => line.includes("already in use"))) {
              console.warn("createSession: session token already exists.");
              let sessionInfo: any = null;
              try {
                sessionInfo = await sessionTokenManager.get(sessionTokenPda);
              } catch (fetchError) {
                sessionInfo = null;
              }
              if (!sessionInfo) {
                try {
                  sessionInfo = await sessionTokenManagerRouter.get(
                    sessionTokenPda
                  );
                } catch (fetchError) {
                  sessionInfo = null;
                }
              }
              const sessionValidUntil =
                sessionInfo?.validUntil ?? sessionInfo?.valid_until ?? null;
              if (
                sessionValidUntil &&
                Number(sessionValidUntil) > nowSecsCreate + 30
              ) {
                console.warn(
                  "createSession: existing session token is valid; continuing."
                );
                sessionSig = sig;
                return;
              }
              console.warn(
                "createSession: existing session token invalid; revoking."
              );
              try {
                const revokeTx = await sessionTokenManager.program.methods
                  .revokeSession()
                  .accounts({
                    sessionToken: sessionTokenPda,
                    authority: client.publicKey,
                    systemProgram: anchor.web3.SystemProgram.programId,
                  })
                  .transaction();
                await withTimeout("revokeSession", 20_000, () =>
                  sendRouterTx(revokeTx, [client])
                );
                sessionSig = await tryCreateSession();
                console.log("createSession sig:", sessionSig);
                return;
              } catch (revokeError) {
                console.warn(
                  "createSession: revoke failed; rotating session signer."
                );
                sessionKeypair = Keypair.generate();
                recomputeSessionTokenPda();
                const rotateTx = await buildCreateSessionTx(
                  validUntil,
                  topUpLamports
                );
                console.log("createSession: submit (rotated signer)");
                sessionSig = await withTimeout("createSession", 45_000, () =>
                  baseProvider.sendAndConfirm(rotateTx, [sessionKeypair, client])
                );
                await waitForSessionToken("createSession (rotated signer)", 30_000);
                console.log("createSession: token ready (rotated signer)");
                return;
              }
            }
          }
        }
        throw error;
      }
    }
    let erBalance = await routerConnection.getBalance(sessionKeypair.publicKey);
    if (erBalance < 1_000_000) {
      console.log(
        `Fund session signer to continue: ${sessionKeypair.publicKey.toBase58()}`
      );
      console.log("Required SOL: 0.01");
      await new Promise((resolve) => setTimeout(resolve, 6000));
      erBalance = await routerConnection.getBalance(sessionKeypair.publicKey);
    }
    if (erBalance < 1_000_000) {
      console.log("Session signer still unfunded; exiting test early.");
      process.exit(0);
    }

    const readSessionToken = async () => {
      let sessionInfoBase: any = null;
      try {
        sessionInfoBase = await sessionTokenManager.get(sessionTokenPda);
      } catch (error) {
        sessionInfoBase = null;
      }
      console.log("session token (base):", sessionInfoBase || "missing");
      return sessionInfoBase;
    };

    await new Promise((resolve) => setTimeout(resolve, 1500));
    let tokenInfo = await readSessionToken();
    if (!tokenInfo) {
      throw new Error("Session token missing after createSession");
    }
    const validUntilRaw = tokenInfo.validUntil ?? tokenInfo.valid_until ?? 0;
    const validUntilBn = new BN(validUntilRaw.toString());
    const nowBn = new BN(Math.floor(Date.now() / 1000));
    console.log("session token validUntil:", validUntilBn.toString());
    console.log("session token now:", nowBn.toString());
    const signerMismatch =
      tokenInfo.sessionSigner?.toBase58?.() &&
      tokenInfo.sessionSigner.toBase58() !== sessionKeypair.publicKey.toBase58();
    if (signerMismatch || validUntilBn.lte(nowBn)) {
      console.warn(
        "Session token invalid; rotating session signer and recreating session."
      );
      sessionKeypair = Keypair.generate();
      recomputeSessionTokenPda();
      const rotateTx = await buildCreateSessionTx(
        new BN(Math.floor(Date.now() / 1000) + 3600),
        new BN(0.0005 * LAMPORTS_PER_SOL)
      );
      const latest = await routerConnection.getLatestBlockhash("confirmed");
      rotateTx.recentBlockhash = latest.blockhash;
      rotateTx.feePayer = client.publicKey;
      rotateTx.sign(sessionKeypair, client);
      await withTimeout("createSession", 45_000, () =>
        routerConnection.sendRawTransaction(rotateTx.serialize(), {
          skipPreflight: true,
        })
      );
      await waitForSessionToken("createSession (rotated signer)");
      tokenInfo = await readSessionToken();
      if (!tokenInfo) {
        throw new Error("Session token missing after rotation");
      }
      const rotatedValidUntilRaw =
        tokenInfo.validUntil ?? tokenInfo.valid_until ?? 0;
      const rotatedValidUntil = new BN(rotatedValidUntilRaw.toString());
      if (rotatedValidUntil.lte(new BN(Math.floor(Date.now() / 1000)))) {
        throw new Error("Session token expired after rotation");
      }
    }
  });

  it("keeps private accounts off L1", async () => {
    const baseTerms = await waitForAccount(
      baseConnection,
      termsPda,
      "terms stub"
    );
    const baseMilestone = await waitForAccount(
      baseConnection,
      privateMilestonePda,
      "milestone stub"
    );
    assert.ok(baseTerms, "terms stub should exist on L1 before PER create");
    assert.ok(baseMilestone, "milestone stub should exist on L1 before PER create");

    const permissionTerms = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), termsPda.toBuffer()],
      PERMISSION_PROGRAM_ID
    )[0];
    const permissionMilestone = PublicKey.findProgramAddressSync(
      [Buffer.from("permission:"), privateMilestonePda.toBuffer()],
      PERMISSION_PROGRAM_ID
    )[0];
    const members = [
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: client.publicKey },
    ];
    const createTermsPermissionIx = await program.methods
      .createPermission({ terms: { escrow: escrowPda } }, members)
      .accountsPartial({
        payer: client.publicKey,
        permissionedAccount: termsPda,
        permission: permissionTerms,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createMilestonePermissionIx = await program.methods
      .createPermission(
        { privateMilestone: { escrow: escrowPda, index: 0 } },
        members
      )
      .accountsPartial({
        payer: client.publicKey,
        permissionedAccount: privateMilestonePda,
        permission: permissionMilestone,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const delegateTermsPermissionIx = createDelegatePermissionInstruction({
      payer: client.publicKey,
      validator: validatorIdentity,
      permissionedAccount: [termsPda, false],
      authority: [client.publicKey, true],
    });
    const delegateMilestonePermissionIx = createDelegatePermissionInstruction({
      payer: client.publicKey,
      validator: validatorIdentity,
      permissionedAccount: [privateMilestonePda, false],
      authority: [client.publicKey, true],
    });
    const permissionSig = await baseProvider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createTermsPermissionIx,
        createMilestonePermissionIx,
        delegateTermsPermissionIx,
        delegateMilestonePermissionIx
      ),
      [client]
    );
    console.log("create permissions sig:", permissionSig);

    const delegateTermsSig = await program.methods
      .delegateAccount({ terms: { escrow: escrowPda } })
      .accounts({
        payer: client.publicKey,
        pda: termsPda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .rpc();
    console.log("delegate terms sig:", delegateTermsSig);

    const delegateMilestoneSig = await program.methods
      .delegateAccount({ privateMilestone: { escrow: escrowPda, index: 0 } })
      .accounts({
        payer: client.publicKey,
        pda: privateMilestonePda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .rpc();
    console.log("delegate private milestone sig:", delegateMilestoneSig);

    const delegatePerVaultSig = await program.methods
      .delegateAccount({ perVault: { escrow: escrowPda } })
      .accounts({
        payer: client.publicKey,
        pda: perVaultPda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .rpc();
    console.log("delegate per vault sig:", delegatePerVaultSig);

    const permissionEndpointBase = normalizeEndpoint(
      process.env.EPHEMERAL_PERMISSION_ENDPOINT || "https://tee.magicblock.app"
    );
    if (
      permissionEndpointBase.includes("devnet-as.magicblock.app") ||
      permissionEndpointBase.includes("devnet-router.magicblock.app")
    ) {
      console.warn(
        "EPHEMERAL_PERMISSION_ENDPOINT points to a JSON-RPC host; use https://tee.magicblock.app"
      );
    }
    const permissionEndpoint = await buildPermissionEndpoint(
      permissionEndpointBase
    );
    const termsReady = await waitUntilPermissionActive(
      permissionEndpoint,
      termsPda,
      20_000
    );
    const milestoneReady = await waitUntilPermissionActive(
      permissionEndpoint,
      privateMilestonePda,
      20_000
    );
    const termsStatus = await getPermissionStatus(
      permissionEndpoint,
      termsPda
    ).catch(
      (error) => {
        if (
          error instanceof Error &&
          error.message.includes("missing request body")
        ) {
          console.warn(
            "Permission status hit a JSON-RPC endpoint; set EPHEMERAL_PERMISSION_ENDPOINT=https://tee.magicblock.app"
          );
        }
        console.warn("terms permission status fetch failed:", error);
        return null;
      }
    );
    const milestoneStatus = await getPermissionStatus(
      permissionEndpoint,
      privateMilestonePda
    ).catch((error) => {
      if (
        error instanceof Error &&
        error.message.includes("missing request body")
      ) {
        console.warn(
          "Permission status hit a JSON-RPC endpoint; set EPHEMERAL_PERMISSION_ENDPOINT=https://tee.magicblock.app"
        );
      }
      console.warn("milestone permission status fetch failed:", error);
      return null;
    });
    console.log("terms permission status:", termsStatus || "missing");
    console.log("milestone permission status:", milestoneStatus || "missing");
    if (!termsReady) {
      console.warn("terms permission not reported active by ER");
    }
    if (!milestoneReady) {
      console.warn("milestone permission not reported active by ER");
    }

    const termsHash = new Uint8Array(32).fill(9);
    const createTermsIx = await program.methods
      .createPrivateTerms(
        escrowId,
        Array.from(termsHash) as number[],
        new BN(1),
        contractDeadline
      )
      .accountsPartial({
        user: client.publicKey,
        payer: sessionKeypair.publicKey,
        sessionToken: sessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
        perVault: perVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createTermsSig = await sendErTx(createTermsIx, [sessionKeypair]);
    console.log("createPrivateTerms (PER) sig:", createTermsSig);

    const descHash = new Uint8Array(32).fill(3);
    const createPrivateMilestoneIx = await program.methods
      .createPrivateMilestone(escrowId, 0, Array.from(descHash) as number[])
      .accountsPartial({
        user: client.publicKey,
        payer: sessionKeypair.publicKey,
        sessionToken: sessionTokenPda,
        escrow: escrowPda,
        privateMilestone: privateMilestonePda,
        perVault: perVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createPrivateMilestoneSig = await sendErTx(
      createPrivateMilestoneIx,
      [sessionKeypair]
    );
    console.log("createPrivateMilestone (PER) sig:", createPrivateMilestoneSig);

    if (termsReady && milestoneReady) {
      const unauthorizedTerms = await erProvider.connection.getAccountInfo(
        termsPda,
        "confirmed"
      );
      const unauthorizedMilestone = await erProvider.connection.getAccountInfo(
        privateMilestonePda,
        "confirmed"
      );
      assert.isNull(
        unauthorizedTerms,
        "Unauthorized PER read for terms should be blocked when permission active"
      );
      assert.isNull(
        unauthorizedMilestone,
        "Unauthorized PER read for milestone should be blocked when permission active"
      );
    } else {
      console.warn(
        "Permission inactive; skipping unauthorized PER read assertion."
      );
    }

    const perTermsInfo = await erProvider.connection.getAccountInfo(
      termsPda,
      "confirmed"
    );
    const perMilestoneInfo = await erProvider.connection.getAccountInfo(
      privateMilestonePda,
      "confirmed"
    );
    assert.ok(perTermsInfo?.data, "PER terms should exist in PER");
    assert.ok(perMilestoneInfo?.data, "PER milestone should exist in PER");
    console.log("PER terms data length:", perTermsInfo!.data.length);
    console.log("PER milestone data length:", perMilestoneInfo!.data.length);
    const termsHead = perTermsInfo!.data.subarray(0, 8);
    const milestoneHead = perMilestoneInfo!.data.subarray(0, 8);
    console.log("PER terms discriminator bytes:", Array.from(termsHead));
    console.log(
      "PER milestone discriminator bytes:",
      Array.from(milestoneHead)
    );
    console.log("PER terms owner:", perTermsInfo!.owner.toBase58());
    console.log("PER milestone owner:", perMilestoneInfo!.owner.toBase58());
    const perTerms = decodeAccount("terms", perTermsInfo!.data);
    const perMilestone = decodeAccount(
      "privateMilestone",
      perMilestoneInfo!.data
    );
    assert.equal(
      perTerms.escrow.toBase58(),
      escrowPda.toBase58(),
      "PER terms should be readable in PER"
    );
    assert.equal(
      perMilestone.escrow.toBase58(),
      escrowPda.toBase58(),
      "PER milestone should be readable in PER"
    );

    const unauthorizedIx = await program.methods
      .updatePrivateMilestoneStatus(escrowId, 0, 1)
      .accountsPartial({
        user: client.publicKey,
        payer: sessionKeypair.publicKey,
        sessionToken: null,
        escrow: escrowPda,
        privateMilestone: privateMilestonePda,
      })
      .instruction();
    let unauthorizedError: unknown = null;
    try {
      await sendErTx(unauthorizedIx);
    } catch (error) {
      unauthorizedError = error;
    }
    assert.ok(
      unauthorizedError,
      "PER update should fail without a session token"
    );

    const baseTermsAfter = await baseConnection.getAccountInfo(termsPda);
    const baseMilestoneAfter = await baseConnection.getAccountInfo(
      privateMilestonePda
    );
    assert.ok(baseTermsAfter, "terms stub should remain on L1");
    assert.ok(baseMilestoneAfter, "milestone stub should remain on L1");
    const baseTermsLen = baseTermsAfter?.data.length ?? 0;
    const baseMilestoneLen = baseMilestoneAfter?.data.length ?? 0;
    console.log("L1 terms data length:", baseTermsLen);
    console.log("L1 milestone data length:", baseMilestoneLen);
    const zeroDisc = Buffer.alloc(8, 0);
    assert.deepEqual(
      baseTermsAfter!.data.subarray(0, 8),
      zeroDisc,
      "L1 terms should not carry the PER discriminator"
    );
    assert.deepEqual(
      baseMilestoneAfter!.data.subarray(0, 8),
      zeroDisc,
      "L1 milestone should not carry the PER discriminator"
    );
  });
});
