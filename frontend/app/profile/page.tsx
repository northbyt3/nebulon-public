'use client';

import React, { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import AppNavbar from '@/components/app-navbar';

interface UserProfile {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
}

interface Contract {
  status: string;
}

export default function PublicProfilePage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [ratingAverage, setRatingAverage] = useState(0);
  const [ratingCount, setRatingCount] = useState(0);
  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  useEffect(() => {
    if (!connected || !publicKey) {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
      }
      return;
    }

    fetchProfile();
    fetchContracts();
  }, [connected, publicKey, router]);

  useEffect(() => {
    if (!userProfile?.nebulonId) {
      return;
    }
    fetchPublicStats(userProfile.nebulonId);
  }, [userProfile?.nebulonId]);

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

  const fetchProfile = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/auth/me`, {
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
      console.error('Error fetching profile:', error);
    }
  };

  const fetchContracts = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/contracts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setContracts(data.contracts || []);
      }
    } catch (error) {
      console.error('Error fetching contracts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchPublicStats = async (handle: string) => {
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/auth/profile/handle/${encodeURIComponent(handle)}`
      );
      if (response.ok) {
        const data = await response.json();
        setRatingAverage(data.stats?.ratingAverage ?? 0);
        setRatingCount(data.stats?.ratingCount ?? 0);
      }
    } catch (error) {
      console.error('Error fetching public stats:', error);
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

  const handleCopyAddress = async (address?: string) => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  const completedCount = contracts.filter((contract) => contract.status === 'completed').length;

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading profile...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-900">
      <AppNavbar
        active="Profile"
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
        <div className="max-w-5xl mx-auto">
          <div className="glass-panel rounded-2xl border border-white/5 p-8">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
              <div className="flex items-center gap-5">
                <div className="relative w-24 h-24 rounded-full overflow-hidden border border-white/10 bg-dark-800">
                  <Image
                    src={userProfile?.pfp ? `/pfps/${userProfile.pfp}` : '/placeholder-user.jpg'}
                    alt={userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'User'}
                    fill
                    className="object-cover"
                  />
                </div>
                <div>
                  <p className="text-sm text-gray-400 uppercase tracking-wide">Nebulon Profile</p>
                  <h1 className="text-3xl font-semibold text-white mt-1">
                    {userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'Unknown'}
                  </h1>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="px-2 py-1 rounded-full text-xs font-medium bg-brand-500/20 text-brand-300 capitalize">
                      {userProfile?.role || 'User'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyAddress(userProfile?.wallet)}
                      className="text-xs text-gray-400 hover:text-[#6e56cf] transition-colors cursor-pointer"
                    >
                      {userProfile?.wallet ? `${userProfile.wallet.slice(0, 6)}...${userProfile.wallet.slice(-6)}` : ''}
                    </button>
                  </div>
                </div>
              </div>

              <Link
                href="/profile/settings"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white transition-colors"
              >
                Edit Profile
              </Link>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
              <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Stars</p>
                <p className="text-2xl font-semibold text-white mt-2">
                  {ratingCount > 0 ? ratingAverage.toFixed(1) : '--'}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  {ratingCount > 0 ? `${ratingCount} rating${ratingCount === 1 ? '' : 's'}` : 'No ratings yet'}
                </p>
              </div>
              <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Completed</p>
                <p className="text-2xl font-semibold text-white mt-2">{completedCount}</p>
              </div>
              <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                <p className="text-xs text-gray-400 uppercase tracking-wide">Wallet</p>
                <p className="text-sm text-gray-200 mt-2">
                  {userProfile?.wallet ? `${userProfile.wallet.slice(0, 10)}...${userProfile.wallet.slice(-10)}` : ''}
                </p>
              </div>
            </div>

            <div className="mt-8 border-t border-white/5 pt-6">
              <p className="text-sm text-gray-400">Public profile details are read-only. Share your Nebulon ID to let others find you.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
