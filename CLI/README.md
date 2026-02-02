# Nebulon CLI

Nebulon CLI is the command-line interface for managing Nebulon escrow contracts,
wallets, capsules, and hosted profile actions. It supports MagicBlock ephemeral
rollups for contract operations and provides end-to-end contract workflows,
including terms, milestones, funding, and claims.

## Requirements

- Node.js 18 or newer
- npm 9 or newer

## Installation

Global install from npm:

```bash
npm install -g nebulon-escrow-cli
```

From source:

```bash
cd CLI
npm install
npm link
```

## Quick start

```bash
nebulon init
nebulon login
nebulon status
```

The `init` flow sets up a capsule, wallet, and network defaults. `login` connects
to hosted services. Use `status` to verify connectivity and balances.

## Command overview

Run `nebulon help` for the full list. Common commands:

- `nebulon init` - interactive setup (banner shows the CLI version)
- `nebulon status` - account summary
- `nebulon login` / `nebulon logout`
- `nebulon capsule list` / `nebulon capsule use <name>`
- `nebulon contract ...` - create and manage escrow contracts
- `nebulon invite list` / `nebulon invite <id>`
- `nebulon balance` / `nebulon address`
- `nebulon wallet export`
- `nebulon config` / `nebulon config <key> <value>`

### Contract commands (examples)

```bash
nebulon contract list
nebulon contract <id> details
nebulon contract <id> add term payment 20
nebulon contract <id> add term deadline 8d
nebulon contract <id> add milestone "Draft spec"
nebulon contract <id> sign
nebulon contract <id> fund
nebulon contract <id> milestone 1 ready
nebulon contract <id> milestone 1 confirm
nebulon contract <id> claim_funds
```

### Verbose diagnostics

Use `--verbose` on contract commands to show additional progress and routing
details:

```bash
nebulon contract <id> fund --verbose
```

## Configuration and storage

By default, configuration and wallets are stored under:

- Windows: `%USERPROFILE%\\.nebulon\\`
- macOS/Linux: `~/.nebulon/`

Capsules live under `~/.nebulon/capsules/`. You can override the base directory
with the `NEBULON_HOME` environment variable.

Wallet import and export:

- Import expects keypair files in `C:\\Nebulon\\Wallets` (Windows).
- Export writes the active wallet to `C:\\Nebulon\\Wallets`.

## Version

```bash
nebulon --version
nebulon -v
```

## Troubleshooting

- If `login` or hosted actions fail, re-run `nebulon config` and confirm backend
  URLs and network settings.
- If RPC calls fail, verify the configured `rpcUrl` and `wsUrl`.
- Use `nebulon contract ... --verbose` for detailed progress output.
