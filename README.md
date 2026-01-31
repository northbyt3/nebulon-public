# Nebulon

Nebulon is a private, milestone-based escrow system for Web3 services. It combines an off-chain coordination server with on-chain enforcement on Solana. Terms and milestones can be public (L1) or private (PER) using MagicBlock TEE. The system is designed to reduce counterparty risk while preserving confidentiality when needed.

## Overview

Nebulon consists of three primary layers:

1) On-chain program (Solana)
   - Enforces escrow state, milestone lifecycle, payouts, and disputes.
   - Supports both public terms/milestones (L1) and private terms/milestones (PER).

2) Off-chain backend (Node.js)
   - Hosts authentication, profile and handle management, invites, and contract metadata.
   - Exposes a configuration endpoint used by the CLI and frontend to auto-discover network and program settings.
   - Runs an indexer that mirrors on-chain state into the backend for UI and CLI consumption.

3) Client interfaces
   - Web frontend (Next.js) for a rich UX.
   - CLI for power users, automation, and reliable on-chain operations.

## Key Concepts

- Escrow: A contract container that holds funds and tracks lifecycle state.
- Terms: Deadline and total payment, stored on-chain. In PER mode the full terms payload is encrypted off-chain with a shared key; only hashes are committed on-chain.
- Milestones: A list of deliverables that progress through states (created, submitted, approved/paid). In PER mode, milestone details are encrypted off-chain.
- L1 mode: Fully on-chain, public terms and milestones. More compatible but less private.
- PER mode: Privacy-enhanced mode using MagicBlock TEE and delegated accounts. Terms/milestones are private; only hashes are committed on-chain.

## How It Works

1) Contract creation and negotiation
   - A party creates a contract draft and invites the counterparty.
   - Both parties finalize terms and milestones.

2) Signing
   - Both parties sign the terms on-chain.
   - In L1 mode, terms are committed publicly.
   - In PER mode, terms are encrypted and committed via TEE.

3) Funding
   - The client funds the escrow in USDC. A protocol fee is applied.
   - The contract transitions to a funded state once on-chain validation confirms the deposit.

4) Milestone execution
   - The contractor submits milestones.
   - The client approves milestones as work is accepted.

5) Payouts
   - Once milestones are approved, funds become available to claim.

6) Disputes and resolution
   - A designated on-chain judge can resolve disputes according to program rules.

## Repository Structure

- backend/          Off-chain API server and indexer
- frontend/         Next.js web application
- CLI/              Nebulon CLI
- smart-contract/   Solana program and tests

## Backend

The backend provides authentication, invites, contract coordination, and a config endpoint for clients.

### Configuration

The backend uses environment variables. Defaults are in backend/src/config.js, and examples are in backend/.env.example.

Important variables:

- PORT
- BASE_URL (frontend base URL used for invite links)
- SOLANA_RPC_URL
- SOLANA_WS_URL
- SOLANA_NETWORK
- PROGRAM_ID
- EPHEMERAL_PROVIDER_ENDPOINT
- EPHEMERAL_TEE_ENDPOINT
- EPHEMERAL_TEE_WS_ENDPOINT
- JWT_SECRET
- ENABLE_INDEXER

### Run locally

```
cd backend
npm install
npm run dev
```

The API defaults to port 3333.

### Health and config endpoints

- GET /health
- GET /v1/config

## Frontend

The frontend is a Next.js application. It communicates with the backend via a single API base URL and supports both L1 and PER flows.

### Environment

Set the following in your deployment environment:

- NEXT_PUBLIC_API_URL
- NEXT_PUBLIC_APP_URL

### Run locally

```
cd frontend
npm install
npm run dev
```

### Production build

```
cd frontend
npm run build
npm run start
```

## CLI

The CLI is designed for reliability and automation. It is recommended for L1 operations when browser performance is constrained.
The CLI experience is more polished and is the preferred interface for production workflows.

### Install (local development)

```
cd CLI
npm install
npm link
```

### Install from npm

```
npm install -g nebulon-escrow-cli
```

### Initialize

```
nebulon init capsule 1
```

The CLI can auto-load configuration from the hosted backend using official mode.

## Deployment Notes

- Backend should run behind HTTPS to avoid mixed-content errors in the frontend.
- Configure Nginx to proxy to port 3333.
- Use a dedicated subdomain for the API (example: api.example.com) and set NEXT_PUBLIC_API_URL accordingly.

## Security Considerations

- Keep JWT_SECRET private and rotate it for production.
- Lock down admin routes using ADMIN_WALLETS and server-side checks.
- Use HTTPS for all client-to-backend traffic.
- For PER mode, ensure MagicBlock endpoints are correctly configured.

## Limitations

- L1 mode is public by design.
- PER mode depends on MagicBlock availability.
- The system assumes both parties follow the protocol flow; disputes are handled by the on-chain judge.

## License

UNLICENSED
