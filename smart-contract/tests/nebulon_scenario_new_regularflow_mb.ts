import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import BN from "bn.js";
import nacl from "tweetnacl";
import { assert } from "chai";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
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
import {
  createDelegatePermissionInstruction,
  getAuthToken,
  getPermissionStatus,
  permissionPdaFromAccount,
  waitUntilPermissionActive,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  PERMISSION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";

import type { Nebulon } from "../target/types/Nebulon.ts";

const ESCROW_SEED = "escrow";
const PER_VAULT_SEED = "per-vault";
const MILESTONE_SEED = "milestone";
const TERMS_SEED = "terms";
const PRIVATE_MILESTONE_SEED = "private-milestone";
const SESSION_TOKEN_SEED = "session_token";
const FIXTURE_PATH = path.join("tests", "fixtures", "nebulon_test_keys.json");
const NEWFLOW_FIXTURE_PATH = path.join(
  "tests",
  "fixtures",
  "nebulon_newflow_keys.json"
);

const FEE_BPS = new BN(200);
const BPS_DENOMINATOR = new BN(10_000);
const NET_BPS = BPS_DENOMINATOR.sub(FEE_BPS);
const FEE_RECEIVER = new PublicKey(
  "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);
const USDC_DECIMALS = 6;
const LOCAL_VALIDATOR_IDENTITY = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const loadKeypair = (filePath: string) => {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
};

const promptUser = async (message: string) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) =>
    rl.question(message, (input) => resolve(input.trim()))
  );
  rl.close();
  return answer.toLowerCase();
};

const deriveSessionTokenPda = (
  programId: PublicKey,
  sessionProgramId: PublicKey,
  signer: PublicKey,
  authority: PublicKey
) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from(SESSION_TOKEN_SEED),
      programId.toBytes(),
      signer.toBytes(),
      authority.toBytes(),
    ],
    sessionProgramId
  )[0];

const textToHash = (text: string) => {
  const bytes = Buffer.alloc(32);
  const encoded = Buffer.from(text, "utf8");
  bytes.set(encoded.subarray(0, 32));
  return Array.from(bytes) as number[];
};

const formatLamports = (lamports: number) =>
  (lamports / LAMPORTS_PER_SOL).toFixed(6);

const formatUsdcAmount = (amount: bigint) => {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
};

const getTokenAmount = async (
  connection: anchor.web3.Connection,
  account: PublicKey
) => {
  try {
    const bal = await connection.getTokenAccountBalance(account, "confirmed");
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
};

const formatDelta = (delta: bigint) => {
  if (delta === 0n) {
    return "+0.000000";
  }
  const sign = delta < 0n ? "-" : "+";
  const abs = delta < 0n ? -delta : delta;
  return `${sign}${formatUsdcAmount(abs)}`;
};

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/$/, "");

