'use client';

import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import AppNavbar from '@/components/app-navbar';
import {
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  TransactionInstruction,
  Keypair,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import {
  getAuthToken,
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from '@magicblock-labs/ephemeral-rollups-sdk';
import { SessionTokenManager } from '@magicblock-labs/gum-sdk';
import bs58 from 'bs58';
import idl from '@/lib/nebulon-idl.json';
import { toast } from '@/hooks/use-toast';
import { ensureContractKeypair, importContractKeypair, loadContractKeys } from '@/lib/privacy-keys';
import { buildPrivacyContext, decryptPayload, deriveContractKey, encryptPayload, isEncryptedPayload } from '@/lib/privacy-crypto';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';
const PROGRAM_ID_FALLBACK = '6UqkmQ2iCkf3acBB71DdXtVd49EyuaftMz8V3E74USbC';
const FEE_RECEIVER = new PublicKey('w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq');
const LOCAL_VALIDATOR_IDENTITY = new PublicKey('mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

const normalizeEndpoint = (endpoint: string) => endpoint.replace(/\/$/, '');
const normalizeRpcEndpoint = (endpoint: string) => {
  const cleaned = endpoint.replace(/\/$/, '');
  try {
    const normalized = cleaned.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
    const url = new URL(normalized);
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}`;
  } catch {
    return cleaned.toLowerCase();
  }
};
const getAnchorWallet = (wallet: ReturnType<typeof useWallet>) => {
  if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
    return null;
  }
  return {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction,
    signAllTransactions: wallet.signAllTransactions,
  } as anchor.Wallet;
};

const getKeypairWallet = (signer: Keypair) =>
  ({
    publicKey: signer.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.sign(signer);
      return tx;
    },
    signAllTransactions: async (txs: Transaction[]) => {
      txs.forEach((tx) => tx.sign(signer));
      return txs;
    },
  }) as anchor.Wallet;

const instructionCoder = new anchor.BorshInstructionCoder(idl as anchor.Idl);

const formatRelativeSeconds = (seconds: number) => {
  const abs = Math.abs(seconds);
  if (abs % 86400 === 0) {
    return `${abs / 86400}d`;
  }
  if (abs % 3600 === 0) {
    return `${abs / 3600}h`;
  }
  if (abs % 60 === 0) {
    return `${abs / 60}m`;
  }
  return `${abs}s`;
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
    return `${formatRelativeSeconds(value)} from funding`;
  }
  return new Date(value * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
};

  const formatUsdc = (value?: number | string | null) => {
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

const feeFromGross = (gross: bigint) => (gross * 2n) / 100n;
const netFromGross = (gross: bigint) => gross - feeFromGross(gross);
const grossFromNet = (net: bigint) => (net * 100n + 98n - 1n) / 98n;

const textToHash = (text: string) => {
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(text);
  bytes.set(encoded.slice(0, 32));
  return Array.from(bytes);
};

const buildTermsHash = (deadline: string | null, payment: string | null) => {
  const payload = `deadline:${deadline ?? ''}|payment:${payment ?? ''}`;
  return textToHash(payload);
};

const parseUsdcToBase = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/usdc/g, '')
    .replace(/\s+/g, '')
    .replace(/[$,_]/g, '')
    .replace(/,/g, '');
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error('Invalid amount.');
  }
  const [wholePart, fracPart = ''] = cleaned.split('.');
  if (fracPart.length > 6) {
    throw new Error('Amount supports up to 6 decimals.');
  }
  const normalized = fracPart.padEnd(6, '0');
  const base = BigInt(wholePart) * 1_000_000n + BigInt(normalized || '0');
  return base.toString();
};

const normalizeUsdcToBase = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    return null;
  }
  if (raw.includes('.')) {
    return parseUsdcToBase(raw);
  }
  const asBig = BigInt(raw);
  if (asBig >= 1_000_000n) {
    return raw;
  }
  return parseUsdcToBase(raw);
};

const buildTermsHashHex = (deadline: string | null, payment: string | null) =>
  Buffer.from(buildTermsHash(deadline, payment)).toString('hex');

const normalizeMilestoneStatus = (status: unknown) => {
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status;
  }
  const value = String(status || '').toLowerCase();
  if (!value) return 0;
  if (['created', 'pending'].includes(value)) return 0;
  if (['ready', 'submitted'].includes(value)) return 1;
  if (['approved', 'paid', 'confirmed'].includes(value)) return 2;
  if (value === 'disabled') return 4;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
};

const renderTxCopy = (sig: string, prefix?: string) => {
  const trimmedTx = `${sig.slice(0, 4)}...${sig.slice(-4)}`;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(sig);
      }}
      className="text-left text-sm text-gray-200 hover:text-white underline underline-offset-2 cursor-pointer"
    >
      {prefix ? `${prefix} ` : ''}
      Click to copy Tx to clipboard (Tx: {trimmedTx})
    </button>
  );
};

const hasNonZeroBytes = (value: any) => {
  if (!value) return false;
  if (Array.isArray(value)) return value.some((byte) => Number(byte) !== 0);
  if (value instanceof Uint8Array) return Array.from(value).some((byte) => byte !== 0);
  if (Buffer.isBuffer(value)) return Array.from(value.values()).some((byte) => byte !== 0);
  return false;
};

interface Contract {
  id: string;
  client_wallet: string;
  contractor_wallet: string;
  status: string;
  execution_mode: string;
  escrow_pda: string;
  mint: string;
  vault_token: string;
  terms_hash: string;
  milestones_hash: string;
  deadline?: string | number | null;
  total_payment?: string | number | null;
  terms_encrypted?: string | null;
  client_signed_at: number;
  contractor_signed_at: number;
  created_at: number;
  updated_at: number;
  client_handle?: string;
  client_pfp?: string;
  contractor_handle?: string;
  contractor_pfp?: string;
  issuer_handle?: string;
  issuer_pfp?: string;
}

interface Milestone {
  index: number;
  details: string;
  status: number;
  submitted_at: number;
  creator: string;
}

interface BackendConfig {
  ok?: boolean;
  network?: string;
  rpcUrl?: string;
  wsUrl?: string;
  programId?: string;
  usdcMint?: string;
  ephemeralProviderUrl?: string | null;
  ephemeralWsUrl?: string | null;
  ephemeralPermissionEndpoint?: string | null;
  ephemeralTeeEndpoint?: string | null;
  ephemeralTeeWsEndpoint?: string | null;
  ephemeralValidatorIdentity?: string | null;
}

export default function ContractDetailsPage({ params }: { params: { id: string } }) {
  const wallet = useWallet();
  const { publicKey, connected, connecting, signMessage } = wallet;
  const router = useRouter();
  const [contract, setContract] = useState<Contract | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [hasEncryptedPayload, setHasEncryptedPayload] = useState(false);
  const [terms, setTerms] = useState<{ deadline: string | number; payment: string | number } | null>(null);
  const [deadlinePreset, setDeadlinePreset] = useState('');
  const [customDeadlineDays, setCustomDeadlineDays] = useState('');
  const [paymentInput, setPaymentInput] = useState('');
  const [submittingTerms, setSubmittingTerms] = useState(false);
  const [showMilestoneModal, setShowMilestoneModal] = useState(false);
  const [milestoneDraft, setMilestoneDraft] = useState('');
  const [milestoneSaving, setMilestoneSaving] = useState(false);
  const [milestoneStep, setMilestoneStep] = useState<string | null>(null);
  const [milestoneProgress, setMilestoneProgress] = useState(0);
  const [perSetupStep, setPerSetupStep] = useState<string | null>(null);
  const [perSetupProgress, setPerSetupProgress] = useState(0);
  const [perSetupReady, setPerSetupReady] = useState(false);
  const [perSetupLoading, setPerSetupLoading] = useState(false);
  const [perSetupChecked, setPerSetupChecked] = useState(false);
  const [cachedBlockhash, setCachedBlockhash] = useState<{
    blockhash: string;
    lastValidBlockHeight: number;
    fetchedAt: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [backendConfig, setBackendConfig] = useState<BackendConfig | null>(null);
  const [teeStatus, setTeeStatus] = useState<'unknown' | 'checking' | 'available' | 'unavailable'>('unknown');
  const [walletRpcEndpoint, setWalletRpcEndpoint] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<'per' | 'l1'>('per');
  const [modeUpdating, setModeUpdating] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showModifyTermsModal, setShowModifyTermsModal] = useState(false);
  const [editDeadlinePreset, setEditDeadlinePreset] = useState('');
  const [editCustomDeadlineDays, setEditCustomDeadlineDays] = useState('');
  const [editPaymentInput, setEditPaymentInput] = useState('');
  const [editBaselineDeadline, setEditBaselineDeadline] = useState<string | null>(null);
  const [editBaselinePayment, setEditBaselinePayment] = useState<string | null>(null);
  const [showPrivacyKeyModal, setShowPrivacyKeyModal] = useState(false);
  const [privacyKeySecret, setPrivacyKeySecret] = useState('');
  const [privacyKeyInput, setPrivacyKeyInput] = useState('');
  const [showPrivacyKeyInput, setShowPrivacyKeyInput] = useState(false);
  const [keyRegistrationPending, setKeyRegistrationPending] = useState(false);
  const [privacyKeyCopied, setPrivacyKeyCopied] = useState(false);
  const [showDeleteKeyModal, setShowDeleteKeyModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmLines, setConfirmLines] = useState<string[]>([]);
  const [confirmTicket, setConfirmTicket] = useState<{
    amount: string;
    fee: string;
    net: string;
    cover: string;
  } | null>(null);
  const [confirmDeadline, setConfirmDeadline] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | (() => void)>(null);
  const [ratingScore, setRatingScore] = useState<number | null>(null);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);
  const [ratingDone, setRatingDone] = useState(false);
  const [milestonesExpanded, setMilestonesExpanded] = useState(false);
  const [userProfile, setUserProfile] = useState<{
    nebulonId: string;
    wallet: string;
    role: string;
    pfp?: string;
  } | null>(null);
  const profileHref = userProfile?.nebulonId ? `/profile/${userProfile.nebulonId}` : '/profile';

  const network = (backendConfig?.network || 'unknown').toLowerCase();
  const localnetByUrl =
    backendConfig?.rpcUrl?.includes('localhost') ||
    backendConfig?.rpcUrl?.includes('127.0.0.1') ||
    false;
  const isLocalnet = network === 'localnet' || localnetByUrl;
  const isDevnet = network === 'devnet';
  const normalizedBackendRpc = backendConfig?.rpcUrl
    ? normalizeRpcEndpoint(backendConfig.rpcUrl)
    : null;
  const normalizedWalletRpc = walletRpcEndpoint
    ? normalizeRpcEndpoint(walletRpcEndpoint)
    : null;
  const hasWalletRpcMismatch = Boolean(
    normalizedBackendRpc &&
      normalizedWalletRpc &&
      normalizedBackendRpc !== normalizedWalletRpc
  );
  const canSelectL1 = true;
  const perDisabled = false;
  const deadlineOptions = [1, 3, 7, 14, 30, 60, 120];
  const hasDeadlineValue =
    terms?.deadline !== null &&
    terms?.deadline !== undefined &&
    Number(terms?.deadline) !== 0;
  const hasPaymentValue =
    terms?.payment !== null &&
    terms?.payment !== undefined &&
    Number(terms?.payment) !== 0;
  const termsReady = Boolean(hasDeadlineValue && hasPaymentValue);
  const canSignContract = termsReady && milestones.length > 0;
  const allMilestonesConfirmed =
    milestones.length > 0 && milestones.every((milestone) => milestone.status === 2);
  const isClient = publicKey?.toString() === contract?.client_wallet;
  const isContractor = publicKey?.toString() === contract?.contractor_wallet;
  const hasClientSigned = Boolean(contract?.client_signed_at);
  const hasContractorSigned = Boolean(contract?.contractor_signed_at);
  const currentUserSigned =
    (isClient && hasClientSigned) || (isContractor && hasContractorSigned);
  const waitingForOtherSignature =
    contract?.status === 'awaiting_signatures' && currentUserSigned;
  const selectedDeadlineDays =
    deadlinePreset === 'custom' ? Number(customDeadlineDays) : Number(deadlinePreset);
  const deadlineDaysValid = Number.isFinite(selectedDeadlineDays) && selectedDeadlineDays > 0;
  let paymentBasePreview: string | null = null;
  try {
    if (paymentInput.trim()) {
      paymentBasePreview = parseUsdcToBase(paymentInput);
    }
  } catch {
    paymentBasePreview = null;
  }
  const paymentValid = Boolean(paymentBasePreview && BigInt(paymentBasePreview) > 0n);
  const canSubmitTerms = Boolean(contract && contract.status === 'negotiating' && deadlineDaysValid && paymentValid);
  const editSelectedDeadlineDays =
    editDeadlinePreset === 'custom' ? Number(editCustomDeadlineDays) : Number(editDeadlinePreset);
  const editDeadlineDaysValid = Number.isFinite(editSelectedDeadlineDays) && editSelectedDeadlineDays > 0;
  let editPaymentBasePreview: string | null = null;
  try {
    if (editPaymentInput.trim()) {
      editPaymentBasePreview = parseUsdcToBase(editPaymentInput);
    }
  } catch {
    editPaymentBasePreview = null;
  }
  const editPaymentValid = Boolean(editPaymentBasePreview && BigInt(editPaymentBasePreview) > 0n);
  const editDeadlineSecondsPreview =
    editDeadlineDaysValid ? (-editSelectedDeadlineDays * 86400).toString() : null;
  const hasEditChanges = Boolean(
    editBaselineDeadline &&
      editBaselinePayment &&
      editDeadlineSecondsPreview &&
      editPaymentBasePreview &&
      (editBaselineDeadline !== editDeadlineSecondsPreview ||
        editBaselinePayment !== editPaymentBasePreview)
  );
  
  // Use React.use() to unwrap the params promise
  const contractId = React.use(params as any).id;

  useEffect(() => {
    if (!contractId) {
      return;
    }
    const token = localStorage.getItem('authToken');
    if (!connected || !publicKey) {
      if (connecting) {
        return;
      }
      if (!token) {
        router.push('/login');
        return;
      }
    }

    if (token) {
      fetchContractDetails();
    }
    fetchBackendConfig();
  }, [connected, publicKey, connecting, router, contractId]);

  useEffect(() => {
    if (!contractId) return;
    const key = `nebulon_rating:${contractId}`;
    if (localStorage.getItem(key)) {
      setRatingDone(true);
    } else {
      setRatingDone(false);
    }
  }, [contractId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const provider = (window as any).solana;
    const endpoint =
      provider?.connection?.rpcEndpoint ||
      provider?.rpcEndpoint ||
      provider?._rpcEndpoint ||
      null;
    if (endpoint) {
      setWalletRpcEndpoint(String(endpoint));
    }
  }, [publicKey]);

  useEffect(() => {
    if (!connected || !publicKey) {
      return;
    }
    const fetchUserProfile = async () => {
      try {
        const token = localStorage.getItem('authToken');
        if (!token) return;
        const response = await fetch(`${API_URL}/v1/auth/me`, {
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'F5' && event.shiftKey) {
        // Browser hard-refresh may still trigger; this is best-effort for demo.
        event.preventDefault();
        setPrivacyKeySecret('FAKEKEY_12345678_FAKEKEY_ABCDEFGH_12345678_FAKEKEY');
        setPrivacyKeyCopied(false);
        setShowPrivacyKeyModal(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleLogout = async () => {
    try {
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');
      await wallet.disconnect();
      setShowUserMenu(false);
      router.push('/login');
    } catch (error) {
      console.error('Error during logout:', error);
    }
  };

  const buildFeeConfirmLines = (amountBase: bigint, contextLabel: string) => {
    const fee = feeFromGross(amountBase);
    const net = netFromGross(amountBase);
    const cover = grossFromNet(amountBase);
    return [];
  };

  const buildFeeTicket = (amountBase: bigint) => {
    const fee = feeFromGross(amountBase);
    const net = netFromGross(amountBase);
    const cover = grossFromNet(amountBase);
    return {
      amount: `${formatUsdc(amountBase.toString())} USDC`,
      fee: `${formatUsdc(fee.toString())} USDC`,
      net: `${formatUsdc(net.toString())} USDC`,
      cover: `${formatUsdc(cover.toString())} USDC`,
    };
  };

  const handleCopyAddress = async (address?: string) => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
    } catch (error) {
      console.error('Failed to copy address:', error);
    }
  };

  const openConfirmModal = (
    title: string,
    lines: string[],
    onConfirm: () => void,
    options?: { ticket?: { amount: string; fee: string; net: string; cover: string }; deadline?: string | null }
  ) => {
    setConfirmTitle(title);
    setConfirmLines(lines);
    setConfirmTicket(options?.ticket ?? null);
    setConfirmDeadline(options?.deadline ?? null);
    setConfirmAction(() => onConfirm);
    setShowConfirmModal(true);
  };

  useEffect(() => {
    if (!isDevnet || teeStatus !== 'unknown') {
      return;
    }
    if (executionMode === 'l1' || contract?.execution_mode === 'l1') {
      return;
    }
    if (!publicKey || !signMessage) {
      return;
    }
    checkTEEAvailability().catch(() => null);
  }, [isDevnet, teeStatus, executionMode, contract?.execution_mode, publicKey, signMessage]);

  useEffect(() => {
    if (!contract) return;
    const mode = (contract.execution_mode || 'per').toLowerCase() === 'l1' ? 'l1' : 'per';
    setExecutionMode(mode);
  }, [contract?.execution_mode, contract]);

  useEffect(() => {
    if (!isLocalnet) {
      setPerSetupReady(false);
      setPerSetupChecked(false);
      return;
    }
    if (!publicKey || !backendConfig?.programId) {
      return;
    }
    checkSessionStatus().catch(() => null);
  }, [isLocalnet, publicKey, backendConfig?.programId]);

  useEffect(() => {
    if (!backendConfig?.rpcUrl || !publicKey) {
      return;
    }
    let active = true;
    const warmBlockhash = async () => {
      try {
        const connection = new Connection(backendConfig.rpcUrl || 'http://localhost:8899', {
          commitment: 'confirmed',
          wsEndpoint: backendConfig.wsUrl || undefined,
        });
        const latest = await connection.getLatestBlockhash();
        if (!active) return;
        setCachedBlockhash({
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          fetchedAt: Date.now(),
        });
      } catch {
        // ignore
      }
    };
    warmBlockhash();
    const interval = setInterval(warmBlockhash, 20000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [backendConfig?.rpcUrl, backendConfig?.wsUrl, publicKey]);

  const fetchBackendConfig = async () => {
    try {
      const response = await fetch(`${API_URL}/v1/config`);
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setBackendConfig(data || null);
    } catch (error) {
      console.error('Error fetching backend config:', error);
    }
  };

  const fetchContractDetails = async () => {
    if (!contractId) return;
    
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/v1/contracts/${contractId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        const nextContract = data.contract;
        setContract(nextContract);
        const rawMilestones = Array.isArray(nextContract?.milestones) ? nextContract.milestones : [];
        const nextMilestones = rawMilestones.map((milestone) => ({
          ...milestone,
          status: normalizeMilestoneStatus(milestone.status),
        }));
        setHasEncryptedPayload(nextMilestones.some((milestone) => isEncryptedPayload(milestone.details)));
        setMilestones(nextMilestones);
        if (nextMilestones.length) {
          try {
            const decrypted = await decryptMilestones(nextContract.id, nextMilestones);
            setMilestones(decrypted);
          } catch (error) {
            console.error('Failed to decrypt milestones:', error);
          }
        }
        if (nextContract?.id) {
          const localKeys = loadContractKeys();
          const entry = localKeys[nextContract.id];
          const ackKey = `nebulon_contract_key_ack:${nextContract.id}`;
          if (entry?.secretKey && !localStorage.getItem(ackKey)) {
            setPrivacyKeySecret(entry.secretKey);
            setShowPrivacyKeyModal(true);
          }
        }
        let resolvedTerms: { deadline: string | number; payment: string | number } | null = null;
        try {
          const onChain = await fetchTermsOnChain(nextContract);
          if (onChain) {
            resolvedTerms = onChain;
          }
        } catch (error) {
          console.error('On-chain terms fetch failed:', error);
        }
        if (!resolvedTerms && nextContract?.terms_encrypted) {
          try {
            const decrypted = await decryptTermsEncrypted(nextContract.id, nextContract.terms_encrypted);
            if (decrypted) {
              resolvedTerms = decrypted;
            }
          } catch (error) {
            console.error('Terms decryption failed:', error);
          }
        }
        if (!resolvedTerms) {
          if (nextContract?.deadline !== null && nextContract?.deadline !== undefined &&
              nextContract?.total_payment !== null && nextContract?.total_payment !== undefined) {
            resolvedTerms = {
              deadline: nextContract.deadline,
              payment: nextContract.total_payment,
            };
          }
        }
        setTerms(resolvedTerms);
      }
    } catch (error) {
      console.error('Error fetching contract details:', error);
    } finally {
      setLoading(false);
    }
  };

  const openModifyTerms = () => {
    if (!terms) {
      setShowModifyTermsModal(true);
      return;
    }
    const deadlineValue = Number(terms.deadline);
    if (Number.isFinite(deadlineValue) && deadlineValue !== 0) {
      const days = Math.max(1, Math.round(Math.abs(deadlineValue) / 86400));
      if (deadlineOptions.includes(days)) {
        setEditDeadlinePreset(days.toString());
        setEditCustomDeadlineDays('');
      } else {
        setEditDeadlinePreset('custom');
        setEditCustomDeadlineDays(days.toString());
      }
    } else {
      setEditDeadlinePreset('');
      setEditCustomDeadlineDays('');
    }
    const paymentString =
      terms.payment !== null && terms.payment !== undefined
        ? formatUsdc(terms.payment)
        : '';
    setEditPaymentInput(paymentString === '--' ? '' : paymentString);
    setEditBaselineDeadline(
      Number.isFinite(deadlineValue) && deadlineValue !== 0 ? deadlineValue.toString() : null
    );
    setEditBaselinePayment(normalizeUsdcToBase(terms.payment));
    setShowModifyTermsModal(true);
  };

  const handleRateContract = async (score: number) => {
    if (!contractId) return;
    const token = localStorage.getItem('authToken');
    if (!token) {
      toast({
        title: 'Sign in required',
        description: 'Log in to rate this contract.',
        variant: 'destructive',
      });
      return;
    }
    setRatingSubmitting(true);
    try {
      const response = await fetch(`${API_URL}/v1/contracts/${contractId}/rate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ score }),
      });
      if (response.ok) {
        setRatingDone(true);
        localStorage.setItem(`nebulon_rating:${contractId}`, '1');
        toast({
          title: 'Rating submitted',
          description: `${score} star${score === 1 ? '' : 's'} recorded.`,
          variant: 'success',
        });
        return;
      }
      const errorData = await response.json().catch(() => ({}));
      if (errorData?.error === 'already_rated') {
        setRatingDone(true);
        localStorage.setItem(`nebulon_rating:${contractId}`, '1');
        toast({
          title: 'Already rated',
          description: 'You have already rated this contract.',
          variant: 'warning',
        });
        return;
      }
      toast({
        title: 'Rating failed',
        description: errorData?.error || 'Unable to submit rating.',
        variant: 'destructive',
      });
    } catch (error) {
      console.error('Error submitting rating:', error);
      toast({
        title: 'Rating failed',
        description: 'Unable to submit rating.',
        variant: 'destructive',
      });
    } finally {
      setRatingSubmitting(false);
    }
  };

  const submitTermsWorkflow = async (deadlineSeconds: string, paymentBase: string) => {
    if (contract?.status !== 'negotiating') {
      toast({
        title: 'Contract locked',
        description: 'Terms cannot be changed after signing starts.',
        variant: 'warning',
      });
      return;
    }
    const amountBase = BigInt(paymentBase);
    const deadlineLabel = formatDeadlineValue(deadlineSeconds);
    openConfirmModal(
      'Confirm terms',
      buildFeeConfirmLines(amountBase, 'terms'),
      async () => {
      setShowConfirmModal(false);
      setSubmittingTerms(true);
      setActionLoading(true);
      try {
        if (publicKey?.toString() !== contract?.client_wallet) {
          toast({
            title: 'Client signature required',
            description: 'Only the client can submit terms on-chain.',
            variant: 'warning',
          });
          return;
        }

        const mode =
          executionMode === 'l1' || contract?.execution_mode === 'l1' ? 'l1' : 'per';
        if (mode === 'l1') {
          const sig = await submitPublicTermsOnChain(deadlineSeconds, paymentBase);
          toast({
            title: 'Terms submitted on-chain',
            description: renderTxCopy(sig),
            variant: 'success',
          });
        } else {
          if (!signMessage) {
            toast({
              title: 'Wallet lacks signMessage',
              description: 'PER mode requires signMessage for TEE auth.',
              variant: 'destructive',
            });
            return;
          }
          const { sig, usedSession } = await submitPrivateTermsOnChain(deadlineSeconds, paymentBase);
          const label = usedSession ? 'Session key' : 'Wallet';
          toast({
            title: 'Private terms submitted',
            description: renderTxCopy(sig, `Signed with ${label}.`),
            variant: 'success',
          });
        }

        const token = localStorage.getItem('authToken');
        const response = await fetch(`${API_URL}/v1/contracts/${contractId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            termsHash: buildTermsHashHex(deadlineSeconds, paymentBase),
            deadline: deadlineSeconds,
            totalPayment: paymentBase,
          }),
        });

        if (response.ok) {
          toast({
            title: 'Terms saved',
            description: 'Deadline and payment were saved.',
            variant: 'success',
          });
          await fetchContractDetails();
        } else {
          const errorData = await response.json();
          toast({
            title: 'Failed to save terms',
            description: errorData.error || 'Unknown error',
            variant: 'destructive',
          });
        }
      } catch (error) {
        console.error('Error submitting terms:', error);
        toast({
          title: 'Failed to submit terms',
          description: 'Unable to submit terms.',
          variant: 'destructive',
        });
      } finally {
        setSubmittingTerms(false);
        setActionLoading(false);
      }
    },
    { ticket: buildFeeTicket(amountBase), deadline: deadlineLabel }
    );
  };

  const handleModifyTerms = async () => {
    if (!contractId || !contract) return;
    if (contract.status !== 'negotiating') {
      toast({
        title: 'Contract locked',
        description: 'Terms cannot be changed after signing starts.',
        variant: 'warning',
      });
      return;
    }
    if (!contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Initialize the contract before submitting terms.',
        variant: 'destructive',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to submit terms.',
        variant: 'destructive',
      });
      return;
    }
    if (!editDeadlineDaysValid || !editPaymentValid || !editPaymentBasePreview) {
      toast({
        title: 'Invalid terms',
        description: 'Enter a valid deadline and payment.',
        variant: 'destructive',
      });
      return;
    }

    const deadlineSeconds = (-editSelectedDeadlineDays * 86400).toString();
    const paymentBase = editPaymentBasePreview;
    await submitTermsWorkflow(deadlineSeconds, paymentBase);
    setShowModifyTermsModal(false);
  };

  const fetchTermsOnChain = async (nextContract: Contract) => {
    if (!nextContract?.escrow_pda) {
      return null;
    }
    if (!publicKey) {
      return null;
    }
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet) {
      return null;
    }
    const config = backendConfig || (await loadBackendConfig());
    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const escrowPda = new PublicKey(nextContract.escrow_pda);
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
        return null;
      }
      return { deadline, payment };
    } catch {
      return null;
    }
  };

  const decryptTermsEncrypted = async (id: string, encrypted: string) => {
    if (!publicKey || !crypto?.subtle) {
      return null;
    }
    const localKeys = loadContractKeys();
    const entry = localKeys[id];
    if (!entry?.secretKey) {
      return null;
    }
    const token = localStorage.getItem('authToken');
    if (!token) {
      return null;
    }
    const keyResponse = await fetch(`${API_URL}/v1/contracts/${id}/keys`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!keyResponse.ok) {
      return null;
    }
    const keyData = await keyResponse.json();
    const keys = Array.isArray(keyData.keys) ? keyData.keys : [];
    const peer = keys.find((key) => key.wallet !== publicKey.toString());
    if (!peer?.public_key) {
      return null;
    }
    const sharedKey = await deriveContractKey(entry.secretKey, peer.public_key, id);
    const aad = buildPrivacyContext('terms', id);
    const plaintext = await decryptPayload(sharedKey, encrypted, aad);
    const parsed = JSON.parse(plaintext);
    const deadline = parsed?.deadline ?? null;
    const payment = parsed?.totalPayment ?? parsed?.total_payment ?? null;
    if (deadline === null || payment === null || deadline === undefined || payment === undefined) {
      return null;
    }
    return { deadline, payment };
  };

  const decryptMilestones = async (id: string, list: Milestone[]) => {
    if (!publicKey || !crypto?.subtle) {
      return list;
    }
    const hasEncrypted = list.some((milestone) => isEncryptedPayload(milestone.details));
    if (!hasEncrypted) {
      return list;
    }
    const localKeys = loadContractKeys();
    const entry = localKeys[id];
    if (!entry?.secretKey) {
      return list.map((milestone) =>
        isEncryptedPayload(milestone.details)
          ? { ...milestone, details: '(encrypted)' }
          : milestone
      );
    }
    const token = localStorage.getItem('authToken');
    if (!token) {
      return list;
    }
    const keyResponse = await fetch(`${API_URL}/v1/contracts/${id}/keys`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!keyResponse.ok) {
      return list;
    }
    const keyData = await keyResponse.json();
    const keys = Array.isArray(keyData.keys) ? keyData.keys : [];
    const peer = keys.find((key) => key.wallet !== publicKey.toString());
    if (!peer?.public_key) {
      return list.map((milestone) =>
        isEncryptedPayload(milestone.details)
          ? { ...milestone, details: '(encrypted)' }
          : milestone
      );
    }
    const sharedKey = await deriveContractKey(entry.secretKey, peer.public_key, id);
    const decrypted = await Promise.all(
      list.map(async (milestone) => {
        if (!isEncryptedPayload(milestone.details)) {
          return milestone;
        }
        try {
          const aad = buildPrivacyContext('milestone', id, milestone.index);
          const plaintext = await decryptPayload(sharedKey, milestone.details, aad);
          const parsed = JSON.parse(plaintext);
          const title = parsed?.title ? String(parsed.title) : '';
          return { ...milestone, details: title || '(encrypted)' };
        } catch {
          return { ...milestone, details: '(encrypted)' };
        }
      })
    );
    return decrypted;
  };

  const hasEncryptedMilestones = hasEncryptedPayload;
  const hasLocalKey = contract?.id ? Boolean(loadContractKeys()[contract.id]?.secretKey) : false;

  const registerContractKey = async (id: string, publicKey: string) => {
    const token = localStorage.getItem('authToken');
    if (!token) return;
    await fetch(`${API_URL}/v1/contracts/${id}/keys`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ publicKey }),
    });
  };

  const handlePrivacyKeyImport = async () => {
    if (!contract?.id) return;
    const trimmed = privacyKeyInput.trim();
    const attemptsKey = `nebulon_key_attempts:${contract.id}`;
    const nowMs = Date.now();
    try {
      const attemptsRaw = localStorage.getItem(attemptsKey);
      if (attemptsRaw) {
        const parsed = JSON.parse(attemptsRaw);
        if (parsed?.lockedUntil && nowMs < parsed.lockedUntil) {
          const minutes = Math.ceil((parsed.lockedUntil - nowMs) / 60000);
          toast({
            title: 'Too many attempts',
            description: `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            variant: 'destructive',
          });
          return;
        }
      }
    } catch {
      // ignore parse errors
    }
    if (!trimmed) {
      toast({
        title: 'Missing key',
        description: 'Paste the privacy key to continue.',
        variant: 'destructive',
      });
      return;
    }
    setKeyRegistrationPending(true);
    try {
      const token = localStorage.getItem('authToken');
      if (!token) {
        throw new Error('Missing auth token.');
      }
      if (!publicKey) {
        throw new Error('Wallet not connected.');
      }
      const entry = importContractKeypair(contract.id, trimmed);
      const keyResponse = await fetch(`${API_URL}/v1/contracts/${contract.id}/keys`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      if (!keyResponse.ok) {
        throw new Error('Unable to verify privacy key.');
      }
      const keyData = await keyResponse.json();
      const keys = Array.isArray(keyData.keys) ? keyData.keys : [];
      const mine = keys.find((key) => key.wallet === publicKey.toString());
      if (!mine?.public_key || mine.public_key !== entry.publicKey) {
        throw new Error('Incorrect privacy key for this contract.');
      }
      await registerContractKey(contract.id, entry.publicKey).catch(() => null);
      localStorage.removeItem(attemptsKey);
      setShowPrivacyKeyInput(false);
      setPrivacyKeyInput('');
      await fetchContractDetails();
      toast({
        title: 'Privacy key saved',
        description: 'You can now view encrypted milestones.',
        variant: 'success',
      });
    } catch (error: any) {
      try {
        const attemptsRaw = localStorage.getItem(attemptsKey);
        const parsed = attemptsRaw ? JSON.parse(attemptsRaw) : null;
        const count = Number(parsed?.count || 0) + 1;
        const lockedUntil =
          count >= 10 ? nowMs + 5 * 60 * 1000 : parsed?.lockedUntil || null;
        localStorage.setItem(
          attemptsKey,
          JSON.stringify({ count, lockedUntil })
        );
        if (lockedUntil && nowMs < lockedUntil) {
          toast({
            title: 'Too many attempts',
            description: 'Locked for 5 minutes.',
            variant: 'destructive',
          });
          return;
        }
      } catch {
        // ignore attempt tracking errors
      }
      toast({
        title: 'Invalid key',
        description: error?.message || 'Unable to save the privacy key.',
        variant: 'destructive',
      });
    } finally {
      setKeyRegistrationPending(false);
    }
  };

  const handleDeletePrivacyKey = () => {
    if (!contract?.id) return;
    const keys = loadContractKeys();
    delete keys[contract.id];
    localStorage.setItem('nebulon_contract_keys', JSON.stringify(keys));
    setShowDeleteKeyModal(false);
    fetchContractDetails().catch(() => null);
    toast({
      title: 'Privacy key removed',
      description: 'Encrypted milestones will be hidden on this device.',
      variant: 'warning',
    });
  };

  const handleInit = async () => {
    if (!contract) return;
    
    setActionLoading(true);
    try {
      console.log('[init] start', { contractId, hasEscrow: Boolean(contract.escrow_pda) });
      // Check if contract is in valid state for initialization
      if (contract.escrow_pda) {
        alert('Escrow already initialized');
        return;
      }

      if (!contract.client_wallet || !contract.contractor_wallet) {
        alert('Invite not accepted yet');
        return;
      }

      console.log('[init] ensureExecutionMode');
      const modeToUse = await ensureExecutionMode();
      const config = backendConfig || (await loadBackendConfig());

      // Create escrow on Solana
      console.log('[init] createEscrowOnChain', { modeToUse });
      const escrowResult = await createEscrowOnChain(modeToUse, config);
      
      // Link escrow to contract via API
      console.log('[init] linkEscrowToContract', { escrowPda: escrowResult?.escrowPda });
      await linkEscrowToContract(escrowResult);

      toast({
        title: 'Contract initialized',
        description: 'Escrow was created and linked successfully.',
      });
      fetchContractDetails();
    } catch (error: any) {
      console.error('Error initializing contract:', error);
      toast({
        title: 'Initialization failed',
        description: error?.message || 'Unable to initialize contract.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const loadBackendConfig = async () => {
    if (backendConfig) {
      return backendConfig;
    }
    const response = await fetch(`${API_URL}/v1/config`);
    if (!response.ok) {
      throw new Error('Failed to load backend config.');
    }
    const data = await response.json();
    setBackendConfig(data || null);
    return data as BackendConfig;
  };

  const updateExecutionMode = async (mode: 'per' | 'l1') => {
    if (!contractId) return;
    setModeUpdating(true);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/v1/contracts/${contractId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ executionMode: mode }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update execution mode');
      }
      setExecutionMode(mode);
      fetchContractDetails();
    } finally {
      setModeUpdating(false);
    }
  };

  const ensureExecutionMode = async () => {
    const config = backendConfig || (await loadBackendConfig());
    const network = (config?.network || '').toLowerCase();
    const localnet = network === 'localnet';
    const devnet = network === 'devnet';
    const currentMode =
      (contract?.execution_mode || executionMode || 'per').toLowerCase() === 'l1' ? 'l1' : 'per';

    if (localnet) {
      setExecutionMode('per');
      return 'per';
    }

    if (currentMode === 'l1') {
      setExecutionMode('l1');
      return 'l1';
    }

    if (devnet) {
      if (teeStatus === 'available') {
        setExecutionMode('per');
        return 'per';
      }
      if (teeStatus === 'unavailable') {
        setExecutionMode(currentMode);
        return currentMode;
      }
      const teeCheck = await checkTEEAvailability();
      if (teeCheck.ok) {
        setExecutionMode('per');
        return 'per';
      }
      setTeeStatus('unavailable');
      setExecutionMode(currentMode);
      return currentMode;
    }

    return executionMode;
  };

  const handleTeeCheck = async () => {
    await checkTEEAvailability();
  };

  const handleModeSelect = async (mode: 'per' | 'l1') => {
    if (!canSelectL1 && mode === 'l1') {
      return;
    }
    if (mode === 'per' && perDisabled) {
      return;
    }
    if (mode === executionMode) {
      return;
    }
    await updateExecutionMode(mode);
  };

  const checkTEEAvailability = async () => {
    const config = backendConfig || (await loadBackendConfig());
    if (executionMode === 'l1' || contract?.execution_mode === 'l1') {
      return { ok: false, reason: 'l1_mode' };
    }
    if (!publicKey || !signMessage) {
      return { ok: false, reason: 'no_sign_message' };
    }
    const base = normalizeEndpoint(
      config?.ephemeralTeeEndpoint ||
        config?.ephemeralPermissionEndpoint ||
        'https://tee.magicblock.app'
    );
    setTeeStatus('checking');
    try {
      const auth = await getAuthToken(
        base,
        publicKey,
        (message) => signMessage(message)
      );
      if (!auth?.token) {
        setTeeStatus('unavailable');
        return { ok: false, reason: 'no_token' };
      }
      const rpcEndpoint = `${base}?token=${auth.token}`;
      let wsEndpoint =
        config?.ephemeralTeeWsEndpoint ||
        rpcEndpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      if (!wsEndpoint.includes('token=')) {
        wsEndpoint += wsEndpoint.includes('?') ? `&token=${auth.token}` : `?token=${auth.token}`;
      }
      const connection = new Connection(rpcEndpoint, {
        commitment: 'confirmed',
        wsEndpoint,
      });
      await connection.getVersion();
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const timeout = setTimeout(() => {
          if (!done) {
            done = true;
            reject(new Error('ws_timeout'));
          }
        }, 4000);
        const subId = connection.onSlotChange(() => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          connection.removeSlotChangeListener(subId);
          resolve();
        });
      });
      setTeeStatus('available');
      return { ok: true };
    } catch (error) {
      setTeeStatus('unavailable');
      return { ok: false, reason: 'error' };
    }
  };

  const deriveEscrowPda = (clientKey: PublicKey, escrowId: anchor.BN, programId: PublicKey) => {
    const ESCROW_SEED = 'escrow';
    const escrowBytes = escrowId.toArrayLike(Buffer, 'le', 8);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(ESCROW_SEED), clientKey.toBuffer(), escrowBytes],
      programId
    );
    return pda;
  };

  const derivePerVaultPda = (escrowPda: PublicKey, programId: PublicKey) => {
    const PER_VAULT_SEED = 'per-vault';
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PER_VAULT_SEED), escrowPda.toBuffer()],
      programId
    );
    return pda;
  };

  const deriveMilestonePda = (escrowPda: PublicKey, index: number, programId: PublicKey) => {
    const MILESTONE_SEED = 'milestone';
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([index])],
      programId
    );
    return pda;
  };

  const derivePrivateMilestonePda = (escrowPda: PublicKey, index: number, programId: PublicKey) => {
    const PRIVATE_MILESTONE_SEED = 'private-milestone';
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PRIVATE_MILESTONE_SEED), escrowPda.toBuffer(), Buffer.from([index])],
      programId
    );
    return pda;
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
    return { program, provider };
  };

  const isAlreadyExistsError = (error: any) => {
    const message = (error?.message || '').toLowerCase();
    return message.includes('already') || message.includes('exists');
  };

  const getDelegationValidator = (config: BackendConfig) => {
    const endpoint = (config.ephemeralProviderUrl || config.rpcUrl || '').toLowerCase();
    if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
      return LOCAL_VALIDATOR_IDENTITY;
    }
    if (config.ephemeralValidatorIdentity) {
      return new PublicKey(config.ephemeralValidatorIdentity);
    }
    return null;
  };

  const ensureDelegatedPermission = async (
    provider: anchor.AnchorProvider,
    permissionedAccount: PublicKey,
    validator?: PublicKey | null
  ) => {
    if (!validator) {
      return;
    }
    const permissionPda = permissionPdaFromAccount(permissionedAccount);
    const info = await provider.connection.getAccountInfo(permissionPda, 'confirmed');
    if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
      return;
    }
    if (info && !info.owner.equals(PERMISSION_PROGRAM_ID)) {
      throw new Error(
        `Permission ${permissionPda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${PERMISSION_PROGRAM_ID.toBase58()}.`
      );
    }
    const ix = createDelegatePermissionInstruction({
      payer: publicKey!,
      validator,
      permissionedAccount: [permissionedAccount, false],
      authority: [publicKey!, true],
    });
    const permissionMeta = ix.keys.find((key) => key.pubkey.equals(permissionedAccount));
    if (permissionMeta) {
      permissionMeta.isWritable = true;
    }
    const tx = new Transaction().add(ix);
    try {
      await provider.sendAndConfirm(tx, []);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  };

  const ensureDelegatedAccount = async (
    program: anchor.Program,
    accountType: any,
    pda: PublicKey,
    validator?: PublicKey | null
  ) => {
    if (!validator) {
      return;
    }
    const info = await program.provider.connection.getAccountInfo(pda, 'confirmed');
    if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
      return;
    }
    const isPerVault = accountType && Object.prototype.hasOwnProperty.call(accountType, 'perVault');
    if (
      info &&
      !info.owner.equals(program.programId) &&
      !(isPerVault && info.owner.equals(SystemProgram.programId))
    ) {
      throw new Error(
        `Account ${pda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${program.programId.toBase58()}.`
      );
    }
    try {
      await program.methods
        .delegateAccount(accountType)
        .accounts({
          payer: publicKey,
          pda,
        })
        .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
        .rpc();
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  };

  const ensureDelegatedEscrow = async (
    program: anchor.Program,
    escrowId: anchor.BN,
    escrowPda: PublicKey,
    client: PublicKey,
    validator?: PublicKey | null
  ) => {
    if (!validator) {
      return;
    }
    const info = await program.provider.connection.getAccountInfo(escrowPda, 'confirmed');
    if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
      return;
    }
    if (info && !info.owner.equals(program.programId)) {
      throw new Error(
        `Escrow ${escrowPda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${program.programId.toBase58()}.`
      );
    }
    try {
      await program.methods
        .delegateEscrow(new anchor.BN(escrowId.toString()))
        .accounts({
          payer: publicKey,
          pda: escrowPda,
          client,
        })
        .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
        .rpc();
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  };

  const getContractPrivacyKey = async (id: string) => {
    const { entry } = ensureContractKeypair(id);
    if (!entry?.secretKey) {
      throw new Error('privacy_key_missing');
    }
    const token = localStorage.getItem('authToken');
    if (!token || !publicKey) {
      if (isLocalnet || network === 'devnet') {
        toast({
          title: 'Using local privacy key',
          description: 'Auth missing; using a local-only privacy key for testing.',
          variant: 'warning',
        });
        return deriveContractKey(entry.secretKey, entry.publicKey, id);
      }
      throw new Error('auth_missing');
    }
    const keyResponse = await fetch(`${API_URL}/v1/contracts/${id}/keys`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    if (!keyResponse.ok) {
      if (isLocalnet || network === 'devnet') {
        toast({
          title: 'Using local privacy key',
          description: 'Backend keys unavailable; using a local-only privacy key for testing.',
          variant: 'warning',
        });
        return deriveContractKey(entry.secretKey, entry.publicKey, id);
      }
      throw new Error('keys_unavailable');
    }
    const keyData = await keyResponse.json();
    const keys = Array.isArray(keyData.keys) ? keyData.keys : [];
    const peer = keys.find((key) => key.wallet !== publicKey.toString());
    if (!peer?.public_key) {
      if (isLocalnet || network === 'devnet') {
        toast({
          title: 'Using local privacy key',
          description: 'Peer key missing; using a local-only privacy key for testing.',
          variant: 'warning',
        });
        return deriveContractKey(entry.secretKey, entry.publicKey, id);
      }
      throw new Error('peer_key_missing');
    }
    return deriveContractKey(entry.secretKey, peer.public_key, id);
  };

  const ensurePrivateMilestonePrepared = async (
    program: anchor.Program,
    escrowPda: PublicKey,
    escrowId: anchor.BN,
    privateMilestonePda: PublicKey,
    perVaultPda: PublicKey,
    index: number,
    config: BackendConfig,
    validator?: PublicKey | null,
    onStep?: (label: string, progress: number) => void
  ) => {
    const connection = program.provider.connection;
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }
    const instructions: TransactionInstruction[] = [];
    const permissionPda = permissionPdaFromAccount(privateMilestonePda);
    const [milestoneInfo, perVaultInfo, escrowInfo, permissionInfo] = await Promise.all([
      connection.getAccountInfo(privateMilestonePda, 'confirmed'),
      connection.getAccountInfo(perVaultPda, 'confirmed'),
      connection.getAccountInfo(escrowPda, 'confirmed'),
      connection.getAccountInfo(permissionPda, 'confirmed'),
    ]);

    onStep?.('Checking PER prep', 40);
    if (!milestoneInfo) {
      const initIx = await program.methods
        .initPrivateMilestoneStub(escrowId, index)
        .accounts({
          payer: publicKey,
          escrow: escrowPda,
          privateMilestone: privateMilestonePda,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      instructions.push(initIx);
    } else if (
      !milestoneInfo.owner.equals(program.programId) &&
      !milestoneInfo.owner.equals(DELEGATION_PROGRAM_ID)
    ) {
      throw new Error(
        `Private milestone ${privateMilestonePda.toBase58()} is owned by ${milestoneInfo.owner.toBase58()}, expected ${program.programId.toBase58()}`
      );
    }

    const members = [
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract!.client_wallet) },
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract!.contractor_wallet) },
    ];

    onStep?.('Preparing permission record', 50);
    const permissionOwnedByDelegation =
      permissionInfo && permissionInfo.owner.equals(DELEGATION_PROGRAM_ID);
    const permissionOwnedByProgram =
      permissionInfo && permissionInfo.owner.equals(PERMISSION_PROGRAM_ID);
    if (permissionInfo && !permissionOwnedByDelegation && !permissionOwnedByProgram) {
      throw new Error(
        `Permission ${permissionPda.toBase58()} is owned by ${permissionInfo.owner.toBase58()}, expected ${PERMISSION_PROGRAM_ID.toBase58()}`
      );
    }
    if (!permissionInfo) {
      const createPermissionIx = await program.methods
        .createPermission({ privateMilestone: { escrow: escrowPda, index } }, members)
        .accountsPartial({
          payer: publicKey,
          permissionedAccount: privateMilestonePda,
          permission: permissionPda,
          permissionProgram: PERMISSION_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      instructions.push(createPermissionIx);
    }

    const delegatedValidator = validator || getDelegationValidator(config);
    if (delegatedValidator) {
      onStep?.('Delegating permission', 60);
      if (!permissionOwnedByDelegation) {
        const delegatePermissionIx = createDelegatePermissionInstruction({
          payer: publicKey,
          validator: delegatedValidator,
          permissionedAccount: [privateMilestonePda, false],
          authority: [publicKey, true],
        });
        const permissionMeta = delegatePermissionIx.keys.find((key) =>
          key.pubkey.equals(privateMilestonePda)
        );
        if (permissionMeta) {
          permissionMeta.isWritable = true;
        }
        instructions.push(delegatePermissionIx);
      }

      onStep?.('Delegating private milestone', 70);
      if (!milestoneInfo || !milestoneInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        const delegateMilestoneIx = await program.methods
          .delegateAccount({ privateMilestone: { escrow: escrowPda, index } })
          .accounts({
            payer: publicKey,
            pda: privateMilestonePda,
          })
          .remainingAccounts([{ pubkey: delegatedValidator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegateMilestoneIx);
      }

      onStep?.('Delegating per vault', 80);
      if (!perVaultInfo || !perVaultInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        if (
          perVaultInfo &&
          !perVaultInfo.owner.equals(program.programId) &&
          !perVaultInfo.owner.equals(SystemProgram.programId)
        ) {
          throw new Error(
            `Account ${perVaultPda.toBase58()} is owned by ${perVaultInfo.owner.toBase58()}, expected ${program.programId.toBase58()}.`
          );
        }
        const delegatePerVaultIx = await program.methods
          .delegateAccount({ perVault: { escrow: escrowPda } })
          .accounts({
            payer: publicKey,
            pda: perVaultPda,
          })
          .remainingAccounts([{ pubkey: delegatedValidator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegatePerVaultIx);
      }

      onStep?.('Delegating escrow', 85);
      if (!escrowInfo || !escrowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        if (escrowInfo && !escrowInfo.owner.equals(program.programId)) {
          throw new Error(
            `Escrow ${escrowPda.toBase58()} is owned by ${escrowInfo.owner.toBase58()}, expected ${program.programId.toBase58()}`
          );
        }
        const delegateEscrowIx = await program.methods
          .delegateEscrow(new anchor.BN(escrowId.toString()))
          .accounts({
            payer: publicKey,
            pda: escrowPda,
            client: new PublicKey(contract!.client_wallet),
          })
          .remainingAccounts([{ pubkey: delegatedValidator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegateEscrowIx);
      }
    }

    if (instructions.length) {
      onStep?.('Submitting PER prep batch', 88);
      const withBudget = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...instructions,
      ];
      await sendIxsWithWallet(connection, anchorWallet, withBudget);
    }
  };
  type SendIxOptions = {
    confirm?: boolean;
    onConfirmed?: (signature: string) => void;
    onError?: (error: unknown) => void;
  };

  const sendIxWithWallet = async (
    connection: Connection,
    anchorWallet: anchor.Wallet,
    ix: TransactionInstruction,
    options?: SendIxOptions
  ) => {
    const txStart = performance.now();
    console.log('[sign] sendIxWithWallet: start');
    const latest = await connection.getLatestBlockhash();
    console.log('[sign] sendIxWithWallet: got blockhash', Math.round(performance.now() - txStart), 'ms');
    const tx = new Transaction({
      feePayer: anchorWallet.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(ix);
    console.log('[sign] sendIxWithWallet: prompt sign', Math.round(performance.now() - txStart), 'ms');
    const signed = await anchorWallet.signTransaction(tx);
    console.log('[sign] sendIxWithWallet: signed', Math.round(performance.now() - txStart), 'ms');
    const sig = await connection.sendRawTransaction(signed.serialize());
    const confirmPromise = connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    if (options?.confirm === false) {
      console.log('[sign] sendIxWithWallet: confirming in background');
      void confirmPromise
        .then(() => {
          console.log('[sign] sendIxWithWallet: confirmed (bg)', Math.round(performance.now() - txStart), 'ms');
          options?.onConfirmed?.(sig);
        })
        .catch((error) => {
          console.warn('[sign] sendIxWithWallet: confirm failed (bg)', error);
          options?.onError?.(error);
        });
      return sig;
    }
    await confirmPromise;
    console.log('[sign] sendIxWithWallet: confirmed', Math.round(performance.now() - txStart), 'ms');
    return sig;
  };

  const sendIxsWithWallet = async (
    connection: Connection,
    anchorWallet: anchor.Wallet,
    instructions: TransactionInstruction[],
    options?: SendIxOptions
  ) => {
    if (!instructions.length) {
      throw new Error('No instructions to send.');
    }
    const txStart = performance.now();
    const latest = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: anchorWallet.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(...instructions);
    const signed = await anchorWallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    const confirmPromise = connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    if (options?.confirm === false) {
      void confirmPromise
        .then(() => {
          options?.onConfirmed?.(sig);
        })
        .catch((error) => {
          options?.onError?.(error);
        });
      return sig;
    }
    await confirmPromise;
    return sig;
  };

  const buildTeeProgram = async (config: BackendConfig, signerKeypair?: Keypair) => {
    const authorityWallet = getAnchorWallet(wallet);
    if (!authorityWallet || !publicKey || !signMessage) {
      throw new Error('wallet_not_ready');
    }
    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    if (isLocalnet) {
      const rpcEndpoint = config.ephemeralProviderUrl || config.rpcUrl || 'http://localhost:8899';
      const wsEndpoint = config.ephemeralWsUrl || config.wsUrl || undefined;
      const teeConnection = new Connection(rpcEndpoint, {
        commitment: 'confirmed',
        wsEndpoint,
      });
      const anchorWallet = signerKeypair ? getKeypairWallet(signerKeypair) : authorityWallet;
      const { program } = buildProgram(teeConnection, programId, anchorWallet);
      return { program, programId, connection: teeConnection, anchorWallet, authorityWallet };
    }
    const base = normalizeEndpoint(
      config.ephemeralTeeEndpoint ||
        config.ephemeralPermissionEndpoint ||
        'https://tee.magicblock.app'
    );
    const auth = await getAuthToken(base, publicKey, (message) => signMessage(message));
    if (!auth?.token) {
      throw new Error('tee_token_missing');
    }
    const rpcEndpoint = `${base}?token=${auth.token}`;
    let wsEndpoint =
      config.ephemeralTeeWsEndpoint ||
      rpcEndpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    if (!wsEndpoint.includes('token=')) {
      wsEndpoint += wsEndpoint.includes('?') ? `&token=${auth.token}` : `?token=${auth.token}`;
    }
    const teeConnection = new Connection(rpcEndpoint, {
      commitment: 'confirmed',
      wsEndpoint,
    });
    const anchorWallet = signerKeypair ? getKeypairWallet(signerKeypair) : authorityWallet;
    const { program } = buildProgram(teeConnection, programId, anchorWallet);
    return { program, programId, connection: teeConnection, anchorWallet, authorityWallet };
  };

  const sendIxWithSigner = async (connection: Connection, signer: Keypair, ix: TransactionInstruction) => {
    const latest = await connection.getLatestBlockhash();
    const tx = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: latest.blockhash,
    }).add(ix);
    tx.sign(signer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    return sig;
  };

  const loadSessionSigner = (authority: string) => {
    if (typeof window === 'undefined') return null;
    const key = `nebulon_session_signer:${authority}`;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const secret = bs58.decode(raw);
      return Keypair.fromSecretKey(secret);
    } catch {
      return null;
    }
  };

  const saveSessionSigner = (authority: string, signer: Keypair) => {
    if (typeof window === 'undefined') return;
    const key = `nebulon_session_signer:${authority}`;
    localStorage.setItem(key, bs58.encode(signer.secretKey));
  };

  const clearSessionSigner = (authority: string) => {
    if (typeof window === 'undefined') return;
    const key = `nebulon_session_signer:${authority}`;
    localStorage.removeItem(key);
  };

  const deriveSessionTokenPda = (
    sessionProgramId: PublicKey,
    programId: PublicKey,
    signer: PublicKey,
    authority: PublicKey
  ) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from('session_token'),
        programId.toBytes(),
        signer.toBytes(),
        authority.toBytes(),
      ],
      sessionProgramId
    )[0];

  const ensureSessionToken = async (config: BackendConfig, programId: PublicKey) => {
    const authorityWallet = getAnchorWallet(wallet);
    if (!authorityWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const provider = new anchor.AnchorProvider(connection, authorityWallet, {
      commitment: 'confirmed',
    });
    const sessionManager = new SessionTokenManager(provider.wallet, provider.connection);
    const authority = authorityWallet.publicKey;
    let sessionSigner = loadSessionSigner(authority.toBase58());
    if (!sessionSigner) {
      sessionSigner = Keypair.generate();
      saveSessionSigner(authority.toBase58(), sessionSigner);
    }
    const sessionProgramId = sessionManager.program.programId;
    let sessionPda = deriveSessionTokenPda(
      sessionProgramId,
      programId,
      sessionSigner.publicKey,
      authority
    );
    const now = Math.floor(Date.now() / 1000);
    let existing = null;
    try {
      existing = await sessionManager.get(sessionPda);
    } catch {
      existing = null;
    }
    const existingUntil = existing?.validUntil ?? existing?.valid_until ?? null;
    if (existingUntil && Number(existingUntil) > now + 30) {
      return { sessionSigner, sessionPda, created: false };
    }
    if (existing) {
      try {
        const revokeTx = await sessionManager.program.methods
          .revokeSession()
          .accounts({
            sessionToken: sessionPda,
            authority,
            systemProgram: SystemProgram.programId,
          })
          .transaction();
        await provider.sendAndConfirm(revokeTx, []);
      } catch {
        sessionSigner = Keypair.generate();
        saveSessionSigner(authority.toBase58(), sessionSigner);
        sessionPda = deriveSessionTokenPda(
          sessionProgramId,
          programId,
          sessionSigner.publicKey,
          authority
        );
      }
    }
    const validUntil = new anchor.BN(now + 3600);
    const tx = await sessionManager.program.methods
      .createSession(true, validUntil, new anchor.BN(0))
      .accounts({
        targetProgram: programId,
        sessionSigner: sessionSigner.publicKey,
        authority,
      })
      .transaction();
    await provider.sendAndConfirm(tx, [sessionSigner]);
    return { sessionSigner, sessionPda, created: true };
  };

  const checkSessionStatus = async () => {
    if (!isLocalnet) {
      setPerSetupReady(false);
      setPerSetupChecked(true);
      return;
    }
    if (!publicKey || !backendConfig?.programId) {
      return;
    }
    const authorityWallet = getAnchorWallet(wallet);
    if (!authorityWallet) {
      return;
    }
    setPerSetupLoading(true);
    try {
      const programId = new PublicKey(backendConfig.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(backendConfig.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: backendConfig.wsUrl || undefined,
      });
      const provider = new anchor.AnchorProvider(connection, authorityWallet, {
        commitment: 'confirmed',
      });
      const sessionManager = new SessionTokenManager(provider.wallet, provider.connection);
      const authority = authorityWallet.publicKey;
      const sessionSigner = loadSessionSigner(authority.toBase58());
      if (!sessionSigner) {
        setPerSetupReady(false);
        setPerSetupChecked(true);
        return;
      }
      const sessionProgramId = sessionManager.program.programId;
      const sessionPda = deriveSessionTokenPda(
        sessionProgramId,
        programId,
        sessionSigner.publicKey,
        authority
      );
      let existing = null;
      try {
        existing = await sessionManager.get(sessionPda);
      } catch {
        existing = null;
      }
      const now = Math.floor(Date.now() / 1000);
      const existingUntil = existing?.validUntil ?? existing?.valid_until ?? null;
      const ready = Boolean(existingUntil && Number(existingUntil) > now + 30);
      setPerSetupReady(ready);
      setPerSetupChecked(true);
    } finally {
      setPerSetupLoading(false);
    }
  };

  const handleDropSession = async () => {
    if (!isLocalnet || !backendConfig?.programId) {
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to manage session keys.',
        variant: 'destructive',
      });
      return;
    }
    const authorityWallet = getAnchorWallet(wallet);
    if (!authorityWallet) {
      return;
    }
    setPerSetupLoading(true);
    try {
      const programId = new PublicKey(backendConfig.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(backendConfig.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: backendConfig.wsUrl || undefined,
      });
      const provider = new anchor.AnchorProvider(connection, authorityWallet, {
        commitment: 'confirmed',
      });
      const sessionManager = new SessionTokenManager(provider.wallet, provider.connection);
      const authority = authorityWallet.publicKey;
      const sessionSigner = loadSessionSigner(authority.toBase58());
      if (!sessionSigner) {
        setPerSetupReady(false);
        setPerSetupChecked(true);
        return;
      }
      const sessionProgramId = sessionManager.program.programId;
      const sessionPda = deriveSessionTokenPda(
        sessionProgramId,
        programId,
        sessionSigner.publicKey,
        authority
      );
      const revokeIx = await sessionManager.program.methods
        .revokeSession()
        .accounts({
          sessionToken: sessionPda,
          authority,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      let latest = cachedBlockhash;
      if (!latest || Date.now() - latest.fetchedAt > 20000) {
        const fresh = await connection.getLatestBlockhash();
        latest = { ...fresh, fetchedAt: Date.now() };
        setCachedBlockhash(latest);
      }
      const tx = new Transaction({
        feePayer: authorityWallet.publicKey,
        recentBlockhash: latest.blockhash,
      }).add(revokeIx);
      const signed = await authorityWallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed'
      );
      clearSessionSigner(authority.toBase58());
      setPerSetupReady(false);
      setPerSetupChecked(true);
      toast({
        title: 'Session dropped',
        description: 'A new session key will be created next time.',
        variant: 'success',
      });
    } catch (error: any) {
      toast({
        title: 'Drop failed',
        description: error?.message || 'Unable to revoke session key.',
        variant: 'destructive',
      });
    } finally {
      setPerSetupLoading(false);
    }
  };

  const handlePreparePerSession = async () => {
    if (!contract) return;
    if (!isLocalnet) {
      toast({
        title: 'PER setup not required',
        description: 'Session keys are only used on localnet.',
        variant: 'warning',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to prepare PER.',
        variant: 'destructive',
      });
      return;
    }
    setPerSetupLoading(true);
    setPerSetupStep('Checking session');
    setPerSetupProgress(20);
    try {
      const config = backendConfig || (await loadBackendConfig());
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      setPerSetupStep('Creating session key (wallet signature)');
      setPerSetupProgress(60);
      const session = await ensureSessionToken(config, programId);
      setPerSetupStep(session.created ? 'Session created' : 'Session reused');
      setPerSetupProgress(90);
      setPerSetupReady(true);
      setPerSetupStep('PER ready');
      setPerSetupProgress(100);
      toast({
        title: 'PER ready',
        description: 'Session key is ready for private transactions.',
        variant: 'success',
      });
      setPerSetupChecked(true);
    } catch (error: any) {
      toast({
        title: 'PER setup failed',
        description: error?.message || 'Unable to prepare PER session.',
        variant: 'destructive',
      });
    } finally {
      setPerSetupLoading(false);
      setTimeout(() => {
        setPerSetupStep(null);
        setPerSetupProgress(0);
      }, 1000);
    }
  };

  const fetchEscrowId = async (program: anchor.Program, escrowPda: PublicKey) => {
    const escrowAccount: any = await program.account.escrow.fetch(escrowPda);
    return new anchor.BN(escrowAccount.escrowId.toString());
  };

  const ensureTermsPrepared = async (
    program: anchor.Program,
    escrowPda: PublicKey,
    escrowId: anchor.BN,
    termsPda: PublicKey,
    perVaultPda: PublicKey,
    validator?: PublicKey | null
  ) => {
    const connection = program.provider.connection;
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }
    const instructions: TransactionInstruction[] = [];
    const permissionPda = permissionPdaFromAccount(termsPda);
    const [termsInfo, perVaultInfo, escrowInfo, permissionInfo] = await Promise.all([
      connection.getAccountInfo(termsPda, 'confirmed'),
      connection.getAccountInfo(perVaultPda, 'confirmed'),
      connection.getAccountInfo(escrowPda, 'confirmed'),
      connection.getAccountInfo(permissionPda, 'confirmed'),
    ]);

    if (!termsInfo) {
      const initIx = await program.methods
        .initPrivateTermsStub(escrowId)
        .accounts({
          payer: publicKey,
          escrow: escrowPda,
          terms: termsPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      instructions.push(initIx);
    } else if (
      !termsInfo.owner.equals(program.programId) &&
      !termsInfo.owner.equals(DELEGATION_PROGRAM_ID)
    ) {
      throw new Error(
        `Terms ${termsPda.toBase58()} is owned by ${termsInfo.owner.toBase58()}, expected ${program.programId.toBase58()}`
      );
    }

    const members = [
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract!.client_wallet) },
      { flags: AUTHORITY_FLAG | TX_LOGS_FLAG, pubkey: new PublicKey(contract!.contractor_wallet) },
    ];

    const permissionOwnedByDelegation =
      permissionInfo && permissionInfo.owner.equals(DELEGATION_PROGRAM_ID);
    const permissionOwnedByProgram =
      permissionInfo && permissionInfo.owner.equals(PERMISSION_PROGRAM_ID);
    if (permissionInfo && !permissionOwnedByDelegation && !permissionOwnedByProgram) {
      throw new Error(
        `Permission ${permissionPda.toBase58()} is owned by ${permissionInfo.owner.toBase58()}, expected ${PERMISSION_PROGRAM_ID.toBase58()}`
      );
    }
    if (!permissionInfo) {
      const createPermissionIx = await program.methods
        .createPermission({ terms: { escrow: escrowPda } }, members)
        .accountsPartial({
          payer: publicKey,
          permissionedAccount: termsPda,
          permission: permissionPda,
          permissionProgram: PERMISSION_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      instructions.push(createPermissionIx);
    }

    if (validator) {
      if (!permissionOwnedByDelegation) {
        const permIx = createDelegatePermissionInstruction({
          payer: publicKey,
          validator,
          permissionedAccount: [termsPda, false],
          authority: [publicKey, true],
        });
        const permissionMeta = permIx.keys.find((key) => key.pubkey.equals(termsPda));
        if (permissionMeta) {
          permissionMeta.isWritable = true;
        }
        instructions.push(permIx);
      }

      if (!termsInfo || !termsInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        const delegateTermsIx = await program.methods
          .delegateAccount({ terms: { escrow: escrowPda } })
          .accounts({
            payer: publicKey,
            pda: termsPda,
          })
          .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegateTermsIx);
      }

      if (!perVaultInfo || !perVaultInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        if (
          perVaultInfo &&
          !perVaultInfo.owner.equals(program.programId) &&
          !perVaultInfo.owner.equals(SystemProgram.programId)
        ) {
          throw new Error(
            `Account ${perVaultPda.toBase58()} is owned by ${perVaultInfo.owner.toBase58()}, expected ${program.programId.toBase58()}.`
          );
        }
        const delegatePerVaultIx = await program.methods
          .delegateAccount({ perVault: { escrow: escrowPda } })
          .accounts({
            payer: publicKey,
            pda: perVaultPda,
          })
          .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegatePerVaultIx);
      }

      if (!escrowInfo || !escrowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        if (escrowInfo && !escrowInfo.owner.equals(program.programId)) {
          throw new Error(
            `Escrow ${escrowPda.toBase58()} is owned by ${escrowInfo.owner.toBase58()}, expected ${program.programId.toBase58()}`
          );
        }
        const delegateEscrowIx = await program.methods
          .delegateEscrow(escrowId)
          .accounts({
            payer: publicKey,
            pda: escrowPda,
            client: new PublicKey(contract!.client_wallet),
          })
          .remainingAccounts([{ pubkey: validator, isWritable: false, isSigner: false }])
          .instruction();
        instructions.push(delegateEscrowIx);
      }
    }

    if (instructions.length) {
      const withBudget = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...instructions,
      ];
      await sendIxsWithWallet(connection, anchorWallet, withBudget);
    }
  };

  const deriveAssociatedTokenAddress = (mint: PublicKey, owner: PublicKey) => {
    const [pda] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return pda;
  };

  const buildCreateAtaInstruction = (
    payer: PublicKey,
    ata: PublicKey,
    owner: PublicKey,
    mint: PublicKey
  ) =>
    new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([0]),
    });

  const buildCreateEscrowIx = (
    programId: PublicKey,
    payer: PublicKey,
    client: PublicKey,
    contractor: PublicKey,
    mint: PublicKey,
    escrow: PublicKey,
    perVault: PublicKey,
    vaultToken: PublicKey,
    escrowId: anchor.BN
  ) => {
    const data = instructionCoder.encode('create_escrow', {
      escrow_id: escrowId,
      _judge: FEE_RECEIVER,
    });

    const keys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: client, isSigner: false, isWritable: false },
      { pubkey: contractor, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: perVault, isSigner: false, isWritable: true },
      { pubkey: vaultToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    return new TransactionInstruction({
      programId,
      keys,
      data,
    });
  };

  const createEscrowOnChain = async (mode: string, config: BackendConfig) => {
    if (!contract) throw new Error('Contract not loaded');
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('Wallet not ready for signing.');
    }

    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    console.log('[init] programId', programId.toBase58());
    const rpcUrl = config.rpcUrl || 'http://localhost:8899';
    const connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const mintValue = contract.mint || config.usdcMint;
    if (!mintValue) {
      throw new Error('USDC mint not configured.');
    }
    const mint = new PublicKey(mintValue);

    const escrowId = new anchor.BN(Date.now());
    const clientKey = new PublicKey(contract.client_wallet);
    const contractorKey = new PublicKey(contract.contractor_wallet);
    const escrowPda = deriveEscrowPda(clientKey, escrowId, programId);
    const perVaultPda = derivePerVaultPda(escrowPda, programId);
    const vaultToken = deriveAssociatedTokenAddress(mint, escrowPda);

    const [programInfo, ataInfo, mintInfo] = await Promise.all([
      connection.getAccountInfo(programId),
      connection.getAccountInfo(ASSOCIATED_TOKEN_PROGRAM_ID),
      connection.getAccountInfo(mint),
    ]);
    if (!programInfo || !programInfo.executable) {
      throw new Error('Nebulon program is not deployed on this network.');
    }
    console.log('[init] programInfo ok');
    if (!ataInfo || !ataInfo.executable) {
      throw new Error('Associated Token Program is not available on this network.');
    }
    console.log('[init] ata program ok');
    if (!mintInfo) {
      throw new Error(
        'USDC mint is not initialized on this network. Create the mint or request faucet first.'
      );
    }
    console.log('[init] mint ok', mint.toBase58());

    const ix = buildCreateEscrowIx(
      programId,
      publicKey,
      clientKey,
      contractorKey,
      mint,
      escrowPda,
      perVaultPda,
      vaultToken,
      escrowId
    );
    console.log('[init] escrow keys', {
      escrowPda: escrowPda.toBase58(),
      perVaultPda: perVaultPda.toBase58(),
      vaultToken: vaultToken.toBase58(),
      escrowId: escrowId.toString(),
    });

    console.log('[init] getLatestBlockhash: start');
    const latest = await connection.getLatestBlockhash();
    console.log('[init] getLatestBlockhash: done', latest);
    const tx = new Transaction({
      feePayer: publicKey,
      recentBlockhash: latest.blockhash,
    }).add(ix);

    console.log('[init] signTransaction: prompt');
    const signed = await anchorWallet.signTransaction(tx);
    console.log('[init] signTransaction: done');
    console.log('[init] signed tx, sending');
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(
      { signature: sig, ...latest },
      'confirmed'
    );
    console.log('[init] tx confirmed', sig);

    return {
      escrowPda: escrowPda.toBase58(),
      vaultToken: vaultToken.toBase58(),
      mint: mint.toBase58(),
      escrowId: escrowId.toString(),
      executionMode: mode,
    };
  };

  const linkEscrowToContract = async (escrowResult: any) => {
    const token = localStorage.getItem('authToken');
    const response = await fetch(
      `${API_URL}/v1/contracts/${contractId}/link-escrow`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          escrowPda: escrowResult.escrowPda,
          mint: escrowResult.mint,
          vaultToken: escrowResult.vaultToken,
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to link escrow');
    }

    return await response.json();
  };

  const handleSign = async () => {
    if (!contractId || !contract) return;
    if (!canSignContract) {
      toast({
        title: 'Cannot sign yet',
        description: 'Set terms and add at least one milestone first.',
        variant: 'warning',
      });
      return;
    }

    if (!contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Initialize the contract before signing.',
        variant: 'destructive',
      });
      return;
    }

    setActionLoading(true);
    const signStart = performance.now();
    console.log('[sign] handleSign: start');
    try {
      const token = localStorage.getItem('authToken');
      const anchorWallet = getAnchorWallet(wallet);
      if (!anchorWallet || !publicKey) {
        throw new Error('wallet_not_ready');
      }
      const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();
      const escrowPda = new PublicKey(contract.escrow_pda);
      const config = backendConfig || (await loadBackendConfig());
      console.log('[sign] handleSign: loaded config', Math.round(performance.now() - signStart), 'ms');
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl || undefined,
      });
      const { program } = buildProgram(connection, programId, anchorWallet);
      console.log('[sign] handleSign: program ready', Math.round(performance.now() - signStart), 'ms');
      const escrowId = await fetchEscrowId(program, escrowPda);
      console.log('[sign] handleSign: fetched escrowId', Math.round(performance.now() - signStart), 'ms');

      if (mode === 'l1') {
        console.log('[sign] handleSign: L1 signing', Math.round(performance.now() - signStart), 'ms');
        const { signIx, commitIx } = await buildPublicTermsIxs(program, escrowPda, escrowId);
        const sig = await sendIxsWithWallet(connection, anchorWallet, [signIx, commitIx], {
          confirm: false,
        });
        console.log('[sign] handleSign: L1 sign+commit tx sent', Math.round(performance.now() - signStart), 'ms');
        toast({
          title: 'Signature submitted',
          description: renderTxCopy(sig),
          variant: 'success',
        });
      } else {
        if (!signMessage) {
          toast({
            title: 'Wallet lacks signMessage',
            description: 'PER mode requires signMessage for TEE auth.',
            variant: 'destructive',
          });
          return;
        }
        console.log('[sign] handleSign: PER prep start', Math.round(performance.now() - signStart), 'ms');
        const perVaultPda = derivePerVaultPda(escrowPda, programId);
        const validator = config.ephemeralValidatorIdentity
          ? new PublicKey(config.ephemeralValidatorIdentity)
          : null;
        await ensureTermsPrepared(
          program,
          escrowPda,
          escrowId,
          deriveTermsPda(escrowPda, programId),
          perVaultPda,
          validator
        );
        console.log('[sign] handleSign: PER prep done', Math.round(performance.now() - signStart), 'ms');
        const signResult = await signPrivateTermsOnChain(escrowPda, escrowId);
        console.log('[sign] handleSign: PER sign tx sent', Math.round(performance.now() - signStart), 'ms');
        toast({
          title: 'Signature submitted',
          description: renderTxCopy(
            signResult.sig,
            signResult.signedWithSession ? 'Signed with session key.' : undefined
          ),
          variant: 'success',
        });
        try {
          const commitResult = await commitPrivateTermsOnChain(escrowPda, escrowId);
          toast({
            title: 'Terms committed',
            description: renderTxCopy(
              commitResult.sig,
              commitResult.signedWithSession ? 'Signed with session key.' : undefined
            ),
            variant: 'success',
          });
        } catch {
          // commit is best-effort
        }
      }

      if (contract.status === 'negotiating') {
        const lockResponse = await fetch(`${API_URL}/v1/contracts/${contractId}/lock`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            milestones,
          }),
        });
        if (!lockResponse.ok) {
          const errorData = await lockResponse.json();
          toast({
            title: 'Unable to lock contract',
            description: errorData.error || 'Unknown error',
            variant: 'destructive',
          });
          setActionLoading(false);
          return;
        }
      }

      const response = await fetch(`${API_URL}/v1/contracts/${contractId}/sign`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        await response.json();
        toast({
          title: 'Contract signed',
          description: 'Signature recorded successfully.',
          variant: 'success',
        });
        fetchContractDetails();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Failed to sign contract',
          description: errorData.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error signing contract:', error);
      toast({
        title: 'Failed to sign contract',
        description: 'Unable to sign contract.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const submitPublicTermsOnChain = async (deadlineSeconds: string, paymentBase: string) => {
    if (!contract || !contract.escrow_pda) {
      throw new Error('missing_escrow');
    }
    const config = backendConfig || (await loadBackendConfig());
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }

    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowId = await fetchEscrowId(program, escrowPda);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const termsHash = buildTermsHash(deadlineSeconds, paymentBase);

    const ix = await program.methods
      .setPublicTerms(
        escrowId,
        termsHash,
        new anchor.BN(paymentBase),
        new anchor.BN(deadlineSeconds)
      )
      .accounts({
        user: publicKey,
        escrow: escrowPda,
        terms: termsPda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    ix.keys = ix.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });

    const trySend = async () => {
      const latest = await connection.getLatestBlockhash();
      const tx = new Transaction({
        feePayer: publicKey,
        recentBlockhash: latest.blockhash,
      }).add(ix);
      const signed = await anchorWallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
      return sig;
    };

    try {
      return await trySend();
    } catch (error: any) {
      const message = String(error?.message || error);
      if (message.toLowerCase().includes('blockhash')) {
        return await trySend();
      }
      throw error;
    }
  };

  const signPublicTermsOnChain = async (
    escrowPda: PublicKey,
    escrowId: anchor.BN,
    options?: SendIxOptions
  ) => {
    const config = backendConfig || (await loadBackendConfig());
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }
    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const ix = await program.methods
      .signPublicTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    ix.keys = ix.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    const sig = await sendIxWithWallet(connection, anchorWallet, ix, options);
    return { sig, termsPda };
  };

  const buildPublicTermsIxs = async (
    program: anchor.Program,
    escrowPda: PublicKey,
    escrowId: anchor.BN
  ) => {
    const programId = program.programId as PublicKey;
    const termsPda = deriveTermsPda(escrowPda, programId);
    const signIx = await program.methods
      .signPublicTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    signIx.keys = signIx.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    const commitIx = await program.methods
      .commitPublicTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    commitIx.keys = commitIx.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    return { signIx, commitIx, termsPda };
  };

  const commitPublicTermsOnChain = async (
    escrowPda: PublicKey,
    escrowId: anchor.BN,
    options?: SendIxOptions
  ) => {
    const config = backendConfig || (await loadBackendConfig());
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }
    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const ix = await program.methods
      .commitPublicTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    ix.keys = ix.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    return sendIxWithWallet(connection, anchorWallet, ix, options);
  };

  const signPrivateTermsOnChain = async (escrowPda: PublicKey, escrowId: anchor.BN) => {
    const config = backendConfig || (await loadBackendConfig());
    let sessionSigner: Keypair | null = null;
    let sessionPda: PublicKey | null = null;
    if (isLocalnet) {
      const session = await ensureSessionToken(config, new PublicKey(config.programId || PROGRAM_ID_FALLBACK));
      sessionSigner = session.sessionSigner;
      sessionPda = session.sessionPda;
    }
    const { program, programId, connection, anchorWallet } = await buildTeeProgram(config, sessionSigner || undefined);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const ix = await program.methods
      .signPrivateTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        payer: sessionSigner ? sessionSigner.publicKey : publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    ix.keys = ix.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    const sig = sessionSigner
      ? await sendIxWithSigner(connection, sessionSigner, ix)
      : await sendIxWithWallet(connection, anchorWallet, ix);
    return { sig, termsPda, signedWithSession: Boolean(sessionSigner) };
  };

  const commitPrivateTermsOnChain = async (escrowPda: PublicKey, escrowId: anchor.BN) => {
    const config = backendConfig || (await loadBackendConfig());
    let sessionSigner: Keypair | null = null;
    let sessionPda: PublicKey | null = null;
    if (isLocalnet) {
      const session = await ensureSessionToken(config, new PublicKey(config.programId || PROGRAM_ID_FALLBACK));
      sessionSigner = session.sessionSigner;
      sessionPda = session.sessionPda;
    }
    const { program, programId, connection, anchorWallet } = await buildTeeProgram(config, sessionSigner || undefined);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const ix = await program.methods
      .commitTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: publicKey,
        payer: sessionSigner ? sessionSigner.publicKey : publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .instruction();
    ix.keys = ix.keys.map((key) => {
      if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
        return { ...key, isWritable: true };
      }
      return key;
    });
    const sig = sessionSigner
      ? await sendIxWithSigner(connection, sessionSigner, ix)
      : await sendIxWithWallet(connection, anchorWallet, ix);
    return { sig, signedWithSession: Boolean(sessionSigner) };
  };

  const submitPrivateTermsOnChain = async (deadlineSeconds: string, paymentBase: string) => {
    if (!contract || !contract.escrow_pda) {
      throw new Error('missing_escrow');
    }
    const config = backendConfig || (await loadBackendConfig());
    const anchorWallet = getAnchorWallet(wallet);
    if (!anchorWallet || !publicKey) {
      throw new Error('wallet_not_ready');
    }

    const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
    const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
      commitment: 'confirmed',
      wsEndpoint: config.wsUrl || undefined,
    });
    const { program } = buildProgram(connection, programId, anchorWallet);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowId = await fetchEscrowId(program, escrowPda);
    const termsPda = deriveTermsPda(escrowPda, programId);
    const perVaultPda = derivePerVaultPda(escrowPda, programId);
    const validator = config.ephemeralValidatorIdentity
      ? new PublicKey(config.ephemeralValidatorIdentity)
      : null;

    await ensureTermsPrepared(program, escrowPda, escrowId, termsPda, perVaultPda, validator);

    const privacyKey = await getContractPrivacyKey(contract.id);
    const encryptedTerms = await encryptPayload(
      privacyKey,
      JSON.stringify({ deadline: deadlineSeconds, totalPayment: paymentBase }),
      buildPrivacyContext('terms', contract.id)
    );
    const encryptedBytes = new TextEncoder().encode(encryptedTerms);
    const termsHash = buildTermsHash(deadlineSeconds, paymentBase);

    if (isLocalnet) {
      const session = await ensureSessionToken(config, programId);
      const sessionSigner = session.sessionSigner;
      const sessionPda = session.sessionPda;
      const { program: teeProgram, connection: teeConnection } = await buildTeeProgram(
        config,
        sessionSigner
      );

      const ix = await teeProgram.methods
        .createPrivateTerms(
          escrowId,
          termsHash,
          new anchor.BN(paymentBase),
          new anchor.BN(deadlineSeconds),
          Buffer.from(encryptedBytes)
        )
        .accounts({
          user: publicKey,
          payer: sessionSigner.publicKey,
          sessionToken: sessionPda,
          escrow: escrowPda,
          terms: termsPda,
          perVault: perVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      ix.keys = ix.keys.map((key) => {
        if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda) || key.pubkey.equals(perVaultPda)) {
          return { ...key, isWritable: true };
        }
        return key;
      });

      const sig = await sendIxWithSigner(teeConnection, sessionSigner, ix);
      return { sig, usedSession: true };
    }

    if (!signMessage) {
      throw new Error('wallet_not_ready');
    }

    const base = normalizeEndpoint(
      config.ephemeralTeeEndpoint ||
        config.ephemeralPermissionEndpoint ||
        'https://tee.magicblock.app'
    );
    const auth = await getAuthToken(base, publicKey, (message) => signMessage(message));
    if (!auth?.token) {
      throw new Error('tee_token_missing');
    }
    const rpcEndpoint = `${base}?token=${auth.token}`;
    let wsEndpoint =
      config.ephemeralTeeWsEndpoint ||
      rpcEndpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    if (!wsEndpoint.includes('token=')) {
      wsEndpoint += wsEndpoint.includes('?') ? `&token=${auth.token}` : `?token=${auth.token}`;
    }

    const teeConnection = new Connection(rpcEndpoint, {
      commitment: 'confirmed',
      wsEndpoint,
    });
    const { program: teeProgram } = buildProgram(teeConnection, programId, anchorWallet);
    const sig = await teeProgram.methods
      .createPrivateTerms(
        escrowId,
        termsHash,
        new anchor.BN(paymentBase),
        new anchor.BN(deadlineSeconds),
        Buffer.from(encryptedBytes)
      )
      .accounts({
        user: publicKey,
        payer: publicKey,
        sessionToken: null,
        escrow: escrowPda,
        terms: termsPda,
        perVault: perVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([])
      .rpc({ skipPreflight: true });

    return { sig, usedSession: false };
  };

  const handleSubmitTerms = async () => {
    if (!contractId || !contract) return;
    if (!contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Initialize the contract before submitting terms.',
        variant: 'destructive',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to submit terms.',
        variant: 'destructive',
      });
      return;
    }

    const preset = deadlinePreset.trim();
    const days =
      preset === 'custom' ? Number(customDeadlineDays) : Number(preset);
    if (!Number.isFinite(days) || days <= 0) {
      toast({
        title: 'Invalid deadline',
        description: 'Select a deadline or enter a valid number of days.',
        variant: 'warning',
      });
      return;
    }

    let paymentBase: string;
    try {
      paymentBase = parseUsdcToBase(paymentInput);
    } catch (error: any) {
      toast({
        title: 'Invalid payment',
        description: error?.message || 'Enter a valid USDC amount.',
        variant: 'warning',
      });
      return;
    }

    const deadlineSeconds = (-days * 86400).toString();
    await submitTermsWorkflow(deadlineSeconds, paymentBase);
  };

  const handleAddMilestone = async () => {
    if (!contractId || !contract) return;
    if (contract.status !== 'negotiating') {
      toast({
        title: 'Contract locked',
        description: 'Milestones cannot be changed after signing starts.',
        variant: 'warning',
      });
      return;
    }
    if (!milestoneDraft.trim()) {
      toast({
        title: 'Missing milestone',
        description: 'Enter a milestone detail.',
        variant: 'warning',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect a wallet to add milestones.',
        variant: 'destructive',
      });
      return;
    }
    if (!contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Initialize the contract before adding milestones.',
        variant: 'destructive',
      });
      return;
    }

    setMilestoneSaving(true);
    try {
      let currentStep = 'Starting';
      let txSig: string | null = null;
      setMilestoneStep('Starting');
      setMilestoneProgress(10);
      const anchorWallet = getAnchorWallet(wallet);
      if (!anchorWallet) {
        throw new Error('wallet_not_ready');
      }
      const config = backendConfig || (await loadBackendConfig());
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl || undefined,
      });
      const { program } = buildProgram(connection, programId, anchorWallet);
      const escrowPda = new PublicKey(contract.escrow_pda);
      const escrowId = await fetchEscrowId(program, escrowPda);
      const nextIndex = milestones.length;
      const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();

      let storedDetails = milestoneDraft.trim();
      if (mode === 'l1') {
        setMilestoneStep('Creating on-chain milestone');
        setMilestoneProgress(50);
        currentStep = 'Creating on-chain milestone (L1)';
        const milestonePda = deriveMilestonePda(escrowPda, nextIndex, programId);
        const ix = await program.methods
          .addMilestone(new anchor.BN(escrowId.toString()), nextIndex)
          .accounts({
            actor: publicKey,
            escrow: escrowPda,
            milestone: milestonePda,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        ix.keys = ix.keys.map((key) => {
          if (key.pubkey.equals(escrowPda) || key.pubkey.equals(milestonePda)) {
            return { ...key, isWritable: true };
          }
          return key;
        });
        txSig = await sendIxWithWallet(connection, anchorWallet, ix);
      } else {
        if (!signMessage) {
          throw new Error('wallet_missing_sign_message');
        }
        setMilestoneStep('Encrypting milestone');
        setMilestoneProgress(25);
        currentStep = 'Encrypting milestone';
        const privacyKey = await getContractPrivacyKey(contract.id);
        const encryptedDetails = await encryptPayload(
          privacyKey,
          JSON.stringify({ title: milestoneDraft.trim() }),
          buildPrivacyContext('milestone', contract.id, nextIndex)
        );
        storedDetails = encryptedDetails;

        const encoder = new TextEncoder();
        const encryptedBytes = encoder.encode(encryptedDetails);
        const expectedSize = 73;
        const paddedBytes = new Uint8Array(expectedSize);
        paddedBytes.set(encryptedBytes.slice(0, expectedSize));
        setMilestoneStep('Hashing milestone');
        setMilestoneProgress(35);
        currentStep = 'Hashing milestone';
        const hashBuffer = await crypto.subtle.digest('SHA-256', encryptedBytes);
        const descriptionHash = new Uint8Array(hashBuffer);

        const privateMilestonePda = derivePrivateMilestonePda(escrowPda, nextIndex, programId);
        const perVaultPda = derivePerVaultPda(escrowPda, programId);
        const validator = config.ephemeralValidatorIdentity
          ? new PublicKey(config.ephemeralValidatorIdentity)
          : null;
        setMilestoneStep('Preparing PER accounts');
        setMilestoneProgress(45);
        currentStep = 'Preparing PER accounts';
        await ensurePrivateMilestonePrepared(
          program,
          escrowPda,
          escrowId,
          privateMilestonePda,
          perVaultPda,
          nextIndex,
          config,
          validator,
          (label, progress) => {
            setMilestoneStep(label);
            setMilestoneProgress(progress);
          }
        );

        setMilestoneStep('Connecting to TEE');
        setMilestoneProgress(88);
        currentStep = 'Connecting to TEE';
        let sessionSigner: Keypair | null = null;
        let sessionPda: PublicKey | null = null;
        if (isLocalnet) {
          setMilestoneStep('Creating session key (wallet signature)');
          setMilestoneProgress(90);
          const session = await ensureSessionToken(config, programId);
          sessionSigner = session.sessionSigner;
          sessionPda = session.sessionPda;
          if (!session.created) {
            setMilestoneStep('Session key reused');
            setMilestoneProgress(92);
          }
        }
        setMilestoneStep('Submitting private milestone');
        setMilestoneProgress(95);
        const { program: teeProgram, connection: teeConnection, anchorWallet: teeWallet } =
          await buildTeeProgram(config, sessionSigner || undefined);
        currentStep = 'Submitting private milestone';
        const ix = await teeProgram.methods
          .createPrivateMilestone(
            new anchor.BN(escrowId.toString()),
            nextIndex,
            Buffer.from(descriptionHash),
            Buffer.from(paddedBytes)
          )
          .accounts({
            user: publicKey,
            payer: sessionSigner ? sessionSigner.publicKey : publicKey,
            sessionToken: sessionPda,
            escrow: escrowPda,
            privateMilestone: privateMilestonePda,
            perVault: perVaultPda,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
        ix.keys = ix.keys.map((key) => {
          if (key.pubkey.equals(escrowPda) || key.pubkey.equals(privateMilestonePda) || key.pubkey.equals(perVaultPda)) {
            return { ...key, isWritable: true };
          }
          return key;
        });
        txSig = sessionSigner
          ? await sendIxWithSigner(teeConnection, sessionSigner, ix)
          : await sendIxWithWallet(teeConnection, teeWallet, ix);
      }

      setMilestoneStep('Saving milestone');
      setMilestoneProgress(95);
      currentStep = 'Saving milestone to backend';
      const nextMilestones = [
        ...milestones,
        {
          index: nextIndex,
          details: storedDetails,
          status: 0,
          submitted_at: 0,
          creator: publicKey.toString(),
        },
      ];

      const token = localStorage.getItem('authToken');
      const response = await fetch(`${API_URL}/v1/contracts/${contractId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          milestones: nextMilestones,
        }),
      });

      if (response.ok) {
        setMilestoneStep('Done');
        setMilestoneProgress(100);
        const trimmedTx = txSig ? `${txSig.slice(0, 4)}...${txSig.slice(-4)}` : '';
        toast({
          title: 'Milestone added',
          description: txSig ? (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(txSig);
              }}
              className="text-left text-sm text-gray-200 hover:text-white underline underline-offset-2 cursor-pointer"
            >
              Click to copy Tx to clipboard (Tx: {trimmedTx})
            </button>
          ) : 'Milestone stored successfully.',
          variant: 'success',
        });
        setMilestoneDraft('');
        setShowMilestoneModal(false);
        setMilestones(nextMilestones);
        await fetchContractDetails();
      } else {
        const errorData = await response.json();
        toast({
          title: 'Failed to save milestone',
          description: errorData.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error adding milestone:', error);
      toast({
        title: 'Failed to add milestone',
        description: error?.message ? `Step failed: ${error.message}` : 'Unable to add milestone.',
        variant: 'destructive',
      });
    } finally {
      setMilestoneSaving(false);
      setMilestoneStep(null);
      setMilestoneProgress(0);
    }
  };

  const handleMarkMilestoneReady = async (milestoneIndex: number) => {
    if (!contract || !contract.escrow_pda || !publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to submit milestones.',
        variant: 'destructive',
      });
      return;
    }
    if (!['waiting_for_milestones_report', 'in_progress'].includes(contract.status)) {
      toast({
        title: 'Milestones locked',
        description: 'Milestones can only be submitted after funding.',
        variant: 'warning',
      });
      return;
    }
    if (publicKey.toString() !== contract.contractor_wallet) {
      toast({
        title: 'Only the contractor can submit milestones',
        description: 'Switch to the contractor wallet to mark ready.',
        variant: 'warning',
      });
      return;
    }

    setActionLoading(true);
    try {
      const config = backendConfig || (await loadBackendConfig());
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      const escrowPda = new PublicKey(contract.escrow_pda);
      const milestonePda = deriveMilestonePda(escrowPda, milestoneIndex, programId);
      const privateMilestonePda = derivePrivateMilestonePda(escrowPda, milestoneIndex, programId);
      const anchorWallet = getAnchorWallet(wallet);
      if (!anchorWallet) {
        throw new Error('wallet_not_ready');
      }

      let sig: string;
      const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();
      if (mode === 'l1') {
        const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
          commitment: 'confirmed',
          wsEndpoint: config.wsUrl || undefined,
        });
        const { program } = buildProgram(connection, programId, anchorWallet);
        const escrowId = await fetchEscrowId(program, escrowPda);
        const ix = await program.methods
          .submitMilestone(new anchor.BN(escrowId.toString()), milestoneIndex)
          .accounts({
            contractor: publicKey,
            escrow: escrowPda,
            milestone: milestonePda,
          })
          .instruction();
        ix.keys = ix.keys.map((key) => {
          if (key.pubkey.equals(escrowPda) || key.pubkey.equals(milestonePda)) {
            return { ...key, isWritable: true };
          }
          return key;
        });
        sig = await sendIxWithWallet(connection, anchorWallet, ix);
      } else {
        let sessionSigner: Keypair | null = null;
        let sessionPda: PublicKey | null = null;
        if (isLocalnet) {
          const session = await ensureSessionToken(config, programId);
          sessionSigner = session.sessionSigner;
          sessionPda = session.sessionPda;
        }
        const validator = getDelegationValidator(config);
        const l1Connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
          commitment: 'confirmed',
          wsEndpoint: config.wsUrl || undefined,
        });
        const { program: l1Program } = buildProgram(l1Connection, programId, anchorWallet);
        const escrowId = await fetchEscrowId(l1Program, escrowPda);
        await ensurePrivateMilestonePrepared(
          l1Program,
          escrowPda,
          escrowId,
          privateMilestonePda,
          derivePerVaultPda(escrowPda, programId),
          milestoneIndex,
          config,
          validator
        );
        const { program: teeProgram } = await buildTeeProgram(config, sessionSigner || undefined);
        sig = await teeProgram.methods
          .updatePrivateMilestoneStatus(
            new anchor.BN(escrowId.toString()),
            milestoneIndex,
            1
          )
          .accounts({
            user: publicKey,
            payer: sessionSigner ? sessionSigner.publicKey : publicKey,
            sessionToken: sessionPda,
            escrow: escrowPda,
            privateMilestone: privateMilestonePda,
          })
          .signers(sessionSigner ? [sessionSigner] : [])
          .rpc({ skipPreflight: true });
      }

      toast({
        title: 'Milestone submitted',
        description: renderTxCopy(sig),
        variant: 'success',
      });

      const nextMilestones = milestones.map((milestone) =>
        milestone.index === milestoneIndex
          ? { ...milestone, status: 1, submitted_at: Math.floor(Date.now() / 1000) }
          : milestone
      );
      setMilestones(nextMilestones);
      const token = localStorage.getItem('authToken');
      if (token) {
        await fetch(`${API_URL}/v1/contracts/${contractId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ milestones: nextMilestones }),
        });
      }
      await fetchContractDetails();
    } catch (error) {
      console.error('Error marking milestone as ready:', error);
      toast({
        title: 'Failed to submit milestone',
        description: 'Unable to mark milestone as ready.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmMilestone = async (milestoneIndex: number) => {
    if (!contract || !contract.escrow_pda || !publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to confirm milestones.',
        variant: 'destructive',
      });
      return;
    }
    if (!['waiting_for_milestones_report', 'in_progress'].includes(contract.status)) {
      toast({
        title: 'Milestones locked',
        description: 'Milestones can only be confirmed after submission.',
        variant: 'warning',
      });
      return;
    }
    if (publicKey.toString() !== contract.client_wallet) {
      toast({
        title: 'Only the client can confirm',
        description: 'Switch to the client wallet to confirm.',
        variant: 'warning',
      });
      return;
    }

    const milestone = milestones.find((item) => item.index === milestoneIndex);
    const milestoneLabel = milestone?.details ? milestone.details : `Milestone ${milestoneIndex + 1}`;
    openConfirmModal(
      `Confirm milestone #${milestoneIndex + 1} ?`,
      [
        milestoneLabel,
        'By confirming this milestone, you acknowledge the service provider has met the agreed deliverables for this milestone. This action is final and cannot be undone.',
      ],
      async () => {
        setShowConfirmModal(false);
        setActionLoading(true);
        try {
          const config = backendConfig || (await loadBackendConfig());
          const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
          const escrowPda = new PublicKey(contract.escrow_pda);
          const milestonePda = deriveMilestonePda(escrowPda, milestoneIndex, programId);
          const privateMilestonePda = derivePrivateMilestonePda(escrowPda, milestoneIndex, programId);
          const anchorWallet = getAnchorWallet(wallet);
          if (!anchorWallet) {
            throw new Error('wallet_not_ready');
          }

          let sig: string;
          const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();
          if (mode === 'l1') {
            const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
              commitment: 'confirmed',
              wsEndpoint: config.wsUrl || undefined,
            });
            const { program } = buildProgram(connection, programId, anchorWallet);
            const escrowId = await fetchEscrowId(program, escrowPda);
            const ix = await program.methods
              .approveMilestone(new anchor.BN(escrowId.toString()), milestoneIndex)
              .accounts({
                client: publicKey,
                escrow: escrowPda,
                milestone: milestonePda,
              })
              .instruction();
            ix.keys = ix.keys.map((key) => {
              if (key.pubkey.equals(escrowPda) || key.pubkey.equals(milestonePda)) {
                return { ...key, isWritable: true };
              }
              return key;
            });
            sig = await sendIxWithWallet(connection, anchorWallet, ix);
      } else {
        let sessionSigner: Keypair | null = null;
        let sessionPda: PublicKey | null = null;
        if (isLocalnet) {
          const session = await ensureSessionToken(config, programId);
          sessionSigner = session.sessionSigner;
          sessionPda = session.sessionPda;
        }
        const validator = getDelegationValidator(config);
        const l1Connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
          commitment: 'confirmed',
          wsEndpoint: config.wsUrl || undefined,
        });
        const { program: l1Program } = buildProgram(l1Connection, programId, anchorWallet);
        const escrowId = await fetchEscrowId(l1Program, escrowPda);
        await ensurePrivateMilestonePrepared(
          l1Program,
          escrowPda,
          escrowId,
          privateMilestonePda,
          derivePerVaultPda(escrowPda, programId),
          milestoneIndex,
          config,
          validator
        );
        const { program: teeProgram } = await buildTeeProgram(config, sessionSigner || undefined);
        sig = await teeProgram.methods
          .updatePrivateMilestoneStatus(
            new anchor.BN(escrowId.toString()),
            milestoneIndex,
            3
          )
          .accounts({
            user: publicKey,
            payer: sessionSigner ? sessionSigner.publicKey : publicKey,
            sessionToken: sessionPda,
            escrow: escrowPda,
            privateMilestone: privateMilestonePda,
          })
          .signers(sessionSigner ? [sessionSigner] : [])
          .rpc({ skipPreflight: true });
          }

          toast({
            title: 'Milestone confirmed',
            description: renderTxCopy(sig),
            variant: 'success',
          });

          const nextMilestones = milestones.map((milestone) =>
            milestone.index === milestoneIndex
              ? { ...milestone, status: 2 }
              : milestone
          );
          setMilestones(nextMilestones);
          const token = localStorage.getItem('authToken');
          const nowReadyToClaim =
            nextMilestones.length > 0 && nextMilestones.every((milestone) => milestone.status === 2);
          if (nowReadyToClaim) {
            try {
              const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();
              const milestoneCount = nextMilestones.length;
              if (milestoneCount > 255) {
                throw new Error('Too many milestones to sync.');
              }

              if (mode === 'l1') {
                const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
                  commitment: 'confirmed',
                  wsEndpoint: config.wsUrl || undefined,
                });
                const { program } = buildProgram(connection, programId, anchorWallet);
                const readyIx = await program.methods
                  .setReadyToClaimPublic(new anchor.BN(escrowId.toString()), milestoneCount)
                  .accounts({
                    user: publicKey,
                    escrow: escrowPda,
                  })
                  .remainingAccounts(
                    nextMilestones.map((milestone) => ({
                      pubkey: deriveMilestonePda(escrowPda, milestone.index, programId),
                      isWritable: false,
                      isSigner: false,
                    }))
                  )
                  .instruction();
                const readySig = await sendIxWithWallet(connection, anchorWallet, readyIx);
                toast({
                  title: 'Ready to claim set',
                  description: renderTxCopy(readySig),
                  variant: 'success',
                });
              } else {
                let sessionSigner: Keypair | null = null;
                let sessionPda: PublicKey | null = null;
                if (isLocalnet) {
                  const session = await ensureSessionToken(config, programId);
                  sessionSigner = session.sessionSigner;
                  sessionPda = session.sessionPda;
                }
                const validator = getDelegationValidator(config);
                const l1Connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
                  commitment: 'confirmed',
                  wsEndpoint: config.wsUrl || undefined,
                });
                const { program: l1Program } = buildProgram(l1Connection, programId, anchorWallet);
                const escrowId = await fetchEscrowId(l1Program, escrowPda);
                for (const milestone of nextMilestones) {
                  await ensurePrivateMilestonePrepared(
                    l1Program,
                    escrowPda,
                    escrowId,
                    derivePrivateMilestonePda(escrowPda, milestone.index, programId),
                    derivePerVaultPda(escrowPda, programId),
                    milestone.index,
                    config,
                    validator
                  );
                }
                const { program: teeProgram } = await buildTeeProgram(config, sessionSigner || undefined);
                const readySig = await teeProgram.methods
                  .setReadyToClaim(new anchor.BN(escrowId.toString()), milestoneCount)
                  .accounts({
                    user: publicKey,
                    payer: sessionSigner ? sessionSigner.publicKey : publicKey,
                    sessionToken: sessionPda,
                    escrow: escrowPda,
                  })
                  .remainingAccounts(
                    nextMilestones.map((milestone) => ({
                      pubkey: derivePrivateMilestonePda(escrowPda, milestone.index, programId),
                      isWritable: false,
                      isSigner: false,
                    }))
                  )
                  .signers(sessionSigner ? [sessionSigner] : [])
                  .rpc({ skipPreflight: true });
                toast({
                  title: 'Ready to claim set',
                  description: renderTxCopy(readySig),
                  variant: 'success',
                });

                const commitSig = await teeProgram.methods
                  .undelegateEscrow()
                  .accounts({
                    payer: sessionSigner ? sessionSigner.publicKey : publicKey,
                    escrow: escrowPda,
                    magicProgram: MAGIC_PROGRAM_ID,
                    magicContext: MAGIC_CONTEXT_ID,
                  })
                  .signers(sessionSigner ? [sessionSigner] : [])
                  .rpc({ skipPreflight: true });
                toast({
                  title: 'Escrow committed',
                  description: renderTxCopy(commitSig),
                  variant: 'success',
                });
              }

              if (token) {
                await fetch(`${API_URL}/v1/contracts/${contractId}/refresh`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                  },
                });
              }
              setContract((prev) => (prev ? { ...prev, status: 'ready_to_claim' } : prev));
              toast({
                title: 'Contract funds are now ready to claim',
                description: 'All milestones are confirmed.',
                variant: 'success',
              });
            } catch (error) {
              console.error('Ready-to-claim sync failed:', error);
              toast({
                title: 'Unable to sync escrow flags',
                description: 'Run sync from the CLI to finalize ready-to-claim.',
                variant: 'warning',
              });
            }
          }
          if (token) {
            await fetch(`${API_URL}/v1/contracts/${contractId}`, {
              method: 'PATCH',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ milestones: nextMilestones }),
            });
          }
          await fetchContractDetails();
        } catch (error) {
          console.error('Error confirming milestone:', error);
          toast({
            title: 'Failed to confirm milestone',
            description: 'Unable to confirm milestone.',
            variant: 'destructive',
          });
        } finally {
          setActionLoading(false);
        }
      }
    );
  };

  const handleOpenDispute = async () => {
    if (!contract || !contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Initialize the contract before opening a dispute.',
        variant: 'destructive',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to open a dispute.',
        variant: 'destructive',
      });
      return;
    }
    if (!['in_progress', 'waiting_for_milestones_report'].includes(contract.status)) {
      toast({
        title: 'Dispute unavailable',
        description: 'Disputes can only be opened while the contract is in progress.',
        variant: 'warning',
      });
      return;
    }
    if (allMilestonesConfirmed) {
      toast({
        title: 'Dispute unavailable',
        description: 'All milestones are confirmed; the contract is ready to claim.',
        variant: 'warning',
      });
      return;
    }
    const walletStr = publicKey.toString();
    if (walletStr !== contract.client_wallet && walletStr !== contract.contractor_wallet) {
      toast({
        title: 'Not a participant',
        description: 'Only contract participants can open disputes.',
        variant: 'warning',
      });
      return;
    }

    openConfirmModal(
      'Dispute contract',
      ['This will open a dispute for this contract.'],
      async () => {
        setShowConfirmModal(false);
        setActionLoading(true);
        try {
          const config = backendConfig || (await loadBackendConfig());
          const anchorWallet = getAnchorWallet(wallet);
          if (!anchorWallet) {
            throw new Error('wallet_not_ready');
          }
          const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
          const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
            commitment: 'confirmed',
            wsEndpoint: config.wsUrl || undefined,
          });
          const { program } = buildProgram(connection, programId, anchorWallet);
          const escrowPda = new PublicKey(contract.escrow_pda);
          const escrowId = await fetchEscrowId(program, escrowPda);
          const disputePda = deriveDisputePda(escrowPda, programId);

          const ix = await program.methods
            .openDispute(new anchor.BN(escrowId.toString()))
            .accounts({
              actor: publicKey,
              escrow: escrowPda,
              dispute: disputePda,
              systemProgram: SystemProgram.programId,
            })
            .instruction();
          ix.keys = ix.keys.map((key) => {
            if (key.pubkey.equals(escrowPda) || key.pubkey.equals(disputePda)) {
              return { ...key, isWritable: true };
            }
            return key;
          });

          const sig = await sendIxWithWallet(connection, anchorWallet, ix);
          toast({
            title: 'Dispute opened',
            description: renderTxCopy(sig),
            variant: 'success',
          });
          await fetchContractDetails();
        } catch (error) {
          console.error('Error opening dispute:', error);
          toast({
            title: 'Failed to open dispute',
            description: 'Unable to open dispute.',
            variant: 'destructive',
          });
        } finally {
          setActionLoading(false);
        }
      }
    );
  };

  const handleResolveDispute = async () => {
    setActionLoading(true);
    try {
      // This is a placeholder for the actual dispute resolution logic
      // In reality, this would involve:
      // 1. Checking contract state
      // 2. Resolving the dispute via Solana program
      
      const token = localStorage.getItem('authToken');
      
      alert('Resolving dispute would happen here. This requires Solana wallet integration.');
      
      // For demonstration purposes, we'll just refresh the contract details
      fetchContractDetails();
    } catch (error) {
      console.error('Error resolving dispute:', error);
      alert('Failed to resolve dispute');
    } finally {
      setActionLoading(false);
    }
  };

  const handleClaimFunds = async () => {
    if (!contract || !contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'This contract has no escrow to claim from.',
        variant: 'destructive',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to claim funds.',
        variant: 'destructive',
      });
      return;
    }
    if (!isContractor) {
      toast({
        title: 'Only the service provider can claim',
        description: 'Funds can only be claimed by the contractor.',
        variant: 'warning',
      });
      return;
    }

    setActionLoading(true);
    try {
      const token = localStorage.getItem('authToken');
      const anchorWallet = getAnchorWallet(wallet);
      if (!anchorWallet) {
        throw new Error('wallet_not_ready');
      }
      const config = backendConfig || (await loadBackendConfig());
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl || undefined,
      });
      const { program } = buildProgram(connection, programId, anchorWallet);
      const escrowPda = new PublicKey(contract.escrow_pda);
      const escrowState: any = await program.account.escrow.fetch(escrowPda);

      const paidOut = Boolean(escrowState?.paidOut ?? escrowState?.paid_out);
      if (paidOut) {
        toast({
          title: 'Already claimed',
          description: 'Funds have already been claimed for this contract.',
          variant: 'success',
        });
        return;
      }

      const readyToClaim = Boolean(escrowState?.readyToClaim ?? escrowState?.ready_to_claim);
      const timeoutFundsReady = Boolean(escrowState?.timeoutFundsReady ?? escrowState?.timeout_funds_ready);
      if (!readyToClaim && !timeoutFundsReady) {
        toast({
          title: 'Not ready to claim',
          description: 'Contract is not ready to claim yet.',
          variant: 'warning',
        });
        return;
      }

      const escrowId =
        escrowState?.escrowId?.toString?.() ||
        escrowState?.escrow_id?.toString?.() ||
        escrowState?.escrowId ||
        escrowState?.escrow_id;
      if (!escrowId) {
        throw new Error('escrow_id_missing');
      }

      const mintValue = contract.mint || config.usdcMint;
      if (!mintValue) {
        throw new Error('usdc_mint_missing');
      }
      const mint = new PublicKey(mintValue);
      const contractorToken = deriveAssociatedTokenAddress(mint, publicKey);
      const vaultToken = deriveAssociatedTokenAddress(mint, escrowPda);

      const instructions: TransactionInstruction[] = [];
      const contractorTokenInfo = await connection.getAccountInfo(contractorToken, 'confirmed');
      if (!contractorTokenInfo) {
        instructions.push(buildCreateAtaInstruction(publicKey, contractorToken, publicKey, mint));
      }

      const claimIx = readyToClaim
        ? await program.methods
            .claimFunds(new anchor.BN(escrowId.toString()))
            .accounts({
              contractor: publicKey,
              creator: escrowState.creator,
              escrow: escrowPda,
              contractorToken,
              vaultToken,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction()
        : await program.methods
            .claimTimeoutFunds(new anchor.BN(escrowId.toString()))
            .accounts({
              contractor: publicKey,
              creator: escrowState.creator,
              escrow: escrowPda,
              contractorToken,
              vaultToken,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();
      instructions.push(claimIx);

      const fundedRaw =
        escrowState?.fundedAmount ??
        escrowState?.funded_amount ??
        0;
      const amountLabel = formatUsdc(
        fundedRaw?.toString?.() || String(fundedRaw)
      );

      setActionLoading(false);
      openConfirmModal(
        'Claim funds',
        [`Amount: ${amountLabel} USDC`],
        async () => {
          setShowConfirmModal(false);
          setActionLoading(true);
          const sig = await sendIxsWithWallet(connection, anchorWallet, instructions);
          toast({
            title: 'Funds claimed',
            description: renderTxCopy(sig),
            variant: 'success',
          });
          if (token) {
            try {
              await fetch(`${API_URL}/v1/contracts/${contractId}/refresh`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                },
              });
            } catch {}
          }
          await fetchContractDetails();
        }
      );
    } catch (error) {
      console.error('Error claiming funds:', error);
      toast({
        title: 'Failed to claim funds',
        description: 'Unable to claim funds.',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleFund = async () => {
    if (!contract) return;
    if (contract.status !== 'waiting_for_funding') {
      toast({
        title: 'Funding not available',
        description: 'Contract must be waiting for funding.',
        variant: 'warning',
      });
      return;
    }
    if (!contract.escrow_pda) {
      toast({
        title: 'Escrow missing',
        description: 'Contract has no escrow. Unable to fund.',
        variant: 'destructive',
      });
      return;
    }
    if (!publicKey) {
      toast({
        title: 'Wallet required',
        description: 'Connect your wallet to fund the contract.',
        variant: 'destructive',
      });
      return;
    }
    if (publicKey.toString() !== contract.client_wallet) {
      toast({
        title: 'Only the client can fund',
        description: 'This contract must be funded by the client.',
        variant: 'warning',
      });
      return;
    }
    if (!contract.total_payment) {
      toast({
        title: 'Payment missing',
        description: 'Contract payment amount is not set.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const token = localStorage.getItem('authToken');
      const anchorWallet = getAnchorWallet(wallet);
      if (!anchorWallet) {
        throw new Error('wallet_not_ready');
      }
      const paymentBase =
        normalizeUsdcToBase(contract.total_payment) ?? String(contract.total_payment);
      const amountBase = BigInt(paymentBase);
      const config = backendConfig || (await loadBackendConfig());
      const programId = new PublicKey(config.programId || PROGRAM_ID_FALLBACK);
      const connection = new Connection(config.rpcUrl || 'http://localhost:8899', {
        commitment: 'confirmed',
        wsEndpoint: config.wsUrl || undefined,
      });
      const { program } = buildProgram(connection, programId, anchorWallet);
      const escrowPda = new PublicKey(contract.escrow_pda);
      const escrowInfo = await connection.getAccountInfo(escrowPda, 'confirmed');
      if (escrowInfo && escrowInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
        toast({
          title: 'Escrow is delegated',
          description: 'Run sync to undelegate before funding.',
          variant: 'warning',
        });
        return;
      }

      const escrowState: any = await program.account.escrow.fetch(escrowPda);
      const termsHash = escrowState?.termsHash ?? escrowState?.terms_hash;
      const milestonesHash = escrowState?.milestonesHash ?? escrowState?.milestones_hash;
      if (!hasNonZeroBytes(termsHash)) {
        toast({
          title: 'Terms not committed',
          description: 'Terms must be committed on-chain before funding.',
          variant: 'warning',
        });
        return;
      }
      const hasMilestones = milestones.length > 0;
      if (hasMilestones && !hasNonZeroBytes(milestonesHash)) {
        toast({
          title: 'Milestones not committed',
          description: 'Run sync to commit milestones before funding.',
          variant: 'warning',
        });
        return;
      }

      const escrowId =
        escrowState?.escrowId?.toString?.() ||
        escrowState?.escrow_id?.toString?.() ||
        escrowState?.escrowId ||
        escrowState?.escrow_id;
      if (!escrowId) {
        throw new Error('escrow_id_missing');
      }

      const mint = new PublicKey(contract.mint || config.usdcMint);
      const clientToken = deriveAssociatedTokenAddress(mint, publicKey);
      const feeReceiverToken = deriveAssociatedTokenAddress(mint, FEE_RECEIVER);
      const vaultToken = deriveAssociatedTokenAddress(mint, escrowPda);
      const instructions: TransactionInstruction[] = [];

      const [clientTokenInfo, feeTokenInfo] = await Promise.all([
        connection.getAccountInfo(clientToken, 'confirmed'),
        connection.getAccountInfo(feeReceiverToken, 'confirmed'),
      ]);
      if (!clientTokenInfo) {
        instructions.push(buildCreateAtaInstruction(publicKey, clientToken, publicKey, mint));
      }
      if (!feeTokenInfo) {
        instructions.push(buildCreateAtaInstruction(publicKey, feeReceiverToken, FEE_RECEIVER, mint));
      }

      const fundIx = await program.methods
        .fundEscrow(
          new anchor.BN(escrowId.toString()),
          new anchor.BN(amountBase.toString())
        )
        .accounts({
          client: publicKey,
          escrow: escrowPda,
          clientToken,
          feeReceiverToken,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      instructions.push(fundIx);
      const mode = (executionMode || contract.execution_mode || 'per').toLowerCase();
      if (mode === 'l1') {
        const termsPda = deriveTermsPda(escrowPda, programId);
        const fundingOkIx = await program.methods
          .setFundingOkPublic(new anchor.BN(escrowId.toString()))
          .accounts({
            user: publicKey,
            escrow: escrowPda,
            terms: termsPda,
          })
          .instruction();
        instructions.push(fundingOkIx);
      }

      setActionLoading(false);
      openConfirmModal(
        'Confirm funding',
        buildFeeConfirmLines(amountBase, 'funding'),
        async () => {
        setShowConfirmModal(false);
        setActionLoading(true);
        const sig = await sendIxsWithWallet(connection, anchorWallet, instructions);
        const trimmedTx = `${sig.slice(0, 4)}...${sig.slice(-4)}`;
        toast({
          title: 'Contract Funded Successfully',
          description: (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(sig);
              }}
              className="text-left text-sm text-gray-200 hover:text-white underline underline-offset-2 cursor-pointer"
            >
              Click to copy Tx to clipboard (Tx: {trimmedTx})
            </button>
          ),
          variant: 'success',
        });

        if (token) {
          const response = await fetch(`${API_URL}/v1/contracts/${contractId}/mark-funded`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          });
          if (!response.ok) {
            const errorData = await response.json();
            toast({
              title: 'Failed to mark funded',
              description: errorData.error || 'Unknown error',
              variant: 'warning',
            });
          }
        }

        await fetchContractDetails();
        setActionLoading(false);
      },
      { ticket: buildFeeTicket(amountBase) }
      );
    } catch (error) {
      console.error('Error funding contract:', error);
      toast({
        title: 'Failed to fund contract',
        description: 'Unable to fund contract.',
        variant: 'destructive',
      });
      setActionLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      negotiating: { color: 'bg-yellow-500/20 text-yellow-400', label: 'Negotiating' },
      waiting_for_init: { color: 'bg-blue-500/20 text-blue-400', label: 'Waiting for Init' },
      awaiting_signatures: { color: 'bg-purple-500/20 text-purple-400', label: 'Awaiting Signatures' },
      waiting_for_funding: { color: 'bg-orange-500/20 text-orange-400', label: 'Waiting for Funding' },
      waiting_for_milestones_report: { color: 'bg-sky-500/20 text-sky-400', label: 'Waiting for Milestone Report' },
      in_progress: { color: 'bg-green-500/20 text-green-400', label: 'In Progress' },
      ready_to_claim: { color: 'bg-emerald-500/20 text-emerald-400', label: 'Ready to Claim' },
      completed: { color: 'bg-gray-500/20 text-gray-400', label: 'Completed' },
      disputed: { color: 'bg-red-500/20 text-red-400', label: 'Disputed' },
    };

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.negotiating;
    return (
      <span className={`px-3 py-1.5 rounded-full text-sm font-semibold shadow-[0_0_12px_rgba(0,0,0,0.25)] ring-1 ring-white/10 ${config.color}`}>
        {config.label}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-gray-400">Loading contract details...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <p className="text-gray-400 mb-4">Contract not found</p>
            <Link href="/dashboard" className="bg-brand-500 hover:bg-brand-600 text-white px-6 py-3 rounded-full font-medium transition-colors">
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!contract.client_wallet || !contract.contractor_wallet) {
    return (
      <div className="min-h-screen bg-dark-900">
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-center">
            <p className="text-gray-400 mb-4">The contract isn’t available yet.</p>
            <Link href="/dashboard" className="bg-brand-500 hover:bg-brand-600 text-white px-6 py-3 rounded-full font-medium transition-colors">
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-dark-900">
      <style jsx>{`
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: rgba(110, 86, 207, 0.6) rgba(255, 255, 255, 0.06);
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.06);
          border-radius: 999px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, rgba(110, 86, 207, 0.9), rgba(110, 86, 207, 0.45));
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(110, 86, 207, 1), rgba(110, 86, 207, 0.6));
        }
      `}</style>
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

      <main className="pt-24 pb-12 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Contract Header */}
          <div className="glass-panel rounded-xl border border-white/5 p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-2xl font-semibold text-white">Contract Details</h1>
              {getStatusBadge(
                allMilestonesConfirmed &&
                  ['waiting_for_milestones_report', 'in_progress'].includes(contract.status)
                  ? 'ready_to_claim'
                  : contract.status
              )}
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Contract ID</label>
                <p className="text-white font-medium break-all">{contract.id}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Execution Mode</label>
                <p className="text-white font-medium">{contract.execution_mode.toUpperCase()}</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Created At</label>
                <p className="text-white font-medium">{new Date(contract.created_at * 1000).toLocaleString()}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-gray-400">
              <span className="uppercase tracking-wide text-gray-500">Privacy Key</span>
              <span
                className={`px-2 py-1 rounded-full text-[11px] font-semibold ${
                  hasLocalKey ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-500/15 text-gray-300'
                }`}
              >
                {hasLocalKey ? 'Saved' : 'Unset'}
              </span>
              {hasLocalKey ? (
                <button
                  onClick={() => setShowDeleteKeyModal(true)}
                  className="text-xs font-semibold text-red-300 hover:text-red-200"
                >
                  Delete key
                </button>
              ) : (
                <button
                  onClick={() => setShowPrivacyKeyInput(true)}
                  className="text-xs font-semibold text-amber-300 hover:text-amber-200"
                >
                  Set key
                </button>
              )}
            </div>
          </div>

          {/* Contract Participants */}
          <div className="glass-panel rounded-xl border border-white/5 p-6 mb-8">
            <h2 className="text-xl font-semibold text-white mb-4">Participants</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Client</label>
                <div className="flex items-center gap-3 mt-2">
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-gray-600">
                    {contract.client_pfp ? (
                      <img
                        src={`/pfps/${contract.client_pfp}`}
                        alt="Client PFP"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gray-700">
                        <iconify-icon icon="solar:user-linear" className="text-gray-400" width="16" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-white font-medium">
                      {contract.client_handle ? `@${contract.client_handle}` : 'Unknown'}
                      {publicKey?.toString() === contract.client_wallet ? ' (YOU)' : ''}
                    </p>
                    <p className="text-gray-400 text-xs break-all">{contract.client_wallet}</p>
                  </div>
                </div>
                {contract.client_signed_at && (
                  <p className="text-green-400 text-xs mt-1">Signed at: {new Date(contract.client_signed_at * 1000).toLocaleString()}</p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Contractor</label>
                <div className="flex items-center gap-3 mt-2">
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-gray-600">
                    {contract.contractor_pfp ? (
                      <img
                        src={`/pfps/${contract.contractor_pfp}`}
                        alt="Contractor PFP"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gray-700">
                        <iconify-icon icon="solar:user-linear" className="text-gray-400" width="16" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-white font-medium">
                      {contract.contractor_handle ? `@${contract.contractor_handle}` : 'Unknown'}
                      {publicKey?.toString() === contract.contractor_wallet ? ' (YOU)' : ''}
                    </p>
                    <p className="text-gray-400 text-xs break-all">{contract.contractor_wallet}</p>
                  </div>
                </div>
                {contract.contractor_signed_at && (
                  <p className="text-green-400 text-xs mt-1">Signed at: {new Date(contract.contractor_signed_at * 1000).toLocaleString()}</p>
                )}
              </div>
            </div>
          </div>

          {/* Session Keys */}
          {!['ready_to_claim', 'completed'].includes(contract.status) &&
            executionMode !== 'l1' &&
            contract.execution_mode !== 'l1' && (
          <div className="glass-panel rounded-xl border border-white/5 p-6 mb-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Session Keys</h2>
                <p className="text-xs text-gray-400 mt-1">
                  Manage session keys to reduce wallet prompts for private actions.
                </p>
              </div>
              <span
                className={`px-2 py-1 rounded-full text-[11px] font-semibold ${
                  perSetupReady ? 'bg-emerald-500/15 text-emerald-300' : 'bg-gray-500/15 text-gray-300'
                }`}
              >
                {perSetupReady ? 'Ready' : perSetupChecked ? 'Not ready' : 'Unknown'}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={checkSessionStatus}
                disabled={perSetupLoading || !isLocalnet}
                className="inline-flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-all"
              >
                {perSetupLoading ? 'Checking...' : 'Check Status'}
              </button>
              {!perSetupReady && (
                <button
                  onClick={handlePreparePerSession}
                  disabled={perSetupLoading || !isLocalnet}
                  className="inline-flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-all"
                >
                  Prepare Session
                </button>
              )}
              {!isLocalnet && (
                <span className="text-xs text-gray-500">Session keys are only used on localnet.</span>
              )}
              {isLocalnet && (
                <span className="text-xs text-gray-500">
                  {perSetupReady ? 'Session key is valid.' : 'Run once per device.'}
                </span>
              )}
            </div>
          </div>
          )}

          {/* Terms and Milestones */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Terms */}
            <div className="glass-panel rounded-xl border border-white/5 p-6">
              <h2 className="text-xl font-semibold text-white mb-2">Terms</h2>
              {terms ? (
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Deadline</label>
                    <p className="text-white font-medium">{formatDeadlineValue(terms.deadline)}</p>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Payment</label>
                    <p className="text-white font-medium">{formatUsdc(terms.payment)} USDC</p>
                  </div>
                </div>
              ) : contract?.terms_encrypted ? (
                <p className="text-gray-400">Terms encrypted (privacy key required)</p>
              ) : null}

              {contract?.status === 'negotiating' && !terms && (
                publicKey?.toString() !== contract.client_wallet ? (
                  <p className="mt-2 text-sm text-gray-400">
                    Waiting for terms to be submitted by the client.
                  </p>
                ) : (
                  <div className="mt-2 space-y-4">
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Deadline</label>
                    <div className="mt-2 flex gap-2">
                      <select
                        value={deadlinePreset}
                        onChange={(event) => setDeadlinePreset(event.target.value)}
                        className="flex-1 bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                      >
                        <option value="">Select deadline</option>
                        {deadlineOptions.map((days) => (
                          <option key={days} value={days.toString()}>
                            {days}d
                          </option>
                        ))}
                        <option value="custom">Custom</option>
                      </select>
                      {deadlinePreset === 'custom' && (
                        <input
                          type="number"
                          min="1"
                          value={customDeadlineDays}
                          onChange={(event) => setCustomDeadlineDays(event.target.value)}
                          placeholder="Days"
                          className="w-24 bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                        />
                      )}
                    </div>
                    {!deadlineDaysValid && deadlinePreset && (
                      <p className="text-xs text-red-400 mt-1">Enter a valid number of days.</p>
                    )}
                  </div>

                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Payment (USDC)</label>
                    <input
                      value={paymentInput}
                      onChange={(event) => setPaymentInput(event.target.value)}
                      placeholder="e.g. 250 or 250.50"
                      className="mt-2 w-full bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    />
                    {paymentInput && !paymentValid && (
                      <p className="text-xs text-red-400 mt-1">Enter a valid amount.</p>
                    )}
                    {paymentValid && paymentBasePreview && (
                      <p className="text-xs text-gray-500 mt-1">
                        Total payment: {formatUsdc(paymentBasePreview)} USDC
                      </p>
                    )}
                  </div>

                  <button
                    onClick={handleSubmitTerms}
                    disabled={!canSubmitTerms || submittingTerms || actionLoading}
                    className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-all"
                  >
                    {submittingTerms ? 'Submitting terms...' : 'Submit Terms'}
                  </button>
                  </div>
                )
              )}

              {contract?.status === 'negotiating' && terms && (
                <button
                  onClick={openModifyTerms}
                  className="mt-6 w-full bg-brand-500/20 hover:bg-brand-500/30 text-brand-200 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                >
                  Modify Terms
                </button>
              )}
            </div>

            {/* Milestones */}
            <div className="glass-panel rounded-xl border border-white/5 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white">
                  Milestones
                  <span className="ml-2 text-xs text-gray-400">({milestones.length})</span>
                </h2>
                <div className="flex items-center gap-3">
                  {!hasLocalKey && hasEncryptedMilestones && (
                    <span className="text-xs text-amber-300">Encrypted (key required)</span>
                  )}
                  {contract?.status === 'negotiating' && (
                    <button
                      onClick={() => setShowMilestoneModal(true)}
                      disabled={milestoneSaving || actionLoading}
                      className="text-xs font-semibold text-brand-300 hover:text-brand-200 disabled:text-gray-500 disabled:cursor-not-allowed"
                    >
                      + Add milestone
                    </button>
                  )}
                </div>
              </div>
              {milestones.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-500">
                    Tip: Double-click to toggle expanded view.
                  </p>
                  <div
                  onDoubleClick={() => setMilestonesExpanded((prev) => !prev)}
                  className={`space-y-4 pr-2 custom-scrollbar cursor-pointer select-none ${
                    milestonesExpanded ? 'max-h-none overflow-y-visible' : 'max-h-72 overflow-y-auto'
                  }`}
                  >
                  {milestones.map((milestone) => {
                    const isClient = publicKey?.toString() === contract?.client_wallet;
                    const isContractor = publicKey?.toString() === contract?.contractor_wallet;
                    const canSubmit =
                      isContractor &&
                      ['waiting_for_milestones_report', 'in_progress'].includes(contract?.status || '');
                    const canConfirm =
                      isClient &&
                      ['waiting_for_milestones_report', 'in_progress'].includes(contract?.status || '');
                    return (
                    <div key={milestone.index} className="border border-white/5 rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-white font-medium">Milestone {milestone.index + 1}</span>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          milestone.status === 2 ? 'bg-green-500/20 text-green-400' : 
                          milestone.status === 1 ? 'bg-yellow-500/20 text-yellow-400' : 
                          'bg-gray-500/20 text-gray-400'
                        }`}>
                          {milestone.status === 2 ? 'Confirmed' : milestone.status === 1 ? 'Marked as ready' : 'Pending'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-gray-300 text-sm">{milestone.details}</p>
                        {milestone.status === 1 && canConfirm && (
                          <button
                            onClick={() => handleConfirmMilestone(milestone.index)}
                            disabled={actionLoading}
                            className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-4 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <iconify-icon icon="solar:check-circle-linear" width="14" />
                            Confirm Milestone
                          </button>
                        )}
                      </div>
                      {milestone.submitted_at > 0 && (
                        <p className="text-gray-500 text-xs mt-2">
                          Submitted: {new Date(milestone.submitted_at * 1000).toLocaleString()}
                        </p>
                      )}
                      {milestone.status === 0 && canSubmit && (
                        <button
                          onClick={() => handleMarkMilestoneReady(milestone.index)}
                          disabled={actionLoading}
                          className="mt-3 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/15 px-3.5 py-1.5 text-xs font-semibold text-brand-200 hover:bg-brand-500/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <iconify-icon icon="solar:upload-linear" width="14" />
                          Mark Ready
                        </button>
                      )}
                      {milestone.status === 1 && !canConfirm && (
                        <p className="mt-3 text-xs text-gray-500">Awaiting client confirmation.</p>
                      )}
                      {milestone.status === 1 && !canConfirm && (
                        <p className="mt-3 text-xs text-gray-500">Awaiting client confirmation.</p>
                      )}
                    </div>
                  );
                  })}
                  </div>
                </div>
              ) : (
                <p className="text-gray-400">No milestones set</p>
              )}
            </div>
          </div>

          {/* Execution Mode */}
          {!contract.escrow_pda && (
            <div className="glass-panel rounded-xl border border-white/5 p-6">
              <h2 className="text-xl font-semibold text-white mb-4">Execution Mode</h2>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm text-gray-300">Privacy & enforcement</p>
                      <p className="text-xs text-gray-500">
                        PER keeps terms private (requires MagicBlock TEE). L1 is public, but extremely slow and unreliable in browser; CLI usage is recommended.
                      </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Network: {network === 'unknown' ? 'unknown' : network.toUpperCase()}
                    </p>
                  </div>
                  <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 p-1">
                    <button
                      onClick={() => handleModeSelect('per')}
                      disabled={modeUpdating || perDisabled}
                      className={`px-4 py-2 rounded-full text-xs font-semibold transition-all ${
                        executionMode === 'per'
                          ? 'bg-brand-500 text-white shadow-[0_0_10px_rgba(110,86,207,0.4)]'
                          : 'text-gray-300 hover:text-white'
                      } ${perDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      PER
                    </button>
                    <button
                      onClick={() => handleModeSelect('l1')}
                      disabled={modeUpdating || !canSelectL1}
                      className={`px-4 py-2 rounded-full text-xs font-semibold transition-all ${
                        executionMode === 'l1'
                          ? 'bg-orange-500 text-white shadow-[0_0_10px_rgba(255,153,102,0.4)]'
                          : 'text-gray-300 hover:text-white'
                      } ${!canSelectL1 ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      L1
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                  <span>
                    TEE: {teeStatus === 'checking'
                      ? 'checking...'
                      : teeStatus === 'available'
                        ? 'available'
                        : teeStatus === 'unavailable'
                          ? 'unavailable'
                          : 'unknown'}
                  </span>
                  <button
                    onClick={handleTeeCheck}
                    disabled={teeStatus === 'checking' || isLocalnet}
                    className="px-2 py-1 rounded-full border border-white/15 hover:border-white/30 transition-all"
                  >
                    Check TEE
                  </button>
                  {isLocalnet && (
                    <span className="text-gray-500">Localnet supports PER or L1.</span>
                  )}
                  {!signMessage && (
                    <span className="text-amber-300">Wallet lacks signMessage; TEE auth may fail.</span>
                  )}
                </div>

                {isDevnet && teeStatus === 'unavailable' && (
                  <div className="text-xs text-amber-300">
                    {executionMode === 'l1'
                      ? 'MagicBlock TEE is currently unavailable. L1 mode is enabled (public, but always works on-chain). Browser performance can be very slow; CLI usage is recommended.'
                      : 'MagicBlock PER (TEE) is not accessible right now. PER actions may fail; L1 is safer. Browser performance can be very slow, so CLI usage is recommended.'}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Contract Actions */}
          <div className="glass-panel rounded-xl border border-white/5 p-6 mt-6">
            <h2 className="text-xl font-semibold text-white mb-4">Actions</h2>
            {hasWalletRpcMismatch && (
              <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                <div className="font-medium">Network mismatch</div>
                <div className="text-xs text-amber-200/80">
                  Your wallet is connected to {walletRpcEndpoint}, but the server is using {backendConfig?.rpcUrl}.
                  Switch the wallet network to match the server before signing.
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {contract.status === 'waiting_for_init' && (
                <div className="md:col-span-3 flex justify-center">
                  <button
                    onClick={handleInit}
                    disabled={actionLoading}
                    className="inline-flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95"
                  >
                    {actionLoading ? (
                      <>
                        <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                        Initializing...
                      </>
                    ) : (
                      <>
                        <iconify-icon icon="solar:rocket-2-linear" width="16" />
                        Initialize Contract
                      </>
                    )}
                  </button>
                </div>
              )}

              {(contract.status === 'awaiting_signatures' || contract.status === 'negotiating') && (
                waitingForOtherSignature ? (
                  <div className="md:col-span-3 mx-auto text-sm text-gray-400">
                    Waiting for the other user to sign the contract.
                  </div>
                ) : (
                  <div
                    onClick={() => {
                      if (actionLoading || canSignContract) return;
                      const missing = [];
                      if (!milestones.length) missing.push('At least 1 milestone');
                      if (!terms) missing.push('Set terms');
                      toast({
                        title: 'Cannot sign yet',
                        description: `Missing: ${missing.join(', ')}`,
                        variant: 'warning',
                      });
                    }}
                    className="md:col-span-3 mx-auto"
                  >
                    <button
                      onClick={handleSign}
                      disabled={actionLoading || !canSignContract}
                      className="inline-flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95"
                    >
                      {actionLoading ? (
                        <>
                          <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                          Signing...
                        </>
                      ) : (
                        <>
                          <iconify-icon icon="solar:pen-linear" width="16" />
                          Sign Contract
                        </>
                      )}
                    </button>
                  </div>
                )
              )}

              {contract.status === 'waiting_for_funding' && (
                isClient ? (
                  <button
                    onClick={handleFund}
                    disabled={actionLoading}
                    className="md:col-span-3 mx-auto inline-flex items-center justify-center gap-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95"
                  >
                    {actionLoading ? (
                      <>
                        <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                        Funding...
                      </>
                    ) : (
                      <>
                        <iconify-icon icon="solar:wallet-linear" width="16" />
                        Fund Contract
                      </>
                    )}
                  </button>
                ) : (
                  <div className="md:col-span-3 mx-auto text-sm text-gray-400">
                    Waiting for the client to fund the contract.
                  </div>
                )
              )}

              {['waiting_for_milestones_report', 'in_progress'].includes(contract.status) && !allMilestonesConfirmed && (
                <div className="md:col-span-3 flex justify-center">
                  <button
                    onClick={handleOpenDispute}
                    disabled={actionLoading}
                    className="inline-flex items-center justify-center gap-2 bg-red-500/20 hover:bg-red-500/30 disabled:bg-gray-600 disabled:cursor-not-allowed text-red-200 px-6 py-3 rounded-lg font-medium transition-all shadow-[0_0_15px_rgba(239,68,68,0.25)] hover:scale-105 active:scale-95"
                  >
                    {actionLoading ? (
                      <>
                        <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                        Opening dispute...
                      </>
                    ) : (
                      <>
                        <iconify-icon icon="solar:shield-warning-linear" width="16" />
                        Dispute Contract
                      </>
                    )}
                  </button>
                </div>
              )}
              {contract.status === 'ready_to_claim' && (
                isContractor ? (
                  <div className="md:col-span-3 flex justify-center">
                    <button
                      onClick={handleClaimFunds}
                      disabled={actionLoading}
                      className="inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-3 rounded-lg font-medium transition-all shadow-[0_0_15px_rgba(16,185,129,0.35)] hover:scale-105 active:scale-95"
                    >
                      {actionLoading ? (
                        <>
                          <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin inline-block mr-2" />
                          Claiming...
                        </>
                      ) : (
                        <>
                          <iconify-icon icon="solar:wallet-money-linear" width="16" />
                          Claim Funds
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="md:col-span-3 mx-auto text-sm text-gray-400">
                    Waiting for the contractor to claim the funds.
                  </div>
                )
              )}
              {allMilestonesConfirmed && contract.status !== 'completed' && (
                <div className="md:col-span-3 text-center text-sm text-gray-400">
                  All milestones have been confirmed. This contract is now ready to claim and can no longer be disputed.
                </div>
              )}
              {contract.status === 'completed' && !ratingDone && (isClient || isContractor) && (
                <div className="md:col-span-3 rounded-xl border border-white/10 bg-white/5 p-4 text-center">
                  <p className="text-sm text-gray-300">
                    Rate {isClient ? (contract.contractor_handle ? `@${contract.contractor_handle}` : 'the contractor') : (contract.client_handle ? `@${contract.client_handle}` : 'the client')}
                  </p>
                  <div className="mt-3 flex justify-center gap-2">
                    {[1, 2, 3, 4, 5].map((score) => (
                      <button
                        key={score}
                        onClick={() => {
                          setRatingScore(score);
                          handleRateContract(score);
                        }}
                        disabled={ratingSubmitting}
                        className={`flex items-center justify-center rounded-full border px-3 py-1.5 text-xs font-semibold transition-all ${
                          (ratingScore || 0) >= score
                            ? 'border-amber-400/50 bg-amber-400/20 text-amber-200'
                            : 'border-white/10 bg-white/5 text-gray-300 hover:text-white'
                        }`}
                      >
                        {score}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-gray-500">Tap a star count to submit your rating.</p>
                </div>
              )}
              {contract.status === 'completed' && (ratingDone || (!isClient && !isContractor)) && (
                <div className="md:col-span-3 text-center text-sm text-gray-400">
                  This contract was completed successfully.
                </div>
              )}
            </div>
          </div>

        </div>
      </main>

      {showMilestoneModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Add Milestone</h3>
            <p className="text-sm text-gray-400 mb-4">Describe what needs to be delivered.</p>
            <textarea
              value={milestoneDraft}
              onChange={(event) => setMilestoneDraft(event.target.value)}
              rows={4}
              className="w-full bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              placeholder="e.g. Provide initial design mockups"
            />
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  setShowMilestoneModal(false);
                  setMilestoneDraft('');
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddMilestone}
                disabled={milestoneSaving || !milestoneDraft.trim()}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors disabled:opacity-60"
              >
                {milestoneSaving ? 'Adding...' : 'Add milestone'}
              </button>
            </div>
            {milestoneSaving && milestoneStep && (
              <div className="mt-4">
                <p className="text-xs text-gray-400">{milestoneStep}</p>
                <div className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-brand-500 transition-all"
                    style={{ width: `${milestoneProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
              onClick={async () => {
                if (!privacyKeySecret) return;
                try {
                  await navigator.clipboard.writeText(privacyKeySecret);
                  setPrivacyKeyCopied(true);
                  toast({
                    title: 'Copied',
                    description: 'Privacy key copied. Store it safely.',
                    variant: 'success',
                  });
                } catch {
                  toast({
                    title: 'Copy failed',
                    description: 'Unable to copy the privacy key.',
                    variant: 'destructive',
                  });
                }
              }}
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
              Contract ID: {contract?.id || ''}
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  if (!privacyKeyCopied) return;
                  if (contract?.id) {
                    localStorage.setItem(`nebulon_contract_key_ack:${contract.id}`, '1');
                  }
                  setShowPrivacyKeyModal(false);
                  setPrivacyKeySecret('');
                  setPrivacyKeyCopied(false);
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

      {showPrivacyKeyInput && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-lg w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Re-enter Privacy Key</h3>
            <p className="text-sm text-gray-400 mb-4">
              Paste your contract privacy key to unlock encrypted milestones on this device.
            </p>
            <textarea
              value={privacyKeyInput}
              onChange={(event) => setPrivacyKeyInput(event.target.value)}
              rows={3}
              className="w-full bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
              placeholder="Paste privacy key"
            />
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  setShowPrivacyKeyInput(false);
                  setPrivacyKeyInput('');
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handlePrivacyKeyImport}
                disabled={keyRegistrationPending}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors disabled:opacity-60"
              >
                {keyRegistrationPending ? 'Saving...' : 'Save key'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteKeyModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Delete Privacy Key</h3>
            <p className="text-sm text-gray-400 mb-4">
              This will delete the locally stored privacy key and show milestones as encrypted.
              Continue?
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setShowDeleteKeyModal(false)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeletePrivacyKey}
                className="flex-1 bg-red-500 hover:bg-red-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Delete key
              </button>
            </div>
          </div>
        </div>
      )}

      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-md w-full">
            <h3 className="text-lg font-semibold text-white mb-2">{confirmTitle}</h3>
            {confirmTicket && (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 mb-4">
                {confirmDeadline && (
                  <div className="flex items-center justify-between text-sm text-gray-300 mb-3">
                    <span>Deadline</span>
                    <span className="font-medium text-white">{confirmDeadline}</span>
                  </div>
                )}
                {confirmDeadline && (
                  <div className="border-t border-white/10 mb-3" />
                )}
                <div className="flex items-center justify-between text-sm text-gray-300">
                  <span>Amount</span>
                  <span className="font-medium text-white">{confirmTicket.amount}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-sm text-gray-300">
                  <span>Protocol fee (2%)</span>
                  <span className="font-medium text-white">-{confirmTicket.fee}</span>
                </div>
                <div className="mt-3 border-t border-white/10 pt-3 flex items-center justify-between">
                  <span className="text-sm text-gray-400">Service provider receives</span>
                  <span className="text-base font-semibold text-emerald-300">{confirmTicket.net}</span>
                </div>
              </div>
            )}
            {confirmLines.length > 0 && (
              <div className="space-y-2">
                {confirmLines.map((line, index) => {
                  const isDisclaimer = index === confirmLines.length - 1;
                  const isMilestoneTitle = index === 0;
                  return (
                    <p
                      key={`${line}-${index}`}
                      className={
                        isDisclaimer
                          ? 'text-xs text-gray-500'
                          : isMilestoneTitle
                            ? 'text-base text-white font-semibold text-center'
                            : 'text-sm text-gray-300'
                      }
                    >
                      {line}
                    </p>
                  );
                })}
              </div>
            )}
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmAction(null);
                  setConfirmTicket(null);
                  setConfirmDeadline(null);
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  confirmAction?.();
                  setConfirmTicket(null);
                  setConfirmDeadline(null);
                }}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Sign &amp; Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {showModifyTermsModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-dark-900 border border-white/10 rounded-2xl p-6 max-w-lg w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Modify Terms</h3>
            <p className="text-sm text-gray-400 mb-4">
              Update the deadline and payment for this contract.
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Deadline</label>
                <div className="mt-2 flex gap-2">
                  <select
                    value={editDeadlinePreset}
                    onChange={(event) => setEditDeadlinePreset(event.target.value)}
                    className="flex-1 bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                  >
                    <option value="">Select deadline</option>
                    {deadlineOptions.map((days) => (
                      <option key={days} value={days.toString()}>
                        {days}d
                      </option>
                    ))}
                    <option value="custom">Custom</option>
                  </select>
                  {editDeadlinePreset === 'custom' && (
                    <input
                      type="number"
                      min="1"
                      value={editCustomDeadlineDays}
                      onChange={(event) => setEditCustomDeadlineDays(event.target.value)}
                      placeholder="Days"
                      className="w-24 bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                    />
                  )}
                </div>
                {!editDeadlineDaysValid && editDeadlinePreset && (
                  <p className="text-xs text-red-400 mt-1">Enter a valid number of days.</p>
                )}
              </div>

              <div>
                <label className="text-xs text-gray-500 uppercase tracking-wide">Payment (USDC)</label>
                <input
                  value={editPaymentInput}
                  onChange={(event) => setEditPaymentInput(event.target.value)}
                  placeholder="e.g. 250 or 250.50"
                  className="mt-2 w-full bg-dark-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                />
                {editPaymentInput && !editPaymentValid && (
                  <p className="text-xs text-red-400 mt-1">Enter a valid amount.</p>
                )}
                {editPaymentValid && editPaymentBasePreview && (
                  <p className="text-xs text-gray-500 mt-1">
                    Total payment: {formatUsdc(editPaymentBasePreview)} USDC
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowModifyTermsModal(false)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleModifyTerms}
                disabled={submittingTerms || !hasEditChanges || !editDeadlineDaysValid || !editPaymentValid}
                className="flex-1 bg-brand-500 hover:bg-brand-600 text-white font-medium py-2 px-4 rounded-lg transition-colors disabled:opacity-60"
              >
                {submittingTerms ? 'Saving...' : 'Save terms'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
