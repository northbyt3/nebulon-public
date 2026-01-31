'use client';

import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import AppNavbar from '@/components/app-navbar';
import { toast } from '@/hooks/use-toast';
import { ensureContractKeypair } from '@/lib/privacy-keys';

interface Invite {
  id: string;
  contract_id: string;
  issuer_wallet: string;
  issuer_handle: string;
  invitee_role: string;
  invitee_wallet: string;
  invitee_handle: string;
  status: string;
  created_at: number;
  accepted_at: number;
  expires_at: number;
}

export default function InvitesPage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPrivacyKeyModal, setShowPrivacyKeyModal] = useState(false);
  const [privacyKeySecret, setPrivacyKeySecret] = useState('');
  const [privacyKeyContractId, setPrivacyKeyContractId] = useState('');
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<{
    nebulonId: string;
    wallet: string;
    role: string;
    pfp?: string;
  } | null>(null);
  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  useEffect(() => {
    if (!connected || !publicKey) {
      router.push('/login');
      return;
    }

    fetchInvites();
  }, [connected, publicKey, router]);

  useEffect(() => {
    if (!connected || !publicKey) {
      return;
    }
    const fetchUserProfile = async () => {
      try {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/me`, {
          headers: {
            'Authorization': `Bearer ${token}`,
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
      } catch (error) {
        console.error('Error fetching user profile:', error);
      }
    };
    fetchUserProfile();
  }, [connected, publicKey]);

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

  const handleLogout = async () => {
    try {
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');
      await disconnect();
      setShowUserMenu(false);
      router.push('/login');
    } catch (error) {
      console.error('Error during logout:', error);
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

  const handleCopyPrivacyKey = async () => {
    if (!privacyKeySecret) return;
    try {
      await navigator.clipboard.writeText(privacyKeySecret);
      toast({
        title: 'Copied',
        description: 'Privacy key copied. Store it safely.',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to copy privacy key:', error);
      toast({
        title: 'Copy failed',
        description: 'Unable to copy the privacy key.',
        variant: 'destructive',
      });
    }
  };

  const fetchInvites = async () => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        const allInvites = [...(data.sent || []), ...(data.received || [])];
        setInvites(allInvites);
      }
    } catch (error) {
      console.error('Error fetching invites:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptInvite = async (inviteId: string) => {
    setActionLoading(inviteId);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites/accept-id`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteId }),
      });

      if (response.ok) {
        const data = await response.json();
        const contractId = data.contractId;
        toast({
          title: 'Invite accepted',
          description: 'Setting up privacy keys...',
          variant: 'success',
        });

        try {
          const { entry, created } = ensureContractKeypair(contractId);
          const keyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts/${contractId}/keys`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publicKey: entry.publicKey }),
          });
          if (!keyResponse.ok) {
            const errorData = await keyResponse.json();
            throw new Error(errorData.error || 'Failed to register privacy key');
          }

          const keysResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts/${contractId}/keys`, {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
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
            setPendingRedirect(contractId);
            router.push(`/contracts/${contractId}`);
          }
        } catch (error: any) {
          console.error('Privacy key setup failed:', error);
          toast({
            title: 'Privacy key setup failed',
            description: error?.message || 'Try again later.',
            variant: 'destructive',
          });
          router.push(`/contracts/${contractId}`);
        }

        fetchInvites();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Failed to accept invite',
          description: errorData.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error accepting invite:', error);
      toast({
        title: 'Failed to accept invite',
        description: 'Unable to accept invite.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeclineInvite = async (inviteId: string) => {
    setActionLoading(inviteId);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites/decline`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteId }),
      });

      if (response.ok) {
        alert('Invite declined successfully');
        fetchInvites();
      } else {
        const errorData = await response.json();
        alert(`Failed to decline invite: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error declining invite:', error);
      alert('Failed to decline invite');
    } finally {
      setActionLoading(null);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      pending: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Pending' },
      accepted: { color: 'bg-green-500/20 text-green-400', label: 'Accepted' },
      declined: { color: 'bg-red-500/20 text-red-400', label: 'Declined' },
      canceled: { color: 'bg-gray-500/20 text-gray-400', label: 'Canceled' },
      expired: { color: 'bg-orange-500/20 text-orange-400', label: 'Expired' },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.pending;
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const getRoleLabel = (role: string) => {
    return role === 'client' ? 'Client' : 'Contractor';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading invites...</p>
          </div>
        </div>
      </div>
    );
  }

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
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel rounded-xl border border-white/5 p-6">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-2xl font-semibold text-white">Your Invites</h1>
              <span className="text-gray-400 text-sm">{invites.length} invites</span>
            </div>

            {invites.length === 0 ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 bg-dark-800 rounded-full flex items-center justify-center mb-4 mx-auto">
                  <iconify-icon icon="solar:envelope-linear" className="text-gray-500" width="32" />
                </div>
                <h3 className="text-lg font-medium text-white mb-2">No invites found</h3>
                <p className="text-gray-400 mb-6">
                  You haven't sent or received any contract invites yet.
                </p>
                <Link
                  href="/contracts/new"
                  className="inline-flex items-center gap-2 bg-brand-500 hover:bg-brand-600 text-white px-6 py-3 rounded-lg text-sm font-medium transition-colors"
                >
                  <iconify-icon icon="solar:add-circle-linear" width="16" />
                  Create Your First Contract
                </Link>
              </div>
            ) : (
              <div className="space-y-6">
                {invites.map((invite) => (
                  <div key={invite.id} className="border border-white/5 rounded-lg p-6 hover:bg-white/5 transition-colors">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-gradient-to-br from-brand-500 to-brand-600 rounded-full flex items-center justify-center">
                          <iconify-icon
                            icon={invite.invitee_wallet === publicKey?.toString() ? "solar:envelope-linear" : "solar:mailbox-linear"}
                            className="text-white text-sm"
                            width="16"
                          />
                        </div>
                        <div>
                          <h3 className="text-white font-medium">
                            {invite.invitee_wallet === publicKey?.toString() ? 'Received Invite' : 'Sent Invite'}
                          </h3>
                          <p className="text-gray-400 text-sm">
                            Contract ID: {invite.contract_id.slice(0, 8)}...
                          </p>
                        </div>
                      </div>
                      {getStatusBadge(invite.status)}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="text-xs text-gray-500 uppercase tracking-wide">From</label>
                        <p className="text-white font-medium">
                          {invite.issuer_handle ? `@${invite.issuer_handle}` : invite.issuer_wallet.slice(0, 8)}...
                        </p>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 uppercase tracking-wide">Role</label>
                        <p className="text-white font-medium">
                          {getRoleLabel(invite.invitee_role)}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="text-xs text-gray-500 uppercase tracking-wide">Created</label>
                        <p className="text-white font-medium">
                          {new Date(invite.created_at * 1000).toLocaleString()}
                        </p>
                      </div>
                      {invite.expires_at && (
                        <div>
                          <label className="text-xs text-gray-500 uppercase tracking-wide">Expires</label>
                          <p className="text-white font-medium">
                            {new Date(invite.expires_at * 1000).toLocaleString()}
                          </p>
                        </div>
                      )}
                    </div>

                    {invite.status === 'pending' && invite.invitee_wallet === publicKey?.toString() && (
                      <div className="flex gap-3">
                        <button
                          onClick={() => handleAcceptInvite(invite.id)}
                          disabled={actionLoading === invite.id}
                          className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        >
                          {actionLoading === invite.id ? (
                            <>
                              <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                              Accepting...
                            </>
                          ) : (
                            'Accept'
                          )}
                        </button>
                        <button
                          onClick={() => handleDeclineInvite(invite.id)}
                          disabled={actionLoading === invite.id}
                          className="flex-1 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                        >
                          {actionLoading === invite.id ? 'Declining...' : 'Decline'}
                        </button>
                      </div>
                    )}

                    {invite.status !== 'pending' && (
                      <Link
                        href={`/contracts/${invite.contract_id}`}
                        className="text-brand-400 hover:text-brand-300 text-sm font-medium flex items-center gap-2"
                      >
                        View Contract
                        <iconify-icon icon="solar:arrow-right-linear" width="16" />
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
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
                onClick={handleCopyPrivacyKey}
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
