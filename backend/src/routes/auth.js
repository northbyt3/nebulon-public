const express = require("express");
const jwt = require("jsonwebtoken");
const { db } = require("../db");
const {
  ADMIN_WALLETS,
  DEFAULT_JUDGE,
  JWT_SECRET,
  JWT_TTL,
  CHALLENGE_TTL_SECONDS,
} = require("../config");
const { randomNonce } = require("../utils/crypto");
const { nowSeconds } = require("../utils/time");
const { isValidWallet, verifySignature } = require("../utils/solana");
const { generateHandle } = require("../utils/handle-generator");
const { normalizeHandle, validateHandle } = require("../utils/handles");

const router = express.Router();
const PROFILE_CHANGE_COOLDOWN_SECONDS = 90 * 24 * 60 * 60;

const formatPst = (unixSeconds) =>
  new Date(unixSeconds * 1000).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });


router.post("/challenge", (req, res) => {
  console.log('Challenge request received');
  console.log('Request body type:', typeof req.body);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  const wallet = (req.body.wallet || "").trim();
  console.log('Parsed wallet:', wallet, 'length:', wallet.length);
  if (!isValidWallet(wallet)) {
    console.log('Invalid wallet format');
    return res.status(400).json({ error: "invalid_wallet" });
  }
  const nonce = randomNonce();
  const expiresAt = nowSeconds() + CHALLENGE_TTL_SECONDS;
  const message = `Nebulon authentication\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(
    expiresAt * 1000
  ).toISOString()}`;
  db.prepare(
    "INSERT INTO auth_challenges (wallet, nonce, message, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(wallet, nonce, message, expiresAt, nowSeconds());
  return res.json({ nonce, message, expiresAt });
});

router.post("/verify", (req, res) => {
  console.log('🔐 POST /verify request received');
  console.log('📦 Request body:', JSON.stringify(req.body, null, 2));

  const wallet = (req.body.wallet || "").trim();
  const nonce = (req.body.nonce || "").trim();
  const signature = (req.body.signature || "").trim();
  const requestedHandle = req.body.nebulonId ? (req.body.nebulonId || "").trim() : null;

  console.log('👤 Wallet:', wallet, '(length:', wallet.length + ')');
  console.log('🎲 Nonce:', nonce, '(length:', nonce.length + ')');
  console.log('✍️  Signature:', signature.substring(0, 20) + '...', '(length:', signature.length + ')');
  console.log('🏷️  Requested handle:', requestedHandle, '(length:', requestedHandle ? requestedHandle.length : 0 + ')' );

  // For initial verification (ownership proof), don't assign any handle
  // Handle assignment happens separately after profile setup
  const isInitialVerification = !requestedHandle;
  console.log('🔍 Is initial verification (no handle requested):', isInitialVerification);

  if (!wallet || !nonce || !signature) {
    console.log('❌ Missing required fields');
    return res.status(400).json({ error: "missing_fields" });
  }
  if (!isValidWallet(wallet)) {
    console.log('❌ Invalid wallet format');
    return res.status(400).json({ error: "invalid_wallet" });
  }

  // If user requested a specific handle, check if it's available
  if (requestedHandle) {
    console.log('🔍 Checking handle availability for:', requestedHandle);
    const existingUser = db
      .prepare("SELECT wallet FROM users WHERE handle = ?")
      .get(requestedHandle);
    if (existingUser && existingUser.wallet !== wallet) {
      console.log('❌ Handle already taken by another user:', existingUser.wallet);
      return res.status(400).json({ error: "handle_taken" });
    }
    console.log('✅ Handle is available');
  }

  console.log('🔍 Looking up challenge for wallet:', wallet, 'nonce:', nonce);
  const challenge = db
    .prepare(
      "SELECT * FROM auth_challenges WHERE wallet = ? AND nonce = ? AND used_at IS NULL"
    )
    .get(wallet, nonce);
  if (!challenge) {
    console.log('❌ No valid challenge found');
    return res.status(400).json({ error: "invalid_challenge" });
  }
  if (challenge.expires_at < nowSeconds()) {
    console.log('❌ Challenge expired at:', new Date(challenge.expires_at * 1000).toISOString());
    return res.status(400).json({ error: "challenge_expired" });
  }

  console.log('📝 Challenge message from DB:', challenge.message);
  console.log('🔐 Attempting to verify signature...');

  const ok = verifySignature(wallet, challenge.message, signature);
  console.log('✅ Signature verification result:', ok);

  if (!ok) {
    console.log('❌ Signature verification failed');
    return res.status(401).json({ error: "invalid_signature" });
  }

  console.log('✅ Signature verified successfully!');

  console.log('✅ Marking challenge as used');
  db.prepare("UPDATE auth_challenges SET used_at = ? WHERE id = ?").run(
    nowSeconds(),
    challenge.id
  );

  const judgeRole = wallet === DEFAULT_JUDGE ? "judge" : null;
  const adminRole = ADMIN_WALLETS.includes(wallet) ? "admin" : null;
  const resolvedRole = judgeRole || adminRole || "user";
  console.log('👑 Determined role:', resolvedRole);

  let user = db
    .prepare("SELECT wallet, handle, role, profile_initialized_at FROM users WHERE wallet = ?")
    .get(wallet);

  const now = nowSeconds();

  if (!user) {
    console.log('🆕 NEW USER - Creating user account');

    // For initial verification, create account without handle
    // Handle will be set later through profile setup
    const handle = requestedHandle || null;

    if (handle) {
      console.log('🏷️  Assigned requested handle:', handle);
    } else {
      console.log('📝 No handle assigned - will be set through profile setup');
    }

    const profileInitializedAt = handle ? now : null;
    db.prepare(
      "INSERT INTO users (wallet, handle, role, profile_initialized_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wallet, handle, resolvedRole, profileInitializedAt, now, now);

    if (handle) {
      db.prepare(
        "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
      ).run(wallet, null, handle, now);
    }

    user = { wallet, handle, role: resolvedRole };
    console.log('✅ New user created successfully');
  } else {
    console.log('🔄 EXISTING USER - Updating user account');
    console.log('📊 Current user data:', { handle: user.handle, role: user.role });

    const updates = [];
    const values = [];
    if (user.role !== resolvedRole) {
      console.log(`⬆️  Updating role to ${resolvedRole}`);
      updates.push("role = ?");
      values.push(resolvedRole);
    }

    // Allow existing users to set their handle if they requested one and don't have one
    if (requestedHandle && !user.handle) {
      console.log('🏷️  Setting requested handle for existing user:', requestedHandle);
      updates.push("handle = ?");
      values.push(requestedHandle);
      if (!user.profile_initialized_at) {
        updates.push("profile_initialized_at = ?");
        values.push(now);
      }
      db.prepare(
        "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
      ).run(wallet, null, requestedHandle, now);
      user.handle = requestedHandle;
    }

    // NOTE: We do NOT auto-generate handles for existing users
    // Auto-generation should only happen during initial signup (new user creation)
    // Existing users without handles should be prompted to set one through the UI

    if (updates.length) {
      updates.push("updated_at = ?");
      values.push(now, wallet);
      console.log('💾 Updating user with:', updates.join(', '));
      db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE wallet = ?`).run(
        ...values
      );
    } else {
      console.log('ℹ️  No updates needed for existing user');
    }
    user.role = resolvedRole;
    console.log('✅ Existing user updated successfully');
  }

  console.log('🎫 Generating JWT token for user:', { wallet: user.wallet, handle: user.handle, role: user.role });
  const token = jwt.sign({ wallet, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_TTL,
  });
  console.log('✅ JWT token generated successfully');

  console.log('🚀 Authentication complete - sending response');
  return res.json({ token, user });
});

router.get("/profile/handle/:handle", (req, res) => {
  const rawHandle = (req.params.handle || "").trim();
  const validation = validateHandle(rawHandle);
  if (!validation.ok) {
    return res.status(400).json({ error: "invalid_handle", reason: validation.reason });
  }

  const handle = normalizeHandle(rawHandle);
  const user = db
    .prepare("SELECT wallet, handle, role, user_pfp FROM users WHERE handle = ?")
    .get(handle);

  if (!user) {
    return res.status(404).json({ error: "user_not_found" });
  }

  const inactiveStatuses = [
    "completed",
    "cancelled",
    "canceled",
    "declined",
    "expired",
    "pending_invite",
    "invite_canceled",
    "invite_cancelled",
    "invite_declined",
    "invite_expired",
    "invite_rejected",
  ];
  const placeholders = inactiveStatuses.map(() => "?").join(", ");
  const activeQuery = `
    SELECT COUNT(*) as count
    FROM contract_drafts
    WHERE (client_wallet = ? OR contractor_wallet = ?)
      AND status NOT IN (${placeholders})
  `;
  const activeParams = [user.wallet, user.wallet, ...inactiveStatuses];
  const activeRow = db.prepare(activeQuery).get(...activeParams);
  const completedRow = db
    .prepare("SELECT COUNT(*) as count FROM contract_drafts WHERE status = 'completed' AND (client_wallet = ? OR contractor_wallet = ?)")
    .get(user.wallet, user.wallet);
  const ratingRow = db
    .prepare("SELECT AVG(score) as avg, COUNT(*) as count FROM ratings WHERE ratee_wallet = ?")
    .get(user.wallet);

  return res.json({
    profile: {
      nebulonId: user.handle,
      wallet: user.wallet,
      role: user.role,
      pfp: user.user_pfp,
    },
    stats: {
      activeContracts: activeRow ? activeRow.count : 0,
      completedContracts: completedRow ? completedRow.count : 0,
      ratingAverage: ratingRow && ratingRow.avg ? Number(ratingRow.avg) : 0,
      ratingCount: ratingRow ? ratingRow.count : 0,
    },
  });
});

router.get("/me", (req, res) => {
  console.log('🔍 GET /me request received');
  console.log('Headers:', JSON.stringify(req.headers, null, 2));

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log('❌ No valid authorization header');
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = authHeader.substring(7);
  console.log('Token received (first 20 chars):', token.substring(0, 20) + '...');

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('✅ Token verified for wallet:', decoded.wallet, 'role:', decoded.role);

    const user = db
      .prepare("SELECT wallet, handle, role, user_pfp, handle_changed_at FROM users WHERE wallet = ?")
      .get(decoded.wallet);

    if (!user) {
      console.log('❌ User not found in database for wallet:', decoded.wallet);
      return res.status(404).json({ error: "user_not_found" });
    }

    console.log('✅ User found:', { wallet: user.wallet, handle: user.handle, role: user.role, pfp: user.user_pfp });
    return res.json({
      nebulonId: user.handle,
      wallet: user.wallet,
      role: user.role,
      pfp: user.user_pfp,
      handleChangedAt: user.handle_changed_at || null
    });
  } catch (error) {
    console.log('❌ Token verification failed:', error.message);
    return res.status(401).json({ error: "invalid_token" });
  }
});

router.get("/profile/cooldown", (req, res) => {
  console.log("🔒 GET /profile/cooldown request");
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log("🔒 GET /profile/cooldown for wallet:", decoded.wallet);
    const user = db
      .prepare("SELECT wallet, handle_changed_at FROM users WHERE wallet = ?")
      .get(decoded.wallet);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    const now = nowSeconds();
    const lastChangedAt = user.handle_changed_at ? Number(user.handle_changed_at) : null;
    const normalizedLastChangedAt =
      Number.isFinite(lastChangedAt) && lastChangedAt > 0 ? lastChangedAt : null;
    const inactiveStatuses = [
      "completed",
      "cancelled",
      "canceled",
      "declined",
      "expired",
      "pending_invite",
      "invite_canceled",
      "invite_cancelled",
      "invite_declined",
      "invite_expired",
      "invite_rejected",
    ];
    const placeholders = inactiveStatuses.map(() => "?").join(", ");
    const activeQuery = `
      SELECT COUNT(*) as count
      FROM contract_drafts
      WHERE (client_wallet = ? OR contractor_wallet = ?)
        AND status NOT IN (${placeholders})
    `;
    const activeParams = [user.wallet, user.wallet, ...inactiveStatuses];
    const activeRow = db.prepare(activeQuery).get(...activeParams);
    const activeContractsCount = activeRow ? activeRow.count : 0;

    const pendingInvitesRow = db
      .prepare(
        "SELECT COUNT(*) as count FROM invites WHERE status = 'pending' AND (issuer_wallet = ? OR invitee_wallet = ?)"
      )
      .get(user.wallet, user.wallet);
    const pendingInvitesCount = pendingInvitesRow ? pendingInvitesRow.count : 0;

    const nextAvailableAt = normalizedLastChangedAt
      ? normalizedLastChangedAt + PROFILE_CHANGE_COOLDOWN_SECONDS
      : null;
    const timeLocked = normalizedLastChangedAt ? now < nextAvailableAt : false;
    const lockReasons = [];
    if (timeLocked) lockReasons.push("cooldown");
    if (activeContractsCount > 0) lockReasons.push("active_contracts");
    if (pendingInvitesCount > 0) lockReasons.push("pending_invites");

    const canChange =
      !timeLocked && activeContractsCount === 0 && pendingInvitesCount === 0;
    return res.json({
      canChange,
      lastChangedAt: normalizedLastChangedAt,
      nextAvailableAt: timeLocked ? nextAvailableAt : null,
      nextAvailableAtPst: timeLocked ? formatPst(nextAvailableAt) : null,
      cooldownSeconds: PROFILE_CHANGE_COOLDOWN_SECONDS,
      lockReasons,
      activeContractsCount,
      pendingInvitesCount,
    });
  } catch (error) {
    return res.status(401).json({ error: "invalid_token" });
  }
});

router.get("/profile/:wallet", (req, res) => {
  const wallet = (req.params.wallet || "").trim();
  if (!isValidWallet(wallet)) {
    return res.status(400).json({ error: "invalid_wallet" });
  }

  const user = db
    .prepare("SELECT wallet, handle, role FROM users WHERE wallet = ?")
    .get(wallet);

  if (!user) {
    return res.status(404).json({ error: "user_not_found" });
  }

  return res.json({ user });
});


router.post("/handle", (req, res) => {
  console.log('🔄 POST /handle request received');
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log('❌ No valid authorization header');
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('✅ Token verified for wallet:', decoded.wallet);

    const requestedHandle = req.body.nebulonId
      ? (req.body.nebulonId || "").trim()
      : null;
    const requestedPfp = req.body.pfp ? (req.body.pfp || "").trim() : null;
    const normalizePfp = (value) => {
      if (!value) {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const match = trimmed.match(/([1-8])(?:\.png)?/);
      if (match) {
        return `${match[1]}.png`;
      }
      return trimmed;
    };

    console.log('🏷️ Requested handle:', requestedHandle);
    const normalizedPfp = normalizePfp(requestedPfp);
    console.log('🖼️  Requested PFP:', normalizedPfp);

    const now = nowSeconds();
    const wallet = decoded.wallet;
    const user = db
      .prepare("SELECT wallet, handle, user_pfp, handle_changed_at, profile_initialized_at FROM users WHERE wallet = ?")
      .get(wallet);
    if (!user) {
      return res.status(404).json({ error: "user_not_found" });
    }
    const lastChangedAt = user.handle_changed_at ? Number(user.handle_changed_at) : null;
    const normalizedLastChangedAt =
      Number.isFinite(lastChangedAt) && lastChangedAt > 0 ? lastChangedAt : null;
    const initializedAt = user.profile_initialized_at
      ? Number(user.profile_initialized_at)
      : null;
    const hasProfileInitialized =
      Number.isFinite(initializedAt) && initializedAt > 0;
    let handle = requestedHandle;
    if (handle) {
      const validation = validateHandle(handle);
      if (!validation.ok) {
        console.log('❌ Invalid handle');
        return res.status(400).json({ error: validation.reason || "invalid_handle" });
      }
      handle = validation.value;
    }

    const effectiveHandle = handle || user.handle;
    const handleChanged = handle && effectiveHandle !== user.handle;
    const pfpChanged = normalizedPfp && normalizedPfp !== user.user_pfp;

    const inactiveStatuses = [
      "completed",
      "cancelled",
      "canceled",
      "declined",
      "expired",
      "pending_invite",
      "invite_canceled",
      "invite_cancelled",
      "invite_declined",
      "invite_expired",
      "invite_rejected",
    ];
    const placeholders = inactiveStatuses.map(() => "?").join(", ");
    const activeQuery = `
      SELECT COUNT(*) as count
      FROM contract_drafts
      WHERE (client_wallet = ? OR contractor_wallet = ?)
        AND status NOT IN (${placeholders})
    `;
    const activeParams = [wallet, wallet, ...inactiveStatuses];
    const activeRow = db.prepare(activeQuery).get(...activeParams);
    const activeContractsCount = activeRow ? activeRow.count : 0;

    const pendingInvitesRow = db
      .prepare(
        "SELECT COUNT(*) as count FROM invites WHERE status = 'pending' AND (issuer_wallet = ? OR invitee_wallet = ?)"
      )
      .get(wallet, wallet);
    const pendingInvitesCount = pendingInvitesRow ? pendingInvitesRow.count : 0;

    if ((handleChanged || pfpChanged) && activeContractsCount > 0) {
      return res.status(400).json({
        error: "profile_change_blocked",
        reason: "active_contracts",
      });
    }

    if ((handleChanged || pfpChanged) && pendingInvitesCount > 0) {
      return res.status(400).json({
        error: "profile_change_blocked",
        reason: "pending_invites",
      });
    }

    if (
      (handleChanged || pfpChanged) &&
      normalizedLastChangedAt &&
      now < normalizedLastChangedAt + PROFILE_CHANGE_COOLDOWN_SECONDS
    ) {
      const retryAt = normalizedLastChangedAt + PROFILE_CHANGE_COOLDOWN_SECONDS;
      return res.status(429).json({
        error: "profile_change_rate_limited",
        retryAt,
        retryAtPst: formatPst(retryAt),
      });
    }

    if (!handleChanged && !pfpChanged) {
      return res.json({
        success: true,
        handle: user.handle,
        pfp: user.user_pfp,
        message: "Profile unchanged"
      });
    }

    if (handleChanged) {
      const existingUser = db
        .prepare("SELECT wallet FROM users WHERE handle = ?")
        .get(handle);
      if (existingUser && existingUser.wallet !== decoded.wallet) {
        console.log('❌ Handle already taken by another user');
        return res.status(400).json({ error: "handle_taken" });
      }
    }

    // Update user's handle and PFP
    const updateFields = [];
    const updateValues = [];

    if (handleChanged) {
      updateFields.push("handle = ?");
      updateValues.push(handle);
    }

    if (pfpChanged) {
      updateFields.push("user_pfp = ?");
      updateValues.push(normalizedPfp);
    }

    if (!hasProfileInitialized) {
      updateFields.push("profile_initialized_at = ?");
      updateValues.push(now);
    } else {
      updateFields.push("handle_changed_at = ?");
      updateValues.push(now);
    }

    updateFields.push("updated_at = ?");
    updateValues.push(now);
    updateValues.push(decoded.wallet);

    const updateResult = db.prepare(
      `UPDATE users SET ${updateFields.join(", ")} WHERE wallet = ?`
    ).run(...updateValues);

    if (updateResult.changes > 0) {
      // Log handle change
      if (handleChanged) {
        db.prepare(
          "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
        ).run(decoded.wallet, user.handle, handle, now);
      }

      console.log('✅ Profile updated successfully for user:', decoded.wallet);
      return res.json({
        success: true,
        handle: handleChanged ? handle : user.handle,
        pfp: pfpChanged ? normalizedPfp : user.user_pfp,
        message: "Profile updated successfully"
      });
    } else {
      console.log('❌ Failed to update profile - user not found');
      return res.status(404).json({ error: "user_not_found" });
    }
  } catch (error) {
    console.log('❌ Profile update failed:', error.message);
    return res.status(401).json({ error: "invalid_token" });
  }
});

module.exports = router;




