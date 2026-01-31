'use client';

import React, { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import AppNavbar from '@/components/app-navbar';

interface ViewerProfile {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
}

interface PublicProfile {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
}

interface PublicStats {
  activeContracts: number;
  completedContracts: number;
  ratingAverage: number;
  ratingCount: number;
}

export default function PublicProfileHandlePage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const params = useParams<{ handle: string }>();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewerProfile, setViewerProfile] = useState<ViewerProfile | null>(null);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [stats, setStats] = useState<PublicStats>({
    activeContracts: 0,
    completedContracts: 0,
    ratingAverage: 0,
    ratingCount: 0,
  });
  const [notFound, setNotFound] = useState(false);
  const profileHref = viewerProfile?.nebulonId ? `/profile/${viewerProfile.nebulonId}` : '/profile';

  const handleParam = Array.isArray(params.handle) ? params.handle[0] : params.handle;

  useEffect(() => {
    if (!connected || !publicKey) {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
      }
      return;
    }

    fetchViewerProfile();
    fetchPublicProfile();
  }, [connected, publicKey, router, handleParam]);

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

  const fetchViewerProfile = async () => {
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
        setViewerProfile({
          nebulonId: profileData.nebulonId || 'Unknown',
          wallet: profileData.wallet,
          role: profileData.role || 'user',
          pfp: profileData.pfp || undefined,
        });
      } else if (response.status === 401) {
        router.push('/login');
      }
    } catch (error) {
      console.error('Error fetching viewer profile:', error);
    }
  };

  const fetchPublicProfile = async () => {
    if (!handleParam) {
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/auth/profile/handle/${encodeURIComponent(handleParam)}`
      );

      if (response.ok) {
        const data = await response.json();
        setProfile({
          nebulonId: data.profile.nebulonId || 'Unknown',
          wallet: data.profile.wallet,
          role: data.profile.role || 'user',
          pfp: data.profile.pfp || undefined,
        });
        setStats({
          activeContracts: data.stats?.activeContracts ?? 0,
          completedContracts: data.stats?.completedContracts ?? 0,
          ratingAverage: data.stats?.ratingAverage ?? 0,
          ratingCount: data.stats?.ratingCount ?? 0,
        });
      } else if (response.status === 404) {
        setNotFound(true);
      }
    } catch (error) {
      console.error('Error fetching public profile:', error);
    } finally {
      setLoading(false);
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
        userProfile={viewerProfile}
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
            {notFound || !profile ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 bg-dark-800 rounded-full flex items-center justify-center mb-4 mx-auto">
                  <iconify-icon icon="solar:user-circle-linear" className="text-gray-500" width="32" />
                </div>
                <h1 className="text-2xl font-semibold text-white mb-2">Profile not found</h1>
                <p className="text-gray-400">We couldn’t find that Nebulon ID.</p>
              </div>
            ) : (
              <>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
                  <div className="flex items-center gap-5">
                    <div className="relative w-24 h-24 rounded-full overflow-hidden border border-white/10 bg-dark-800">
                      <Image
                        src={profile.pfp ? `/pfps/${profile.pfp}` : '/placeholder-user.jpg'}
                        alt={profile.nebulonId ? `@${profile.nebulonId}` : 'User'}
                        fill
                        className="object-cover"
                      />
                    </div>
                    <div>
                      <p className="text-sm text-gray-400 uppercase tracking-wide">Nebulon Profile</p>
                      <h1 className="text-3xl font-semibold text-white mt-1">
                        {profile.nebulonId ? `@${profile.nebulonId}` : 'Unknown'}
                      </h1>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-brand-500/20 text-brand-300 capitalize">
                          {profile.role || 'User'}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCopyAddress(profile.wallet)}
                          className="text-xs text-gray-400 hover:text-[#6e56cf] transition-colors cursor-pointer"
                        >
                          {profile.wallet ? `${profile.wallet.slice(0, 6)}...${profile.wallet.slice(-6)}` : ''}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
                  <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                    <p className="text-xs text-gray-400 uppercase tracking-wide">Stars</p>
                    <p className="text-2xl font-semibold text-white mt-2">
                      {stats.ratingCount > 0 ? stats.ratingAverage.toFixed(1) : '--'}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {stats.ratingCount > 0 ? `${stats.ratingCount} rating${stats.ratingCount === 1 ? '' : 's'}` : 'No ratings yet'}
                    </p>
                  </div>
                  <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                    <p className="text-xs text-gray-400 uppercase tracking-wide">Completed</p>
                    <p className="text-2xl font-semibold text-white mt-2">{stats.completedContracts}</p>
                  </div>
                  <div className="bg-dark-800/60 border border-white/5 rounded-xl p-4">
                    <p className="text-xs text-gray-400 uppercase tracking-wide">Wallet</p>
                    <p className="text-sm text-gray-200 mt-2">
                      {profile.wallet ? `${profile.wallet.slice(0, 10)}...${profile.wallet.slice(-10)}` : ''}
                    </p>
                  </div>
                </div>

                <div className="mt-8 border-t border-white/5 pt-6">
                  <p className="text-sm text-gray-400">Public profile details are read-only.</p>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
