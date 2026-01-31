'use client';

import React, { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { toast } from '@/hooks/use-toast';
import AppNavbar from '@/components/app-navbar';

interface UserProfile {
  nebulonId: string;
  wallet: string;
  role: string;
  pfp?: string;
}

interface ProfileCooldown {
  canChange: boolean;
  lastChangedAt: number | null;
  nextAvailableAt: number;
  nextAvailableAtPst?: string;
  cooldownSeconds: number;
  lockReasons?: string[];
  activeContractsCount?: number;
  pendingInvitesCount?: number;
}

const normalizeHandle = (handle: string) =>
  handle.trim().toLowerCase().replace(/^@/, '');

const validateHandleLocally = (handle: string) => {
  const value = normalizeHandle(handle);

  if (!value) {
    return { ok: false, reason: 'missing' as const };
  }

  if (value.length < 4 || value.length > 16) {
    return { ok: false, reason: 'length' as const };
  }

  const HANDLE_REGEX = /^[a-z0-9._-]+$/;
  if (!HANDLE_REGEX.test(value)) {
    return { ok: false, reason: 'characters' as const };
  }

  if (value.startsWith('.') || value.endsWith('.')) {
    return { ok: false, reason: 'dots' as const };
  }

  if (value.includes('..')) {
    return { ok: false, reason: 'dots' as const };
  }

  return { ok: true as const, value };
};

const formatPst = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

export default function ProfileSettingsPage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [nebulonId, setNebulonId] = useState('');
  const [selectedPfp, setSelectedPfp] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPfpModal, setShowPfpModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState(false);
  const [cooldown, setCooldown] = useState<ProfileCooldown | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [idValidation, setIdValidation] = useState<{ isValid: boolean; checked: boolean; reason?: string }>({
    isValid: true,
    checked: false,
  });
  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';
  const isTimeLocked = React.useMemo(() => {
    if (!cooldown?.lastChangedAt) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return nowSeconds < cooldown.lastChangedAt + cooldown.cooldownSeconds;
  }, [cooldown]);
  const hasActiveContracts = Boolean(cooldown && (cooldown.activeContractsCount || 0) > 0);
  const hasPendingInvites = Boolean(cooldown && (cooldown.pendingInvitesCount || 0) > 0);
  const isLocked = Boolean(
    cooldown &&
      (!cooldown.canChange || isTimeLocked || hasActiveContracts || hasPendingInvites)
  );
  const lockMessage = React.useMemo(() => {
    if (!cooldown || !isLocked) return null;
    if (isTimeLocked) {
      const unlockAt =
        cooldown.nextAvailableAtPst ||
        formatPst(cooldown.lastChangedAt + cooldown.cooldownSeconds);
      return `Profile changes are locked until: ${unlockAt}`;
    }
    return 'Profile changes are locked until active contracts and pending invites are cleared.';
  }, [cooldown, isLocked, isTimeLocked]);

  const projectedNextChange = React.useMemo(() => {
    if (!cooldown) {
      return null;
    }
    if (!cooldown.canChange && cooldown.nextAvailableAtPst) {
      return cooldown.nextAvailableAtPst;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    return formatPst(nowSeconds + cooldown.cooldownSeconds);
  }, [cooldown]);

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    fetchProfile();
    fetchCooldown();
  }, [router]);

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
        setNebulonId(profileData.nebulonId || '');
        setSelectedPfp(profileData.pfp || null);
      } else if (response.status === 401) {
        router.push('/login');
      }
    } catch (error) {
      console.error('Error fetching profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCooldown = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }
      const apiBase = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333').trim();
      const url = `${apiBase}/v1/auth/profile/cooldown`;
      console.log('🔒 Fetching profile cooldown from:', url);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: 'no-store',
      });
      if (response.ok) {
        const data = await response.json();
        console.log('🔒 Profile cooldown response:', data);
        setCooldown(data);
      } else {
        const errorText = await response.text();
        console.warn('🔒 Profile cooldown request failed:', response.status, response.url, errorText);
      }
    } catch (error) {
      console.error('Error fetching profile cooldown:', error);
    }
  };

  const handleCopyAddress = async (address?: string) => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toast({
        title: 'Copied',
        description: 'Wallet address copied to clipboard.',
        variant: 'success',
      });
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

  const handleNebulonIdChange = (value: string) => {
    setNebulonId(value);
  };

  const validateNebulonId = async (value: string) => {
    const trimmedId = value.trim();
    const currentHandle = normalizeHandle(userProfile?.nebulonId || '');
    const nextHandle = normalizeHandle(trimmedId);

    if (!trimmedId) {
      setIdValidation({ isValid: false, reason: 'missing', checked: true });
      return;
    }

    if (nextHandle === currentHandle) {
      setIdValidation({ isValid: true, checked: true, reason: 'unchanged' });
      return;
    }

    const localValidation = validateHandleLocally(trimmedId);
    if (!localValidation.ok) {
      setIdValidation({
        isValid: false,
        reason: localValidation.reason,
        checked: true,
      });
      return;
    }

    setCheckingId(true);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/ids/check?handle=${encodeURIComponent(trimmedId)}`
      );
      const { available, reason } = await response.json();
      setIdValidation({
        isValid: available,
        reason: available ? undefined : reason || 'taken',
        checked: true,
      });
    } catch (error) {
      console.error('Error checking ID availability:', error);
      setIdValidation({
        isValid: false,
        reason: 'error',
        checked: true,
      });
    } finally {
      setCheckingId(false);
    }
  };

  useEffect(() => {
    if (!userProfile) {
      return;
    }
    const currentHandle = normalizeHandle(userProfile.nebulonId || '');
    const nextHandle = normalizeHandle(nebulonId);
    if (!nextHandle || nextHandle === currentHandle) {
      setIdValidation({ isValid: true, checked: false, reason: 'unchanged' });
      return;
    }

    const timeout = window.setTimeout(() => {
      validateNebulonId(nebulonId);
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [nebulonId, userProfile]);

  const handleSaveProfile = async () => {
    if (!userProfile) return;

    const token = localStorage.getItem('authToken');
    if (!token) {
      router.push('/login');
      return;
    }

    const trimmedId = nebulonId.trim();
    if (!trimmedId) {
      toast({
        title: 'Missing Nebulon ID',
        description: 'Please enter a valid Nebulon ID.',
        variant: 'warning',
      });
      return;
    }

    const currentHandle = normalizeHandle(userProfile.nebulonId || '');
    const nextHandle = normalizeHandle(trimmedId);
    if (idValidation.reason === 'unchanged') {
      toast({
        title: 'No changes to save',
        description: 'Update your Nebulon ID before saving.',
        variant: 'warning',
      });
      return;
    }

    if (!idValidation.checked || !idValidation.isValid) {
      toast({
        title: 'Nebulon ID unavailable',
        description:
          nextHandle === currentHandle
            ? 'Your current Nebulon ID is already set.'
            : 'Please choose an available Nebulon ID.',
        variant: 'warning',
      });
      return;
    }

    try {
      setSaving(true);
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'}/v1/auth/handle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          nebulonId: trimmedId,
          pfp: selectedPfp || userProfile.pfp,
        }),
      });

      if (response.ok) {
        const responseData = await response.json();
        const updatedHandle = responseData.handle || trimmedId;
        setUserProfile((prev) =>
          prev
            ? {
                ...prev,
                nebulonId: updatedHandle,
                pfp: responseData.pfp || selectedPfp || prev.pfp,
              }
            : prev
        );
        localStorage.setItem('nebulonId', updatedHandle);
        toast({
          title: 'Profile updated',
          description: 'Your profile changes have been saved.',
          variant: 'success',
        });
        await fetchCooldown();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Update failed',
          description: errorData.error || 'Unable to update your profile.',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: 'Update failed',
        description: 'Unable to update your profile.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveClick = () => {
    setShowConfirmModal(true);
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
        <div className="max-w-4xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-semibold text-white mb-2">Profile Settings</h1>
            <p className="text-gray-400">Update your Nebulon ID and avatar.</p>
          </div>

          <div className="glass-panel rounded-2xl border border-white/5 p-6">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="relative w-20 h-20 rounded-full overflow-hidden border border-white/10 bg-dark-800">
                  <Image
                    src={selectedPfp ? `/pfps/${selectedPfp}` : '/placeholder-user.jpg'}
                    alt={userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'User'}
                    fill
                    className="object-cover"
                  />
                </div>
                <div>
                  <p className="text-sm text-gray-400">Nebulon ID</p>
                  <p className="text-xl font-semibold text-white">
                    {userProfile?.nebulonId ? `@${userProfile.nebulonId}` : 'Unknown'}
                  </p>
                  <button
                    onClick={() => setShowPfpModal(true)}
                    disabled={isLocked}
                    className={`text-xs transition-colors mt-2 ${
                      isLocked ? 'text-gray-600 cursor-not-allowed' : 'text-brand-400 hover:text-brand-300'
                    }`}
                  >
                    Change avatar
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-xs uppercase tracking-wide text-gray-500">Role</span>
                <span className="px-2 py-1 rounded-full text-xs font-medium bg-brand-500/20 text-brand-300 capitalize">
                  {userProfile?.role || 'user'}
                </span>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm text-gray-300">Nebulon ID</label>
                <div className="flex gap-2">
                  <input
                    value={nebulonId}
                    onChange={(e) => handleNebulonIdChange(e.target.value)}
                    onBlur={() => validateNebulonId(nebulonId)}
                    disabled={isLocked}
                    className={`flex-1 bg-dark-800 border rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 ${
                      isLocked ? 'border-white/5 text-gray-500 cursor-not-allowed' : 'border-white/10'
                    }`}
                    placeholder="Enter your Nebulon ID"
                  />
                </div>
                {idValidation.checked && !idValidation.isValid && (
                  <p className="text-xs text-red-400">
                    {idValidation.reason === 'missing' && 'Please enter a Nebulon ID.'}
                    {idValidation.reason === 'length' && 'ID must be 4-16 characters.'}
                    {idValidation.reason === 'characters' && 'Only letters, numbers, ., _, and - are allowed.'}
                    {idValidation.reason === 'dots' && 'Dots cannot be at the start/end or doubled.'}
                    {(idValidation.reason === 'taken' || idValidation.reason === 'reserved') &&
                      "This Nebulon ID isn't available."}
                    {idValidation.reason === 'error' && 'Unable to check availability.'}
                  </p>
                )}
                {checkingId && (
                  <p className="text-xs text-gray-400">Checking availability...</p>
                )}
                {idValidation.checked && idValidation.isValid && idValidation.reason !== 'unchanged' && !checkingId && (
                  <p className="text-xs text-emerald-400">Nebulon ID is available.</p>
                )}
                {idValidation.reason === 'unchanged' && (
                  <p className="text-xs text-gray-500">No changes detected.</p>
                )}
                {isLocked ? (
                  <p className="text-xs text-yellow-400">{lockMessage}</p>
                ) : (
                  <p className="text-xs text-gray-500">Profile changes are limited to once every 90 days.</p>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm text-gray-300">Wallet Address</label>
                <button
                  type="button"
                  onClick={() => handleCopyAddress(userProfile?.wallet)}
                  className="w-full flex items-center justify-between bg-dark-800 border border-white/10 rounded-lg px-4 py-2 text-sm text-gray-200 hover:text-[#6e56cf] hover:border-white/20 transition-colors cursor-pointer"
                  title="Click to copy wallet address"
                >
                  <span>{userProfile?.wallet ? `${userProfile.wallet.slice(0, 8)}...${userProfile.wallet.slice(-8)}` : 'Unknown'}</span>
                  <span className="text-xs text-gray-500">Click to copy</span>
                </button>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-end gap-3">
              <button
                onClick={handleSaveClick}
                disabled={
                  saving ||
                  checkingId ||
                  isLocked ||
                  !idValidation.checked ||
                  !idValidation.isValid ||
                  idValidation.reason === 'unchanged'
                }
                className="px-5 py-2 rounded-lg text-sm font-medium bg-brand-500 hover:bg-brand-600 text-white transition-colors disabled:opacity-60"
              >
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </main>

      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full animate-in zoom-in-95 duration-300">
            <div className="text-center mb-4">
              <h3 className="text-lg font-semibold text-white mb-2">Profile Change Warning</h3>
              <p className="text-sm text-gray-400">
                Profile changes are limited to once every 90 days.
              </p>
              {projectedNextChange && (
                <p className="text-xs text-yellow-400 mt-2">
                  Next change available: {projectedNextChange}
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                {cooldown && !cooldown.canChange ? 'Got it' : 'Cancel'}
              </button>
              {(!cooldown || cooldown.canChange) && (
                <button
                  onClick={() => {
                    setShowConfirmModal(false);
                    handleSaveProfile();
                  }}
                  className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Confirm Change
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showPfpModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-300">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full animate-in zoom-in-95 duration-300">
            <div className="text-center mb-6">
              <h3 className="text-lg font-semibold text-white mb-2">Choose Profile Picture</h3>
              <p className="text-sm text-gray-400">Select your avatar</p>
            </div>

            <div className="grid grid-cols-4 gap-4 mb-6">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((num) => (
                <button
                  key={num}
                  onClick={() => {
                    setSelectedPfp(`${num}.png`);
                    setShowPfpModal(false);
                  }}
                  className={`w-16 h-16 rounded-full overflow-hidden border-2 transition-all duration-200 ${
                    selectedPfp === `${num}.png`
                      ? 'border-brand-500 ring-2 ring-brand-500/30 scale-105'
                      : 'border-white/20 hover:border-white/40 hover:scale-105'
                  }`}
                >
                  <img
                    src={`/pfps/${num}.png`}
                    alt={`PFP ${num}`}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowPfpModal(false)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowPfpModal(false)}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


