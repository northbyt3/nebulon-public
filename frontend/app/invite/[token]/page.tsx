'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import AppNavbar from '@/components/app-navbar';
import { toast } from '@/hooks/use-toast';
import { ensureContractKeypair } from '@/lib/privacy-keys';

type InvitePreview = {
  inviteId: string;
  issuerHandle: string | null;
  inviteeRole: string;
  expiresAt: number | null;
  status: string;
};

export default function InviteTokenPage() {
  const router = useRouter();
  const { publicKey, connected, disconnect } = useWallet();
  const params = useParams();
  const token = typeof params?.token === 'string' ? params.token : '';
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [userProfile, setUserProfile] = useState<{
    nebulonId: string;
    wallet: string;
    role: string;
    pfp?: string;
  } | null>(null);
  const [showPrivacyKeyModal, setShowPrivacyKeyModal] = useState(false);
  const [privacyKeySecret, setPrivacyKeySecret] = useState('');
  const [privacyKeyContractId, setPrivacyKeyContractId] = useState('');
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);

  const apiBase = useMemo(
    () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333',
    []
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tokenValue = localStorage.getItem('authToken');
    setAuthToken(tokenValue);
    if (!tokenValue || !connected || !publicKey) {
      router.push('/login');
    }
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
    if (!connected || !publicKey) {
      return;
    }
    const fetchUserProfile = async () => {
      try {
        const tokenValue = localStorage.getItem('authToken');
        if (!tokenValue) return;
        const response = await fetch(`${apiBase}/v1/auth/me`, {
          headers: {
            'Authorization': `Bearer ${tokenValue}`,
          },
        });
        if (response.ok) {
          const profileData = await response.json();
          setUserProfile({
            nebulonId: profileData.nebulonId || 'Unknown',
            wallet: publicKey.toString(),
            role: profileData.role || 'user',
            pfp: profileData.pfp || undefined,
          });
        }
      } catch (profileError) {
        console.error('Error fetching user profile:', profileError);
      }
    };
    fetchUserProfile();
  }, [apiBase, connected, publicKey]);

  useEffect(() => {
    let cancelled = false;
    const fetchPreview = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`${apiBase}/v1/invites/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Unable to load invite');
        }
        const data = await response.json();
        if (!cancelled) {
          setPreview({
            inviteId: data.inviteId,
            issuerHandle: data.issuerHandle,
            inviteeRole: data.inviteeRole,
            expiresAt: data.expiresAt || null,
            status: data.status,
          });
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Unable to load invite');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    if (token) {
      fetchPreview();
    }
    return () => {
      cancelled = true;
    };
  }, [apiBase, token]);

  const roleLabel = preview?.inviteeRole === 'client' ? 'Client' : 'Contractor';
  const issuerLabel = preview?.issuerHandle ? `@${preview.issuerHandle}` : '@someone';
  const canAccept = Boolean(authToken) && preview?.status === 'pending' && !actionLoading;

  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  const handleLogout = async () => {
    try {
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');
      await disconnect();
      setShowUserMenu(false);
      router.push('/login');
    } catch (logoutError) {
      console.error('Error during logout:', logoutError);
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
    } catch (copyError) {
      console.error('Failed to copy address:', copyError);
    }
  };

  const handleAcceptInvite = async () => {
    if (!authToken) {
      router.push('/login');
      return;
    }

    setActionLoading(true);
    try {
      const response = await fetch(`${apiBase}/v1/invites/accept`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Unable to accept invite');
      }

      const data = await response.json();
      const contractId = data.contractId;
      toast({
        title: 'Invite accepted',
        description: 'Setting up privacy keys...',
        variant: 'success',
      });

      try {
        const { entry, created } = ensureContractKeypair(contractId);
        const keyResponse = await fetch(`${apiBase}/v1/contracts/${contractId}/keys`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ publicKey: entry.publicKey }),
        });
        if (!keyResponse.ok) {
          const errorData = await keyResponse.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to register privacy key');
        }

        const keysResponse = await fetch(`${apiBase}/v1/contracts/${contractId}/keys`, {
          headers: { 'Authorization': `Bearer ${authToken}` },
        });
        if (keysResponse.ok) {
          const keysData = await keysResponse.json();
          const count = Array.isArray(keysData.keys) ? keysData.keys.length : 0;
          toast({
            title: count > 1 ? 'Privacy key exchange complete' : 'Privacy key registered',
            description: count > 1
              ? 'You can now add encrypted milestones.'
              : 'Awaiting counterparty to register their key.',
            variant: count > 1 ? 'success' : 'warning',
          });
        }

        if (created) {
          setPrivacyKeySecret(entry.secretKey);
          setPrivacyKeyContractId(contractId);
          setShowPrivacyKeyModal(true);
          setPendingRedirect(contractId);
        } else {
          router.push(`/contracts/${contractId}`);
        }
      } catch (privacyError: any) {
        console.error('Privacy key setup failed:', privacyError);
        toast({
          title: 'Privacy key setup failed',
          description: privacyError?.message || 'Try again later.',
          variant: 'destructive',
        });
        router.push(`/contracts/${contractId}`);
      }
    } catch (err: any) {
      console.error('Error accepting invite:', err);
      toast({
        title: 'Failed to accept invite',
        description: err?.message || 'Unable to accept invite.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeny = () => {
    router.push('/dashboard');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <AppNavbar
          active="Invites"
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
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading invite...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="min-h-screen bg-dark-900">
        <AppNavbar
          active="Invites"
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
          <div className="max-w-xl mx-auto">
            <div className="glass-panel rounded-2xl border border-white/5 p-8 text-center">
              <div className="w-14 h-14 bg-red-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <iconify-icon icon="solar:danger-triangle-linear" className="text-red-400" width="28" />
              </div>
              <h1 className="text-2xl font-semibold text-white">Invite not found</h1>
              <p className="text-sm text-gray-400 mt-2">
                {error || 'This invite link is invalid or expired.'}
              </p>
              <div className="mt-6">
                <Link
                  href="/invite"
                  className="inline-flex items-center gap-2 rounded-full border border-white/10 px-5 py-2 text-sm text-gray-300 hover:text-white hover:border-white/30 transition-colors"
                >
                  Enter another invite code
                </Link>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const statusLabel = preview.status === 'pending'
    ? 'Pending'
    : preview.status === 'accepted'
      ? 'Accepted'
      : preview.status === 'expired'
        ? 'Expired'
        : preview.status === 'declined'
          ? 'Declined'
          : 'Unavailable';

  return (
    <div className="min-h-screen bg-dark-900">
      <AppNavbar
        active="Invites"
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
        <div className="max-w-2xl mx-auto">
          <div className="glass-panel rounded-2xl border border-white/5 p-8">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 bg-brand-500/20 rounded-full flex items-center justify-center mb-4">
                <iconify-icon icon="solar:mailbox-linear" className="text-brand-300" width="32" />
              </div>
              <h1 className="text-2xl font-semibold text-white">
                {issuerLabel} has invited you as {roleLabel}
              </h1>
              <p className="text-sm text-gray-400 mt-2">
                to this contract.
              </p>
              <div className="mt-4 flex items-center gap-3 text-xs text-gray-500">
                <span className="px-3 py-1 rounded-full bg-white/5 border border-white/10 uppercase tracking-wide">
                  {statusLabel}
                </span>
                {preview.expiresAt && (
                  <span>
                    Expires {new Date(preview.expiresAt * 1000).toLocaleString()}
                  </span>
                )}
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                onClick={handleAcceptInvite}
                disabled={!canAccept}
                className="rounded-xl bg-brand-500 hover:bg-brand-600 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 transition-colors"
              >
                {actionLoading ? 'Accepting...' : 'Accept'}
              </button>
              <button
                onClick={handleDeny}
                className="rounded-xl border border-white/10 text-gray-300 hover:text-white hover:border-white/30 text-sm font-semibold py-3 transition-colors"
              >
                Deny
              </button>
            </div>

            {preview.status !== 'pending' && (
              <div className="mt-6 text-center text-sm text-gray-500">
                This invite is no longer active.
              </div>
            )}
          </div>

          <div className="mt-6 text-center">
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-white transition-colors">
              Back to dashboard
            </Link>
          </div>
        </div>
      </main>

      {showPrivacyKeyModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-lg w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Privacy Key Created</h3>
            <p className="text-sm text-gray-400 mb-4">
              This private key enables encrypted milestones for this contract. Store it safely.
              You will not be able to view it again.
            </p>
            <div className="bg-dark-800 border border-white/10 rounded-lg p-3 text-xs text-gray-200 break-all font-mono">
              {privacyKeySecret}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Contract ID: {privacyKeyContractId}
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={async () => {
                  if (!privacyKeySecret) return;
                  try {
                    await navigator.clipboard.writeText(privacyKeySecret);
                    toast({
                      title: 'Copied',
                      description: 'Privacy key copied. Store it safely.',
                      variant: 'success',
                    });
                  } catch (copyError) {
                    console.error('Failed to copy privacy key:', copyError);
                    toast({
                      title: 'Copy failed',
                      description: 'Unable to copy the privacy key.',
                      variant: 'destructive',
                    });
                  }
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Copy key
              </button>
              <button
                onClick={() => {
                  setShowPrivacyKeyModal(false);
                  const redirectId = pendingRedirect;
                  setPendingRedirect(null);
                  setPrivacyKeySecret('');
                  if (redirectId) {
                    router.push(`/contracts/${redirectId}`);
                  }
                }}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                I saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
