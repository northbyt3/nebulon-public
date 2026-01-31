'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import * as anchor from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  getAuthToken,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import idl from '@/lib/nebulon-idl.json';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

const TEE_PRESETS = [
  { key: 'config', label: 'From backend config', rpc: '', ws: '' },
  { key: 'tee', label: 'TEE (tee.magicblock.app)', rpc: 'https://tee.magicblock.app', ws: 'wss://tee.magicblock.app' },
  { key: 'devnet-router', label: 'Devnet router (devnet-router.magicblock.app)', rpc: 'https://devnet-router.magicblock.app', ws: 'wss://devnet-router.magicblock.app' },
  { key: 'devnet-as', label: 'Devnet AS (devnet-as.magicblock.app)', rpc: 'https://devnet-as.magicblock.app', ws: 'wss://devnet-as.magicblock.app' },
];

const textToHash = (text: string) => {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(text);
  bytes.set(encoded.slice(0, 32));
  return Array.from(bytes);
};

const buildTermsHash = (deadline: string, payment: string) => {
  const payload = `deadline:${deadline ?? ''}|payment:${payment ?? ''}`;
  return textToHash(payload);
};

const parseDeadline = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Deadline required.');
  }
  const relativeMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (relativeMatch) {
    const qty = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const seconds =
      unit === 'd'
        ? qty * 86400
        : unit === 'h'
          ? qty * 3600
          : unit === 'm'
            ? qty * 60
            : qty;
    return new BN(seconds).neg();
  }
  if (/^\d+$/.test(trimmed)) {
    return new BN(Number(trimmed));
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    return new BN(Math.floor(parsed.getTime() / 1000));
  }
  throw new Error('Invalid deadline format.');
};

const parseUsdc = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/usdc/g, '')
    .replace(/\s+/g, '')
    .replace(/[$,_]/g, '')
    .replace(/,/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error('Invalid amount.');
  }
  const [whole, frac = ''] = cleaned.split('.');
  if (frac.length > 6) {
    throw new Error('Amount supports up to 6 decimals.');
  }
  const normalized = frac.padEnd(6, '0');
  return new BN(whole).mul(new BN(1_000_000)).add(new BN(normalized || '0'));
};

const derivePda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

const ensureWsReady = async (
  connection: anchor.web3.Connection,
  pushLog: (message: string) => void,
  timeoutMs = 8000
) => {
  return new Promise<number>((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('TEE WS health check timed out.'));
    }, timeoutMs);
    const subId = connection.onSlotChange((slotInfo) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      pushLog(`TEE WS health check: slot ${slotInfo.slot}`);
      resolve(subId);
    });
  });
};

const getAnchorWallet = (wallet: ReturnType<typeof useWallet>) => {
  if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
    return null;
  }
  return {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction,
    signAllTransactions: wallet.signAllTransactions,
  } as anchor.Wallet;
};

