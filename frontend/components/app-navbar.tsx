'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import Image from 'next/image';
import Link from 'next/link';

type NavKey = 'Dashboard' | 'Invites' | 'Profile' | 'Faucet';

type UserProfile = {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
};

type AppNavbarProps = {
  active?: NavKey;
  profileHref: string;
  userProfile: UserProfile | null;
  publicKey?: string | null;
  showUserMenu: boolean;
  onToggleUserMenu: () => void;
  onCopyAddress: (address?: string) => void;
  onGoProfileSettings: () => void;
  onLogout: () => void;
};

type BackendConfig = {
  network?: string;
  rpcUrl?: string;
  wsUrl?: string;
  usdcMint?: string;
};

const isLocalnetConfig = (config: BackendConfig | null) => {
  if (!config) return false;
  const network = (config.network || '').toLowerCase();
  if (network === 'localnet') return true;
  const rpc = config.rpcUrl || '';
  return rpc.includes('localhost') || rpc.includes('127.0.0.1');
};

export default function AppNavbar({
  active,
  profileHref,
  userProfile,
  publicKey,
  showUserMenu,
  onToggleUserMenu,
  onCopyAddress,
  onGoProfileSettings,
  onLogout,
}: AppNavbarProps) {
  const [backendConfig, setBackendConfig] = useState<BackendConfig | null>(null);
  const [balances, setBalances] = useState<{ sol: string; usdc: string }>({
    sol: '--',
    usdc: '--',
  });

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333';
        const response = await fetch(`${base}/v1/config`);
        if (!response.ok) return;
        const data = (await response.json()) as BackendConfig;
        setBackendConfig(data);
      } catch {
        // Ignore config fetch failures; navbar will simply hide localnet-only items.
      }
    };
    loadConfig();
  }, []);

  const showVerificator = useMemo(
    () => isLocalnetConfig(backendConfig),
    [backendConfig],
  );

  useEffect(() => {
    const fetchBalances = async () => {
      if (!publicKey || !backendConfig?.rpcUrl) return;
      let owner: PublicKey;
      try {
        owner = new PublicKey(publicKey);
      } catch {
        return;
      }
      try {
        const connection = new Connection(backendConfig.rpcUrl, {
          commitment: 'confirmed',
          wsEndpoint: backendConfig.wsUrl || undefined,
        });
        const lamports = await connection.getBalance(owner);
        const sol = (lamports / 1_000_000_000).toFixed(4);

        let usdc = '--';
        if (backendConfig.usdcMint) {
          try {
            const mintKey = new PublicKey(backendConfig.usdcMint);
            const mintInfo = await connection.getAccountInfo(mintKey);
            if (mintInfo) {
              const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
                mint: mintKey,
              });
              const total = tokenAccounts.value.reduce((sum, account) => {
                const amount = account.account.data.parsed.info.tokenAmount?.uiAmount || 0;
                return sum + amount;
              }, 0);
              usdc = total.toFixed(2);
            }
          } catch {
            usdc = '--';
          }
        }

        setBalances({ sol, usdc });
      } catch {
        // Keep previous balance values if fetch fails.
      }
    };

    fetchBalances();
  }, [backendConfig?.rpcUrl, backendConfig?.wsUrl, backendConfig?.usdcMint, publicKey]);

  const navItems = [
    { label: 'Dashboard', href: '/dashboard' },
    { label: 'Invites', href: '/invites' },
    { label: 'Profile', href: profileHref },
    { label: 'Faucet', href: '/faucet' },
  ] as const;

  return (
    <header className="fixed top-0 w-full z-50 navbar-glass">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/dashboard" className="group flex items-center gap-2">
          <Image
            src="/nebulonLogo.svg"
            alt="Nebulon"
            width={140}
            height={28}
            className="h-6 w-auto opacity-90 group-hover:opacity-100 transition-opacity duration-300"
            priority
          />
        </Link>

        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-gray-400">
          {navItems.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className={`hover:text-white transition-colors relative group ${active === item.label ? 'text-white' : ''}`}
            >
              {item.label}
              <span
                className={`absolute -bottom-1 left-0 w-0 h-px bg-brand-500 transition-all group-hover:w-full ${
                  active === item.label ? 'w-full' : ''
                }`}
              />
            </Link>
          ))}
          {showVerificator && (
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new Event('nebulon:open-tx-verifier'));
              }}
              className="hover:text-white transition-colors relative group"
            >
              Verificator
              <span className="absolute -bottom-1 left-0 w-0 h-px bg-brand-500 transition-all group-hover:w-full" />
            </button>
          )}
        </nav>

        <div className="flex items-center gap-4">
          <div className="relative user-menu-container">
            <button
              onClick={onToggleUserMenu}
              className="flex items-center gap-2 p-2 rounded-lg hover:bg-white/5 transition-colors group"
            >
              <div className="relative w-8 h-8 rounded-full overflow-hidden border border-white/10 bg-dark-800">
                <Image
                  src={userProfile?.pfp ? `/pfps/${userProfile.pfp}` : '/placeholder-user.jpg'}
                  alt={userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'User'}
                  fill
                  className="object-cover"
                />
              </div>
              <div className="hidden md:block text-left">
                <p className="text-sm font-medium text-white leading-none">
                  {userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'Loading...'}
                </p>
                <button
                  type="button"
                  onClick={() => onCopyAddress(publicKey || undefined)}
                  className="text-xs text-gray-400 leading-none hover:text-[#6e56cf] transition-colors cursor-pointer"
                  title="Copy wallet address"
                >
                  {publicKey ? `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}` : ''}
                </button>
              </div>
              <iconify-icon
                icon="solar:alt-arrow-down-linear"
                className={`text-gray-400 text-sm transition-transform ${showUserMenu ? 'rotate-180' : ''}`}
                width="12"
              />
            </button>

            {showUserMenu && (
              <div className="absolute right-0 top-full mt-2 w-72 glass-panel border border-white/10 rounded-xl shadow-xl z-50 backdrop-blur-xl bg-dark-900/70">
                <div className="p-4 border-b border-white/5">
                  <div className="flex items-center gap-3">
                    <div className="relative w-10 h-10 rounded-full overflow-hidden border border-white/10 bg-dark-800">
                      <Image
                        src={userProfile?.pfp ? `/pfps/${userProfile.pfp}` : '/placeholder-user.jpg'}
                        alt={userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'User'}
                        fill
                        className="object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'Unknown'}
                      </p>
                      <button
                        type="button"
                        onClick={() => onCopyAddress(publicKey || undefined)}
                        className="text-xs text-gray-400 truncate hover:text-[#6e56cf] transition-colors text-left cursor-pointer"
                        title="Copy wallet address"
                      >
                        {publicKey ? `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}` : ''}
                      </button>
                      <p className="text-xs text-brand-400 capitalize mt-1">
                        {userProfile?.role || 'User'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="px-4 pt-3 pb-2">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-white/10 bg-dark-800/60 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">SOL</p>
                      <p className="text-sm font-semibold text-white">{balances.sol}</p>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-dark-800/60 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500">T-USDC</p>
                      <p className="text-sm font-semibold text-white">{balances.usdc}</p>
                    </div>
                  </div>
                </div>

                <div className="p-2">
                  <button
                    onClick={onGoProfileSettings}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-gray-300 hover:text-white hover:bg-white/5 rounded-lg transition-colors"
                  >
                    <iconify-icon icon="solar:settings-linear" width="16" />
                    Profile Settings
                  </button>

                  <div className="border-t border-white/5 my-1"></div>

                  <button
                    onClick={onLogout}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors"
                  >
                    <iconify-icon icon="solar:logout-2-linear" width="16" />
                    Logout
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
