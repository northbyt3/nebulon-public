# MagicBlock Ephemeral Rollups - Complete Implementation Guide

## Table of Contents

1. [Overview](#overview)
2. [What are Ephemeral Rollups?](#what-are-ephemeral-rollups)
3. [Key Benefits](#key-benefits)
4. [Prerequisites](#prerequisites)
5. [Architecture Overview](#architecture-overview)
6. [Step-by-Step Implementation](#step-by-step-implementation)
7. [Anchor Framework Implementation](#anchor-framework-implementation)
8. [Rust Native Implementation](#rust-native-implementation)
9. [Client-Side Integration](#client-side-integration)
10. [Delegation Process](#delegation-process)
11. [Validators and Networks](#validators-and-networks)
12. [Testing and Deployment](#testing-and-deployment)
13. [Best Practices](#best-practices)
14. [Troubleshooting](#troubleshooting)
15. [Additional Resources](#additional-resources)

---

## Overview

MagicBlock's Ephemeral Rollups (ER) is an extension of the Solana network designed for high-performance decentralized applications. It enhances Solana's capabilities while preserving its composability and integrity.

**Delegation Program ID**: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

Any Solana program can be upgraded with Ephemeral Rollups by adding delegation capabilities, enabling:
- Zero-fee transactions
- Sub-10ms latency
- Real-time execution
- Full Solana composability

---

## What are Ephemeral Rollups?

Ephemeral Rollups leverage the Solana Virtual Machine (SVM)'s account-based structure and parallel execution to optimize state management. By structuring the state into clusters, users can:

1. **Lock accounts** - Temporarily shift state execution to a dedicated auxiliary layer
2. **Execute off-chain** - Process transactions with zero fees and sub-10ms latency
3. **Synchronize state** - Commit state changes back to Solana base layer when needed
4. **Maintain composability** - Full compatibility with existing Solana programs

The system uses a dynamic fraud-proof mechanism that enables fast state finalization through a decentralized Security Committee.

---

## Key Benefits

### ✅ Gasless Transactions
Zero fees enabling scalability and mass adoption. Users can interact with your dApp without worrying about transaction costs.

### ✅ Faster Block Times
Sub-10ms latency for seamless UX. Transactions are processed almost instantly, providing a near-instant user experience.

### ✅ High-precision Scheduling
Built-in automation to execute transactions at specific intervals. Perfect for automated tasks, cron jobs, and scheduled operations.

### ✅ Program and State Synchronization
No fragmentation, composable and upgradable. Your program state remains synchronized between base layer and ephemeral rollup.

### ✅ Horizontal Scaling
Multiple rollups on-demand for millions of transactions. Scale horizontally as your application grows.

### ✅ Familiar Tooling
Reusability of existing and familiar programming languages, libraries, and testing tools. Works with Anchor, Rust Native, and standard Solana tooling.

---

## Prerequisites

### Required Software

| Software   | Version | Installation Guide                                              |
| ---------- | ------- | --------------------------------------------------------------- |
| **Solana** | 2.3.13  | [Install Solana](https://docs.anza.xyz/cli/install)             |
| **Rust**   | 1.85.0  | [Install Rust](https://www.rust-lang.org/tools/install)         |
| **Anchor** | 0.32.1  | [Install Anchor](https://www.anchor-lang.com/docs/installation) |
| **Node**   | 24.10.0 | [Install Node](https://nodejs.org/en/download/current)          |

### Required Knowledge

- Basic understanding of Solana programming
- Familiarity with Anchor framework (for Anchor implementation)
- Understanding of Rust (for Rust Native implementation)
- Knowledge of TypeScript/JavaScript (for client-side integration)

---

## Architecture Overview

### Core Concepts

1. **Base Layer (Solana)**: The main Solana blockchain where your program is deployed
2. **Ephemeral Rollup (ER)**: The auxiliary layer where delegated accounts execute
3. **Delegation Program**: MagicBlock's program that manages account delegation
4. **Validator**: The entity that processes transactions in the ephemeral rollup

### Workflow

```
┌─────────────────┐
│  Base Layer     │
│  (Solana)       │
└────────┬────────┘
         │
         │ 1. Delegate
         ▼
┌─────────────────┐
│  Delegation     │
│  Program        │
└────────┬────────┘
         │
         │ 2. Transfer Ownership
         ▼
┌─────────────────┐
│  Ephemeral      │
│  Rollup (ER)    │
│  - Zero fees    │
│  - Sub-10ms     │
│  - Real-time    │
└────────┬────────┘
         │
         │ 3. Commit
         ▼
┌─────────────────┐
│  Base Layer     │
│  (Synchronized) │
└─────────────────┘
```

### Account Lifecycle

1. **Initialization**: Account created on Solana base layer
2. **Delegation**: Account ownership transferred to Delegation Program
3. **Execution**: Account state modified in Ephemeral Rollup
4. **Commitment**: State changes scheduled for synchronization
5. **Undelegation**: Account ownership returned to original program

---

## Step-by-Step Implementation

### Overview

The implementation process consists of four main steps:

1. **Write your program** - Create your Solana program as you normally would
2. **Add delegation hooks** - Integrate CPI hooks for delegation, commit, and undelegation
3. **Deploy on Solana** - Deploy your program using Anchor or Solana CLI
4. **Execute transactions** - Send transactions on both base layer and ephemeral rollup

---

## Anchor Framework Implementation

### Step 1: Project Setup

Create a new Anchor project:

```bash
anchor init anchor-counter
cd anchor-counter
```

### Step 2: Add Dependencies

Add the Ephemeral Rollups SDK to your `Cargo.toml`:

```toml
[dependencies]
ephemeral-rollups-sdk = { version = "0.1.0", features = ["anchor"] }
```

Or using cargo:

```bash
cargo add ephemeral-rollups-sdk --features anchor
```

### Step 3: Write Your Program

Create a simple counter program with delegation capabilities:

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{
    commit,
    delegate,
    ephemeral
};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{
    commit_accounts,
    commit_and_undelegate_accounts
};

declare_id!("YourProgramIDHere");

#[ephemeral]
#[program]
pub mod anchor_counter {
    use super::*;

    // Seed constant for PDA
    const TEST_PDA_SEED: &[u8] = b"counter_account";

    /// Initialize the counter.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        msg!("Counter initialized to 0");
        Ok(())
    }

    /// Increment the counter.
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;
        msg!("Counter incremented to {}", counter.count);
        Ok(())
    }

    /// Delegate the counter account to the delegation program
    /// This is called on the Base Layer (Solana)
    /// Set specific validator based on ER, see validator section
    #[delegate]
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        msg!("Delegating counter account to Ephemeral Rollup");
        Ok(())
    }

    /// Increment the counter and manually commit the account in the Ephemeral Rollup session.
    /// This is called on the Ephemeral Rollup
    pub fn increment_and_commit(ctx: Context<IncrementAndCommit>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count += 1;
        msg!("Counter incremented to {} and committed", counter.count);
        Ok(())
    }

    /// Undelegate the account from the delegation program
    /// This can be called on both Base Layer and Ephemeral Rollup
    #[ephemeral]
    pub fn undelegate(ctx: Context<UndelegateInput>) -> Result<()> {
        msg!("Undelegating counter account from Ephemeral Rollup");
        Ok(())
    }
}

/// Context for initializing counter
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + 8,
        seeds = [TEST_PDA_SEED],
        bump
    )]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Context for incrementing counter
#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [TEST_PDA_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

/// Context for delegating counter
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    #[account(mut, seeds = [TEST_PDA_SEED], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Context for incrementing and committing
#[derive(Accounts)]
pub struct IncrementAndCommit<'info> {
    #[account(mut, seeds = [TEST_PDA_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

/// Context for undelegating
#[derive(Accounts)]
pub struct UndelegateInput<'info> {
    #[account(mut, seeds = [TEST_PDA_SEED], bump)]
    pub counter: Account<'info, Counter>,
}

/// Counter struct
#[account]
pub struct Counter {
    pub count: u64,
}
```

### Step 4: Configure Validator

The `#[delegate]` macro automatically handles delegation, but you need to specify which validator to use. You can do this in your instruction or use a default:

```rust
// In your delegate instruction or configuration
let validator = match ctx.accounts.validator {
    Some(v) => v.key(),
    None => pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"), // Default: Local ER
};

// The delegate macro will use this validator
```

### Step 5: Build and Deploy

```bash
# Build the program
anchor build

# Deploy to devnet
anchor deploy --provider.cluster devnet

# Or deploy to mainnet
anchor deploy --provider.cluster mainnet
```

---

## Rust Native Implementation

### Step 1: Add Dependencies

Add to your `Cargo.toml`:

```toml
[dependencies]
solana-program = "~1.18"
ephemeral-rollups-sdk = "0.1.0"
```

### Step 2: Import Required Modules

```rust
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    pubkey::Pubkey,
    entrypoint::ProgramResult,
    program_error::ProgramError,
};
use ephemeral_rollups_sdk::cpi::{
    delegate_account,
    commit_account,
    undelegate_account,
    DelegateAccounts,
    DelegateConfig,
};
```

### Step 3: Implement Delegate Instruction

```rust
// For Base Layer only
// Set specific validator based on ER, see validator section
pub fn process_delegate(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    
    // Extract accounts
    let initializer = next_account_info(account_info_iter)?;
    let system_program = next_account_info(account_info_iter)?;
    let pda_to_delegate = next_account_info(account_info_iter)?;
    let owner_program = next_account_info(account_info_iter)?;
    let delegation_buffer = next_account_info(account_info_iter)?;
    let delegation_record = next_account_info(account_info_iter)?;
    let delegation_metadata = next_account_info(account_info_iter)?;
    let delegation_program = next_account_info(account_info_iter)?;
    
    // Optional: Get validator from accounts or use default
    let validator_pubkey = match account_info_iter.next() {
        Some(validator_account) => validator_account.key.clone(),
        None => pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"), // Local ER validator
    };

    // Prepare PDA seeds
    let seed_1 = b"counter_account";
    let seed_2 = initializer.key.as_ref();
    let pda_seeds: &[&[u8]] = &[seed_1, seed_2];

    // Prepare delegate accounts
    let delegate_accounts = DelegateAccounts {
        payer: initializer,
        pda: pda_to_delegate,
        owner_program,
        buffer: delegation_buffer,
        delegation_record,
        delegation_metadata,
        delegation_program,
        system_program,
    };

    // Configure delegation
    let delegate_config = DelegateConfig {
        validator: Some(validator_pubkey), // Set delegating ER validator
        ..Default::default()
    };

    // Execute delegation
    delegate_account(delegate_accounts, pda_seeds, delegate_config)?;

    Ok(())
}
```

### Step 4: Implement Commit Instruction

```rust
// For Ephemeral Rollup only
pub fn process_commit(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    
    let pda_to_commit = next_account_info(account_info_iter)?;
    let owner_program = next_account_info(account_info_iter)?;
    let delegation_buffer = next_account_info(account_info_iter)?;
    let delegation_record = next_account_info(account_info_iter)?;
    let delegation_metadata = next_account_info(account_info_iter)?;
    let delegation_program = next_account_info(account_info_iter)?;

    // Prepare PDA seeds
    let seed_1 = b"counter_account";
    let seed_2 = b"user_pubkey"; // Replace with actual user pubkey
    let pda_seeds: &[&[u8]] = &[seed_1, seed_2];

    // Prepare commit accounts
    let commit_accounts = commit_accounts(
        pda_to_commit,
        owner_program,
        delegation_buffer,
        delegation_record,
        delegation_metadata,
        delegation_program,
    );

    // Execute commit
    commit_account(commit_accounts, pda_seeds)?;

    Ok(())
}
```

### Step 5: Implement Commit and Undelegate

```rust
// For Ephemeral Rollup only
pub fn process_commit_and_undelegate(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let account_info_iter = &mut accounts.iter();
    
    let pda_to_commit = next_account_info(account_info_iter)?;
    let owner_program = next_account_info(account_info_iter)?;
    let delegation_buffer = next_account_info(account_info_iter)?;
    let delegation_record = next_account_info(account_info_iter)?;
    let delegation_metadata = next_account_info(account_info_iter)?;
    let delegation_program = next_account_info(account_info_iter)?;

    // Prepare PDA seeds
    let seed_1 = b"counter_account";
    let seed_2 = b"user_pubkey"; // Replace with actual user pubkey
    let pda_seeds: &[&[u8]] = &[seed_1, seed_2];

    // Prepare commit and undelegate accounts
    let commit_and_undelegate_accounts = commit_and_undelegate_accounts(
        pda_to_commit,
        owner_program,
        delegation_buffer,
        delegation_record,
        delegation_metadata,
        delegation_program,
    );

    // Execute commit and undelegate
    commit_and_undelegate_account(commit_and_undelegate_accounts, pda_seeds)?;

    Ok(())
}
```

---

## Client-Side Integration

### TypeScript/JavaScript with Solana Web3.js

#### Setup

```bash
npm install @solana/web3.js @solana/spl-token
```

#### Initialize Connections

```typescript
import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    sendAndConfirmTransaction,
} from '@solana/web3.js';

// Base Layer connection (Solana)
const connectionBaseLayer = new Connection(
    'https://api.devnet.solana.com',
    'confirmed'
);

// Ephemeral Rollup connection
const ephemeralConnection = new Connection(
    'https://devnet-us.magicblock.app', // Use appropriate ER endpoint
    'confirmed'
);

// Delegation Program ID
const DELEGATION_PROGRAM_ID = new PublicKey(
    'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'
);

// Your program ID
const YOUR_PROGRAM_ID = new PublicKey('YourProgramIDHere');

// Validator addresses
const VALIDATORS = {
    ASIA: new PublicKey('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57'),
    EU: new PublicKey('MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e'),
    US: new PublicKey('MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd'),
    TEE: new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'),
    LOCAL: new PublicKey('mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev'),
};
```

#### Delegate Account (Base Layer)

```typescript
import { SystemProgram } from '@solana/web3.js';

async function delegateAccount(
    userKeypair: Keypair,
    feePayerKeypair: Keypair,
    counterPDA: PublicKey,
    validator: PublicKey = VALIDATORS.US
) {
    // Get required accounts for delegation
    const [delegationBuffer] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_buffer'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    const [delegationRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_record'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    const [delegationMetadata] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_metadata'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    // Create delegate instruction
    const delegateInstruction = await createDelegateInstruction({
        payer: feePayerKeypair.publicKey,
        delegatedAccount: counterPDA,
        ownerProgram: YOUR_PROGRAM_ID,
        validator: validator,
        delegationBuffer: delegationBuffer,
        delegationRecord: delegationRecord,
        delegationMetadata: delegationMetadata,
        delegationProgram: DELEGATION_PROGRAM_ID,
    });

    // Create and send transaction
    const tx = new Transaction().add(delegateInstruction);
    tx.feePayer = feePayerKeypair.publicKey;

    const txSignature = await sendAndConfirmTransaction(
        connectionBaseLayer,
        tx,
        [userKeypair, feePayerKeypair],
        {
            skipPreflight: true,
        }
    );

    console.log('Delegation successful:', txSignature);
    return txSignature;
}
```

#### Execute on Ephemeral Rollup

```typescript
async function incrementOnEphemeralRollup(
    userKeypair: Keypair,
    feePayerKeypair: Keypair,
    counterPDA: PublicKey
) {
    // Create increment instruction
    const incrementInstruction = await createIncrementInstruction({
        counter: counterPDA,
        user: userKeypair.publicKey,
    });

    // Create and send transaction on ephemeral rollup
    const tx = new Transaction().add(incrementInstruction);
    tx.feePayer = feePayerKeypair.publicKey;

    const txSignature = await sendAndConfirmTransaction(
        ephemeralConnection,
        tx,
        [userKeypair, feePayerKeypair],
        {
            skipPreflight: true,
        }
    );

    console.log('Increment on ER successful:', txSignature);
    return txSignature;
}
```

#### Commit and Undelegate

```typescript
async function commitAndUndelegate(
    userKeypair: Keypair,
    feePayerKeypair: Keypair,
    counterPDA: PublicKey
) {
    // Get required accounts
    const [delegationBuffer] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_buffer'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    const [delegationRecord] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_record'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    const [delegationMetadata] = PublicKey.findProgramAddressSync(
        [Buffer.from('delegation_metadata'), counterPDA.toBuffer()],
        DELEGATION_PROGRAM_ID
    );

    // Create commit and undelegate instruction
    const commitAndUndelegateInstruction = await createCommitAndUndelegateInstruction({
        counter: counterPDA,
        ownerProgram: YOUR_PROGRAM_ID,
        delegationBuffer: delegationBuffer,
        delegationRecord: delegationRecord,
        delegationMetadata: delegationMetadata,
        delegationProgram: DELEGATION_PROGRAM_ID,
    });

    // Send on ephemeral rollup
    const tx = new Transaction().add(commitAndUndelegateInstruction);
    tx.feePayer = feePayerKeypair.publicKey;

    const txSignature = await sendAndConfirmTransaction(
        ephemeralConnection,
        tx,
        [userKeypair, feePayerKeypair],
        {
            skipPreflight: true,
        }
    );

    console.log('Commit and undelegate successful:', txSignature);
    return txSignature;
}
```

### TypeScript/JavaScript with Solana Kit

```typescript
import {
    createTransactionMessage,
    setTransactionMessageFeePayer,
    appendTransactionMessageInstructions,
    pipe,
} from '@solana/kit';
import {
    address,
    cryptoKeyPairToTransactionSigner,
} from '@solana/web3.js';

// Create delegate instruction
const accountSigner = await cryptoKeyPairToTransactionSigner(userKeypair);
const delegationProgramAddress = address(DELEGATION_PROGRAM_ID.toString());

const assignInstruction = getAssignInstruction({
    account: accountSigner,
    programAddress: delegationProgramAddress,
});

const delegateInstruction = await createDelegateInstruction({
    payer: feePayerAddress,
    delegatedAccount: userAddress,
    ownerProgram: ownerProgramAddress,
    validator: validatorAddress,
});

// Prepare transaction
const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(feePayerAddress, tx),
    (tx) => appendTransactionMessageInstructions(
        [assignInstruction, delegateInstruction],
        tx
    )
);

// Send and confirm transaction
const txHash = await connection.sendAndConfirmTransaction(
    transactionMessage,
    [userKeypair, feePayerKeypair],
    { commitment: "confirmed", skipPreflight: true }
);
```

---

## Delegation Process

### Understanding Delegation

Delegation is the process of transferring account ownership from your program to MagicBlock's Delegation Program. This enables the account to be executed in the Ephemeral Rollup.

### Delegation Flow

1. **Prepare Accounts**: Get or create required delegation accounts (buffer, record, metadata)
2. **Call Delegate Instruction**: Execute delegate instruction on base layer
3. **Ownership Transfer**: Delegation Program gains ownership of the account
4. **Execute on ER**: Account can now be modified in Ephemeral Rollup
5. **Commit State**: Schedule state synchronization back to base layer
6. **Undelegate**: Return ownership to original program

### Account Types

#### On-Curve Accounts

On-curve accounts are standard Solana accounts that can sign transactions. To delegate them:

1. **Assign System Account**: Change account owner to Delegation Program
2. **Delegate**: Call delegate instruction

```typescript
// Assign instruction
const assignInstruction = SystemProgram.assign({
    accountPubkey: userPubkey,
    programId: DELEGATION_PROGRAM_ID,
});

// Delegate instruction
const delegateInstruction = createDelegateInstruction({
    payer: feePayerKeypair.publicKey,
    delegatedAccount: userPubkey,
    ownerProgram: ownerProgram,
    validator: validator,
});

// Both instructions in one transaction
const tx = new Transaction()
    .add(assignInstruction, delegateInstruction);
```

#### Program Derived Addresses (PDAs)

PDAs are accounts derived from seeds. They cannot sign transactions but can be delegated:

1. **Delegate**: Call delegate instruction with PDA seeds
2. **No assign needed**: PDAs don't require assignment

```typescript
const delegateInstruction = createDelegateInstruction({
    payer: feePayerKeypair.publicKey,
    delegatedAccount: pdaPubkey,
    ownerProgram: ownerProgram,
    validator: validator,
});

// Include seeds when signing
const tx = new Transaction().add(delegateInstruction);
await sendAndConfirmTransaction(
    connection,
    tx,
    [feePayerKeypair],
    {
        skipPreflight: true,
    }
);
```

### Commit Operations

#### Commit Only

Schedules state synchronization without undelegating:

```typescript
const commitInstruction = createCommitInstruction({
    counter: counterPDA,
    ownerProgram: YOUR_PROGRAM_ID,
    // ... other accounts
});

// Execute on Ephemeral Rollup
const tx = new Transaction().add(commitInstruction);
await sendAndConfirmTransaction(ephemeralConnection, tx, [signer]);
```

#### Commit and Undelegate

Schedules synchronization and undelegation in one operation:

```typescript
const commitAndUndelegateInstruction = createCommitAndUndelegateInstruction(
    counterPDA,
    [counterPDA] // Accounts to commit
);

// Execute on Ephemeral Rollup
const tx = new Transaction().add(commitAndUndelegateInstruction);
await sendAndConfirmTransaction(ephemeralConnection, tx, [signer]);
```

---

## Validators and Networks

### Public Validators for Development

These validators are supported for development. Make sure to add the specific ER validator in your instruction when delegating:

| Region | Hostname | Validator Address |
|--------|----------|-------------------|
| **Asia** | devnet-as.magicblock.app | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| **EU** | devnet-eu.magicblock.app | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` |
| **US** | devnet-us.magicblock.app | `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` |
| **TEE** | tee.magicblock.app | `FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA` |
| **Local ER** | localhost | `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` |

### Choosing a Validator

1. **Geographic Proximity**: Choose a validator closest to your users for lowest latency
2. **TEE for Privacy**: Use TEE validator for privacy-preserving applications
3. **Local Development**: Use local validator for testing

### RPC Endpoints

```typescript
const EPHEMERAL_ROLLUP_ENDPOINTS = {
    ASIA: 'https://devnet-as.magicblock.app',
    EU: 'https://devnet-eu.magicblock.app',
    US: 'https://devnet-us.magicblock.app',
    TEE: 'https://tee.magicblock.app',
    LOCAL: 'http://localhost:8899', // Adjust port as needed
};
```

### Network Configuration

```typescript
// Base Layer (Solana)
const BASE_LAYER_ENDPOINTS = {
    MAINNET: 'https://api.mainnet-beta.solana.com',
    DEVNET: 'https://api.devnet.solana.com',
    TESTNET: 'https://api.testnet.solana.com',
    LOCALHOST: 'http://localhost:8899',
};

// Ephemeral Rollup
const ER_ENDPOINTS = {
    ASIA: 'https://devnet-as.magicblock.app',
    EU: 'https://devnet-eu.magicblock.app',
    US: 'https://devnet-us.magicblock.app',
};
```

---

## Testing and Deployment

### Local Development Setup

1. **Start Local Validator**:

```bash
solana-test-validator
```

2. **Start Local Ephemeral Rollup**:

```bash
# Follow MagicBlock's local setup guide
# https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/local-development
```

3. **Deploy Program**:

```bash
anchor build
anchor deploy --provider.cluster localhost
```

### Testing Workflow

```typescript
async function testEphemeralRollup() {
    // 1. Initialize counter on base layer
    await initializeCounter(userKeypair, feePayerKeypair);
    
    // 2. Delegate counter to ER
    await delegateAccount(userKeypair, feePayerKeypair, counterPDA, VALIDATORS.US);
    
    // 3. Increment on ER (zero fees, fast)
    for (let i = 0; i < 10; i++) {
        await incrementOnEphemeralRollup(userKeypair, feePayerKeypair, counterPDA);
    }
    
    // 4. Commit and undelegate
    await commitAndUndelegate(userKeypair, feePayerKeypair, counterPDA);
    
    // 5. Verify state on base layer
    const counterState = await connectionBaseLayer.getAccountInfo(counterPDA);
    console.log('Final counter state:', counterState);
}
```

### Deployment Checklist

- [ ] Program compiled successfully
- [ ] All dependencies installed
- [ ] Validator endpoint configured
- [ ] Delegation Program ID verified
- [ ] Test transactions on devnet
- [ ] Verify state synchronization
- [ ] Test error handling
- [ ] Deploy to mainnet (if ready)

### Mainnet Deployment

```bash
# Set mainnet cluster
solana config set --url https://api.mainnet-beta.solana.com

# Build for production
anchor build --release

# Deploy
anchor deploy --provider.cluster mainnet

# Verify deployment
solana program show YOUR_PROGRAM_ID
```

---

## Best Practices

### 1. Error Handling

Always handle delegation errors gracefully:

```rust
pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
    // Check if already delegated
    // Handle delegation errors
    // Log delegation status
    
    msg!("Delegating account...");
    // Delegation logic
    Ok(())
}
```

### 2. State Validation

Validate state before and after delegation:

```typescript
async function safeDelegation(
    counterPDA: PublicKey,
    expectedState: number
) {
    // Verify initial state
    const initialState = await getCounterState(counterPDA);
    if (initialState !== expectedState) {
        throw new Error('State mismatch');
    }
    
    // Delegate
    await delegateAccount(...);
    
    // Verify delegation status
    const isDelegated = await checkDelegationStatus(counterPDA);
    if (!isDelegated) {
        throw new Error('Delegation failed');
    }
}
```

### 3. Transaction Retry Logic

Implement retry logic for network issues:

```typescript
async function sendWithRetry(
    connection: Connection,
    transaction: Transaction,
    signers: Keypair[],
    maxRetries: number = 3
): Promise<string> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await sendAndConfirmTransaction(
                connection,
                transaction,
                signers,
                { skipPreflight: true }
            );
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    throw new Error('Max retries exceeded');
}
```

### 4. Monitoring

Monitor delegation status and state synchronization:

```typescript
async function monitorDelegation(counterPDA: PublicKey) {
    const status = await checkDelegationStatus(counterPDA);
    const state = await getCounterState(counterPDA);
    
    console.log('Delegation Status:', status);
    console.log('Current State:', state);
    
    // Alert if state is out of sync
    if (status === 'delegated' && state === null) {
        console.warn('State not found on ER');
    }
}
```

### 5. Security Considerations

- **Validate Validator**: Always verify validator address before delegation
- **Check Ownership**: Verify account ownership before operations
- **Handle Undelegation**: Ensure proper undelegation to prevent stuck accounts
- **Monitor State**: Regularly check state synchronization

### 6. Performance Optimization

- **Batch Operations**: Group multiple operations when possible
- **Async Operations**: Use async/await for non-blocking operations
- **Connection Pooling**: Reuse connections when possible
- **Caching**: Cache account states to reduce RPC calls

---

## Troubleshooting

### Common Issues

#### 1. Delegation Fails

**Problem**: `Error: Account not found` or `Error: Invalid account owner`

**Solutions**:
- Verify account exists and is initialized
- Check account ownership is correct
- Ensure sufficient SOL for transaction fees
- Verify delegation program ID is correct

#### 2. State Not Synchronizing

**Problem**: Changes on ER not reflected on base layer

**Solutions**:
- Ensure commit instruction is called
- Check delegation status is active
- Verify validator is operational
- Wait for synchronization delay (usually < 1 minute)

#### 3. Transaction Fails on ER

**Problem**: Transactions rejected on Ephemeral Rollup

**Solutions**:
- Verify account is delegated
- Check validator endpoint is correct
- Ensure account state is valid
- Verify program logic handles ER execution

#### 4. Undelegation Fails

**Problem**: Cannot undelegate account

**Solutions**:
- Ensure commit is called before undelegation
- Check account is actually delegated
- Verify proper signers are provided
- Wait for previous operations to complete

### Debugging Tips

1. **Enable Logging**: Use `msg!()` in Rust or `console.log()` in TypeScript
2. **Check Account State**: Inspect account data before and after operations
3. **Verify Transactions**: Use Solana Explorer to inspect transactions
4. **Test Incrementally**: Test each step separately before combining

### Getting Help

- **Documentation**: https://docs.magicblock.gg
- **GitHub Examples**: https://github.com/magicblock-labs/magicblock-engine-examples
- **Discord**: Join MagicBlock's Discord community
- **Support**: Contact MagicBlock support for issues

---

## Additional Resources

### Official Documentation

- **Quickstart Guide**: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart
- **Rust Native Guide**: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/rust-program
- **Local Development**: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/local-development
- **API Reference**: https://docs.magicblock.gg/api-reference/er-api/introduction

### Code Examples

- **Anchor Counter**: https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/anchor-counter
- **React UI**: https://github.com/GabrielePicco/ephemeral-counter-ui
- **On-Curve Delegation**: https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/oncurve-delegation

### Video Tutorials

- **Build a real-time Anchor Counter**: https://www.youtube.com/watch?v=qwu2RBKyFiw

### Related Products

- **Private Ephemeral Rollups (PER)**: Privacy-preserving computation with TEE
- **Verifiable Randomness Function (VRF)**: Provably fair randomness on-chain
- **Cranks**: Scheduled execution on Ephemeral Rollups

### Solana Resources

- **Solana Explorer**: https://explorer.solana.com/
- **Solscan**: https://solscan.io/
- **Solana Docs**: https://docs.solana.com/

### RPC Providers

- **Solana**: Free public nodes
- **Helius**: Free shared nodes
- **Triton**: Dedicated high-performance nodes

---

## Summary

MagicBlock Ephemeral Rollups enable you to:

1. **Upgrade any Solana program** with zero-fee, real-time execution
2. **Maintain full composability** with existing Solana ecosystem
3. **Scale horizontally** for millions of transactions
4. **Use familiar tooling** (Anchor, Rust, TypeScript)

### Key Takeaways

- Delegation transfers account ownership to enable ER execution
- Commit synchronizes state changes back to base layer
- Undelegation returns ownership to original program
- Validators process transactions in different regions
- State remains synchronized between base layer and ER

### Next Steps

1. Set up your development environment
2. Create a simple counter program
3. Add delegation hooks
4. Test on devnet
5. Deploy to mainnet

---

**Last Updated**: Based on MagicBlock documentation as of 2025

**Delegation Program ID**: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

For the most up-to-date information, visit: https://docs.magicblock.gg

