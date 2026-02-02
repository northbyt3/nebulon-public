DEVNET PER Fix (Nebulon)
Date: 2026-02-02

Problem
- Localnet PER worked, devnet PER failed.
- Errors seen:
  - Cloudflare 502 from tee.magicblock.app during sendTransaction
  - InvalidWritableAccount when calling ER directly
  - Unauthorized (Custom 6000) on devnet ER without session token

Root Causes
1) TEE RPC CORS + instability
   - Browser POSTs to tee.magicblock.app are blocked by CORS.
   - Even with CORS bypass, tee.magicblock.app sometimes returns 502 for sendTransaction.
2) Devnet PER requires session auth
   - Direct ER calls on devnet require a Session Token (Gum) and correct validator delegation.
   - Localnet allows direct ER without auth; devnet does not.
3) Validator mismatch
   - Delegation must target the same validator as the router’s closest validator.

What We Changed

Backend (TEE proxy + diagnostics)
- Added a CORS-bypassing TEE proxy:
  - POST /v1/tee-proxy?token=...
  - Forwards JSON-RPC to tee.magicblock.app (tokenized).
  - Logs upstream errors and payload sizes.
- Added ping endpoint:
  - GET /v1/tee-proxy/ping?token=...
  - Calls getVersion with params: [].
- Removed auth requirement on proxy (Anchor doesn’t send auth headers).

Files
- backend/src/routes/tee-proxy.js
- backend/src/index.js

Backend env (devnet ER endpoints)
- Updated devnet ER endpoints:
  - EPHEMERAL_PROVIDER_ENDPOINT=https://devnet.magicblock.app
  - EPHEMERAL_WS_ENDPOINT=wss://devnet-router.magicblock.app

File
- backend/.env

Frontend PER test scene
- Added /PER-test for ER + TEE checks with visible success/fail logs.
- Uses backend config to prefill endpoints.
- Uses proxy for TEE RPC to bypass CORS.

File
- frontend/app/PER-test/page.tsx

DEBUG-test fixes (key success path)
- Tests contract terms submission via PER/TEE.

Critical Fixes
1) Use ER router’s closest validator
   - Call ConnectionMagicRouter and use the returned identity.
   - Delegate all PER accounts (terms, per-vault, escrow) to that validator.
2) Use Session Token (Gum) on devnet
   - Create/refresh a Session Token via SessionTokenManager.
   - Submit createPrivateTerms using:
     - sessionSigner as payer
     - sessionToken account
     - signed transaction via sendIxWithSigner
3) ER direct calls without session token are rejected on devnet
   - Error: Unauthorized (Custom 6000).
4) ER direct calls with wrong validator -> InvalidWritableAccount.

Result
- With ER direct + router validator + session token, createPrivateTerms succeeds on devnet.

File
- frontend/app/DEBUG-test/page.tsx

Contract page (local "fake privacy key" fallback)
- For devnet/localnet testing, if peer key/auth is missing, use local-only privacy key.
- Makes encrypted terms possible during dev testing.

File
- frontend/app/contracts/[id]/page.tsx

How to Reproduce Success (Devnet)
1) Backend config
   - Verify http://localhost:3333/v1/config returns:
     - ephemeralProviderUrl = https://devnet.magicblock.app
     - ephemeralWsUrl = wss://devnet-router.magicblock.app
2) Start backend
3) Open DEBUG-test
   - http://localhost:3000/DEBUG-test
4) Enable:
   - Use ER RPC directly (localnet-style)
   - Use Session Token (Gum)
5) Run
   - createPrivateTerms should succeed.

How to Verify ER Transaction
1) In /DEBUG-test, use the "ER Tx Lookup" box.
2) Paste the ER transaction signature (e.g., the one returned by createPrivateTerms).
3) Ensure ER RPC is set (auto-filled from config or router).
4) Click "Lookup ER Transaction".
5) The UI will show a success/failure badge and a short summary.

Notes:
- ER transactions will not appear on Solscan because they are not L1.
- The lookup uses the router-selected validator RPC to query getTransaction.

Notes
- Devnet requires session auth; localnet does not.
- TEE endpoint can be unstable on sendTransaction; proxy+retry recommended.
- If InvalidWritableAccount occurs, validator delegation mismatched the router’s closest validator.
