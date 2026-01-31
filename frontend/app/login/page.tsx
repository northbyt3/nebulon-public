'use client';

import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton, WalletDisconnectButton } from '@solana/wallet-adapter-react-ui';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import bs58 from 'bs58';

export default function LoginPage() {
  const { publicKey, connected, connecting, signMessage, disconnect, select } = useWallet();
  const router = useRouter();
  const [showVerification, setShowVerification] = useState(false);
  const [showProfileSetup, setShowProfileSetup] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [challenge, setChallenge] = useState<{ message: string; nonce: string } | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [nebulonId, setNebulonId] = useState('');
  const [selectedPfp, setSelectedPfp] = useState<string>('');
  const [showPfpModal, setShowPfpModal] = useState(false);
  const [checkingId, setCheckingId] = useState(false);
  const [idValidation, setIdValidation] = useState<{
    isValid: boolean;
    reason?: string;
    checked: boolean;
  }>({ isValid: false, checked: false });
  const [isInputFocused, setIsInputFocused] = useState(false);

  // If already authenticated, go straight to dashboard
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (token) {
      validateExistingToken(token);
    }
  }, [router]);

  // Check wallet state to guide verification/profile setup
  useEffect(() => {
    if (connected && publicKey) {
      console.log('🔗 Wallet connected:', publicKey.toString());
      const token = localStorage.getItem('authToken');
      if (token) {
        console.log('🔍 Found existing token - validating with backend...');
        // Validate token with backend before redirecting
        validateExistingToken(token);
      } else {
        console.log('🔍 User connected but not authenticated - checking user status...');
        // User is connected but not authenticated, check if they exist
        checkUserExists();
      }
    } else {
      console.log('🔌 Wallet disconnected - resetting login state');
    }
  }, [connected, publicKey, router]);

  // Set random default PFP when profile setup is shown
  useEffect(() => {
    if (showProfileSetup && !selectedPfp) {
      const randomPfp = Math.floor(Math.random() * 8) + 1; // 1-8
      setSelectedPfp(`${randomPfp}.png`);
      console.log('🎲 Random default PFP selected:', `${randomPfp}.png`);
    }
  }, [showProfileSetup, selectedPfp]);

  const validateExistingToken = async (token: string) => {
    try {
      console.log('🔐 Validating existing token with backend...');
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/me`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      console.log('📥 Token validation response status:', response.status);

      if (response.ok) {
        const userData = await response.json();
        console.log('✅ Token valid - user found:', userData);

        console.log('Already authenticated - redirecting to dashboard');
        setShowVerification(false);
        setShowProfileSetup(false);
        router.push('/dashboard');
        return;
      } else {
        console.log('❌ Token invalid or user not found');
        console.log('🗑️ Clearing invalid token from localStorage');
        // Token is invalid, clear it and check user status
        localStorage.removeItem('authToken');
        localStorage.removeItem('nebulonId');
        console.log('🔍 Checking user status after clearing invalid token...');
        checkUserExists();
      }
    } catch (error) {
      console.error('❌ Error validating token:', error);
      console.log('🗑️ Clearing token due to validation error');
      // On error, clear token and check user status
      localStorage.removeItem('authToken');
      localStorage.removeItem('nebulonId');
      console.log('🔍 Checking user status after clearing token...');
      checkUserExists();
    }
  };

  const checkUserExists = async () => {
    if (!publicKey) return;

    try {
      console.log('📡 Checking if user exists in database...');
      // Try to get user profile - if it fails, user doesn't exist
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/profile/${publicKey.toString()}`);

      console.log('📥 User existence check response status:', response.status);

      if (response.ok) {
        const profileData = await response.json();
        console.log('✅ Existing user found:', profileData.user);
        console.log('🔐 Existing user - proceeding to verification step');
        // Always proceed to verification for existing users (profile setup comes after)
        setShowVerification(true);
      } else {
        console.log('🆕 New user detected');
        console.log('🔐 New user - proceeding to verification step');
        // Always proceed to verification for new users (profile setup comes after)
        setShowVerification(true);
      }
    } catch (error) {
      console.error('❌ Error checking user existence:', error);
      console.log('🆕 Assuming new user due to error - showing profile setup');
      // Assume user doesn't exist and show profile setup
      setShowProfileSetup(true);
    }
  };


  const handleNebulonIdChange = (value: string) => {
    setNebulonId(value);
    // Reset validation when user types
    if (idValidation.checked) {
      setIdValidation({ isValid: false, checked: false });
    }
  };

  // Client-side validation (matches backend logic)
  const validateHandleLocally = (handle: string) => {
    const value = handle.trim().toLowerCase().replace(/^@/, "");

    if (!value) {
      return { ok: false, reason: "missing" };
    }

    if (value.length < 4 || value.length > 16) {
      return { ok: false, reason: "length" };
    }

    const HANDLE_REGEX = /^[a-z0-9._-]+$/;
    if (!HANDLE_REGEX.test(value)) {
      return { ok: false, reason: "characters" };
    }

    if (value.startsWith(".") || value.endsWith(".")) {
      return { ok: false, reason: "dots" };
    }

    if (value.includes("..")) {
      return { ok: false, reason: "dots" };
    }

    return { ok: true, value };
  };

  const validateNebulonId = async () => {
    const trimmedId = nebulonId.trim();

    if (!trimmedId) {
      // Empty is allowed (will auto-generate)
      setIdValidation({ isValid: true, checked: true });
      return;
    }

    // Local validation first
    const localValidation = validateHandleLocally(trimmedId);
    if (!localValidation.ok) {
      setIdValidation({
        isValid: false,
        reason: localValidation.reason,
        checked: true
      });
      return;
    }

    // If locally valid, check with server
    setCheckingId(true);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/ids/check?handle=${encodeURIComponent(trimmedId)}`);
      const { available, reason } = await response.json();

      setIdValidation({
        isValid: available,
        reason: available ? undefined : (reason || "taken"),
        checked: true
      });
    } catch (error) {
      console.error('Error checking ID availability:', error);
      setIdValidation({
        isValid: false,
        reason: "error",
        checked: true
      });
    } finally {
      setCheckingId(false);
    }
  };

  const proceedToVerification = () => {
    // If user provided an ID, check if it's available
    if (nebulonId.trim()) {
      if (idAvailable === true) {
        setShowProfileSetup(false);
        setShowVerification(true);
      } else if (idAvailable === false) {
        alert('This Nebulon ID is not available. Please choose a different one.');
        return;
      } else {
        alert('Please check if your Nebulon ID is available first.');
        return;
      }
    } else {
      // Empty ID - will use auto-generated
      setShowProfileSetup(false);
      setShowVerification(true);
    }
  };

  const completeProfileSetup = async () => {
    // User is already authenticated, now setting their Nebulon ID
    if (nebulonId.trim()) {
      // Validation should already be done, but double-check
      if (!idValidation.checked) {
        alert('Please check if your Nebulon ID is available first.');
        return;
      }

      if (!idValidation.isValid) {
        alert('Please choose a valid and available Nebulon ID.');
        return;
      }

      // Update handle for authenticated user
      try {
        console.log('🔄 Updating Nebulon ID for authenticated user...');
        const token = authToken || localStorage.getItem('authToken');
        if (!token) {
          alert('Session expired. Please verify your wallet again.');
          setShowProfileSetup(false);
          setShowVerification(true);
          return;
        }
        const updateResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/handle`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            nebulonId: nebulonId.trim(),
            pfp: selectedPfp,
          }),
        });

        if (updateResponse.ok) {
          const responseData = await updateResponse.json();
          console.log('✅ Handle updated successfully:', responseData);
          localStorage.setItem('nebulonId', responseData.handle);
          router.push('/dashboard');
        } else {
          const errorData = await updateResponse.json();
          console.error('❌ Handle update failed:', errorData);
          if (errorData.error === 'invalid_token') {
            localStorage.removeItem('authToken');
            setAuthToken(null);
            setShowProfileSetup(false);
            setShowVerification(true);
            alert('Session expired. Please verify your wallet again.');
          } else {
            alert(`Failed to update handle: ${errorData.error || 'Unknown error'}`);
          }
        }
      } catch (error) {
        console.error('❌ Error updating handle:', error);
        alert('Failed to update your Nebulon ID. Please try again.');
      }
    } else {
      // Empty ID - just redirect to dashboard (user is already authenticated)
      console.log('📝 Empty handle provided - user stays authenticated');
      router.push('/dashboard');
    }
  };

  const getChallenge = async () => {
    if (!publicKey) return;

    try {
      setAuthenticating(true);

      console.log('Getting challenge for wallet:', publicKey.toString());

      // Get challenge from backend
      const challengeResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/challenge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ wallet: publicKey.toString() }),
      });

      console.log('Challenge response status:', challengeResponse.status);

      if (!challengeResponse.ok) {
        const errorText = await challengeResponse.text();
        console.error('Challenge error response:', errorText);
        throw new Error(`Failed to get challenge: ${challengeResponse.status} ${errorText}`);
      }

      const challengeData = await challengeResponse.json();
      console.log('Challenge data received:', challengeData);
      setChallenge(challengeData);
    } catch (error) {
      console.error('Error getting challenge:', error);
      alert(`Failed to get authentication challenge: ${error.message}`);
    } finally {
      setAuthenticating(false);
    }
  };

  const verifyOwnership = async () => {
    if (!publicKey || !challenge || !signMessage) return;

    try {
      setAuthenticating(true);

      // Sign the message with wallet
      const messageBytes = new TextEncoder().encode(challenge.message);
      const signature = await signMessage(messageBytes);

      console.log('Original signature (Uint8Array):', signature);
      console.log('Message being signed:', challenge.message);

      // Convert signature to base58 for API (matches backend expectation)
      const signatureBase58 = bs58.encode(signature);
      console.log('Encoded signature (base58):', signatureBase58);

      // Verify signature with backend
      console.log('🔐 Sending verification request to backend...');
      console.log('📤 Request payload:', {
        wallet: publicKey.toString(),
        nonce: challenge.nonce,
        signature: signatureBase58.substring(0, 20) + '...',
        nebulonId: nebulonId.trim() || null,
      });

      const verifyResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/v1/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet: publicKey.toString(),
          nonce: challenge.nonce,
          signature: signatureBase58,
          nebulonId: nebulonId.trim() || null, // null means auto-generate
        }),
      });

      console.log('📥 Verify response status:', verifyResponse.status);

      if (verifyResponse.ok) {
        const responseData = await verifyResponse.json();
        console.log('✅ Authentication successful!');
        console.log('👤 User data:', responseData.user);
        console.log('🎫 Token received (first 20 chars):', responseData.token.substring(0, 20) + '...');

        localStorage.setItem('authToken', responseData.token);
        setAuthToken(responseData.token);

        // Always show profile setup after initial verification if no handle
        // This ensures ownership is proven BEFORE any profile data is set
        if (!responseData.user.handle) {
          console.log('👤 Ownership verified but no Nebulon ID - showing profile setup');
          localStorage.removeItem('nebulonId'); // Clear any cached handle
          setShowVerification(false);
          setShowProfileSetup(true);
          setChallenge(null); // Clear challenge
        } else {
          console.log('👤 User has Nebulon ID - redirecting to dashboard');
          localStorage.setItem('nebulonId', responseData.user.handle);
          // Redirect to dashboard
          router.push('/dashboard');
        }
      } else {
        const errorData = await verifyResponse.json();
        console.error('❌ Authentication failed:', errorData);
        alert(`Authentication failed: ${errorData.error || 'Unknown error'}`);
        setChallenge(null); // Reset challenge on failure
      }
    } catch (error) {
      console.error('Authentication error:', error);
      alert('Failed to sign message. Please try again.');
      setChallenge(null); // Reset challenge on failure
    } finally {
      setAuthenticating(false);
    }
  };


  const handleDisconnect = async () => {
    await disconnect();
    // Clear the selected wallet so autoConnect won't silently reconnect.
    select(null);
    localStorage.removeItem('walletName');
    setShowVerification(false);
    setShowProfileSetup(false);
    setChallenge(null);
    setAuthenticating(false);
    setNebulonId('');
    setIdValidation({ isValid: false, checked: false });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-900">
      <div className="max-w-md w-full mx-4">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-6">
            <Image
              src="/nebulonLogo.svg"
              alt="Nebulon"
              width={140}
              height={28}
              className="h-7 w-auto"
            />
          </div>
          <h1 className="text-2xl font-semibold text-white mb-2">Connect Your Wallet</h1>
          <p className="text-gray-400 text-sm">
            Connect your Solana wallet to start using Nebulon
          </p>
        </div>

        <div className="glass-panel p-8 rounded-2xl border border-white/5">
          {/* Wallet Connect Step */}
          {!showVerification && !showProfileSetup && (
            <div className="text-center">
              <div className="w-16 h-16 bg-brand-500/20 rounded-full flex items-center justify-center mb-6 mx-auto">
                <iconify-icon icon="solar:wallet-linear" width="32" className="text-brand-500" />
              </div>

              <WalletMultiButton className="!bg-brand-500 hover:!bg-brand-600 !text-white !rounded-full !px-8 !py-3 !font-semibold !shadow-[0_0_15px_rgba(110,86,207,0.4)] !transition-all" />

              <p className="text-xs text-gray-500 mt-4">
                By connecting, you agree to our Terms of Service
              </p>
            </div>
          )}

          {/* Profile Setup Step */}
          {showProfileSetup && (
            <div className="text-center">
              <h2 className="text-xl font-semibold text-white mb-6">Welcome to Nebulon!</h2>
              <p className="text-gray-400 text-sm mb-6">
                Select your profile picture and create your unique Nebulon ID
              </p>

              <div className="space-y-6">
                {/* Profile Picture Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-3">
                    Select Profile Picture
                  </label>
                  <div className="flex justify-center">
                    <button
                      onClick={() => setShowPfpModal(true)}
                      className="w-20 h-20 rounded-full overflow-hidden border-2 border-white/20 hover:border-brand-500 transition-colors"
                    >
                      {selectedPfp ? (
                        <img
                          src={`/pfps/${selectedPfp}`}
                          alt="Selected PFP"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-gray-600 flex items-center justify-center">
                          <iconify-icon icon="solar:user-linear" className="text-gray-400" width="32" />
                        </div>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Click to choose from 8 available options
                  </p>
                </div>

                {/* Nebulon ID */}
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">
                    Nebulon ID
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={nebulonId}
                      onChange={(e) => handleNebulonIdChange(e.target.value)}
                      onFocus={() => setIsInputFocused(true)}
                      onBlur={() => {
                        setIsInputFocused(false);
                        validateNebulonId();
                      }}
                      placeholder="your-unique-id"
                      className="flex-1 bg-dark-800 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-500 transition-colors"
                    />
                  </div>

                  {/* Validation Messages */}
                  {idValidation.checked && (
                    <div className="mt-2">
                      {idValidation.isValid ? (
                        <p className="text-green-400 text-xs flex items-center gap-1">
                          <iconify-icon icon="solar:check-circle-linear" width="14" />
                          {nebulonId.trim() ? "Available!" : "Will auto-generate"}
                        </p>
                      ) : (
                        <p className="text-red-400 text-xs flex items-center gap-1">
                          <iconify-icon icon="solar:close-circle-linear" width="14" />
                          {idValidation.reason === "missing" && "ID is required"}
                          {idValidation.reason === "length" && "Must be 4-16 characters"}
                          {idValidation.reason === "characters" && "Only letters, numbers, dots, underscores, and hyphens"}
                          {idValidation.reason === "dots" && "Cannot start/end with dots or have consecutive dots"}
                          {idValidation.reason === "taken" && "This ID is already taken"}
                          {idValidation.reason === "reserved" && "This username is not available"}
                          {idValidation.reason === "error" && "Error checking availability"}
                        </p>
                      )}
                    </div>
                  )}

                  {checkingId && (
                    <p className="text-blue-400 text-xs flex items-center gap-1 mt-2">
                      <iconify-icon icon="solar:refresh-circle-linear" width="14" className="animate-spin" />
                      Checking availability...
                    </p>
                  )}

                  <p className="text-xs text-gray-500 mt-1">
                    Leave empty for auto-generated ID
                  </p>
                </div>

                {/* Continue Button */}
                <button
                  onClick={completeProfileSetup}
                  disabled={
                    isInputFocused ||
                    (nebulonId.trim() && idValidation.checked && !idValidation.isValid) ||
                    checkingId
                  }
                  className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-full transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
                >
                  Continue
                  <iconify-icon icon="solar:arrow-right-linear" width="16" />
                </button>
              </div>
            </div>
          )}

          {/* Verification Step */}
          {showVerification && connected && publicKey && (
            <div className="text-center">
              <div className="w-16 h-16 bg-brand-500/20 rounded-full flex items-center justify-center mb-6 mx-auto">
                <iconify-icon icon="solar:check-circle-linear" width="32" className="text-brand-500" />
              </div>

              <h2 className="text-xl font-semibold text-white mb-2">Wallet Connected!</h2>
              <p className="text-gray-400 text-sm mb-6">
                Verify ownership to create your Nebulon account
              </p>

              <div className="space-y-4">
                {!challenge ? (
                  <button
                    onClick={getChallenge}
                    disabled={authenticating}
                    className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-full transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
                  >
                    {authenticating ? (
                      <>
                        <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin" />
                        Getting Challenge...
                      </>
                    ) : (
                      <>
                        <iconify-icon icon="solar:shield-check-linear" width="16" />
                        Verify Ownership
                      </>
                    )}
                  </button>
                ) : (
                  <>
                    <div className="p-4 bg-dark-800 rounded-lg border border-brand-500/20">
                      <p className="text-xs text-gray-500 mb-2">Sign this message to prove ownership:</p>
                      <p className="text-xs text-gray-300 font-mono bg-dark-900 p-2 rounded break-all">
                        {challenge.message}
                      </p>
                    </div>

                    <button
                      onClick={verifyOwnership}
                      disabled={authenticating}
                      className="w-full bg-brand-500 hover:bg-brand-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-full transition-all shadow-[0_0_15px_rgba(110,86,207,0.4)] hover:scale-105 active:scale-95 flex items-center justify-center gap-2"
                    >
                      {authenticating ? (
                        <>
                          <div className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin" />
                          Signing & Authenticating...
                        </>
                      ) : (
                        <>
                          <iconify-icon icon="solar:pen-linear" width="16" />
                          Sign & Continue
                        </>
                      )}
                    </button>
                  </>
                )}
              </div>

              <div className="mt-6 space-y-3">
                <div className="p-3 bg-dark-800 rounded-lg">
                  <p className="text-xs text-gray-500">Connected Wallet</p>
                  <p className="text-xs text-gray-300 font-mono mt-1">
                    {publicKey?.toString().slice(0, 8)}...{publicKey?.toString().slice(-8)}
                  </p>
                </div>

                <button
                  onClick={handleDisconnect}
                  className="bg-transparent border border-red-500/20 hover:border-red-500/40 text-red-400 hover:text-red-300 text-xs font-medium py-2 px-3 rounded-lg transition-colors"
                >
                  Disconnect Wallet
                </button>
              </div>

              <p className="text-xs text-gray-500 mt-4">
                Your wallet will prompt you to sign a message for security
              </p>
            </div>
          )}

          {/* Loading state */}
          {connecting && (
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full mx-auto mb-4"></div>
              <p className="text-gray-400">Connecting wallet...</p>
            </div>
          )}
        </div>

        {/* Supported Wallets */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500 mb-3">Supported Wallets</p>
          <div className="flex justify-center gap-4">
            <div className="text-xs text-gray-400">Phantom</div>
            <div className="text-xs text-gray-400">Solflare</div>
            <div className="text-xs text-gray-400">Backpack</div>
          </div>
        </div>
      </div>

      {/* PFP Selection Modal */}
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

