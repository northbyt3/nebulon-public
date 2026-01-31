'use client';

import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import AppNavbar from '@/components/app-navbar';
import { toast } from '@/hooks/use-toast';
import { ensureContractKeypair } from '@/lib/privacy-keys';

export default function NewContractPage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    role: '',
    counterpartyId: '',
  });
  const [creating, setCreating] = useState(false);
  const [shareMethod, setShareMethod] = useState<'direct' | 'url' | 'code'>('direct');
  const [counterpartyCheck, setCounterpartyCheck] = useState<{
    checked: boolean;
    exists: boolean;
    reason?: 'self' | 'not_found' | 'invalid' | 'unknown';
  }>({ checked: false, exists: false });
  const [checkingCounterparty, setCheckingCounterparty] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPrivacyKeyModal, setShowPrivacyKeyModal] = useState(false);
  const [privacyKeySecret, setPrivacyKeySecret] = useState('');
  const [privacyKeyContractId, setPrivacyKeyContractId] = useState('');
  const [privacyKeyCopied, setPrivacyKeyCopied] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState<string | null>(null);
  const [inviteShareUrl, setInviteShareUrl] = useState('');
  const [inviteShareCode, setInviteShareCode] = useState('');
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
    }
  }, [connected, publicKey, router]);

  const handleCopyPrivacyKey = async () => {
    if (!privacyKeySecret) return;
    try {
      await navigator.clipboard.writeText(privacyKeySecret);
      setPrivacyKeyCopied(true);
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
    setInviteShareUrl('');
    setInviteShareCode('');
  }, [shareMethod]);

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
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  const handleCopyInviteUrl = async () => {
    if (!inviteShareUrl) return;
    try {
      await navigator.clipboard.writeText(inviteShareUrl);
      toast({
        title: 'Copied',
        description: 'Invite link copied.',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to copy invite link:', error);
      toast({
        title: 'Copy failed',
        description: 'Unable to copy invite link.',
        variant: 'destructive',
      });
    }
  };

  const handleCopyInviteCode = async () => {
    if (!inviteShareCode) return;
    try {
      await navigator.clipboard.writeText(inviteShareCode);
      toast({
        title: 'Copied',
        description: 'Contract code copied.',
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to copy contract code:', error);
      toast({
        title: 'Copy failed',
        description: 'Unable to copy contract code.',
        variant: 'destructive',
      });
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'counterpartyId') {
      setCounterpartyCheck({ checked: false, exists: false });
    }
  };

  const normalizeHandle = (value: string) =>
    value.trim().toLowerCase().replace(/^@/, '');

  const verifyCounterpartyId = async () => {
    const value = formData.counterpartyId.trim();
    if (!value) {
      setCounterpartyCheck({ checked: false, exists: false });
      return;
    }
    if (userProfile?.nebulonId) {
      const selfHandle = normalizeHandle(userProfile.nebulonId);
      if (normalizeHandle(value) === selfHandle) {
        setCounterpartyCheck({ checked: true, exists: false, reason: 'self' });
        return;
      }
    }
    try {
      setCheckingCounterparty(true);
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/ids/check?handle=${encodeURIComponent(value)}`);
      if (response.ok) {
        const data = await response.json();
        const exists = data && data.available === false && data.reason === 'taken';
        setCounterpartyCheck({
          checked: true,
          exists,
          reason: exists ? undefined : data?.reason === 'reserved' ? 'invalid' : 'not_found',
        });
      } else {
        setCounterpartyCheck({ checked: true, exists: false, reason: 'unknown' });
      }
    } catch (error) {
      console.error('Error checking counterparty ID:', error);
      setCounterpartyCheck({ checked: true, exists: false, reason: 'unknown' });
    } finally {
      setCheckingCounterparty(false);
    }
  };

  const nextStep = () => {
    if (step < 3) {
      setStep(step + 1);
    }
  };

  const prevStep = () => {
    if (step > 1) {
      setStep(step - 1);
    }
  };

  const handleSubmit = async () => {
    if (!formData.role) {
      toast({
        title: 'Missing details',
        description: 'Please fill in all required fields.',
        variant: 'destructive',
      });
      return;
    }
    if (shareMethod === 'direct') {
      if (!formData.counterpartyId.trim()) {
        toast({
          title: 'Missing details',
          description: 'Please enter a Nebulon ID.',
          variant: 'destructive',
        });
        return;
      }
      if (!counterpartyCheck.checked || !counterpartyCheck.exists) {
        toast({
          title: 'Invalid Nebulon ID',
          description: counterpartyCheck.reason === 'self'
            ? 'You cannot invite yourself.'
            : 'Please enter a Nebulon ID that exists.',
          variant: 'destructive',
        });
        return;
      }
    }

    setCreating(true);
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const contractData: {
        inviteeRole: string;
        inviteeHandle?: string;
      } = {
        inviteeRole: formData.role === 'client' ? 'contractor' : 'client', // The other party's role
      };
      if (shareMethod === 'direct') {
        contractData.inviteeHandle = formData.counterpartyId.trim();
      }

      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(contractData),
      });

      if (response.ok) {
        const result = await response.json();
        const shouldShare = shareMethod !== 'direct';
        toast({
          title: 'Invite created',
          description: shareMethod === 'direct'
            ? 'Contract invitation sent successfully.'
            : 'Your share link is ready.',
          variant: 'success',
        });
        if (shouldShare) {
          setInviteShareUrl(result.inviteUrl || '');
          setInviteShareCode(result.token || '');
        }
        try {
          const { entry, created } = ensureContractKeypair(result.contractId);
          const keyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts/${result.contractId}/keys`, {
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

          if (created) {
            setPrivacyKeySecret(entry.secretKey);
            setPrivacyKeyContractId(result.contractId);
            setShowPrivacyKeyModal(true);
            if (shareMethod === 'direct') {
              setPendingRedirect('/dashboard');
            }
          } else {
            if (shareMethod === 'direct') {
              router.push('/dashboard');
            }
          }
        } catch (error: any) {
          console.error('Privacy key setup failed:', error);
          toast({
            title: 'Privacy key setup failed',
            description: error?.message || 'Try again later.',
            variant: 'destructive',
          });
          router.push('/dashboard');
        }
      } else {
        const error = await response.json();
        toast({
        title: 'Invite failed',
        description: error?.error || 'Failed to create contract.',
        variant: 'destructive',
      });
      }
    } catch (error) {
      console.error('Error creating contract:', error);
      toast({
        title: 'Invite failed',
        description: 'Failed to create contract. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center mb-8">
      {[1, 2, 3].map((stepNum) => (
        <React.Fragment key={stepNum}>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
            step >= stepNum
              ? 'bg-brand-500 text-white'
              : 'bg-dark-700 text-gray-500 border border-gray-600'
          }`}>
            {stepNum}
          </div>
          {stepNum < 3 && (
            <div className={`w-12 h-px mx-2 transition-colors ${
              step > stepNum ? 'bg-brand-500' : 'bg-gray-600'
            }`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-4">
          What's your role in this contract?
        </label>

        <div className="space-y-3">
          <label className="flex items-center gap-3 p-4 bg-dark-800 border border-white/10 rounded-lg cursor-pointer hover:border-brand-500/50 transition-colors">
            <input
              type="radio"
              name="role"
              value="client"
              checked={formData.role === 'client'}
              onChange={(e) => handleInputChange('role', e.target.value)}
              className="text-brand-500 focus:ring-brand-500"
            />
            <div className="flex-1">
              <div className="font-medium text-white">Client</div>
              <div className="text-sm text-gray-400">I'll fund this contract</div>
            </div>
          </label>

          <label className="flex items-center gap-3 p-4 bg-dark-800 border border-white/10 rounded-lg cursor-pointer hover:border-brand-500/50 transition-colors">
            <input
              type="radio"
              name="role"
              value="contractor"
              checked={formData.role === 'contractor'}
              onChange={(e) => handleInputChange('role', e.target.value)}
              className="text-brand-500 focus:ring-brand-500"
            />
            <div className="flex-1">
              <div className="font-medium text-white">Contractor</div>
              <div className="text-sm text-gray-400">I'll provide the service</div>
            </div>
          </label>
        </div>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-16 h-16 bg-brand-500/20 rounded-full flex items-center justify-center mb-4 mx-auto">
          <iconify-icon icon="solar:share-linear" width="32" className="text-brand-500" />
        </div>
        <h3 className="text-xl font-semibold text-white mb-2">How would you like to share this contract?</h3>
        <p className="text-gray-400">Choose how you want to send the invite.</p>
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-3 p-4 bg-dark-800 border border-white/10 rounded-lg cursor-pointer hover:border-brand-500/50 transition-colors">
          <input
            type="radio"
            name="shareMethod"
            value="direct"
            checked={shareMethod === 'direct'}
            onChange={() => setShareMethod('direct')}
            className="text-brand-500 focus:ring-brand-500"
          />
          <div className="flex-1">
            <div className="font-medium text-white">Directly by Nebulon ID</div>
            <div className="text-sm text-gray-400">Send directly to a specific user.</div>
          </div>
        </label>

        <label className="flex items-center gap-3 p-4 bg-dark-800 border border-white/10 rounded-lg cursor-pointer hover:border-brand-500/50 transition-colors">
          <input
            type="radio"
            name="shareMethod"
            value="url"
            checked={shareMethod === 'url'}
            onChange={() => setShareMethod('url')}
            className="text-brand-500 focus:ring-brand-500"
          />
          <div className="flex-1">
            <div className="font-medium text-white">Generate URL</div>
            <div className="text-sm text-gray-400">Share a link anyone can open.</div>
          </div>
        </label>

        <label className="flex items-center gap-3 p-4 bg-dark-800 border border-white/10 rounded-lg cursor-pointer hover:border-brand-500/50 transition-colors">
          <input
            type="radio"
            name="shareMethod"
            value="code"
            checked={shareMethod === 'code'}
            onChange={() => setShareMethod('code')}
            className="text-brand-500 focus:ring-brand-500"
          />
          <div className="flex-1">
            <div className="font-medium text-white">With a contract code</div>
            <div className="text-sm text-gray-400">Share a short code instead of a link.</div>
          </div>
        </label>
      </div>
    </div>
  );

  const renderStep3 = () => (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-16 h-16 bg-brand-500/20 rounded-full flex items-center justify-center mb-4 mx-auto">
          <iconify-icon icon="solar:user-circle-linear" width="32" className="text-brand-500" />
        </div>
        <h3 className="text-xl font-semibold text-white mb-2">
          {shareMethod === 'direct'
            ? 'Who are you working with?'
            : shareMethod === 'url'
              ? 'Share this contract link'
              : 'Share this contract code'}
        </h3>
        <p className="text-gray-400">
          {shareMethod === 'direct'
            ? 'Enter their Nebulon ID to create the contract'
            : shareMethod === 'url'
              ? 'A shareable link has been generated for your counterparty.'
              : 'A short code has been generated that you can send to your counterparty.'}
        </p>
      </div>

      {shareMethod === 'direct' ? (
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Counterparty's Nebulon ID *
          </label>
          <input
            type="text"
            value={formData.counterpartyId}
            onChange={(e) => handleInputChange('counterpartyId', e.target.value)}
            onBlur={verifyCounterpartyId}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                verifyCounterpartyId();
              }
            }}
            placeholder="their-nebulon-id"
            className="w-full bg-dark-800 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 transition-colors"
          />
          <p className="text-xs text-gray-500 mt-1">
            Enter the Nebulon ID of the person you want to work with
          </p>
          {checkingCounterparty && (
            <p className="text-xs text-gray-400 mt-2">Checking Nebulon ID...</p>
          )}
          {!checkingCounterparty && counterpartyCheck.checked && (
            counterpartyCheck.exists ? (
              <p className="text-xs text-emerald-400 mt-2">Nebulon ID found.</p>
            ) : counterpartyCheck.reason === 'self' ? (
              <p className="text-xs text-red-400 mt-2">You cannot invite yourself.</p>
            ) : (
              <p className="text-xs text-red-400 mt-2">Nebulon ID not found.</p>
            )
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {shareMethod === 'url' && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Invite Link</p>
              <div className="bg-dark-800 border border-white/10 rounded-lg p-3 text-xs text-gray-200 break-all font-mono">
                {inviteShareUrl ? inviteShareUrl : 'Press Generate Link to see the contract link.'}
              </div>
              <button
                onClick={handleCopyInviteUrl}
                className="mt-2 text-xs text-brand-300 hover:text-brand-200 transition-colors"
              >
                Copy link
              </button>
            </div>
          )}

          {shareMethod === 'code' && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Contract Code</p>
              <div className="bg-dark-800 border border-white/10 rounded-lg p-3 text-xs text-gray-200 break-all font-mono">
                {inviteShareCode || '?'}
              </div>
              <button
                onClick={handleCopyInviteCode}
                className="mt-2 text-xs text-brand-300 hover:text-brand-200 transition-colors"
              >
                Copy code
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  if (!connected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-dark-900">
        <div className="text-center">
          <p className="text-gray-400 mb-4">Please connect your wallet first</p>
          <Link href="/login" className="bg-brand-500 hover:bg-brand-600 text-white px-6 py-3 rounded-full font-medium transition-colors">
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-900">
      <AppNavbar
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

      {/* Main Content */}
      <main className="pt-24 pb-12 px-6">
        <div className="max-w-2xl mx-auto">
          {renderStepIndicator()}

          <div className="glass-panel p-8 rounded-2xl border border-white/5">
            {step === 1 && renderStep1()}
            {step === 2 && renderStep2()}
            {step === 3 && renderStep3()}

            {/* Navigation */}
            <div className="flex justify-between mt-8">
              <button
                onClick={prevStep}
                disabled={step === 1}
                className="px-6 py-3 text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Back
              </button>

              <div className="flex gap-3">
                {step < 3 ? (
                  <button
                    onClick={nextStep}
                    disabled={!formData.role}
                    className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-full font-medium transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95"
                  >
                    Next
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (shareMethod !== 'direct' && (inviteShareUrl || inviteShareCode)) {
                        router.push('/dashboard');
                        return;
                      }
                      handleSubmit();
                    }}
                    disabled={
                      creating ||
                      (shareMethod === 'direct' && checkingCounterparty) ||
                      (shareMethod === 'direct' && (
                        !formData.counterpartyId.trim() ||
                        !counterpartyCheck.checked ||
                        !counterpartyCheck.exists
                      ))
                    }
                    className="bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-8 py-3 rounded-full font-medium transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95 flex items-center gap-2"
                  >
                    {creating ? (
                      <>
                        <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin" />
                        Creating...
                      </>
                    ) : (
                      <>
                        {shareMethod === 'direct'
                          ? 'Send Invitation'
                          : (inviteShareUrl || inviteShareCode)
                            ? 'Done'
                            : shareMethod === 'code'
                              ? 'Generate Code'
                              : 'Generate Link'}
                        <iconify-icon icon="solar:check-circle-linear" width="16" />
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {showPrivacyKeyModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-lg w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Privacy Key Created</h3>
            <p className="text-sm text-gray-400 mb-4">
              This private key enables encrypted milestones for this contract. Store it safely.
            </p>
            <p className="text-xs text-yellow-400 mb-2">
              Click on the key to copy to clipboard, and proceed.
            </p>
            <button
              type="button"
              onClick={handleCopyPrivacyKey}
              className="w-full text-center bg-dark-800 border border-white/10 rounded-lg p-3 text-xs text-gray-200 font-mono break-all hover:border-white/20 hover:text-brand-300 transition-colors"
              title="Click to copy full key"
            >
              {privacyKeySecret
                ? `${privacyKeySecret.slice(0, 8)}...${privacyKeySecret.slice(-8)}`
                : ''}
            </button>
            <p className="text-xs text-red-400 mt-2">
              You will not see this key again.
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Contract ID: {privacyKeyContractId}
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  if (!privacyKeyCopied) return;
                  setShowPrivacyKeyModal(false);
                  const redirectTo = pendingRedirect;
                  setPendingRedirect(null);
                  setPrivacyKeySecret('');
                  setPrivacyKeyCopied(false);
                  if (privacyKeyContractId) {
                    localStorage.setItem(`nebulon_contract_key_ack:${privacyKeyContractId}`, '1');
                  }
                  if (redirectTo) router.push(redirectTo);
                }}
                disabled={!privacyKeyCopied}
                className="flex-1 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition-colors"
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
