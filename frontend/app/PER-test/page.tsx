'use client';

import { useCallback, useEffect, useState } from 'react';
import { Connection } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

type BackendConfig = {
  ok?: boolean;
  network?: string;
  rpcUrl?: string;
  wsUrl?: string;
  programId?: string;
  ephemeralProviderUrl?: string | null;
  ephemeralWsUrl?: string | null;
  ephemeralPermissionEndpoint?: string | null;
  ephemeralTeeEndpoint?: string | null;
  ephemeralTeeWsEndpoint?: string | null;
};

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/$/, '');
const deriveWsEndpoint = (endpoint: string) =>
  endpoint.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');

const waitForWsSlot = (connection: Connection, timeoutMs = 6000) =>
  new Promise<number>((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error('WS timeout'));
    }, timeoutMs);
    const subId = connection.onSlotChange((slotInfo) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(slotInfo.slot);
    });
  });

export default function PerTestPage() {
  const { publicKey, signMessage } = useWallet();
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [erEndpoint, setErEndpoint] = useState('');
  const [erWsEndpoint, setErWsEndpoint] = useState('');
  const [teeEndpoint, setTeeEndpoint] = useState('');
  const [teeWsEndpoint, setTeeWsEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const pushLog = useCallback((message: string) => {
    setLogs((current) => [`${new Date().toLocaleTimeString()} ${message}`, ...current]);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadConfig = async () => {
      try {
        const response = await fetch(`${API_URL}/v1/config`);
        if (!response.ok) throw new Error('Failed to load backend config');
        const data = (await response.json()) as BackendConfig;
        if (!mounted) return;
        setConfig(data);
        setErEndpoint(data.ephemeralProviderUrl || '');
        setErWsEndpoint(data.ephemeralWsUrl || '');
        setTeeEndpoint(data.ephemeralTeeEndpoint || data.ephemeralPermissionEndpoint || '');
        setTeeWsEndpoint(data.ephemeralTeeWsEndpoint || '');
      } catch (error: any) {
        if (!mounted) return;
        pushLog(`Config load failed: ${error?.message || String(error)}`);
      }
    };
    loadConfig();
    return () => {
      mounted = false;
    };
  }, [pushLog]);

  const handleCheckEr = useCallback(async () => {
    const endpoint = normalizeEndpoint(
      erEndpoint || config?.ephemeralProviderUrl || ''
    );
    if (!endpoint) {
      pushLog('ER endpoint missing.');
      return;
    }
    const wsEndpoint = normalizeEndpoint(
      erWsEndpoint || config?.ephemeralWsUrl || deriveWsEndpoint(endpoint)
    );
    setBusy(true);
    try {
      pushLog(`ER RPC: ${endpoint}`);
      const connection = new Connection(endpoint, {
        commitment: 'confirmed',
        wsEndpoint,
      });
      const version = await connection.getVersion();
      pushLog(`ER getVersion ok: ${JSON.stringify(version)}`);
      const slot = await waitForWsSlot(connection);
      pushLog(`ER WS ok: slot ${slot}`);
      pushLog('ER check SUCCESS');
    } catch (error: any) {
      pushLog(`ER check failed: ${error?.message || String(error)}`);
      pushLog('ER check FAILED');
    } finally {
      setBusy(false);
    }
  }, [config?.ephemeralProviderUrl, config?.ephemeralWsUrl, erEndpoint, erWsEndpoint, pushLog]);

  const handleCheckTee = useCallback(async () => {
    if (!publicKey || !signMessage) {
      pushLog('Wallet missing signMessage or publicKey.');
      return;
    }
    const base = normalizeEndpoint(
      teeEndpoint ||
        config?.ephemeralTeeEndpoint ||
        config?.ephemeralPermissionEndpoint ||
        'https://tee.magicblock.app'
    );
    setBusy(true);
    try {
      pushLog(`TEE base: ${base}`);
      const auth = await getAuthToken(base, publicKey, (message) => signMessage(message));
      if (!auth?.token) {
        pushLog('TEE auth failed: no token.');
        return;
      }
      const useProxy = API_URL.startsWith('http');
      const rpcEndpoint = useProxy
        ? `${API_URL}/v1/tee-proxy?token=${auth.token}`
        : `${base}?token=${auth.token}`;
      let wsEndpoint =
        teeWsEndpoint ||
        config?.ephemeralTeeWsEndpoint ||
        deriveWsEndpoint(base);
      if (!wsEndpoint.includes('token=')) {
        wsEndpoint += wsEndpoint.includes('?') ? `&token=${auth.token}` : `?token=${auth.token}`;
      }
      pushLog(`TEE RPC: ${rpcEndpoint}`);
      const connection = new Connection(rpcEndpoint, {
        commitment: 'confirmed',
        wsEndpoint,
      });
      const version = await connection.getVersion();
      pushLog(`TEE getVersion ok: ${JSON.stringify(version)}`);
      const slot = await waitForWsSlot(connection);
      pushLog(`TEE WS ok: slot ${slot}`);
      pushLog('TEE check SUCCESS');
    } catch (error: any) {
      pushLog(`TEE check failed: ${error?.message || String(error)}`);
      pushLog('TEE check FAILED');
    } finally {
      setBusy(false);
    }
  }, [
    config?.ephemeralPermissionEndpoint,
    config?.ephemeralTeeEndpoint,
    config?.ephemeralTeeWsEndpoint,
    publicKey,
    pushLog,
    signMessage,
    teeEndpoint,
    teeWsEndpoint,
  ]);

  return (
    <div className="min-h-screen bg-[#0b0b12] text-white">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">PER / TEE Test</h1>
            <p className="text-sm text-gray-400">
              Quick sanity checks for MagicBlock PER endpoints and TEE auth on devnet.
            </p>
          </div>
          <WalletMultiButton />
        </div>

        <div className="mt-8 grid gap-6">
          <div className="rounded-xl border border-white/10 bg-white/5 p-5">
            <h2 className="text-lg font-semibold">Endpoints</h2>
            <p className="text-xs text-gray-400 mt-1">
              Backend network: {config?.network ? config.network.toUpperCase() : 'unknown'}
            </p>

            <div className="mt-4 grid gap-4">
              <div>
                <label className="text-xs text-gray-400">ER RPC (HTTPS)</label>
                <input
                  value={erEndpoint}
                  onChange={(event) => setErEndpoint(event.target.value)}
                  placeholder="https://devnet.magicblock.app"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400">ER WS (WSS)</label>
                <input
                  value={erWsEndpoint}
                  onChange={(event) => setErWsEndpoint(event.target.value)}
                  placeholder="wss://devnet-router.magicblock.app"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400">TEE Base (HTTPS)</label>
                <input
                  value={teeEndpoint}
                  onChange={(event) => setTeeEndpoint(event.target.value)}
                  placeholder="https://tee.magicblock.app"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400">TEE WS (WSS)</label>
                <input
                  value={teeWsEndpoint}
                  onChange={(event) => setTeeWsEndpoint(event.target.value)}
                  placeholder="wss://tee.magicblock.app"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={handleCheckEr}
                disabled={busy}
                className="rounded-full bg-indigo-500/80 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Check ER RPC + WS
              </button>
              <button
                onClick={handleCheckTee}
                disabled={busy}
                className="rounded-full bg-emerald-500/80 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Check TEE Auth + WS
              </button>
              <button
                onClick={() => setLogs([])}
                className="rounded-full border border-white/10 px-4 py-2 text-sm text-gray-200 hover:border-white/30"
              >
                Clear Logs
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/40 p-5">
            <h2 className="text-lg font-semibold">Logs</h2>
            {logs.length === 0 ? (
              <p className="mt-3 text-sm text-gray-500">No logs yet.</p>
            ) : (
              <div className="mt-3 max-h-96 space-y-2 overflow-auto text-xs text-gray-300">
                {logs.map((entry, index) => (
                  <div key={`${entry}-${index}`} className="rounded-md bg-white/5 px-3 py-2">
                    {entry}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