const diagnoseAuthEndpoint = async (
  baseUrl: string,
  pubkey: PublicKey
) => {
  try {
    const challengeUrl = `${baseUrl}/auth/challenge?pubkey=${pubkey.toBase58()}`;
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

const buildPermissionEndpoint = async (
  baseUrl: string,
  wallet: anchor.Wallet
) => {
  const signMessage =
    wallet.signMessage ??
    (async (message: Uint8Array) =>
      nacl.sign.detached(message, wallet.payer.secretKey));
  try {
    const auth = await getAuthToken(
      baseUrl,
      wallet.publicKey,
      (message) => signMessage(message)
    );
    return `${baseUrl}?token=${auth.token}`;
  } catch (error) {
    console.warn("permission token fetch failed:", error);
    await diagnoseAuthEndpoint(baseUrl, wallet.publicKey);
    return baseUrl;
  }
};

const saveNewflowFixtures = (fixtures: Record<string, number[]>) => {
  fs.writeFileSync(NEWFLOW_FIXTURE_PATH, JSON.stringify(fixtures, null, 2));
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

describe("Nebulon New Flow (regular scenario + PER enforcement)", () => {
  const rpcUrl =
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new anchor.web3.Connection(rpcUrl);
  const ephemeralRpc =
    process.env.EPHEMERAL_PROVIDER_ENDPOINT || "http://localhost:7799";
  const ephemeralWs =
    process.env.EPHEMERAL_WS_ENDPOINT || "ws://localhost:7800";
  const erConnection = new anchor.web3.Connection(ephemeralRpc, {
    wsEndpoint: ephemeralWs,
  });
  const walletPath =
    process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  if (!fs.existsSync(walletPath)) {
    throw new Error(
      "ANCHOR_WALLET is not set and default Solana wallet was not found."
    );
  }
  const payerKeypair = loadKeypair(walletPath);
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payerKeypair),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);
  const program = anchor.workspace.Nebulon as Program<Nebulon>;
  const erProvider = new anchor.AnchorProvider(
    erConnection,
    new anchor.Wallet(payerKeypair),
    { commitment: "confirmed" }
  );
  let erProgram: Program<Nebulon>;
  const isLocalEr =
    ephemeralRpc.includes("localhost") || ephemeralRpc.includes("127.0.0.1");
  const validatorIdentity = isLocalEr
    ? LOCAL_VALIDATOR_IDENTITY
    : process.env.EPHEMERAL_VALIDATOR_IDENTITY
      ? new PublicKey(process.env.EPHEMERAL_VALIDATOR_IDENTITY)
      : null;
  const isLocalnet =
    rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1");

  const loadOrCreateKeypair = (key: number[] | undefined) =>
    key ? Keypair.fromSecretKey(Uint8Array.from(key)) : Keypair.generate();
  const ensureNewflowFixtures = () => {
    if (fs.existsSync(NEWFLOW_FIXTURE_PATH)) {
      return JSON.parse(fs.readFileSync(NEWFLOW_FIXTURE_PATH, "utf8"));
    }
    const seed = {
      funder: Array.from(Keypair.generate().secretKey),
      client: Array.from(Keypair.generate().secretKey),
      dev: Array.from(Keypair.generate().secretKey),
      client_session_signer: Array.from(Keypair.generate().secretKey),
      dev_session_signer: Array.from(Keypair.generate().secretKey),
    };
    fs.writeFileSync(NEWFLOW_FIXTURE_PATH, JSON.stringify(seed, null, 2));
    return seed;
  };
  const newflowFixtures = ensureNewflowFixtures();
  const funder = loadOrCreateKeypair(newflowFixtures.funder);
  const client = loadOrCreateKeypair(newflowFixtures.client);
  const dev = loadOrCreateKeypair(newflowFixtures.dev);

  const sessionTokenManager = new SessionTokenManager(
    provider.wallet,
    provider.connection
  );
  let clientSessionSigner = loadOrCreateKeypair(
    newflowFixtures.client_session_signer
  );
  let devSessionSigner = loadOrCreateKeypair(
    newflowFixtures.dev_session_signer
  );

  const fixtures = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  const mintKeypair = Keypair.fromSecretKey(
    Uint8Array.from(fixtures.usdc_mint)
  );

  const escrowId = new BN(Date.now());
  const totalPayment = new BN(200_000_000); // 200 USDC (6 decimals, gross)
  const grossFunding = totalPayment;
  const feeAmount = totalPayment.mul(FEE_BPS).div(BPS_DENOMINATOR);
  const contractDeadline = new BN(
    Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60
  );

  let escrowPda: PublicKey;
  let perVaultPda: PublicKey;
  let vaultToken: PublicKey;
  let termsPda: PublicKey;
  let milestone0Pda: PublicKey;
  let milestone1Pda: PublicKey;
  let milestone2Pda: PublicKey;
  let privateMilestone0Pda: PublicKey;
  let privateMilestone1Pda: PublicKey;
  let usdcMint: PublicKey;
  let clientToken: PublicKey;
  let devToken: PublicKey;
  let feeReceiverToken: PublicKey;
  let treasuryBefore: bigint = 0n;
  let clientUsdcBefore: bigint = 0n;
  let devUsdcBefore: bigint = 0n;
  let clientSessionTokenPda: PublicKey;
  let devSessionTokenPda: PublicKey;

  const ensureSolFrom = async (
    label: string,
    payer: Keypair,
    recipient: PublicKey,
    minLamports: number
  ) => {
    const payerBalance = await connection.getBalance(payer.publicKey, "confirmed");
    if (payerBalance < minLamports) {
      throw new Error(
        `Funder wallet is underfunded (${payer.publicKey.toBase58()}); cannot fund ${label}.`
      );
    }
    const balance = await connection.getBalance(recipient, "confirmed");
    if (balance >= minLamports) {
      return;
    }
    console.log(`${label} needs SOL funding: ${recipient.toBase58()}`);
    const tx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: recipient,
        lamports: minLamports - balance,
      })
    );
    await provider.sendAndConfirm(tx, [payer]);
  };

  const logTokenBalance = async (label: string, account: PublicKey) => {
    try {
      const bal = await connection.getTokenAccountBalance(account, "confirmed");
      const amount = BigInt(bal.value.amount);
      console.log(`${label}: ${formatUsdcAmount(amount)} TUSDC`);
    } catch (error) {
      console.log(`${label}: 0.000000 TUSDC`);
    }
  };
  const waitForOwner = async (
    connection: anchor.web3.Connection,
    account: PublicKey,
    owner: PublicKey,
    attempts = 20
  ) => {
    for (let i = 0; i < attempts; i += 1) {
      const info = await connection.getAccountInfo(account, "confirmed");
      if (info && info.owner.equals(owner)) {
        return true;
      }
      await sleep(500);
    }
    return false;
  };
  const sendErTx = async (
    ix: anchor.web3.TransactionInstruction,
    feePayer: Keypair,
    signers: Keypair[] = []
  ) => {
    const tx = new anchor.web3.Transaction().add(ix);
    const latest = await erConnection.getLatestBlockhash("confirmed");
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(feePayer, ...signers);
    const sig = await erConnection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    await erConnection.confirmTransaction(sig, "confirmed");
    const txInfo = await erConnection.getTransaction(sig, {
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

  before(async () => {
    if (isLocalnet) {
      const programInfo = await connection.getAccountInfo(
        program.programId,
        "confirmed"
      );
      if (!programInfo) {
        throw new Error(
          "Nebulon program is not deployed on localnet. Deploy with:\n" +
            "ANCHOR_PROVIDER_URL=http://localhost:8899 \\\n" +
            "ANCHOR_WALLET=~/.config/solana/id.json \\\n" +
            "anchor deploy"
        );
      }
      const sessionProgramId = sessionTokenManager.program.programId;
      const sessionProgramInfo = await connection.getAccountInfo(
        sessionProgramId,
        "confirmed"
      );
      if (!sessionProgramInfo) {
        throw new Error(
          "Session keys program is missing on localnet. Restart mb-test-validator with:\n" +
            "--clone-upgradeable-program KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5\n" +
            "--clone-upgradeable-program ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1\n" +
            "and --url devnet."
        );
      }
      const permissionProgramInfo = await connection.getAccountInfo(
        PERMISSION_PROGRAM_ID,
        "confirmed"
      );
      if (!permissionProgramInfo) {
        throw new Error(
          "Permission program is missing on localnet. Restart mb-test-validator with:\n" +
            "--clone-upgradeable-program ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1\n" +
            "and --url devnet."
        );
      }
    }
    erProgram = new Program<Nebulon>(
      program.idl as anchor.Idl,
      erProvider
    );
    console.log("Roles:");
    console.log("funder:", funder.publicKey.toBase58());
    console.log("client:", client.publicKey.toBase58());
    console.log("dev:", dev.publicKey.toBase58());
    // funding wallet log omitted to keep output minimal
    const fundingBalance = await connection.getBalance(
      provider.wallet.publicKey,
      "confirmed"
    );
    if (fundingBalance < 0.6 * LAMPORTS_PER_SOL) {
      console.log(
        "Funding wallet needs SOL. Required ~0.6 SOL for this test."
      );
      process.exit(0);
    }

    const funderMin = 0.2 * LAMPORTS_PER_SOL;
    const funderBalance = await connection.getBalance(
      funder.publicKey,
      "confirmed"
    );
    if (funderBalance < funderMin) {
      console.log(
        "Fund Funder wallet with at least 0.2 SOL:",
        funder.publicKey.toBase58()
      );
      const answer = await promptUser("Press N to continue or M to cancel: ");
      if (answer === "m") {
        process.exit(0);
      }
    }
    const funderBalanceAfter = await connection.getBalance(
      funder.publicKey,
      "confirmed"
    );
    console.log(
      "funder SOL after prompt:",
      `${formatLamports(funderBalanceAfter)} SOL`
    );
    if (funderBalanceAfter < funderMin) {
      throw new Error(
        `Funder wallet still underfunded (${funderBalanceAfter}).`
      );
    }
    await ensureSolFrom(
      "Client",
      funder,
      client.publicKey,
      0.08 * LAMPORTS_PER_SOL
    );
    await ensureSolFrom(
      "Dev",
      funder,
      dev.publicKey,
      0.08 * LAMPORTS_PER_SOL
    );
    await ensureSolFrom(
      "Client session signer",
      funder,
      clientSessionSigner.publicKey,
      0.02 * LAMPORTS_PER_SOL
    );
    await ensureSolFrom(
      "Dev session signer",
      funder,
      devSessionSigner.publicKey,
      0.02 * LAMPORTS_PER_SOL
    );

    usdcMint = mintKeypair.publicKey;
    const mintInfo = await connection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      await createMint(
        connection,
        funder,
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
      funder,
      usdcMint,
      client.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    devToken = await createAssociatedTokenAccountIdempotent(
      connection,
      funder,
      usdcMint,
      dev.publicKey,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    feeReceiverToken = await createAssociatedTokenAccountIdempotent(
      connection,
      funder,
      usdcMint,
      FEE_RECEIVER,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const clientTokenInfo = await connection
      .getTokenAccountBalance(clientToken, "confirmed")
      .catch(() => null);
    const clientAmount = BigInt(clientTokenInfo?.value.amount ?? "0");
    if (clientAmount < BigInt(grossFunding.toNumber())) {
      if (rpcUrl.includes("localhost") || rpcUrl.includes("127.0.0.1")) {
        const mintAmount = grossFunding.toNumber();
        const mintSig = await mintToChecked(
          connection,
          funder,
          usdcMint,
          clientToken,
          mintKeypair,
          mintAmount,
          USDC_DECIMALS,
          undefined,
          undefined,
          TOKEN_PROGRAM_ID
        );
        console.log("local TUSDC mint sig:", mintSig);
      } else {
        console.log("Client needs test USDC.");
        console.log(
          `Run: npm run mint-tusdc -- ${grossFunding.toNumber() / 10 ** USDC_DECIMALS} ${client.publicKey.toBase58()}`
        );
        const answer = await promptUser("Press N to continue or M to cancel: ");
        if (answer === "m") {
          process.exit(0);
        }
      }
    }
    const clientTokenInfoAfter = await connection
      .getTokenAccountBalance(clientToken, "confirmed")
      .catch(() => null);
    const clientAmountAfter = BigInt(clientTokenInfoAfter?.value.amount ?? "0");
    if (clientAmountAfter < BigInt(grossFunding.toNumber())) {
      throw new Error("Client USDC balance still insufficient.");
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
    [termsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(TERMS_SEED), escrowPda.toBuffer()],
      program.programId
    );
    [milestone0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [milestone1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([1])],
      program.programId
    );
    [milestone2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([2])],
      program.programId
    );
    [privateMilestone0Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PRIVATE_MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [privateMilestone1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PRIVATE_MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([1])],
      program.programId
    );

    const ensureSessionToken = async (
      role: "client" | "dev",
      authority: Keypair
    ) => {
      const nowSecs = Math.floor(Date.now() / 1000);
      const validUntil = new BN(nowSecs + 3600);
      const topUpLamports = new BN(0);
      const updateSigner = (signer: Keypair) => {
        if (role === "client") {
          clientSessionSigner = signer;
          newflowFixtures.client_session_signer = Array.from(signer.secretKey);
        } else {
          devSessionSigner = signer;
          newflowFixtures.dev_session_signer = Array.from(signer.secretKey);
        }
        saveNewflowFixtures(newflowFixtures);
      };
      const getSigner = () =>
        role === "client" ? clientSessionSigner : devSessionSigner;
      const getAuthority = () => authority.publicKey;
      const getPda = () =>
        deriveSessionTokenPda(
          program.programId,
          sessionTokenManager.program.programId,
          getSigner().publicKey,
          getAuthority()
        );

      let sessionSigner = getSigner();
      let pda = getPda();
      let existing: any = null;
      try {
        existing = await sessionTokenManager.get(pda);
      } catch {
        existing = null;
      }
      const existingValidUntil =
        existing?.validUntil ?? existing?.valid_until ?? null;
      if (existing && Number(existingValidUntil) > nowSecs + 30) {
        console.log(`${role} session token already valid:`, pda.toBase58());
        return pda;
      }

      let revoked = false;
      if (existing) {
        try {
          const revokeTx = await sessionTokenManager.program.methods
            .revokeSession()
            .accounts({
              sessionToken: pda,
              authority: getAuthority(),
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .transaction();
          await provider.sendAndConfirm(revokeTx);
          revoked = true;
        } catch {
          revoked = false;
        }
      }

      if (existing && !revoked) {
        sessionSigner = Keypair.generate();
        updateSigner(sessionSigner);
        await ensureSolFrom(
          `${role} session signer`,
          funder,
          sessionSigner.publicKey,
          0.08 * LAMPORTS_PER_SOL
        );
        pda = getPda();
      }

      const tx = await sessionTokenManager.program.methods
        .createSession(true, validUntil, topUpLamports)
        .accounts({
          targetProgram: program.programId,
          sessionSigner: sessionSigner.publicKey,
          authority: getAuthority(),
        })
        .transaction();
      await provider.sendAndConfirm(tx, [sessionSigner, authority]);
      return pda;
    };

    clientSessionTokenPda = await ensureSessionToken("client", client);
    devSessionTokenPda = await ensureSessionToken("dev", dev);
  });

  it("runs the new regular flow", async () => {
    console.log("Roles:");
    console.log("funder:", funder.publicKey.toBase58());
    console.log("client:", client.publicKey.toBase58());
    console.log("dev:", dev.publicKey.toBase58());
    console.log("----BALANCES BEFORE----");
    console.log(
      "client SOL:",
      `${formatLamports(await connection.getBalance(client.publicKey))} SOL`
    );
    console.log(
      "dev SOL:",
      `${formatLamports(await connection.getBalance(dev.publicKey))} SOL`
    );
    clientUsdcBefore = await getTokenAmount(connection, clientToken);
    devUsdcBefore = await getTokenAmount(connection, devToken);
    console.log(
      `client USDC: ${formatUsdcAmount(clientUsdcBefore)} TUSDC`
    );
    console.log(`dev USDC: ${formatUsdcAmount(devUsdcBefore)} TUSDC`);
    const treasuryBeforeInfo = await getAccount(connection, feeReceiverToken);
    treasuryBefore = await getTokenAmount(connection, feeReceiverToken);
    console.log(
      "Treasury balance:",
      `${formatUsdcAmount(treasuryBefore)} TUSDC`
    );
    console.log("Treasury ATA:", feeReceiverToken.toBase58());
    console.log(
      "Treasury ATA mint:",
      treasuryBeforeInfo.mint.toBase58()
    );
    console.log(
      "Treasury ATA owner:",
      treasuryBeforeInfo.owner.toBase58()
    );
    console.log("----------------------");

    console.log("1) Client signs in (message)");
    const clientMsg = Buffer.from("Nebulon sign-in (client)", "utf8");
    const clientSig = nacl.sign.detached(clientMsg, client.secretKey);
    console.log("client sign-in sig:", Buffer.from(clientSig).toString("base64"));

    console.log("2) Client creates invite");
    console.log("invite -> role: client sends to dev");

    console.log("3) Dev signs in (message)");
    const devMsg = Buffer.from("Nebulon sign-in (dev)", "utf8");
    const devSig = nacl.sign.detached(devMsg, dev.secretKey);
    console.log("dev sign-in sig:", Buffer.from(devSig).toString("base64"));

    console.log("4) Dev accepts invite as dev");

    console.log("5) Client creates escrow");
    const createEscrowAccounts = {
      client: client.publicKey,
      contractor: dev.publicKey,
      mint: usdcMint,
      escrow: escrowPda,
      perVault: perVaultPda,
      vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    };
    console.log("escrow PDA:", escrowPda.toBase58());
    const createSig = await program.methods
      .createEscrow(escrowId, dev.publicKey)
      .accountsStrict(createEscrowAccounts)
      .signers([client])
      .rpc();
    console.log("createEscrow sig:", createSig);
    await connection.confirmTransaction(createSig, "confirmed");
    await waitForAccount(connection, escrowPda);
    const escrowInfo = await connection.getAccountInfo(escrowPda, "confirmed");
    console.log("escrow exists after create:", Boolean(escrowInfo));
    if (escrowInfo) {
      console.log("escrow owner:", escrowInfo.owner.toBase58());
      console.log("escrow data len:", escrowInfo.data.length);
    }

    console.log("6) Session keys already created");

    console.log("7) Milestones (add 3, remove 1)");
    const add0Sig = await program.methods
      .addMilestone(escrowId, 0)
      .accounts({
        actor: client.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    console.log("addMilestone 0 sig:", add0Sig);

    const add1Sig = await program.methods
      .addMilestone(escrowId, 1)
      .accounts({
        actor: dev.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([dev])
      .rpc();
    console.log("addMilestone 1 sig:", add1Sig);

    const add2Sig = await program.methods
      .addMilestone(escrowId, 2)
      .accounts({
        actor: dev.publicKey,
        escrow: escrowPda,
        milestone: milestone2Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([dev])
      .rpc();
    console.log("addMilestone 2 sig:", add2Sig);

    const remove2Sig = await program.methods
      .removeMilestone(escrowId, 2)
      .accounts({
        actor: dev.publicKey,
        escrow: escrowPda,
        milestone: milestone2Pda,
      })
      .signers([dev])
      .rpc();
    console.log("removeMilestone 2 sig:", remove2Sig);
    await connection.confirmTransaction(remove2Sig, "confirmed");

    await waitForAccount(connection, escrowPda);
    const escrowInfoAfterRemove = await connection.getAccountInfo(
      escrowPda,
      "confirmed"
    );
    if (escrowInfoAfterRemove) {
      console.log("escrow owner after remove:", escrowInfoAfterRemove.owner.toBase58());
      console.log("escrow data len after remove:", escrowInfoAfterRemove.data.length);
    }
    const escrowAfterRemove = await program.account.escrow.fetch(
      escrowPda,
      "confirmed"
    );
    console.log("milestone_count after remove:", escrowAfterRemove.milestoneCount);

    console.log("8) Private milestone metadata");
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

    const initPrivate0Sig = await program.methods
      .initPrivateMilestoneStub(escrowId, 0)
      .accounts({
        payer: client.publicKey,
        escrow: escrowPda,
        privateMilestone: privateMilestone0Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    console.log("initPrivateMilestoneStub 0 sig:", initPrivate0Sig);

    const initPrivate1Sig = await program.methods
      .initPrivateMilestoneStub(escrowId, 1)
      .accounts({
        payer: client.publicKey,
        escrow: escrowPda,
        privateMilestone: privateMilestone1Pda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([client])
      .rpc();
    console.log("initPrivateMilestoneStub 1 sig:", initPrivate1Sig);

    if (!validatorIdentity) {
      throw new Error(
        "Missing validator identity; set EPHEMERAL_VALIDATOR_IDENTITY for non-local ER."
      );
    }

    console.log("8.1) Permissions + delegation");
    const members = [
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: client.publicKey },
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: dev.publicKey },
    ];
    const permissionTerms = permissionPdaFromAccount(termsPda);
    const permissionMilestone0 = permissionPdaFromAccount(privateMilestone0Pda);
    const permissionMilestone1 = permissionPdaFromAccount(privateMilestone1Pda);
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
    const createMilestone0PermissionIx = await program.methods
      .createPermission(
        { privateMilestone: { escrow: escrowPda, index: 0 } },
        members
      )
      .accountsPartial({
        payer: client.publicKey,
        permissionedAccount: privateMilestone0Pda,
        permission: permissionMilestone0,
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createMilestone1PermissionIx = await program.methods
      .createPermission(
        { privateMilestone: { escrow: escrowPda, index: 1 } },
        members
      )
      .accountsPartial({
        payer: client.publicKey,
        permissionedAccount: privateMilestone1Pda,
        permission: permissionMilestone1,
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
    const delegateMilestone0PermissionIx = createDelegatePermissionInstruction({
      payer: client.publicKey,
      validator: validatorIdentity,
      permissionedAccount: [privateMilestone0Pda, false],
      authority: [client.publicKey, true],
    });
    const delegateMilestone1PermissionIx = createDelegatePermissionInstruction({
      payer: client.publicKey,
      validator: validatorIdentity,
      permissionedAccount: [privateMilestone1Pda, false],
      authority: [client.publicKey, true],
    });
    const permissionCreateSig = await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createTermsPermissionIx,
        createMilestone0PermissionIx,
        createMilestone1PermissionIx
      ),
      [client]
    );
    console.log("create permissions sig:", permissionCreateSig);

    const permissionDelegateSig = await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        delegateTermsPermissionIx,
        delegateMilestone0PermissionIx,
        delegateMilestone1PermissionIx
      ),
      [client]
    );
    console.log("delegate permissions sig:", permissionDelegateSig);

    const delegateTermsSig = await program.methods
      .delegateAccount({ terms: { escrow: escrowPda } })
      .accounts({
        payer: client.publicKey,
        pda: termsPda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .signers([client])
      .rpc();
    console.log("delegate terms sig:", delegateTermsSig);

    const delegateMilestone0Sig = await program.methods
      .delegateAccount({ privateMilestone: { escrow: escrowPda, index: 0 } })
      .accounts({
        payer: client.publicKey,
        pda: privateMilestone0Pda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .signers([client])
      .rpc();
    console.log("delegate private milestone 0 sig:", delegateMilestone0Sig);

    const delegateMilestone1Sig = await program.methods
      .delegateAccount({ privateMilestone: { escrow: escrowPda, index: 1 } })
      .accounts({
        payer: client.publicKey,
        pda: privateMilestone1Pda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .signers([client])
      .rpc();
    console.log("delegate private milestone 1 sig:", delegateMilestone1Sig);

    const delegatePerVaultSig = await program.methods
      .delegateAccount({ perVault: { escrow: escrowPda } })
      .accounts({
        payer: client.publicKey,
        pda: perVaultPda,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .signers([client])
      .rpc();
    console.log("delegate per vault sig:", delegatePerVaultSig);

    const delegateEscrowSig = await program.methods
      .delegateEscrow(escrowId)
      .accounts({
        payer: client.publicKey,
        pda: escrowPda,
        client: client.publicKey,
      })
      .remainingAccounts([
        { pubkey: validatorIdentity, isWritable: false, isSigner: false },
      ])
      .signers([client])
      .rpc();
    console.log("delegate escrow sig:", delegateEscrowSig);

    const permissionEndpointBase = normalizeEndpoint(
      process.env.EPHEMERAL_PERMISSION_ENDPOINT || ephemeralRpc
    );
    const skipPermissionChecks = isLocalEr;
    let termsReady = false;
    let milestone0Ready = false;
    let milestone1Ready = false;
    if (skipPermissionChecks) {
      console.warn(
        "Local ER detected; skipping permission status checks (no /permission endpoint)."
      );
    } else {
      const permissionEndpoint = await buildPermissionEndpoint(
        permissionEndpointBase,
        provider.wallet as anchor.Wallet
      );
      termsReady = await waitUntilPermissionActive(
        permissionEndpoint,
        termsPda
      );
      milestone0Ready = await waitUntilPermissionActive(
        permissionEndpoint,
        privateMilestone0Pda
      );
      milestone1Ready = await waitUntilPermissionActive(
        permissionEndpoint,
        privateMilestone1Pda
      );
      const termsStatus = await getPermissionStatus(permissionEndpoint, termsPda);
      const milestone0Status = await getPermissionStatus(
        permissionEndpoint,
        privateMilestone0Pda
      );
      const milestone1Status = await getPermissionStatus(
        permissionEndpoint,
        privateMilestone1Pda
      );
      console.log("terms permission status:", termsStatus || "missing");
      console.log("milestone0 permission status:", milestone0Status || "missing");
      console.log("milestone1 permission status:", milestone1Status || "missing");
      if (!termsReady || !milestone0Ready || !milestone1Ready) {
        console.warn("permission not reported active by ER");
      }
    }

    const createPrivate0Ix = await erProgram.methods
      .createPrivateMilestone(
        escrowId,
        0,
        textToHash("placeholder")
      )
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        privateMilestone: privateMilestone0Pda,
        perVault: perVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createPrivate0Sig = await sendErTx(
      createPrivate0Ix,
      clientSessionSigner
    );
    console.log("createPrivateMilestone 0 sig:", createPrivate0Sig);

    const createPrivate1Ix = await erProgram.methods
      .createPrivateMilestone(
        escrowId,
        1,
        textToHash("placeholder")
      )
      .accounts({
        user: dev.publicKey,
        payer: devSessionSigner.publicKey,
        sessionToken: devSessionTokenPda,
        escrow: escrowPda,
        privateMilestone: privateMilestone1Pda,
        perVault: perVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const createPrivate1Sig = await sendErTx(
      createPrivate1Ix,
      devSessionSigner
    );
    console.log("createPrivateMilestone 1 sig:", createPrivate1Sig);

    const update0Ix = await erProgram.methods
      .updatePrivateMilestoneDetails(
        escrowId,
        0,
        textToHash("1.Start project")
      )
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        privateMilestone: privateMilestone0Pda,
      })
      .instruction();
    const update0Sig = await sendErTx(update0Ix, clientSessionSigner);
    console.log("updatePrivateMilestoneDetails 0 sig:", update0Sig);

    const update1Ix = await erProgram.methods
      .updatePrivateMilestoneDetails(
        escrowId,
        1,
        textToHash("2.Finish Project")
      )
      .accounts({
        user: dev.publicKey,
        payer: devSessionSigner.publicKey,
        sessionToken: devSessionTokenPda,
        escrow: escrowPda,
        privateMilestone: privateMilestone1Pda,
      })
      .instruction();
    const update1Sig = await sendErTx(update1Ix, devSessionSigner);
    console.log("updatePrivateMilestoneDetails 1 sig:", update1Sig);

    console.log("9) Discuss deadline");
    const draftTermsIx = await erProgram.methods
      .createPrivateTerms(
        escrowId,
        textToHash("draft-terms"),
        new BN(100_000),
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
      .instruction();
    const draftTermsSig = await sendErTx(draftTermsIx, clientSessionSigner);
    console.log("createPrivateTerms (draft) sig:", draftTermsSig);

    console.log("10) Discuss payment");
    const finalTermsIx = await erProgram.methods
      .createPrivateTerms(
        escrowId,
        textToHash("final-terms"),
        totalPayment,
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
      .instruction();
    const finalTermsSig = await sendErTx(finalTermsIx, clientSessionSigner);
    console.log("createPrivateTerms (final) sig:", finalTermsSig);

    console.log("11) Sign terms and commit");
    const clientSignIx = await erProgram.methods
      .signPrivateTerms(escrowId)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    const clientSignSig = await sendErTx(clientSignIx, clientSessionSigner);
    console.log("signPrivateTerms (client) sig:", clientSignSig);

    const devSignIx = await erProgram.methods
      .signPrivateTerms(escrowId)
      .accounts({
        user: dev.publicKey,
        payer: devSessionSigner.publicKey,
        sessionToken: devSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    const devSignSig = await sendErTx(devSignIx, devSessionSigner);
    console.log("signPrivateTerms (dev) sig:", devSignSig);

    console.log("11.1) Revoke dev session token and verify PER access fails");
    const revokeTx = await sessionTokenManager.program.methods
      .revokeSession()
      .accounts({
        sessionToken: devSessionTokenPda,
        authority: dev.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .transaction();
    await provider.sendAndConfirm(revokeTx);
    let revokedError: unknown = null;
    try {
      const revokedIx = await erProgram.methods
        .updatePrivateMilestoneDetails(
          escrowId,
          1,
          textToHash("revoked-update")
        )
        .accounts({
          user: dev.publicKey,
          payer: devSessionSigner.publicKey,
          sessionToken: devSessionTokenPda,
          escrow: escrowPda,
          privateMilestone: privateMilestone1Pda,
        })
        .instruction();
      await sendErTx(revokedIx, devSessionSigner);
    } catch (error) {
      revokedError = error;
    }
    assert.ok(revokedError, "PER update should fail after session revoke");

    if (termsReady && milestone0Ready && milestone1Ready) {
      const unauthorizedTerms = await erConnection.getAccountInfo(termsPda);
      const unauthorizedMilestone0 = await erConnection.getAccountInfo(
        privateMilestone0Pda
      );
      const unauthorizedMilestone1 = await erConnection.getAccountInfo(
        privateMilestone1Pda
      );
      assert.ok(
        !unauthorizedTerms,
        "Unauthorized PER read for terms should be blocked when permission active"
      );
      assert.ok(
        !unauthorizedMilestone0,
        "Unauthorized PER read for milestone 0 should be blocked when permission active"
      );
      assert.ok(
        !unauthorizedMilestone1,
        "Unauthorized PER read for milestone 1 should be blocked when permission active"
      );
    } else {
      console.warn("Permission inactive; skipping unauthorized PER read assertion.");
    }

    const commitTermsIx = await erProgram.methods
      .commitTerms(escrowId)
      .accounts({
        user: client.publicKey,
        payer: clientSessionSigner.publicKey,
        sessionToken: clientSessionTokenPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    const commitSig = await sendErTx(commitTermsIx, clientSessionSigner);
    console.log("commitTerms sig:", commitSig);

    const undelegateEscrowIx = await erProgram.methods
      .undelegateEscrow()
      .accounts({
        payer: clientSessionSigner.publicKey,
        escrow: escrowPda,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT_ID,
      })
      .instruction();
    const undelegateEscrowSig = await sendErTx(
      undelegateEscrowIx,
      clientSessionSigner
    );
    console.log("undelegate escrow sig:", undelegateEscrowSig);
    const escrowRestored = await waitForOwner(
      connection,
      escrowPda,
      program.programId
    );
    if (!escrowRestored) {
      console.warn("escrow owner still delegated after undelegate; retrying later");
    }

    console.log("12) Fund escrow");
    const treasuryBeforeFund = await getTokenAmount(connection, feeReceiverToken);
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
    const treasuryAfterFund = await getTokenAmount(connection, feeReceiverToken);
    console.log(
      "treasury delta after fund:",
      `${formatUsdcAmount(treasuryAfterFund - treasuryBeforeFund)} TUSDC`
    );

    console.log("13) Wait 3 seconds");
    await sleep(3000);

    console.log("14) Dev submits milestone 1");
    const submit0Sig = await program.methods
      .submitMilestone(escrowId, 0)
      .accounts({
        contractor: dev.publicKey,
        escrow: escrowPda,
        milestone: milestone0Pda,
      })
      .signers([dev])
      .rpc();
    console.log("submitMilestone 0 sig:", submit0Sig);

    console.log("15) Client approves milestone 1");
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

    console.log("16) Dev submits milestone 2");
    const submit1Sig = await program.methods
      .submitMilestone(escrowId, 1)
      .accounts({
        contractor: dev.publicKey,
        escrow: escrowPda,
        milestone: milestone1Pda,
      })
      .signers([dev])
      .rpc();
    console.log("submitMilestone 1 sig:", submit1Sig);

    console.log("17) Client approves milestone 2");
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

    console.log("18) Dev claims funds");
    const claimSig = await program.methods
      .claimFunds(escrowId)
      .accounts({
        contractor: dev.publicKey,
        escrow: escrowPda,
        contractorToken: devToken,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([dev])
      .rpc();
    console.log("claimFunds sig:", claimSig);

    console.log("19) Transfer confirmation");
    console.log("claimFunds tx:", claimSig);

    console.log("----BALANCES AFTER----");
    const clientUsdcAfter = await getTokenAmount(connection, clientToken);
    const devUsdcAfter = await getTokenAmount(connection, devToken);
    console.log(
      `client USDC: ${formatUsdcAmount(clientUsdcAfter)} TUSDC (${formatDelta(clientUsdcAfter - clientUsdcBefore)} TUSDC)`
    );
    console.log(
      `dev USDC: ${formatUsdcAmount(devUsdcAfter)} TUSDC (${formatDelta(devUsdcAfter - devUsdcBefore)} TUSDC)`
    );
    console.log(
      "client SOL:",
      `${formatLamports(await connection.getBalance(client.publicKey))} SOL`
    );
    console.log(
      "dev SOL:",
      `${formatLamports(await connection.getBalance(dev.publicKey))} SOL`
    );
    const treasuryAfter = await getTokenAmount(connection, feeReceiverToken);
    const treasuryDelta =
      treasuryAfter >= treasuryBefore
        ? treasuryAfter - treasuryBefore
        : 0n;
    console.log(
      "Treasury balance:",
      `${formatUsdcAmount(treasuryAfter)} TUSDC (+${formatUsdcAmount(treasuryDelta)} TUSDC)`
    );
    console.log(
      "vault USDC:",
      `${formatUsdcAmount(await getTokenAmount(connection, vaultToken))} TUSDC`
    );
    console.log(
      "fee charged:",
      `${formatUsdcAmount(BigInt(feeAmount.toString()))} TUSDC`
    );
    if (treasuryDelta !== BigInt(feeAmount.toString())) {
      console.warn(
        "Treasury delta does not match fee charged:",
        `${formatUsdcAmount(treasuryDelta)} vs ${formatUsdcAmount(BigInt(feeAmount.toString()))} TUSDC`
      );
    }
    console.log("---------------------");
  });
});
