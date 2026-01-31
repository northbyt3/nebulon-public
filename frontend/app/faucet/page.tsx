'use client';

import React, { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import AppNavbar from '@/components/app-navbar';
import { toast } from '@/hooks/use-toast';

interface UserProfile {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
}

interface FaucetStatus {
  enabled: boolean;
  network?: string;
  cooldownSeconds: number;
  lastRequestedAt: number | null;
  nextAvailableAt: number;
  nextAvailableAtPst?: string;
  canRequest: boolean;
  reason?: string | null;
}

const formatDuration = (seconds: number) => {
  if (seconds <= 0) return 'Ready';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
};

export default function FaucetPage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const reasonLabel = (reason?: string | null) => {
    if (!reason) return null;
    if (reason === 'wallet_rate_limited') return 'Wallet limit reached. Try again after the cooldown.';
    if (reason === 'ip_rate_limited') return 'IP limit reached. Try again after the cooldown.';
    if (reason === 'faucet_disabled') return 'Faucet is disabled on this network.';
    return reason;
  };

  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  useEffect(() => {
    if (!connected || !publicKey) {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
      }
      return;
    }

    fetchUserProfile();
    fetchStatus();
  }, [connected, publicKey, router]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('.user-menu-container')) {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showUserMenu]);

  useEffect(() => {
    if (!status) return;
    const interval = window.setInterval(() => {
      setStatus((prev) => {
        if (!prev) return prev;
        const now = Math.floor(Date.now() / 1000);
        const canRequest = now >= prev.nextAvailableAt;
        const reason = canRequest ? null : prev.reason;
        return { ...prev, canRequest, reason };
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  const fetchUserProfile = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const profileData = await response.json();
        setUserProfile({
          nebulonId: profileData.nebulonId || 'Unknown',
          wallet: profileData.wallet,
          role: profileData.role || 'user',
          pfp: profileData.pfp || undefined,
        });
      } else if (response.status === 401) {
        router.push('/login');
      }
    } catch (error) {
      console.error('Error fetching user profile:', error);
    }
  };

  const fetchStatus = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/faucet/status`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        setStatusMessage(reasonLabel(data.reason));
      }
    } catch (error) {
      console.error('Error fetching faucet status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyAddress = async (address?: string) => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  const handleLogout = async () => {
    try {
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');
      await disconnect();
      router.push('/login');
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  const handleRequest = async () => {
    try {
      setRequesting(true);
      setStatusMessage(null);
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/faucet/tusdc`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 429 && errorData.retryAt) {
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  canRequest: false,
                  nextAvailableAt: errorData.retryAt,
                  nextAvailableAtPst: errorData.retryAtPst || prev.nextAvailableAtPst,
                  reason: errorData.error || prev.reason,
                }
              : prev
          );
        }
        if (errorData?.error) {
          setStatusMessage(reasonLabel(errorData.error));
        }
        toast({
          title: 'Request failed',
          description: errorData.error || 'Unable to request T-USDC.',
          variant: 'destructive',
        });
        return;
      }
      const data = await response.json();
      toast({
        title: 'T-USDC requested',
        description: 'Faucet request sent. Balance will update shortly.',
        variant: 'success',
      });
      if (data?.nextAvailableAt) {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                canRequest: false,
                nextAvailableAt: data.nextAvailableAt,
                nextAvailableAtPst: data.nextAvailableAtPst || prev.nextAvailableAtPst,
                reason: 'wallet_rate_limited',
              }
            : prev
        );
        setStatusMessage(reasonLabel('wallet_rate_limited'));
      } else {
        await fetchStatus();
      }
    } catch (error) {
      console.error('Error requesting T-USDC:', error);
      toast({
        title: 'Request failed',
        description: 'Unable to request T-USDC.',
        variant: 'destructive',
      });
    } finally {
      setRequesting(false);
    }
  };

  const remainingSeconds = status
    ? Math.max(0, status.nextAvailableAt - Math.floor(Date.now() / 1000))
    : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading faucet...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-900">
      <AppNavbar
        active="Faucet"
        profileHref={profileHref}
        userProfile={userProfile}
        publicKey={publicKey?.toString() || null}
        showUserMenu={showUserMenu}
        onToggleUserMenu={() => setShowUserMenu(!showUserMenu)}
        onCopyAddress={handleCopyAddress}
        onGoProfileSettings={() => {
          setShowUserMenu(false);
          router.push('/profile/settings');
        }}
        onLogout={handleLogout}
      />

      <main className="pt-24 pb-12 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold text-white mb-2">T-Faucet</h1>
            <p className="text-gray-400">Request daily T-USDC for testing.</p>
          </div>

          <div className="glass-panel rounded-2xl border border-white/5 p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-400 uppercase tracking-wide">Next available in</p>
                <p className="text-2xl font-semibold text-white mt-1">
                  {status?.enabled === false ? 'Unavailable' : formatDuration(remainingSeconds)}
                </p>
                {status?.network && (
                  <p className="text-xs text-gray-500 mt-1">Network: {status.network.toUpperCase()}</p>
                )}
                {!status?.canRequest && status?.nextAvailableAtPst && (
                  <p className="text-xs text-gray-500 mt-1">Available at: {status.nextAvailableAtPst}</p>
                )}
                {!status?.canRequest && (statusMessage || status?.reason) && (
                  <p className="text-xs text-yellow-400 mt-1">{statusMessage || reasonLabel(status?.reason)}</p>
                )}
              </div>
              <button
                onClick={handleRequest}
                disabled={requesting || !status?.enabled || !status?.canRequest}
                className="inline-flex items-center gap-2 rounded-full border border-brand-500/40 bg-brand-500/15 px-5 py-2 text-sm font-semibold text-brand-200 hover:bg-brand-500/30 hover:border-brand-500/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <iconify-icon icon="solar:drop-linear" width="16" />
                {requesting ? 'Requesting...' : 'Request T-USDC'}
              </button>
            </div>

            <div className="p-4 rounded-xl bg-dark-800/60 border border-white/5 text-sm text-gray-400 space-y-2">
              <p className="font-semibold text-white">Test Token Notice</p>
              <p>
                T-USDC is a test token used for development and demos. It has no real monetary value and exists only for testing the Nebulon flow.
              </p>
              <p>
                The token is labeled USDC in the UI for familiarity, but it is strictly for test networks.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
