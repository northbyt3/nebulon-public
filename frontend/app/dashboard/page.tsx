'use client';

import React, { useState, useEffect } from 'react';
import { useWallet, useWalletModal } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { ensureContractKeypair, loadContractKeys } from '@/lib/privacy-keys';
import { buildPrivacyContext, decryptPayload, deriveContractKey } from '@/lib/privacy-crypto';
import idl from '@/lib/nebulon-idl.json';
import AppNavbar from '@/components/app-navbar';

interface Contract {
  id: string;
  title?: string;
  status: string;
  escrow_pda?: string;
  client_handle?: string;
  client_wallet?: string;
  client_pfp?: string;
  contractor_handle?: string;
  contractor_wallet?: string;
  contractor_pfp?: string;
  execution_mode?: string;
  total_payment?: number | string;
  deadline?: number | string | null;
  terms_encrypted?: string | null;
  created_at?: number;
}

interface Invite {
  id: string;
  contract_id: string;
  issuer_wallet: string;
  issuer_handle?: string;
  invitee_role: string;
  invitee_wallet?: string;
  status: string;
  created_at: number;
  accepted_at?: number;
  expires_at?: number;
}

interface UserStats {
  totalEarned: number;
  activeContracts: number;
  completedContracts: number;
  successRate: number;
}