export default function DebugTestPage() {
  const wallet = useWallet();
  const anchorWallet = useMemo(() => getAnchorWallet(wallet), [wallet]);
  const [mounted, setMounted] = useState(false);
  const [contractId, setContractId] = useState('');
  const [deadlineInput, setDeadlineInput] = useState('7d');
  const [paymentInput, setPaymentInput] = useState('20');
  const [encryptedTerms, setEncryptedTerms] = useState('');
  const [skipPrep, setSkipPrep] = useState(false);
  const [teePresetKey, setTeePresetKey] = useState('config');
  const [teeBaseInput, setTeeBaseInput] = useState('');
  const [teeWsInput, setTeeWsInput] = useState('');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const pushLog = useCallback((message: string) => {
    setLog((prev) => [...prev, message]);
  }, []);

  const runDebug = useCallback(async () => {
    if (!wallet.publicKey || !anchorWallet) {
      pushLog('Connect a wallet first.');
      return;
    }
    if (!wallet.signMessage) {
      pushLog('Wallet does not support signMessage (required for TEE auth).');
      return;
    }
    if (!contractId.trim()) {
      pushLog('Enter a contract ID.');
      return;
    }

    setRunning(true);
    setLog([]);
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        throw new Error('Missing auth token. Login in the app first.');
      }

      pushLog('Fetching backend config...');
      const configRes = await fetch(`${API_URL}/v1/config`);
      const config = await configRes.json();
      pushLog(`Config programId: ${config?.programId}`);
      if (!config?.programId) {
        throw new Error('Missing programId from backend config.');
      }
      const programId = new PublicKey(config.programId);
      const rpcUrl = config.rpcUrl;
      const teeBase = (config.ephemeralTeeEndpoint || config.ephemeralPermissionEndpoint || 'https://tee.magicblock.app').replace(/\/$/, '');
      const teeWsBase = (config.ephemeralTeeWsEndpoint || 'wss://tee.magicblock.app').replace(/\/$/, '');
      const preset = TEE_PRESETS.find((entry) => entry.key === teePresetKey) || TEE_PRESETS[0];
      const resolvedBase = (preset.key === 'config' ? teeBase : preset.rpc).replace(/\/$/, '');
      const resolvedWs = (preset.key === 'config' ? teeWsBase : preset.ws).replace(/\/$/, '');
      if (!teeBaseInput || teePresetKey === 'config') {
        setTeeBaseInput(resolvedBase);
      }
      if (!teeWsInput || teePresetKey === 'config') {
        setTeeWsInput(resolvedWs);
      }
      const validator = config.ephemeralValidatorIdentity
        ? new PublicKey(config.ephemeralValidatorIdentity)
        : null;

      pushLog(`RPC: ${rpcUrl}`);
      pushLog(`TEE: ${teeBase}`);

      pushLog('Fetching contract...');
      const contractRes = await fetch(`${API_URL}/v1/contracts/${contractId.trim()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!contractRes.ok) {
        throw new Error(`Contract fetch failed (${contractRes.status})`);
      }
      const contractPayload = await contractRes.json();
      pushLog(`Contract payload keys: ${Object.keys(contractPayload || {}).join(', ')}`);
      const { contract } = contractPayload || {};
      if (!contract) {
        throw new Error('Missing contract in response payload.');
      }
      pushLog(`Contract escrow_pda: ${contract.escrow_pda}`);
      if (!contract.escrow_pda) {
        throw new Error('Contract has no escrow PDA.');
      }

      const escrowPda = new PublicKey(contract.escrow_pda);
      const connection = new anchor.web3.Connection(rpcUrl, 'confirmed');
      const provider = new anchor.AnchorProvider(connection, anchorWallet, {
        commitment: 'confirmed',
      });
      const idlData = JSON.parse(JSON.stringify(idl)) as any;
      const accountCount = Array.isArray(idlData?.accounts) ? idlData.accounts.length : 0;
      pushLog(`IDL accounts: ${accountCount}`);
      idlData.address = programId.toBase58();
      let program: anchor.Program;
      try {
        program = new anchor.Program(idlData as anchor.Idl, provider);
      } catch (err: any) {
        pushLog(`Program init error: ${err?.message || err}`);
        throw err;
      }

      pushLog(`Escrow PDA: ${escrowPda.toBase58()}`);
      if (!program?.account?.escrow?.fetch) {
        throw new Error('IDL missing escrow account definition.');
      }
      pushLog('Fetching escrow account...');
      let escrowAccount: any;
      try {
        escrowAccount = await program.account.escrow.fetch(escrowPda);
      } catch (err: any) {
        pushLog(`Escrow fetch error: ${err?.message || err}`);
        throw err;
      }
      const escrowId = new BN(escrowAccount.escrowId.toString());

      const termsPda = derivePda(
        [Buffer.from('terms'), escrowPda.toBuffer()],
        programId
      );
      const perVaultPda = derivePda(
        [Buffer.from('per-vault'), escrowPda.toBuffer()],
        programId
      );

      if (!skipPrep) {
        pushLog('Preparing terms stub + permissions...');
        try {
          await program.methods
            .initPrivateTermsStub(escrowId)
            .accounts({
              payer: wallet.publicKey,
              escrow: escrowPda,
              terms: termsPda,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .signers([])
            .rpc({ skipPreflight: true });
          pushLog('Terms stub initialized.');
        } catch (err) {
          pushLog('Terms stub exists (continuing).');
        }

        const members = [
          { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract.client_wallet) },
          { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract.contractor_wallet) },
        ];

        try {
          await program.methods
            .createPermission({ terms: { escrow: escrowPda } }, members)
            .accountsPartial({
              payer: wallet.publicKey,
              permissionedAccount: termsPda,
              permission: permissionPdaFromAccount(termsPda),
              permissionProgram: PERMISSION_PROGRAM_ID,
              systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc({ skipPreflight: true });
          pushLog('Permission created.');
        } catch {
          pushLog('Permission exists (continuing).');
        }

        if (validator) {
          const permIx = createDelegatePermissionInstruction({
            payer: wallet.publicKey,
            validator,
            permissionedAccount: [termsPda, false],
            authority: [wallet.publicKey, true],
          });
          const permissionMeta = permIx.keys.find((key) =>
            key.pubkey.equals(termsPda)
          );
          if (permissionMeta) {
            permissionMeta.isWritable = true;
          }
          const tx = new Transaction().add(permIx);
          await provider.sendAndConfirm(tx, []);
          pushLog('Permission delegated.');

          await program.methods
            .delegateAccount({ terms: { escrow: escrowPda } })
            .accounts({
              payer: wallet.publicKey,
              pda: termsPda,
            })
            .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
            .rpc({ skipPreflight: true });
          pushLog('Terms account delegated.');

          await program.methods
            .delegateAccount({ perVault: { escrow: escrowPda } })
            .accounts({
              payer: wallet.publicKey,
              pda: perVaultPda,
            })
            .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
            .rpc({ skipPreflight: true });
          pushLog('Per-vault delegated.');

          await program.methods
            .delegateEscrow(escrowId)
            .accounts({
              payer: wallet.publicKey,
              pda: escrowPda,
              client: new PublicKey(contract.client_wallet),
            })
            .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
            .rpc({ skipPreflight: true });
          pushLog('Escrow delegated.');
        } else {
          pushLog('No validator identity provided; skipping delegation.');
        }
      }

      const deadline = parseDeadline(deadlineInput);
      const payment = parseUsdc(paymentInput);
      const termsHash = buildTermsHash(deadline.toString(), payment.toString());
      const encryptedBytes = new TextEncoder().encode(encryptedTerms || '');

      pushLog('Requesting TEE token...');
      const teeBaseResolved = (teeBaseInput || teeBase).replace(/\/$/, '');
      const teeWsResolved = (teeWsInput || teeWsBase).replace(/\/$/, '');
      const auth = await getAuthToken(
        teeBaseResolved,
        wallet.publicKey,
        (message) => wallet.signMessage!(message)
      );
      const teeRpc = `${teeBaseResolved}?token=${auth.token}`;
      const teeWs = `${teeWsResolved}?token=${auth.token}`;
      pushLog(`TEE RPC: ${teeRpc}`);

      const teeConnection = new anchor.web3.Connection(teeRpc, {
        commitment: 'confirmed',
        wsEndpoint: teeWs,
      });
      const teeProvider = new anchor.AnchorProvider(teeConnection, anchorWallet, {
        commitment: 'confirmed',
      });
      const teeProgram = new anchor.Program(idlData as anchor.Idl, teeProvider);

      pushLog('Submitting createPrivateTerms...');
      let wsSubId: number | null = null;
      try {
        pushLog('TEE WS health check: subscribing for slot change...');
        wsSubId = await ensureWsReady(teeConnection, pushLog);
        pushLog('TEE WS health check: OK');
      } catch (err: any) {
        pushLog(`TEE WS health check failed: ${err?.message || err}`);
      }
      const sig = await teeProgram.methods
        .createPrivateTerms(
          escrowId,
          termsHash,
          payment,
          deadline,
          Array.from(encryptedBytes)
        )
        .accounts({
          user: wallet.publicKey,
          payer: wallet.publicKey,
          sessionToken: null,
          escrow: escrowPda,
          terms: termsPda,
          perVault: perVaultPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([])
        .rpc({ skipPreflight: true });
      pushLog(`Done. Tx: ${sig}`);
      if (wsSubId !== null) {
        await teeConnection.removeSlotChangeListener(wsSubId);
      }
    } catch (err: any) {
      pushLog(`Error: ${err?.message || err}`);
    } finally {
      setRunning(false);
    }
  }, [anchorWallet, contractId, deadlineInput, encryptedTerms, paymentInput, pushLog, skipPrep, wallet]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#0c1d2f,_#05070d_60%)] text-slate-100">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Nebulon Debug</p>
            <h1 className="text-3xl font-semibold">DEBUG-test - Submit Terms (TEE)</h1>
            <p className="mt-2 text-sm text-slate-400">
              Minimal front-end harness that mirrors the CLI term submission flow (TEE + PER).
            </p>
          </div>
          {mounted ? (
            <WalletMultiButton className="!bg-slate-900 !text-white" />
          ) : (
            <div className="h-10 w-40 rounded-lg border border-slate-800 bg-slate-900/60" />
          )}
        </div>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-6 shadow-[0_0_40px_rgba(0,0,0,0.35)]">
            <h2 className="text-lg font-semibold">Inputs</h2>
            <div className="mt-4 grid gap-4">
              <label className="text-sm text-slate-300">
                Contract ID
                <input
                  value={contractId}
                  onChange={(e) => setContractId(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                  placeholder="UUID from backend"
                />
              </label>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="text-sm text-slate-300">
                  Deadline (e.g. 7d)
                  <input
                    value={deadlineInput}
                    onChange={(e) => setDeadlineInput(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-sm text-slate-300">
                  Payment (USDC)
                  <input
                    value={paymentInput}
                    onChange={(e) => setPaymentInput(e.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="text-sm text-slate-300">
                Encrypted terms (optional)
                <textarea
                  value={encryptedTerms}
                  onChange={(e) => setEncryptedTerms(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Leave empty to send blank encrypted payload"
                />
              </label>
              <label className="text-sm text-slate-300">
                TEE endpoint preset
                <select
                  value={teePresetKey}
                  onChange={(e) => {
                    const nextKey = e.target.value;
                    setTeePresetKey(nextKey);
                    const preset = TEE_PRESETS.find((entry) => entry.key === nextKey);
                    if (preset) {
                      if (preset.key !== 'config') {
                        setTeeBaseInput(preset.rpc);
                        setTeeWsInput(preset.ws);
                      }
                    }
                  }}
                  className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm"
                >
                  {TEE_PRESETS.map((preset) => (
                    <option key={preset.key} value={preset.key}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={skipPrep}
                  onChange={(e) => setSkipPrep(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-900"
                />
                Skip L1 preparation (assume delegated already)
              </label>
            </div>
            <button
              onClick={runDebug}
              disabled={running}
              className="mt-6 w-full rounded-xl bg-emerald-500/80 px-4 py-3 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {running ? 'Running...' : 'Run TEE Term Submit'}
            </button>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-black/70 p-6">
            <h2 className="text-lg font-semibold">Session Log</h2>
            <div className="mt-4 max-h-[420px] overflow-auto rounded-lg border border-slate-800 bg-black/60 p-4 font-mono text-xs text-emerald-200">
              {log.length === 0 ? (
                <p className="text-slate-500">No logs yet.</p>
              ) : (
                log.map((line, idx) => <div key={idx}>{line}</div>)
              )}
            </div>
            <p className="mt-4 text-xs text-slate-500">
              This page uses TEE auth + PER transactions. If this fails while CLI fails, it confirms a backend TEE
              subscription issue.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