export default function DashboardPage() {
  const { publicKey, connected, disconnect } = useWallet();
  const router = useRouter();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [stats, setStats] = useState<UserStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'active' | 'completed' | 'invited'>('active');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showInviteConfirm, setShowInviteConfirm] = useState(false);
  const [inviteConfirmId, setInviteConfirmId] = useState<string | null>(null);
  const [inviteConfirmAction, setInviteConfirmAction] = useState<'accept' | 'decline' | 'cancel' | null>(null);
  const [inviteConfirmLabel, setInviteConfirmLabel] = useState('');
  const [showJoinByCode, setShowJoinByCode] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinCodeError, setJoinCodeError] = useState('');
  const [backendConfig, setBackendConfig] = useState<{ rpcUrl?: string; wsUrl?: string; usdcMint?: string; programId?: string } | null>(null);
  const [resolvedTerms, setResolvedTerms] = useState<Record<string, { deadline?: string | number; payment?: string | number }>>({});
  const [balances, setBalances] = useState<{ sol: string; usdc: string }>({ sol: '--', usdc: '--' });
  const [userProfile, setUserProfile] = useState<{
    nebulonId: string;
    wallet: string;
    role: string;
    pfp?: string;
  } | null>(null);
  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  const extractInviteToken = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    try {
      const url = new URL(trimmed);
      const parts = url.pathname.split('/').filter(Boolean);
      const inviteIndex = parts.findIndex((part) => part === 'invite');
      if (inviteIndex >= 0 && parts[inviteIndex + 1]) {
        return parts[inviteIndex + 1];
      }
      return parts[parts.length - 1] || '';
    } catch {
      const marker = '/invite/';
      if (trimmed.includes(marker)) {
        const token = trimmed.split(marker)[1] || '';
        return token.split(/[?#/]/)[0] || '';
      }
      return trimmed;
    }
  };

  useEffect(() => {
    // Don't redirect immediately - wait for wallet to connect or check for existing token
    if (!connected || !publicKey) {
      // Check if we have an existing token before redirecting
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
      }
      return;
    }

    fetchDashboardData();
    fetchInvites();
    fetchBackendConfig();
    fetchUserProfile();
  }, [connected, publicKey, router]);

  useEffect(() => {
    if (!connected || !publicKey || !backendConfig?.rpcUrl) {
      return;
    }
    fetchBalances();
  }, [connected, publicKey, backendConfig?.rpcUrl]);

  useEffect(() => {
    if (!contracts.length || !backendConfig?.rpcUrl || !publicKey) {
      return;
    }
    console.log('[dashboard] resolve terms for contracts', contracts.map((c) => ({
      id: c.id,
      escrow_pda: c.escrow_pda,
      total_payment: c.total_payment,
      deadline: c.deadline,
    })));
    resolveDashboardTerms(contracts).catch((error) => {
      console.error('Error resolving dashboard terms:', error);
    });
  }, [contracts, backendConfig?.rpcUrl, backendConfig?.wsUrl, publicKey]);


  // Close user menu when clicking outside
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

  const fetchDashboardData = async () => {
    if (!publicKey) return;

    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        router.push('/login');
        return;
      }

      const contractsResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (contractsResponse.ok) {
        const contractsData = await contractsResponse.json();
        setContracts(contractsData.contracts);
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchInvites = async () => {
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        return;
      }
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setInvites([...(data.received || []), ...(data.sent || [])]);
      }
    } catch (error) {
      console.error('Error fetching invites:', error);
    } finally {
      setInvitesLoading(false);
    }
  };

  const fetchBackendConfig = async () => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/config`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setBackendConfig({
        rpcUrl: data.rpcUrl,
        wsUrl: data.wsUrl,
        usdcMint: data.usdcMint,
        programId: data.programId,
      });
    } catch (error) {
      console.error('Error fetching backend config:', error);
    }
  };

  const getAnchorWallet = () => {
    if (!publicKey || !connected) {
      return null;
    }
    return {
      publicKey,
      signTransaction: async (tx: any) => tx,
      signAllTransactions: async (txs: any[]) => txs,
    } as anchor.Wallet;
  };

  const deriveTermsPda = (escrowPda: PublicKey, programId: PublicKey) => {
    const TERMS_SEED = 'terms';
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(TERMS_SEED), escrowPda.toBuffer()],
      programId
    );
    return pda;
  };

  const buildProgram = (connection: Connection, programId: PublicKey, anchorWallet: anchor.Wallet) => {
    const provider = new anchor.AnchorProvider(connection, anchorWallet, {
      commitment: 'confirmed',
    });
    const idlData = JSON.parse(JSON.stringify(idl)) as any;
    idlData.address = programId.toBase58();
    const program = new anchor.Program(idlData as anchor.Idl, provider);
    return { program };
  };

  const fetchTermsOnChain = async (contract: Contract) => {
    if (!contract.escrow_pda || !backendConfig?.rpcUrl) {
      console.log('[dashboard] skip terms fetch (missing escrow/rpc)', {
        id: contract.id,
        escrow_pda: contract.escrow_pda,
        rpcUrl: backendConfig?.rpcUrl,
      });
      return null;
    }
    const anchorWallet = getAnchorWallet();
    if (!anchorWallet) {
      console.log('[dashboard] skip terms fetch (wallet not ready)', { id: contract.id });
      return null;
    }
    const programId = new PublicKey(
      (backendConfig as any).programId || '6UqkmQ2iCkf3acBB71DdXtVd49EyuaftMz8V3E74USbC'
    );
    console.log('[dashboard] fetching terms on-chain', {
      id: contract.id,
      escrow_pda: contract.escrow_pda,
      programId: programId.toBase58(),
    });
    const connection = new Connection(backendConfig.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: backendConfig.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const termsPda = deriveTermsPda(escrowPda, programId);
    try {
      const termsState: any = await program.account.terms.fetch(termsPda);
      const payment =
        termsState?.totalPayment?.toString?.() ||
        termsState?.total_payment?.toString?.() ||
        termsState?.total_payment ||
        termsState?.totalPayment;
      const deadline = termsState?.deadline?.toString?.() || termsState?.deadline;
      if (payment === undefined || deadline === undefined) {
        console.log('[dashboard] terms missing fields', { id: contract.id, payment, deadline });
        return null;
      }
      console.log('[dashboard] terms fetched', { id: contract.id, payment, deadline });
      return { deadline, payment };
    } catch (error) {
      console.error('[dashboard] terms fetch failed', { id: contract.id, error });
      return null;
    }
  };

  const decryptTermsEncrypted = async (contract: Contract) => {
    if (!publicKey || !crypto?.subtle) {
      return null;
    }
    if (!contract.terms_encrypted) {
      return null;
    }
    const localKeys = loadContractKeys();
    const entry = localKeys[contract.id];
    if (!entry?.secretKey) {
      return null;
    }
    const token = localStorage.getItem('authToken');
    if (!token) {
      return null;
    }
    try {
      const keyResponse = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts/${contract.id}/keys`,
        {
          headers: { 'Authorization': `Bearer ${token}` },
        }
      );
      if (!keyResponse.ok) {
        return null;
      }
      const keyData = await keyResponse.json();
      const keys = Array.isArray(keyData.keys) ? keyData.keys : [];
      const peer = keys.find((key: any) => key.wallet !== publicKey.toString());
      if (!peer?.public_key) {
        return null;
      }
      const sharedKey = await deriveContractKey(entry.secretKey, peer.public_key, contract.id);
      const aad = buildPrivacyContext('terms', contract.id);
      const plaintext = await decryptPayload(sharedKey, contract.terms_encrypted, aad);
      const parsed = JSON.parse(plaintext);
      const deadline = parsed?.deadline ?? null;
      const payment = parsed?.totalPayment ?? parsed?.total_payment ?? null;
      if (deadline === null || payment === null || deadline === undefined || payment === undefined) {
        return null;
      }
      return { deadline, payment };
    } catch (error) {
      console.error('[dashboard] terms decrypt failed', { id: contract.id, error });
      return null;
    }
  };

  const resolveDashboardTerms = async (list: Contract[]) => {
    const missing = list.filter(
      (contract) =>
        contract.escrow_pda &&
        (contract.total_payment === null ||
          contract.total_payment === undefined ||
          contract.deadline === null ||
          contract.deadline === undefined)
    );
    console.log('[dashboard] terms missing list', missing.map((c) => c.id));
    if (!missing.length) {
      return;
    }
    const results = await Promise.all(
      missing.map(async (contract) => {
        const decrypted = await decryptTermsEncrypted(contract);
        if (decrypted) {
          return { id: contract.id, terms: decrypted };
        }
        return { id: contract.id, terms: await fetchTermsOnChain(contract) };
      })
    );
    console.log('[dashboard] terms resolve results', results);
    setResolvedTerms((prev) => {
      const next = { ...prev };
      results.forEach((entry) => {
        if (entry.terms) {
          next[entry.id] = entry.terms;
        }
      });
      return next;
    });
  };

  const fetchBalances = async () => {
    if (!publicKey || !backendConfig?.rpcUrl) {
      return;
    }
    try {
      const connection = new Connection(backendConfig.rpcUrl, {
        commitment: 'confirmed',
        wsEndpoint: backendConfig.wsUrl || undefined,
      });
      const lamports = await connection.getBalance(publicKey);
      const sol = (lamports / 1_000_000_000).toFixed(4);

      let usdc = '--';
      if (backendConfig.usdcMint) {
        try {
          const mintKey = new PublicKey(backendConfig.usdcMint);
          const mintInfo = await connection.getAccountInfo(mintKey);
          if (!mintInfo) {
            setBalances({ sol, usdc });
            return;
          }
          const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
            mint: mintKey,
          });
          const total = tokenAccounts.value.reduce((sum, account) => {
            const amount = account.account.data.parsed.info.tokenAmount?.uiAmount || 0;
            return sum + amount;
          }, 0);
          usdc = total.toFixed(2);
        } catch (error) {
          console.error('Error fetching USDC balance:', error);
          usdc = '--';
        }
      }

      setBalances({ sol, usdc });
    } catch (error) {
      console.error('Error fetching balances:', error);
    }
  };


  const handleAcceptInvite = async (inviteId: string) => {
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
        try {
          const { entry } = ensureContractKeypair(contractId);
          const keyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/contracts/${contractId}/keys`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ publicKey: entry.publicKey }),
          });
          if (!keyResponse.ok) {
            const errorData = await keyResponse.json().catch(() => ({}));
            console.error('Failed to register privacy key:', errorData.error || 'Unknown error');
          }
        } catch (error) {
          console.error('Privacy key setup failed:', error);
        }
        await fetchDashboardData();
        await fetchInvites();
        router.push(`/contracts/${contractId}`);
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
    }
  };

  const handleDeclineInvite = async (inviteId: string) => {
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
        toast({
          title: 'Invite declined',
          description: 'The invite was declined.',
          variant: 'success',
        });
        await fetchInvites();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Failed to decline invite',
          description: errorData.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error declining invite:', error);
      toast({
        title: 'Failed to decline invite',
        description: 'Unable to decline invite.',
        variant: 'destructive',
      });
    }
  };

  const openInviteConfirm = (inviteId: string, action: 'accept' | 'decline' | 'cancel') => {
    setInviteConfirmId(inviteId);
    setInviteConfirmAction(action);
    setInviteConfirmLabel(
      action === 'accept' ? 'Accept Invite' : action === 'decline' ? 'Decline Invite' : 'Cancel Invite'
    );
    setShowInviteConfirm(true);
  };

  // Calculate stats from contracts data
  useEffect(() => {
    if (contracts.length > 0) {
      const calculatedStats: UserStats = {
        totalEarned: 0,
        activeContracts: 0,
        completedContracts: 0,
        successRate: 0,
      };

      contracts.forEach(contract => {
        if (contract.status === 'completed') {
          calculatedStats.completedContracts++;
          calculatedStats.totalEarned += contract.total_payment || 0;
        } else if (isActiveContractStatus(contract.status)) {
          calculatedStats.activeContracts++;
        }
      });

      calculatedStats.successRate = Math.round(
        (calculatedStats.completedContracts / contracts.length) * 100
      );

      setStats(calculatedStats);
    }
  }, [contracts]);

  const fetchUserProfile = async () => {
    if (!publicKey) return;

    try {
      const token = localStorage.getItem('authToken');
      if (!token) return;

      const response = await fetch('http://localhost:3333/v1/auth/me', {
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

  const handleLogout = async () => {
    try {
      // Clear local storage
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');

      // Disconnect wallet
      await disconnect();

      // Close user menu
      setShowUserMenu(false);

      // Redirect to login
      router.push('/login');
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/invites/${inviteId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (response.ok) {
        await fetchInvites();
      } else {
        const errorData = await response.json();
        alert(`Failed to cancel invite: ${errorData.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error canceling invite:', error);
      alert('Failed to cancel invite');
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


  const getStatusBadge = (status: string) => {
    const statusConfig = {
      waiting_for_init: { color: 'bg-gray-500/20 text-gray-400', label: 'Setup' },
      negotiating: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Negotiating' },
      awaiting_signatures: { color: 'bg-purple-500/20 text-purple-400', label: 'Awaiting Signatures' },
      waiting_for_funding: { color: 'bg-blue-500/20 text-blue-400', label: 'Waiting for Funding' },
      waiting_for_milestones_report: { color: 'bg-purple-500/20 text-purple-400', label: 'Waiting for Milestones' },
      in_progress: { color: 'bg-green-500/20 text-green-400', label: 'In Progress' },
      ready_to_claim: { color: 'bg-emerald-500/20 text-emerald-400', label: 'Ready to Claim' },
      completed: { color: 'bg-gray-500/20 text-gray-400', label: 'Completed' },
      disputed: { color: 'bg-red-500/20 text-red-400', label: 'Disputed' },
      pending_invite: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Invite Pending' },
      invite_canceled: { color: 'bg-gray-500/20 text-gray-400', label: 'Invite Canceled' },
      invite_declined: { color: 'bg-gray-500/20 text-gray-400', label: 'Invite Declined' },
      invite_expired: { color: 'bg-gray-500/20 text-gray-400', label: 'Invite Expired' },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.negotiating;
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${config.color}`}>
        {config.label}
      </span>
    );
  };

  const trimPubkey = (value?: string) => {
    if (!value) return 'Unknown';
    if (value.length <= 10) return value;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  };

  const formatUsdc = (value?: number | string) => {
    if (value === null || value === undefined) return '--';
    if (typeof value === 'number') {
      return value.toFixed(2);
    }
    const raw = value.toString().trim();
    if (!raw) return '--';
    if (raw.includes('.')) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed.toFixed(2) : raw;
    }
    try {
      const lamports = BigInt(raw);
      const whole = lamports / 1_000_000n;
      const fraction = (lamports % 1_000_000n).toString().padStart(6, '0');
      const trimmed = fraction.replace(/0+$/, '');
      return trimmed ? `${whole}.${trimmed}` : whole.toString();
    } catch {
      return raw;
    }
  };

  const formatDeadlineValue = (deadline?: string | number | null) => {
    if (deadline === null || deadline === undefined) {
      return 'n/a';
    }
    const value = Number(deadline);
    if (!Number.isFinite(value) || value === 0) {
      return 'n/a';
    }
    if (value < 0) {
      const abs = Math.abs(value);
      if (abs % 86400 === 0) {
        return `${abs / 86400}d from funding`;
      }
      if (abs % 3600 === 0) {
        return `${abs / 3600}h from funding`;
      }
      if (abs % 60 === 0) {
        return `${abs / 60}m from funding`;
      }
      return `${abs}s from funding`;
    }
    return new Date(value * 1000).toLocaleDateString();
  };

  const getDashboardTermsDisplay = (contract: Contract) => {
    const resolved = resolvedTerms[contract.id];
    const payment = contract.total_payment ?? resolved?.payment;
    const deadline = contract.deadline ?? resolved?.deadline;
    if (payment !== undefined && payment !== null) {
      return {
        amount: `${formatUsdc(payment)} USDC`,
        deadline: formatDeadlineValue(deadline),
      };
    }
    if (contract.terms_encrypted) {
      const localKeys = loadContractKeys();
      const hasKey = Boolean(localKeys[contract.id]?.secretKey);
      if (!hasKey) {
        return { amount: 'Encrypted', deadline: 'Encrypted' };
      }
    }
    return {
      amount: `${formatUsdc(payment)} USDC`,
      deadline: formatDeadlineValue(deadline),
    };
  };

  const getPartner = (contract: Contract) => {
    const currentWallet = publicKey?.toString() || userProfile?.wallet;
    const isClient = currentWallet && contract.client_wallet === currentWallet;
    const isContractor = currentWallet && contract.contractor_wallet === currentWallet;
    if (isClient) {
      return {
        handle: contract.contractor_handle || 'Unknown',
        wallet: contract.contractor_wallet,
        pfp: contract.contractor_pfp,
        role: 'Contractor',
      };
    }
    if (isContractor) {
      return {
        handle: contract.client_handle || 'Unknown',
        wallet: contract.client_wallet,
        pfp: contract.client_pfp,
        role: 'Client',
      };
    }
    return {
      handle: contract.contractor_handle || contract.client_handle || 'Unknown',
      wallet: contract.contractor_wallet || contract.client_wallet,
      pfp: contract.contractor_pfp || contract.client_pfp,
      role: 'Partner',
    };
  };

  const isActiveContractStatus = (status: string) =>
    ![
      'completed',
      'pending_invite',
      'invite_canceled',
      'invite_declined',
      'invite_expired',
      'canceled',
      'expired',
    ].includes(status);

  const filteredContracts = contracts.filter((contract) => {
    switch (activeTab) {
      case 'active':
        return isActiveContractStatus(contract.status);
      case 'completed':
        return contract.status === 'completed';
      case 'invited':
        return false;
      default:
        return true;
    }
  });

  const pendingInvites = invites.filter((invite) => invite.status === 'pending');

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading dashboard...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-900">
      <AppNavbar
        active="Dashboard"
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
        <div className="max-w-7xl mx-auto">
          {/* Welcome Section */}
          <div className="mb-8">
            <h1 className="text-3xl font-semibold text-white mb-2">
              Welcome back{userProfile?.nebulonId ? `, @${userProfile.nebulonId}` : ''}!
            </h1>
            <p className="text-gray-400">Here's an overview of your contracts and activity.</p>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              <div className="glass-panel p-6 rounded-xl border border-white/5">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                    <iconify-icon icon="solar:wallet-linear" className="text-emerald-400" width="16" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide">SOL Balance</p>
                    <p className="text-lg font-semibold text-white">{balances.sol} SOL</p>
                  </div>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-xl border border-white/5 relative group overflow-hidden">
                <div className="transition-all duration-200 group-hover:opacity-20 group-hover:blur-sm">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 bg-blue-500/20 rounded-lg flex items-center justify-center">
                      <iconify-icon icon="solar:card-linear" className="text-blue-400" width="16" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-400 uppercase tracking-wide">T-USDC Balance</p>
                      <p className="text-lg font-semibold text-white">{balances.usdc} T-USDC</p>
                    </div>
                  </div>
                </div>

                <div className="absolute inset-0 flex items-center px-5 opacity-0 transition-all duration-200 group-hover:opacity-100">
                  <div className="w-full">
                    <p className="text-sm font-semibold text-white">T-USDC (test token)</p>
                    <p className="mt-1 text-[11px] leading-snug text-gray-400">
                      Test-only balance for demos (no real value). On mainnet, we will use real USDC instead.
                    </p>
                    <p className="mt-2 text-[11px] leading-snug text-gray-400">
                      Need more? Open the Faucet tab for a daily top‑up.
                    </p>
                  </div>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-xl border border-white/5">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 bg-purple-500/20 rounded-lg flex items-center justify-center">
                    <iconify-icon icon="solar:document-linear" className="text-purple-400" width="16" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide">Active Contracts</p>
                    <p className="text-lg font-semibold text-white">{stats?.activeContracts ?? 0}</p>
                  </div>
                </div>
              </div>

              <div className="glass-panel p-6 rounded-xl border border-white/5">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 bg-yellow-500/20 rounded-lg flex items-center justify-center">
                    <iconify-icon icon="solar:mailbox-linear" className="text-yellow-400" width="16" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 uppercase tracking-wide">Pending Invites</p>
                    <p className="text-lg font-semibold text-white">{pendingInvites.length}</p>
                  </div>
                </div>
              </div>
            </div>

          {/* Contracts Section */}
          <div className="glass-panel rounded-xl border border-white/5 overflow-hidden">
            <div className="p-6 border-b border-white/5">
              <div className="flex flex-col gap-5">
                {/* Tabs */}
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-dark-800/60 p-1 w-fit">
                  {[
                    { id: 'active', label: 'Active', count: contracts.filter(c => isActiveContractStatus(c.status)).length },
                    { id: 'completed', label: 'Completed', count: contracts.filter(c => c.status === 'completed').length },
                    { id: 'invited', label: 'Invites', count: pendingInvites.length },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as typeof activeTab)}
                      className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                        activeTab === tab.id
                          ? 'bg-brand-500/20 text-brand-200 shadow-inner shadow-brand-500/20'
                          : 'text-gray-400 hover:text-gray-200'
                      }`}
                    >
                      {tab.label} <span className="ml-1 text-xs text-gray-500">({tab.count})</span>
                    </button>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-white">
                      {activeTab === 'active' ? 'Active Contracts' : activeTab === 'completed' ? 'Completed Contracts' : 'Pending Invites'}
                    </h2>
                    <p className="text-sm text-gray-400 mt-1">
                      {activeTab === 'invited' ? 'Manage incoming and outgoing invites.' : 'Keep track of your contract activity.'}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <Link
                      href="/contracts/new"
                      className="inline-flex items-center gap-2 rounded-full border border-brand-500/40 bg-brand-500/15 px-4 py-2 text-sm font-semibold text-brand-200 hover:bg-brand-500/30 hover:border-brand-500/60 transition-colors"
                    >
                      <iconify-icon icon="solar:add-square-linear" width="16" />
                      New Contract
                    </Link>
                    <button
                      onClick={() => {
                        setJoinCodeInput('');
                        setJoinCodeError('');
                        setShowJoinByCode(true);
                      }}
                      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-gray-200 hover:border-white/30 hover:text-white transition-colors"
                    >
                      <iconify-icon icon="solar:link-linear" width="16" />
                      Join Contract by Contract Code
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Contracts / Invites List */}
            <div className="divide-y divide-white/5">
              {activeTab === 'invited' ? (
                pendingInvites.length === 0 ? (
                  <div className="p-12 text-center">
                    <div className="w-16 h-16 bg-dark-800 rounded-full flex items-center justify-center mb-4 mx-auto">
                      <iconify-icon icon="solar:envelope-linear" className="text-gray-500" width="32" />
                    </div>
                    <h3 className="text-lg font-medium text-white mb-2">No invites found</h3>
                    <p className="text-gray-400 mb-4">
                      You haven't received any contract invites yet.
                    </p>
                  </div>
                ) : (
                  pendingInvites.map((invite) => (
                    <div key={invite.id} className="p-6 hover:bg-white/5 transition-colors">
                      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <h3 className="text-lg font-medium text-white">
                              {invite.issuer_wallet === publicKey?.toString()
                                ? "Invite to @" + (invite.invitee_handle || "unknown")
                                : "Invite from @" + (invite.issuer_handle || "unknown")}
                            </h3>
                            <span className="px-2 py-1 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400">
                              Pending
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-400">
                            <span>Role: {invite.invitee_role === "client" ? "Client" : "Contractor"}</span>
                            <span>
                              {invite.issuer_wallet === publicKey?.toString()
                                ? "Invitee: " + trimPubkey(invite.invitee_wallet)
                                : "Issuer: " + trimPubkey(invite.issuer_wallet)}
                            </span>
                            <span>{invite.created_at ? new Date(invite.created_at * 1000).toLocaleDateString() : "N/A"}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          {invite.issuer_wallet === publicKey?.toString() ? (
                            <button
                              onClick={() => openInviteConfirm(invite.id, 'cancel')}
                              className="text-xs font-medium px-3 py-2 rounded-full border border-white/10 text-gray-300 hover:text-white hover:border-white/30 transition-colors"
                            >
                              Cancel Invite
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => openInviteConfirm(invite.id, 'decline')}
                                className="text-xs font-medium px-3 py-2 rounded-full border border-white/10 text-gray-300 hover:text-white hover:border-white/30 transition-colors"
                              >
                                Decline
                              </button>
                              <button
                                onClick={() => openInviteConfirm(invite.id, 'accept')}
                                className="text-xs font-medium px-4 py-2 rounded-full bg-brand-500 hover:bg-brand-600 text-white transition-colors"
                              >
                                Accept
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )
              ) : filteredContracts.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-16 h-16 bg-dark-800 rounded-full flex items-center justify-center mb-4 mx-auto">
                    <iconify-icon icon="solar:document-linear" className="text-gray-500" width="32" />
                  </div>
                  <h3 className="text-lg font-medium text-white mb-2">No contracts found</h3>
                  <p className="text-gray-400 mb-4">
                    {activeTab === 'invited'
                      ? "You haven't received any contract invites yet."
                      : activeTab === 'completed'
                      ? "You haven't completed any contracts yet."
                      : "You don't have any active contracts."
                    }
                  </p>
                  {activeTab !== 'completed' && (
                    <p className="text-sm text-gray-500">
                      Click <span className="text-gray-300 font-medium">New Contract</span> to get started.
                    </p>
                  )}
                </div>
              ) : (
                filteredContracts.map((contract, index) => (
                  <div key={contract.id} className="p-6 hover:bg-white/5 transition-colors">
                    <div className="flex items-center justify-between gap-6">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-xs uppercase tracking-wide text-gray-500">Contract</span>
                          <span className="text-xs text-gray-500">#{index + 1}</span>
                          {getStatusBadge(contract.status)}
                        </div>
                        <div className="text-lg font-semibold text-white">
                          {contract.id.slice(0, 8)}...{contract.id.slice(-4)}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-gray-400">
                          {(() => {
                            const partner = getPartner(contract);
                            const currentWallet = publicKey?.toString() || userProfile?.wallet;
                            const isClient = currentWallet && contract.client_wallet === currentWallet;
                            const isContractor = currentWallet && contract.contractor_wallet === currentWallet;
                            return (
                              <>
                                <span className="inline-flex items-center gap-2">
                                  <span className="relative inline-flex h-6 w-6 overflow-hidden rounded-full border border-white/10 bg-dark-800">
                                    <Image
                                      src={contract.client_pfp ? `/pfps/${contract.client_pfp}` : '/placeholder-user.jpg'}
                                      alt={contract.client_handle || 'Client'}
                                      fill
                                      className="object-cover"
                                    />
                                  </span>
                                  <span className="text-gray-200">
                                    Client: @{contract.client_handle || 'Unknown'}
                                    {isClient ? ' (YOU)' : ''}
                                  </span>
                                  <span className="text-gray-500">({trimPubkey(contract.client_wallet)})</span>
                                </span>
                                <span className="text-gray-600">|</span>
                                <span className="inline-flex items-center gap-2">
                                  <span className="relative inline-flex h-6 w-6 overflow-hidden rounded-full border border-white/10 bg-dark-800">
                                    <Image
                                      src={contract.contractor_pfp ? `/pfps/${contract.contractor_pfp}` : '/placeholder-user.jpg'}
                                      alt={contract.contractor_handle || 'Contractor'}
                                      fill
                                      className="object-cover"
                                    />
                                  </span>
                                  <span className="text-gray-200">
                                    Contractor: @{contract.contractor_handle || 'Unknown'}
                                    {isContractor ? ' (YOU)' : ''}
                                  </span>
                                  <span className="text-gray-500">({trimPubkey(contract.contractor_wallet)})</span>
                                </span>
                              </>
                            );
                          })()}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                          {(() => {
                            const termsDisplay = getDashboardTermsDisplay(contract);
                            return (
                              <>
                                <span>Amount: {termsDisplay.amount}</span>
                                <span className="text-gray-600">|</span>
                                <span>Deadline: {termsDisplay.deadline}</span>
                              </>
                            );
                          })()}
                          <span className="text-gray-600">|</span>
                          <span>Status: {contract.status}</span>
                          {contract.execution_mode && (
                            <>
                              <span className="text-gray-600">|</span>
                              <span>Mode: {contract.execution_mode.toUpperCase()}</span>
                            </>
                          )}
                          <span className="text-gray-600">|</span>
                          <span>{contract.created_at ? new Date(contract.created_at * 1000).toLocaleDateString() : 'N/A'}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <Link
                          href={`/contracts/${contract.id}`}
                          className="inline-flex items-center gap-2 rounded-full bg-brand-500/20 px-4 py-2 text-sm font-semibold text-brand-300 hover:bg-brand-500/40 transition-colors"
                        >
                          View Details
                          <iconify-icon icon="solar:arrow-right-linear" width="16" />
                        </Link>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </main>

      {showJoinByCode && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Join Contract by Contract Code</h3>
            <p className="text-sm text-gray-400 mb-4">
              Paste the invite link or contract code to open the invite.
            </p>
            <label className="text-xs text-gray-500 uppercase tracking-wide">Invite Link or Code</label>
            <input
              value={joinCodeInput}
              onChange={(event) => setJoinCodeInput(event.target.value)}
              placeholder="e.g. 7kgcAhmwxiWBVko27o45SrWun1YP2WBNc"
              className="mt-2 w-full rounded-xl border border-white/10 bg-dark-800/60 px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-400"
            />
            {joinCodeError && <p className="text-xs text-red-400 mt-2">{joinCodeError}</p>}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  setShowJoinByCode(false);
                  setJoinCodeError('');
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const token = extractInviteToken(joinCodeInput);
                  if (!token) {
                    setJoinCodeError('Enter a valid invite link or code.');
                    return;
                  }
                  setShowJoinByCode(false);
                  setJoinCodeError('');
                  router.push(`/invite/${token}`);
                }}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {showInviteConfirm && inviteConfirmId && inviteConfirmAction && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">{inviteConfirmLabel}</h3>
            <p className="text-sm text-gray-400 mb-4">
              {inviteConfirmAction === 'accept'
                ? 'Accept this invite and set up privacy keys?'
                : inviteConfirmAction === 'decline'
                  ? 'Decline this invite? This cannot be undone.'
                  : 'Cancel this invite? This cannot be undone.'}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowInviteConfirm(false);
                  setInviteConfirmId(null);
                  setInviteConfirmAction(null);
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const id = inviteConfirmId;
                  const action = inviteConfirmAction;
                  setShowInviteConfirm(false);
                  setInviteConfirmId(null);
                  setInviteConfirmAction(null);
                  if (action === 'accept') {
                    await handleAcceptInvite(id);
                  } else if (action === 'decline') {
                    await handleDeclineInvite(id);
                  } else {
                    await handleCancelInvite(id);
                  }
                }}
                className={`flex-1 ${inviteConfirmAction === 'accept' ? 'bg-brand-500 hover:bg-brand-600' : 'bg-red-500 hover:bg-red-600'} text-white font-medium py-2 px-4 rounded-lg transition-colors`}
              >
                {inviteConfirmAction === 'accept' ? 'Accept' : inviteConfirmAction === 'decline' ? 'Decline' : 'Cancel Invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
