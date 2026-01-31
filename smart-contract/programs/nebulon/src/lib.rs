use anchor_lang::prelude::*;
use std::collections::BTreeSet;
use std::io::Cursor;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as TokenTransfer};
use ephemeral_rollups_sdk::access_control::instructions::{
    CommitAndUndelegatePermissionCpiBuilder, CreatePermissionCpiBuilder, UpdatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

declare_id!("6UqkmQ2iCkf3acBB71DdXtVd49EyuaftMz8V3E74USbC"); // devnet/localnet
pub const FEE_BPS: u64 = 200; // 2%
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const FEE_RECEIVER: Pubkey = pubkey!("w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq");
pub const DEFAULT_JUDGE: Pubkey = pubkey!("w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq");
pub const DEFAULT_DEADLINE_GRACE_SECONDS: i64 = 0;

pub const PROFILE_SEED: &[u8] = b"profile";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const MILESTONE_SEED: &[u8] = b"milestone";
pub const DISPUTE_SEED: &[u8] = b"dispute";
pub const TERMS_SEED: &[u8] = b"terms";
pub const PRIVATE_MILESTONE_SEED: &[u8] = b"private-milestone";
pub const PER_VAULT_SEED: &[u8] = b"per-vault";
pub const PER_VAULT_TOPUP_LAMPORTS: u64 = 10_000_000; // 0.01 SOL for PER rent
pub const TERMS_DISCRIMINATOR: [u8; 8] = [223, 24, 40, 223, 249, 219, 14, 97];
pub const PRIVATE_MILESTONE_DISCRIMINATOR: [u8; 8] = [176, 171, 202, 24, 180, 225, 97, 3];
pub const MAX_TERMS_CIPHERTEXT: usize = 256;
pub const MAX_MILESTONE_CIPHERTEXT: usize = 256;
pub const DELEGATION_PROGRAM_ID: Pubkey =
    pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

fn collect_private_milestones(
    program_id: &Pubkey,
    escrow_key: &Pubkey,
    milestone_count: u8,
    accounts: &[AccountInfo],
) -> Result<Vec<PrivateMilestone>> {
    let mut indices = BTreeSet::new();
    let mut milestones = Vec::new();
    for account in accounts {
        require!(account.owner == program_id, NebulonError::InvalidState);
        let data = account.try_borrow_data()?;
        let milestone = PrivateMilestone::try_deserialize(&mut &data[..])
            .map_err(|_| error!(NebulonError::InvalidState))?;
        require!(milestone.escrow == *escrow_key, NebulonError::InvalidState);
        let expected = Pubkey::find_program_address(
            &[PRIVATE_MILESTONE_SEED, escrow_key.as_ref(), &[milestone.index]],
            program_id,
        )
        .0;
        require!(*account.key == expected, NebulonError::InvalidState);
        require!(indices.insert(milestone.index), NebulonError::InvalidState);
        milestones.push(milestone);
    }
    require!(
        milestones.len() == milestone_count as usize,
        NebulonError::MissingMilestones
    );
    Ok(milestones)
}

fn collect_public_milestones(
    program_id: &Pubkey,
    escrow_key: &Pubkey,
    milestone_count: u8,
    accounts: &[AccountInfo],
) -> Result<Vec<Milestone>> {
    let mut indices = BTreeSet::new();
    let mut milestones = Vec::new();
    for account in accounts {
        require!(account.owner == program_id, NebulonError::InvalidState);
        let data = account.try_borrow_data()?;
        let milestone =
            Milestone::try_deserialize(&mut &data[..]).map_err(|_| error!(NebulonError::InvalidState))?;
        require!(milestone.escrow == *escrow_key, NebulonError::InvalidState);
        let expected = Pubkey::find_program_address(
            &[MILESTONE_SEED, escrow_key.as_ref(), &[milestone.index]],
            program_id,
        )
        .0;
        require!(*account.key == expected, NebulonError::InvalidState);
        require!(indices.insert(milestone.index), NebulonError::InvalidState);
        milestones.push(milestone);
    }
    require!(
        milestones.len() == milestone_count as usize,
        NebulonError::MissingMilestones
    );
    Ok(milestones)
}

fn fee_from_amount(amount: u64) -> Result<u64> {
    amount
        .checked_mul(FEE_BPS)
        .ok_or_else(|| error!(NebulonError::Overflow))?
        .checked_div(BPS_DENOMINATOR)
        .ok_or_else(|| error!(NebulonError::Overflow))
}

fn net_from_amount(amount: u64) -> Result<u64> {
    let fee = fee_from_amount(amount)?;
    amount
        .checked_sub(fee)
        .ok_or_else(|| error!(NebulonError::Overflow))
}

fn resolve_terms_deadline(deadline: i64, funded_at: i64) -> Result<i64> {
    if deadline > 0 {
        return Ok(deadline);
    }
    let offset = deadline
        .checked_abs()
        .ok_or_else(|| error!(NebulonError::Overflow))?;
    require!(funded_at > 0, NebulonError::InvalidDeadline);
    funded_at
        .checked_add(offset)
        .ok_or_else(|| error!(NebulonError::Overflow))
}

fn load_delegated_escrow(
    escrow_info: &AccountInfo,
    program_id: &Pubkey,
    escrow_id: u64,
) -> Result<Escrow> {
    require!(
        escrow_info.owner == program_id || escrow_info.owner == &DELEGATION_PROGRAM_ID,
        NebulonError::InvalidState
    );
    let escrow =
        Escrow::try_deserialize(&mut &escrow_info.try_borrow_data()?[..])
            .map_err(|_| error!(NebulonError::InvalidState))?;
    let (expected, bump) = Pubkey::find_program_address(
        &[ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        program_id,
    );
    require!(*escrow_info.key == expected, NebulonError::InvalidState);
    require!(escrow.bump == bump, NebulonError::InvalidState);
    require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
    Ok(escrow)
}

#[ephemeral]
#[program]
pub mod nebulon {
    use super::*;

    pub fn initialize_profile(ctx: Context<InitializeProfile>) -> Result<()> {
        let profile = &mut ctx.accounts.profile;
        profile.owner = ctx.accounts.owner.key();
        profile.stars = 0;
        profile.completed_jobs = 0;
        profile.total_earned = 0;
        Ok(())
    }

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        escrow_id: u64,
        _judge: Pubkey,
    ) -> Result<()> {
        let payer_key = ctx.accounts.payer.key();
        require!(
            payer_key == ctx.accounts.client.key()
                || payer_key == ctx.accounts.contractor.key(),
            NebulonError::Unauthorized
        );

        let per_vault_info = ctx.accounts.per_vault.to_account_info();
        if per_vault_info.data_is_empty() {
            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(0);
            let create_ix = anchor_lang::solana_program::system_instruction::create_account(
                ctx.accounts.payer.key,
                ctx.accounts.per_vault.key,
                lamports,
                0,
                &System::id(),
            );
            let escrow_key = ctx.accounts.escrow.key();
            let per_vault_seeds = &[
                PER_VAULT_SEED,
                escrow_key.as_ref(),
                &[ctx.bumps.per_vault],
            ];
            anchor_lang::solana_program::program::invoke_signed(
                &create_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    ctx.accounts.per_vault.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[per_vault_seeds],
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.creator = ctx.accounts.payer.key();
        escrow.client = ctx.accounts.client.key();
        escrow.contractor = ctx.accounts.contractor.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault_token = ctx.accounts.vault_token.key();
        escrow.escrow_id = escrow_id;
        escrow.terms_hash = [0u8; 32];
        escrow.milestones_hash = [0u8; 32];
        escrow.funded_amount = 0;
        escrow.released_amount = 0;
        escrow.funded_at = 0;
        escrow.dispute_open = false;
        escrow.paid_out = false;
        escrow.funding_ok = false;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        escrow.judge = DEFAULT_JUDGE;
        escrow.per_vault = ctx.accounts.per_vault.key();
        escrow.bump = ctx.bumps.escrow;
        escrow.per_vault_bump = ctx.bumps.per_vault;

        if PER_VAULT_TOPUP_LAMPORTS > 0 {
            let cpi_accounts = system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.per_vault.to_account_info(),
            };
            let cpi_ctx =
                CpiContext::new(ctx.accounts.system_program.to_account_info(), cpi_accounts);
            system_program::transfer(cpi_ctx, PER_VAULT_TOPUP_LAMPORTS)?;
        }
        Ok(())
    }

    /// Create or update public terms on L1 (no PER). Does not commit to escrow yet.
    pub fn set_public_terms(
        ctx: Context<SetPublicTerms>,
        escrow_id: u64,
        terms_hash: [u8; 32],
        total_payment: u64,
        deadline: i64,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(user_key == escrow.client, NebulonError::Unauthorized);
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::InvalidState);
        require!(!escrow.paid_out, NebulonError::InvalidState);

        let now = Clock::get()?.unix_timestamp;
        if deadline > 0 {
            require!(deadline > now, NebulonError::InvalidDeadline);
        } else {
            require!(deadline < 0, NebulonError::InvalidDeadline);
        }
        require!(total_payment > 0, NebulonError::InvalidFundingAmount);

        let terms_info = ctx.accounts.terms.to_account_info();
        let space = 8 + Terms::SIZE;
        require!(terms_info.data_len() == space, NebulonError::InvalidState);
        require!(terms_info.owner == ctx.program_id, NebulonError::InvalidState);

        let terms = &mut ctx.accounts.terms;
        require!(
            !terms.signed_client && !terms.signed_contractor,
            NebulonError::TermsLocked
        );
        terms.escrow = escrow.key();
        terms.terms_hash = terms_hash;
        terms.total_payment = total_payment;
        terms.deadline = deadline;
        terms.encrypted_terms_len = 0;
        terms.encrypted_terms = [0u8; MAX_TERMS_CIPHERTEXT];
        terms.signed_client = false;
        terms.signed_contractor = false;
        terms.signed_at = 0;
        Ok(())
    }

    /// Sign public terms (L1 only).
    pub fn sign_public_terms(ctx: Context<SignPublicTerms>, escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let terms = &mut ctx.accounts.terms;
        if terms.escrow == Pubkey::default() {
            require!(terms.total_payment > 0, NebulonError::InvalidState);
            terms.escrow = escrow.key();
        }
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        if ctx.accounts.user.key() == escrow.client {
            terms.signed_client = true;
        }
        if ctx.accounts.user.key() == escrow.contractor {
            terms.signed_contractor = true;
        }
        terms.signed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Commit signed public terms into the escrow (L1 only).
    pub fn commit_public_terms(ctx: Context<CommitPublicTerms>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(terms.signed_client, NebulonError::InvalidState);
        require!(terms.signed_contractor, NebulonError::InvalidState);
        escrow.terms_hash = terms.terms_hash;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Create private terms (PER-only). Intended to run on PER and not be committed to L1.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn create_private_terms(
        ctx: Context<CreatePrivateTerms>,
        escrow_id: u64,
        terms_hash: [u8; 32],
        total_payment: u64,
        deadline: i64,
        encrypted_terms: Vec<u8>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(user_key == escrow.client, NebulonError::Unauthorized);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        let (expected_terms, _terms_bump) = Pubkey::find_program_address(
            &[TERMS_SEED, escrow.key().as_ref()],
            ctx.program_id,
        );
        require!(
            expected_terms == ctx.accounts.terms.key(),
            NebulonError::InvalidState
        );

        let space = 8 + Terms::SIZE;
        let terms_info = ctx.accounts.terms.to_account_info();
        require!(
            terms_info.data_len() == space,
            NebulonError::InvalidState
        );
        require!(terms_info.owner == ctx.program_id, NebulonError::InvalidState);

        if let Ok(existing) = Terms::try_deserialize(&mut &terms_info.try_borrow_data()?[..]) {
            require!(
                !existing.signed_client && !existing.signed_contractor,
                NebulonError::TermsLocked
            );
        }

        let now = Clock::get()?.unix_timestamp;
        if deadline > 0 {
            require!(deadline > now, NebulonError::InvalidDeadline);
        } else {
            require!(deadline < 0, NebulonError::InvalidDeadline);
        }
        require!(total_payment > 0, NebulonError::InvalidFundingAmount);
        require!(
            encrypted_terms.len() <= MAX_TERMS_CIPHERTEXT,
            NebulonError::InvalidState
        );
        let mut encrypted_terms_buf = [0u8; MAX_TERMS_CIPHERTEXT];
        let encrypted_len = encrypted_terms.len() as u16;
        encrypted_terms_buf[..encrypted_terms.len()].copy_from_slice(&encrypted_terms);
        let terms = Terms {
            escrow: escrow.key(),
            terms_hash,
            total_payment,
            deadline,
            encrypted_terms_len: encrypted_len,
            encrypted_terms: encrypted_terms_buf,
            signed_client: false,
            signed_contractor: false,
            signed_at: 0,
        };
        let mut data = terms_info.try_borrow_mut_data()?;
        let mut cursor = Cursor::new(data.as_mut());
        terms.try_serialize(&mut cursor)?;
        Ok(())
    }

    /// Sign private terms (PER-only). Requires client or contractor via session auth.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn sign_private_terms(ctx: Context<SignPrivateTerms>, escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        let terms = &mut ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        if ctx.accounts.user.key() == escrow.client {
            terms.signed_client = true;
        }
        if ctx.accounts.user.key() == escrow.contractor {
            terms.signed_contractor = true;
        }
        terms.signed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Commit signed terms into the escrow (PER-auth).
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn commit_terms(ctx: Context<CommitTerms>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(terms.signed_client, NebulonError::InvalidState);
        require!(terms.signed_contractor, NebulonError::InvalidState);
        escrow.terms_hash = terms.terms_hash;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Commit milestone hash into the escrow (PER-auth).
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn commit_milestones(
        ctx: Context<CommitMilestones>,
        escrow_id: u64,
        milestones_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        escrow.milestones_hash = milestones_hash;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set funding_ok flag after verifying funded amount matches private terms.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn set_funding_ok(ctx: Context<SetFundingOk>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);
        require!(terms.signed_client, NebulonError::InvalidState);
        require!(terms.signed_contractor, NebulonError::InvalidState);

        let required_net = net_from_amount(terms.total_payment)?;
        require!(
            escrow.funded_amount == required_net,
            NebulonError::InvalidFundingAmount
        );

        escrow.funding_ok = true;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set ready_to_claim when all private milestones are approved.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn set_ready_to_claim(
        ctx: Context<SetReadyToClaim>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let milestones = collect_private_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let all_approved = milestone_count == 0
            || milestones.iter().all(|milestone| {
                milestone.status == MilestoneStatus::Paid as u8
                    || milestone.status == MilestoneStatus::Deleted as u8
            });
        require!(all_approved, NebulonError::InvalidState);

        escrow.ready_to_claim = true;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set timeout_refund_ready when deadline has passed and work is incomplete.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn set_timeout_refund_ready(
        ctx: Context<SetTimeoutRefundReady>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);

        let deadline = resolve_terms_deadline(terms.deadline, escrow.funded_at)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > deadline.saturating_add(DEFAULT_DEADLINE_GRACE_SECONDS),
            NebulonError::DeadlineNotReached
        );

        let milestones = collect_private_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let has_unsubmitted = milestone_count == 0
            || milestones.iter().any(|milestone| {
                if milestone.status == MilestoneStatus::Deleted as u8 {
                    return false;
                }
                milestone.status == MilestoneStatus::Created as u8
                    || milestone.status == MilestoneStatus::Rejected as u8
            });
        require!(has_unsubmitted, NebulonError::InvalidState);

        escrow.timeout_refund_ready = true;
        escrow.timeout_funds_ready = false;
        escrow.ready_to_claim = false;
        Ok(())
    }

    /// Set timeout_funds_ready when deadline has passed and all work was submitted.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn set_timeout_funds_ready(
        ctx: Context<SetTimeoutFundsReady>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);

        let deadline = resolve_terms_deadline(terms.deadline, escrow.funded_at)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > deadline.saturating_add(DEFAULT_DEADLINE_GRACE_SECONDS),
            NebulonError::DeadlineNotReached
        );

        let milestones = collect_private_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let all_submitted = milestone_count == 0
            || milestones.iter().all(|milestone| {
                if milestone.status == MilestoneStatus::Deleted as u8 {
                    return true;
                }
                milestone.status == MilestoneStatus::Submitted as u8
                    || milestone.status == MilestoneStatus::Paid as u8
            });
        require!(all_submitted, NebulonError::InvalidState);

        escrow.timeout_funds_ready = true;
        escrow.timeout_refund_ready = false;
        escrow.ready_to_claim = false;
        Ok(())
    }

    /// Commit public milestone hash into the escrow (L1 only).
    pub fn commit_public_milestones(
        ctx: Context<CommitPublicMilestones>,
        escrow_id: u64,
        milestones_hash: [u8; 32],
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        escrow.milestones_hash = milestones_hash;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set funding_ok flag after verifying funded amount matches public terms (L1 only).
    pub fn set_funding_ok_public(ctx: Context<SetFundingOkPublic>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);
        require!(terms.signed_client, NebulonError::InvalidState);
        require!(terms.signed_contractor, NebulonError::InvalidState);

        let required_net = net_from_amount(terms.total_payment)?;
        require!(
            escrow.funded_amount >= required_net,
            NebulonError::InvalidFundingAmount
        );

        escrow.funding_ok = true;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set ready_to_claim when all public milestones are approved (L1 only).
    pub fn set_ready_to_claim_public(
        ctx: Context<SetReadyToClaimPublic>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let milestones = collect_public_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let all_approved = milestone_count == 0
            || milestones.iter().all(|milestone| {
                milestone.status == MilestoneStatus::Paid as u8
                    || milestone.status == MilestoneStatus::Deleted as u8
            });
        require!(all_approved, NebulonError::InvalidState);

        escrow.ready_to_claim = true;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        Ok(())
    }

    /// Set timeout_refund_ready when deadline has passed and work is incomplete (L1 only).
    pub fn set_timeout_refund_ready_public(
        ctx: Context<SetTimeoutRefundReadyPublic>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);

        let deadline = resolve_terms_deadline(terms.deadline, escrow.funded_at)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > deadline.saturating_add(DEFAULT_DEADLINE_GRACE_SECONDS),
            NebulonError::DeadlineNotReached
        );

        let milestones = collect_public_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let has_unsubmitted = milestone_count == 0
            || milestones.iter().any(|milestone| {
                if milestone.status == MilestoneStatus::Deleted as u8 {
                    return false;
                }
                milestone.status == MilestoneStatus::Created as u8
                    || milestone.status == MilestoneStatus::Rejected as u8
            });
        require!(has_unsubmitted, NebulonError::InvalidState);

        escrow.timeout_refund_ready = true;
        escrow.timeout_funds_ready = false;
        escrow.ready_to_claim = false;
        Ok(())
    }

    /// Set timeout_funds_ready when deadline has passed and all work was submitted (L1 only).
    pub fn set_timeout_funds_ready_public(
        ctx: Context<SetTimeoutFundsReadyPublic>,
        escrow_id: u64,
        milestone_count: u8,
    ) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let terms = &ctx.accounts.terms;
        require!(terms.escrow == escrow.key(), NebulonError::InvalidState);
        require!(escrow.terms_hash == terms.terms_hash, NebulonError::InvalidState);

        let deadline = resolve_terms_deadline(terms.deadline, escrow.funded_at)?;
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > deadline.saturating_add(DEFAULT_DEADLINE_GRACE_SECONDS),
            NebulonError::DeadlineNotReached
        );

        let milestones = collect_public_milestones(
            ctx.program_id,
            &escrow.key(),
            milestone_count,
            ctx.remaining_accounts,
        )?;
        let all_submitted = milestone_count == 0
            || milestones.iter().all(|milestone| {
                if milestone.status == MilestoneStatus::Deleted as u8 {
                    return true;
                }
                milestone.status == MilestoneStatus::Submitted as u8
                    || milestone.status == MilestoneStatus::Paid as u8
            });
        require!(all_submitted, NebulonError::InvalidState);

        escrow.timeout_funds_ready = true;
        escrow.timeout_refund_ready = false;
        escrow.ready_to_claim = false;
        Ok(())
    }

    /// Create a private milestone (PER-only). Stores sensitive milestone details off L1.
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn create_private_milestone(
        ctx: Context<CreatePrivateMilestone>,
        escrow_id: u64,
        index: u8,
        description_hash: [u8; 32],
        encrypted_details: Vec<u8>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        let index_seed = [index];
        let (expected_milestone, _milestone_bump) = Pubkey::find_program_address(
            &[
                PRIVATE_MILESTONE_SEED,
                escrow.key().as_ref(),
                &index_seed,
            ],
            ctx.program_id,
        );
        require!(
            expected_milestone == ctx.accounts.private_milestone.key(),
            NebulonError::InvalidState
        );

        let space = 8 + PrivateMilestone::SIZE;
        let milestone_info = ctx.accounts.private_milestone.to_account_info();
        require!(
            milestone_info.data_len() == space,
            NebulonError::InvalidState
        );
        require!(
            milestone_info.owner == ctx.program_id,
            NebulonError::InvalidState
        );

        require!(
            encrypted_details.len() <= MAX_MILESTONE_CIPHERTEXT,
            NebulonError::InvalidState
        );
        let mut encrypted_details_buf = [0u8; MAX_MILESTONE_CIPHERTEXT];
        let encrypted_len = encrypted_details.len() as u16;
        encrypted_details_buf[..encrypted_details.len()].copy_from_slice(&encrypted_details);
        let milestone = PrivateMilestone {
            escrow: escrow.key(),
            index,
            status: MilestoneStatus::Created as u8,
            description_hash,
            encrypted_details_len: encrypted_len,
            encrypted_details: encrypted_details_buf,
            updated_at: Clock::get()?.unix_timestamp,
        };
        let mut data = milestone_info.try_borrow_mut_data()?;
        let mut cursor = Cursor::new(data.as_mut());
        milestone.try_serialize(&mut cursor)?;
        Ok(())
    }

    /// Initialize a private terms account on L1 with empty data so it can be delegated to PER.
    pub fn init_private_terms_stub(
        ctx: Context<InitPrivateTermsStub>,
        escrow_id: u64,
    ) -> Result<()> {
        let escrow = load_delegated_escrow(&ctx.accounts.escrow, ctx.program_id, escrow_id)?;
        let terms_info = ctx.accounts.terms.to_account_info();
        if terms_info.data_is_empty() {
            let space = 8 + Terms::SIZE;
            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(space);
            let create_ix = anchor_lang::solana_program::system_instruction::create_account(
                ctx.accounts.payer.key,
                ctx.accounts.terms.key,
                lamports,
                space as u64,
                ctx.program_id,
            );
            let escrow_key = ctx.accounts.escrow.key();
            let terms_seeds = &[TERMS_SEED, escrow_key.as_ref(), &[ctx.bumps.terms]];
            anchor_lang::solana_program::program::invoke_signed(
                &create_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    terms_info,
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[terms_seeds],
            )?;
        }
        Ok(())
    }

    /// Initialize a private milestone account on L1 with empty data so it can be delegated to PER.
    pub fn init_private_milestone_stub(
        ctx: Context<InitPrivateMilestoneStub>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = load_delegated_escrow(&ctx.accounts.escrow, ctx.program_id, escrow_id)?;
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let milestone_info = ctx.accounts.private_milestone.to_account_info();
        if milestone_info.data_is_empty() {
            let space = 8 + PrivateMilestone::SIZE;
            let rent = Rent::get()?;
            let lamports = rent.minimum_balance(space);
            let create_ix = anchor_lang::solana_program::system_instruction::create_account(
                ctx.accounts.payer.key,
                ctx.accounts.private_milestone.key,
                lamports,
                space as u64,
                ctx.program_id,
            );
            let escrow_key = ctx.accounts.escrow.key();
            let index_seed = [index];
            let milestone_seeds = &[
                PRIVATE_MILESTONE_SEED,
                escrow_key.as_ref(),
                &index_seed,
                &[ctx.bumps.private_milestone],
            ];
            anchor_lang::solana_program::program::invoke_signed(
                &create_ix,
                &[
                    ctx.accounts.payer.to_account_info(),
                    milestone_info,
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[milestone_seeds],
            )?;
        }
        Ok(())
    }

    /// Update private milestone status (PER-only).
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn update_private_milestone_status(
        ctx: Context<UpdatePrivateMilestone>,
        escrow_id: u64,
        index: u8,
        status: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        let milestone = &mut ctx.accounts.private_milestone;
        require!(milestone.escrow == escrow.key(), NebulonError::InvalidState);
        require!(milestone.index == index, NebulonError::InvalidState);
        milestone.status = status;
        milestone.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Update private milestone details (PER-only).
    #[session_auth_or(false, NebulonError::Unauthorized)]
    pub fn update_private_milestone_details(
        ctx: Context<UpdatePrivateMilestoneDetails>,
        escrow_id: u64,
        index: u8,
        description_hash: [u8; 32],
        encrypted_details: Vec<u8>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let user_key = ctx.accounts.user.key();
        require!(
            user_key == escrow.client || user_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        let milestone = &mut ctx.accounts.private_milestone;
        require!(milestone.escrow == escrow.key(), NebulonError::InvalidState);
        require!(milestone.index == index, NebulonError::InvalidState);
        milestone.description_hash = description_hash;
        require!(
            encrypted_details.len() <= MAX_MILESTONE_CIPHERTEXT,
            NebulonError::InvalidState
        );
        milestone.encrypted_details_len = encrypted_details.len() as u16;
        milestone.encrypted_details = [0u8; MAX_MILESTONE_CIPHERTEXT];
        milestone.encrypted_details[..encrypted_details.len()].copy_from_slice(&encrypted_details);
        milestone.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn add_milestone(
        ctx: Context<AddMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let actor_key = ctx.accounts.actor.key();
        require!(
            actor_key == escrow.client || actor_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::InvalidState);
        require!(!escrow.paid_out, NebulonError::InvalidState);

        let milestone = &mut ctx.accounts.milestone;
        milestone.escrow = escrow.key();
        milestone.index = index;
        milestone.status = MilestoneStatus::Created as u8;
        milestone.submitted_at = 0;
        milestone.creator = actor_key;
        Ok(())
    }

    pub fn remove_milestone(
        ctx: Context<RemoveMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let actor_key = ctx.accounts.actor.key();
        require!(
            actor_key == escrow.client || actor_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::InvalidState);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        let milestone = &ctx.accounts.milestone;
        require!(milestone.index == index, NebulonError::InvalidState);
        Ok(())
    }

    pub fn disable_milestone(
        ctx: Context<DisableMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let actor_key = ctx.accounts.actor.key();
        require!(
            actor_key == escrow.client || actor_key == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funded_amount == 0, NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let milestone = &mut ctx.accounts.milestone;
        require!(milestone.index == index, NebulonError::InvalidState);
        milestone.status = MilestoneStatus::Deleted as u8;
        milestone.submitted_at = 0;
        Ok(())
    }

    pub fn fund_escrow(ctx: Context<FundEscrow>, escrow_id: u64, amount: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(
            ctx.accounts.client.key() == escrow.client,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.terms_hash != [0u8; 32], NebulonError::InvalidState);
        require!(!escrow.funding_ok, NebulonError::InvalidState);
        let fee_amount = fee_from_amount(amount)?;
        let net_amount = net_from_amount(amount)?;
        require!(net_amount > 0, NebulonError::InvalidFundingAmount);
        let next_funded = escrow
            .funded_amount
            .checked_add(net_amount)
            .ok_or(NebulonError::Overflow)?;

        if fee_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    TokenTransfer {
                        from: ctx.accounts.client_token.to_account_info(),
                        to: ctx.accounts.fee_receiver_token.to_account_info(),
                        authority: ctx.accounts.client.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.client_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.client.to_account_info(),
                },
            ),
            net_amount,
        )?;

        if escrow.funded_amount == 0 && net_amount > 0 {
            escrow.funded_at = Clock::get()?.unix_timestamp;
        }
        escrow.funded_amount = next_funded;
        Ok(())
    }

    pub fn submit_milestone(
        ctx: Context<SubmitMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            ctx.accounts.contractor.key() == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let milestone = &mut ctx.accounts.milestone;
        require!(milestone.index == index, NebulonError::InvalidState);
        require!(
            milestone.status == MilestoneStatus::Created as u8
                || milestone.status == MilestoneStatus::Rejected as u8,
            NebulonError::InvalidState
        );
        milestone.status = MilestoneStatus::Submitted as u8;
        milestone.submitted_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn approve_milestone(
        ctx: Context<ApproveMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            ctx.accounts.client.key() == escrow.client,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let milestone = &mut ctx.accounts.milestone;
        require!(milestone.index == index, NebulonError::InvalidState);
        require!(
            milestone.status == MilestoneStatus::Submitted as u8,
            NebulonError::InvalidState
        );
        milestone.status = MilestoneStatus::Paid as u8;
        Ok(())
    }

    pub fn claim_funds(ctx: Context<ClaimFunds>, escrow_id: u64) -> Result<()> {
        let (_client_key, _escrow_id, _bump, payout_amount) = {
            let escrow = &ctx.accounts.escrow;
            require!(
                ctx.accounts.contractor.key() == escrow.contractor,
                NebulonError::Unauthorized
            );
            require!(
                ctx.accounts.creator.key() == escrow.creator,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(!escrow.dispute_open, NebulonError::DisputeOpen);
            require!(!escrow.paid_out, NebulonError::InvalidState);
            require!(
                escrow.funding_ok,
                NebulonError::InvalidState
            );
            require!(
                escrow.ready_to_claim,
                NebulonError::InvalidState
            );
            require!(
                escrow.funded_amount > 0,
                NebulonError::InsufficientFunds
            );
            (
                escrow.client,
                escrow.escrow_id,
                escrow.bump,
                escrow.funded_amount,
            )
        };

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.contractor_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[signer_seeds],
            ),
            payout_amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = 0;
        escrow.funded_at = 0;
        escrow.released_amount = escrow
            .released_amount
            .checked_add(payout_amount)
            .ok_or(NebulonError::Overflow)?;
        escrow.paid_out = true;
        escrow.ready_to_claim = false;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        escrow.funding_ok = false;
        Ok(())
    }

    pub fn reject_milestone(
        ctx: Context<RejectMilestone>,
        escrow_id: u64,
        index: u8,
    ) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(
            ctx.accounts.client.key() == escrow.client,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);

        let milestone = &mut ctx.accounts.milestone;
        require!(milestone.index == index, NebulonError::InvalidState);
        require!(
            milestone.status == MilestoneStatus::Submitted as u8,
            NebulonError::InvalidState
        );
        milestone.status = MilestoneStatus::Rejected as u8;
        Ok(())
    }

    pub fn open_dispute(ctx: Context<OpenDispute>, escrow_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow;
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(!escrow.paid_out, NebulonError::InvalidState);
        require!(
            ctx.accounts.actor.key() == escrow.client
                || ctx.accounts.actor.key() == escrow.contractor,
            NebulonError::Unauthorized
        );
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(escrow.funding_ok, NebulonError::InvalidState);
        require!(
            !escrow.ready_to_claim
                && !escrow.timeout_funds_ready
                && !escrow.timeout_refund_ready,
            NebulonError::InvalidState
        );
        let dispute = &mut ctx.accounts.dispute;
        dispute.escrow = escrow.key();
        dispute.opened_by = ctx.accounts.actor.key();
        dispute.opened_at = Clock::get()?.unix_timestamp;
        dispute.amount = 0;
        dispute.client_amount = 0;
        dispute.contractor_amount = 0;
        dispute.resolved = false;
        escrow.dispute_open = true;
        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        escrow_id: u64,
        amount: u64,
        release_to_contractor: bool,
    ) -> Result<()> {
        let (_client_key, _escrow_id, _bump) = {
            let escrow = &ctx.accounts.escrow;
            require!(escrow.dispute_open, NebulonError::NoDispute);
            require!(
                ctx.accounts.judge.key() == escrow.judge,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(
                escrow.funded_amount >= amount,
                NebulonError::InsufficientFunds
            );
            (escrow.client, escrow.escrow_id, escrow.bump)
        };

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        let destination = if release_to_contractor {
            ctx.accounts.contractor_token.to_account_info()
        } else {
            ctx.accounts.client_token.to_account_info()
        };

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: destination,
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[signer_seeds],
            ),
            amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = escrow
            .funded_amount
            .checked_sub(amount)
            .ok_or(NebulonError::Overflow)?;
        if escrow.funded_amount == 0 {
            escrow.funded_at = 0;
        }
        escrow.dispute_open = false;

        let dispute = &mut ctx.accounts.dispute;
        require!(dispute.escrow == escrow.key(), NebulonError::InvalidState);
        dispute.amount = amount;
        if release_to_contractor {
            dispute.client_amount = 0;
            dispute.contractor_amount = amount;
        } else {
            dispute.client_amount = amount;
            dispute.contractor_amount = 0;
        }
        dispute.release_to_contractor = release_to_contractor;
        dispute.resolved = true;
        dispute.resolved_at = Clock::get()?.unix_timestamp;
        dispute.resolved_by = ctx.accounts.judge.key();
        Ok(())
    }

    pub fn resolve_dispute_split(
        ctx: Context<ResolveDispute>,
        escrow_id: u64,
        client_percent: u16,
        contractor_percent: u16,
    ) -> Result<()> {
        require!(
            client_percent as u64 + contractor_percent as u64 == 100,
            NebulonError::InvalidSplit
        );
        let (_client_key, _escrow_id, _bump, total_amount) = {
            let escrow = &ctx.accounts.escrow;
            require!(escrow.dispute_open, NebulonError::NoDispute);
            require!(
                ctx.accounts.judge.key() == escrow.judge,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(escrow.funded_amount > 0, NebulonError::InsufficientFunds);
            (
                escrow.client,
                escrow.escrow_id,
                escrow.bump,
                escrow.funded_amount,
            )
        };

        let client_amount = total_amount
            .checked_mul(client_percent as u64)
            .ok_or(NebulonError::Overflow)?
            .checked_div(100)
            .ok_or(NebulonError::Overflow)?;
        let contractor_amount = total_amount
            .checked_sub(client_amount)
            .ok_or(NebulonError::Overflow)?;

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        if client_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TokenTransfer {
                        from: ctx.accounts.vault_token.to_account_info(),
                        to: ctx.accounts.client_token.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                client_amount,
            )?;
        }

        if contractor_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TokenTransfer {
                        from: ctx.accounts.vault_token.to_account_info(),
                        to: ctx.accounts.contractor_token.to_account_info(),
                        authority: ctx.accounts.escrow.to_account_info(),
                    },
                    &[signer_seeds],
                ),
                contractor_amount,
            )?;
        }

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = escrow
            .funded_amount
            .checked_sub(total_amount)
            .ok_or(NebulonError::Overflow)?;
        if escrow.funded_amount == 0 {
            escrow.funded_at = 0;
        }
        escrow.dispute_open = false;

        let dispute = &mut ctx.accounts.dispute;
        require!(dispute.escrow == escrow.key(), NebulonError::InvalidState);
        dispute.amount = total_amount;
        dispute.client_amount = client_amount;
        dispute.contractor_amount = contractor_amount;
        dispute.release_to_contractor = false;
        dispute.resolved = true;
        dispute.resolved_at = Clock::get()?.unix_timestamp;
        dispute.resolved_by = ctx.accounts.judge.key();
        Ok(())
    }

    /// Mutual cancel: both parties sign to refund remaining funds to client.
    pub fn mutual_cancel_escrow(
        ctx: Context<MutualCancelEscrow>,
        escrow_id: u64,
    ) -> Result<()> {
        let (_client_key, _escrow_id, _bump, refund_amount) = {
            let escrow = &ctx.accounts.escrow;
            require!(
                ctx.accounts.client.key() == escrow.client,
                NebulonError::Unauthorized
            );
            require!(
                ctx.accounts.contractor.key() == escrow.contractor,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(!escrow.dispute_open, NebulonError::DisputeOpen);
            require!(!escrow.paid_out, NebulonError::InvalidState);
            require!(escrow.funded_amount > 0, NebulonError::InsufficientFunds);
            (
                escrow.client,
                escrow.escrow_id,
                escrow.bump,
                escrow.funded_amount,
            )
        };

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.client_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[signer_seeds],
            ),
            refund_amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = 0;
        escrow.funded_at = 0;
        Ok(())
    }

    /// Client refund when timeout flag is set (no dispute).
    pub fn claim_timeout_refund(
        ctx: Context<ClaimTimeoutRefund>,
        escrow_id: u64,
    ) -> Result<()> {
        let (_client_key, _escrow_id, _bump, refund_amount) = {
            let escrow = &ctx.accounts.escrow;
            require!(
                ctx.accounts.client.key() == escrow.client,
                NebulonError::Unauthorized
            );
            require!(
                ctx.accounts.creator.key() == escrow.creator,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(!escrow.dispute_open, NebulonError::DisputeOpen);
            require!(escrow.funding_ok, NebulonError::InvalidState);
            require!(escrow.timeout_refund_ready, NebulonError::InvalidState);
            require!(escrow.funded_amount > 0, NebulonError::InsufficientFunds);
            (
                escrow.client,
                escrow.escrow_id,
                escrow.bump,
                escrow.funded_amount,
            )
        };

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.client_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[signer_seeds],
            ),
            refund_amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = 0;
        escrow.funded_at = 0;
        escrow.timeout_refund_ready = false;
        escrow.timeout_funds_ready = false;
        escrow.ready_to_claim = false;
        escrow.funding_ok = false;
        escrow.paid_out = true;
        Ok(())
    }

    pub fn close_escrow(ctx: Context<CloseEscrow>, escrow_id: u64) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
        require!(!escrow.dispute_open, NebulonError::DisputeOpen);
        require!(escrow.paid_out, NebulonError::InvalidState);
        require!(escrow.creator == ctx.accounts.creator.key(), NebulonError::Unauthorized);
        Ok(())
    }

    /// Contractor claim when timeout flag is set.
    pub fn claim_timeout_funds(
        ctx: Context<ClaimTimeoutFunds>,
        escrow_id: u64,
    ) -> Result<()> {
        let (_client_key, _escrow_id, _bump, payout_amount) = {
            let escrow = &ctx.accounts.escrow;
            require!(
                ctx.accounts.contractor.key() == escrow.contractor,
                NebulonError::Unauthorized
            );
            require!(
                ctx.accounts.creator.key() == escrow.creator,
                NebulonError::Unauthorized
            );
            require!(escrow.escrow_id == escrow_id, NebulonError::InvalidState);
            require!(!escrow.dispute_open, NebulonError::DisputeOpen);
            require!(!escrow.paid_out, NebulonError::InvalidState);
            require!(escrow.funding_ok, NebulonError::InvalidState);
            require!(escrow.timeout_funds_ready, NebulonError::InvalidState);
            require!(escrow.funded_amount > 0, NebulonError::InsufficientFunds);
            (
                escrow.client,
                escrow.escrow_id,
                escrow.bump,
                escrow.funded_amount,
            )
        };

        let signer_seeds: &[&[u8]] = &[
            ESCROW_SEED,
            ctx.accounts.escrow.client.as_ref(),
            &escrow_id.to_le_bytes(),
            &[ctx.accounts.escrow.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.contractor_token.to_account_info(),
                    authority: ctx.accounts.escrow.to_account_info(),
                },
                &[signer_seeds],
            ),
            payout_amount,
        )?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.funded_amount = 0;
        escrow.funded_at = 0;
        escrow.released_amount = escrow
            .released_amount
            .checked_add(payout_amount)
            .ok_or(NebulonError::Overflow)?;
        escrow.paid_out = true;
        escrow.timeout_funds_ready = false;
        escrow.timeout_refund_ready = false;
        escrow.ready_to_claim = false;
        escrow.funding_ok = false;
        Ok(())
    }

    /// Delegate escrow account to an ER validator for PER execution.
    pub fn delegate_escrow(
        ctx: Context<DelegateEscrow>,
        escrow_id: u64,
    ) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[
                ESCROW_SEED,
                ctx.accounts.client.key.as_ref(),
                &escrow_id.to_le_bytes(),
            ],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Delegate any account type to an ER validator for PER execution.
    pub fn delegate_account(
        ctx: Context<DelegateAccount>,
        account_type: AccountType,
    ) -> Result<()> {
        let seed_data = derive_seeds_from_account_type(&account_type);
        let seed_refs: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &seed_refs,
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Manual commit of escrow account in ER.
    pub fn commit_escrow(ctx: Context<CommitEscrow>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.escrow.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Commit and undelegate escrow account back to Solana L1.
    pub fn undelegate_escrow(ctx: Context<CommitEscrow>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.escrow.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Manual commit any delegated PDA in ER.
    pub fn commit_account(ctx: Context<CommitAccount>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.pda.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Commit and undelegate any delegated PDA back to Solana L1.
    pub fn undelegate_pda(ctx: Context<CommitAccount>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.pda.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    /// Create a permission for a given account type and member list.
    pub fn create_permission(
        ctx: Context<CreatePermission>,
        account_type: AccountType,
        members: Option<Vec<Member>>,
    ) -> Result<()> {
        let CreatePermission {
            permissioned_account,
            permission,
            payer,
            permission_program,
            system_program,
        } = ctx.accounts;

        let seed_data = derive_seeds_from_account_type(&account_type);
        let (_, bump) = Pubkey::find_program_address(
            &seed_data.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
            &crate::ID,
        );

        let mut seeds = seed_data.clone();
        seeds.push(vec![bump]);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();

        CreatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&permissioned_account.to_account_info())
            .permission(&permission)
            .payer(&payer)
            .system_program(&system_program)
            .args(MembersArgs { members })
            .invoke_signed(&[seed_refs.as_slice()])?;
        Ok(())
    }


    /// Update an existing permission (e.g., add/remove members).
    pub fn update_permission(
        ctx: Context<UpdatePermission>,
        account_type: AccountType,
        members: Option<Vec<Member>>,
    ) -> Result<()> {
        let UpdatePermission {
            permissioned_account,
            permission,
            authority,
            permission_program,
        } = ctx.accounts;

        let seed_data = derive_seeds_from_account_type(&account_type);
        let (_, bump) = Pubkey::find_program_address(
            &seed_data.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
            &crate::ID,
        );
        let mut seeds = seed_data.clone();
        seeds.push(vec![bump]);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();

        UpdatePermissionCpiBuilder::new(&permission_program)
            .permissioned_account(&permissioned_account.to_account_info(), true)
            .authority(&authority, false)
            .permission(&permission)
            .args(MembersArgs { members })
            .invoke_signed(&[seed_refs.as_slice()])?;
        Ok(())
    }

    /// Commit and undelegate a permissioned account back to Solana L1.
    pub fn commit_and_undelegate_permission(
        ctx: Context<CommitAndUndelegatePermission>,
        account_type: AccountType,
    ) -> Result<()> {
        let CommitAndUndelegatePermission {
            permissioned_account,
            permission,
            authority,
            permission_program,
            magic_program,
            magic_context,
        } = ctx.accounts;

        let seed_data = derive_seeds_from_account_type(&account_type);
        let (_, bump) = Pubkey::find_program_address(
            &seed_data.iter().map(|s| s.as_slice()).collect::<Vec<_>>(),
            &crate::ID,
        );
        let mut seeds = seed_data.clone();
        seeds.push(vec![bump]);
        let seed_refs: Vec<&[u8]> = seeds.iter().map(|s| s.as_slice()).collect();

        CommitAndUndelegatePermissionCpiBuilder::new(&permission_program)
            .authority(&authority, false)
            .permissioned_account(&permissioned_account.to_account_info(), true)
            .permission(&permission)
            .magic_program(&magic_program)
            .magic_context(&magic_context)
            .invoke_signed(&[seed_refs.as_slice()])?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeProfile<'info> {
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Profile::SIZE,
        seeds = [PROFILE_SEED, owner.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, Profile>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: client is used for escrow seed + stored in escrow
    pub client: AccountInfo<'info>,
    /// CHECK: contractor can be any pubkey
    pub contractor: AccountInfo<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Escrow::SIZE,
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: PER vault PDA used to pay PER rent
    #[account(
        mut,
        seeds = [PER_VAULT_SEED, escrow.key().as_ref()],
        bump
    )]
    pub per_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = escrow
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SetPublicTerms<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Terms::SIZE,
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SignPublicTerms<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CommitPublicTerms<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CommitPublicMilestones<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SetFundingOkPublic<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SetReadyToClaimPublic<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SetTimeoutRefundReadyPublic<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct SetTimeoutFundsReadyPublic<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct CreatePrivateTerms<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: PDA allocated in PER using per_vault; not initialized on L1.
    #[account(
        mut,
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: UncheckedAccount<'info>,
    /// CHECK: PER vault PDA used to pay PER rent
    #[account(
        mut,
        seeds = [PER_VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.per_vault_bump
    )]
    pub per_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct SignPrivateTerms<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct CommitTerms<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct CommitMilestones<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct SetFundingOk<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct SetReadyToClaim<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct SetTimeoutRefundReady<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64)]
pub struct SetTimeoutFundsReady<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: Account<'info, Terms>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64, index: u8)]
pub struct CreatePrivateMilestone<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: PDA allocated in PER using per_vault; not initialized on L1.
    #[account(
        mut,
        seeds = [PRIVATE_MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub private_milestone: UncheckedAccount<'info>,
    /// CHECK: PER vault PDA used to pay PER rent
    #[account(
        mut,
        seeds = [PER_VAULT_SEED, escrow.key().as_ref()],
        bump = escrow.per_vault_bump
    )]
    pub per_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64, index: u8)]
pub struct UpdatePrivateMilestone<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [PRIVATE_MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub private_milestone: Account<'info, PrivateMilestone>,
}

#[derive(Accounts, Session)]
#[instruction(escrow_id: u64, index: u8)]
pub struct UpdatePrivateMilestoneDetails<'info> {
    /// CHECK: matched via session auth
    pub user: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[session(
        signer = payer,
        authority = user.key()
    )]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [PRIVATE_MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub private_milestone: Account<'info, PrivateMilestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct InitPrivateTermsStub<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: escrow ownership can be delegated; validated in handler.
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: Stub PDA is created manually to avoid writing discriminator on L1.
    #[account(
        mut,
        seeds = [TERMS_SEED, escrow.key().as_ref()],
        bump
    )]
    pub terms: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct InitPrivateMilestoneStub<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: escrow ownership can be delegated; validated in handler.
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: Stub PDA is created manually to avoid writing discriminator on L1.
    #[account(
        mut,
        seeds = [PRIVATE_MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub private_milestone: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct AddMilestone<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = actor,
        space = 8 + Milestone::SIZE,
        seeds = [
            MILESTONE_SEED,
            escrow.key().as_ref(),
            &[index]
        ],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct RemoveMilestone<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        close = actor,
        seeds = [MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct DisableMilestone<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        constraint = client_token.owner == client.key(),
        constraint = client_token.mint == escrow.mint
    )]
    pub client_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = fee_receiver_token.owner == FEE_RECEIVER,
        constraint = fee_receiver_token.mint == escrow.mint
    )]
    pub fee_receiver_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct SubmitMilestone<'info> {
    #[account(mut)]
    pub contractor: Signer<'info>,
    #[account(
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct ApproveMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ClaimFunds<'info> {
    #[account(mut)]
    pub contractor: Signer<'info>,
    /// CHECK: rent recipient
    #[account(mut)]
    pub creator: SystemAccount<'info>,
    #[account(
        mut,
        close = creator,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        constraint = contractor_token.owner == escrow.contractor,
        constraint = contractor_token.mint == escrow.mint
    )]
    pub contractor_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64, index: u8)]
pub struct RejectMilestone<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [MILESTONE_SEED, escrow.key().as_ref(), &[index]],
        bump
    )]
    pub milestone: Account<'info, Milestone>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct OpenDispute<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = actor,
        space = 8 + Dispute::SIZE,
        seeds = [DISPUTE_SEED, escrow.key().as_ref()],
        bump
    )]
    pub dispute: Account<'info, Dispute>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub judge: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        seeds = [DISPUTE_SEED, escrow.key().as_ref()],
        bump
    )]
    pub dispute: Account<'info, Dispute>,
    #[account(
        mut,
        constraint = client_token.owner == escrow.client,
        constraint = client_token.mint == escrow.mint
    )]
    pub client_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = contractor_token.owner == escrow.contractor,
        constraint = contractor_token.mint == escrow.mint
    )]
    pub contractor_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct MutualCancelEscrow<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    #[account(mut)]
    pub contractor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        constraint = client_token.owner == escrow.client,
        constraint = client_token.mint == escrow.mint
    )]
    pub client_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ClaimTimeoutRefund<'info> {
    #[account(mut)]
    pub client: Signer<'info>,
    /// CHECK: rent recipient
    #[account(mut)]
    pub creator: SystemAccount<'info>,
    #[account(
        mut,
        close = creator,
        seeds = [ESCROW_SEED, client.key().as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        constraint = client_token.owner == escrow.client,
        constraint = client_token.mint == escrow.mint
    )]
    pub client_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct ClaimTimeoutFunds<'info> {
    #[account(mut)]
    pub contractor: Signer<'info>,
    /// CHECK: rent recipient
    #[account(mut)]
    pub creator: SystemAccount<'info>,
    #[account(
        mut,
        close = creator,
        seeds = [ESCROW_SEED, escrow.client.as_ref(), &escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        mut,
        constraint = contractor_token.owner == escrow.contractor,
        constraint = contractor_token.mint == escrow.mint
    )]
    pub contractor_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = vault_token.mint == escrow.mint,
        constraint = vault_token.owner == escrow.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Add delegate function to the context
#[delegate]
#[derive(Accounts)]
pub struct DelegateEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    /// CHECK: client is used only for seed derivation
    pub client: AccountInfo<'info>,
}

/// Manual commit context for ER
#[commit]
#[derive(Accounts)]
pub struct CommitEscrow<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub escrow: Account<'info, Escrow>,
}

/// Generic delegate PDA context
#[delegate]
#[derive(Accounts)]
pub struct DelegateAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

/// Generic commit/undelegate PDA context
#[commit]
#[derive(Accounts)]
pub struct CommitAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA to commit
    #[account(mut)]
    pub pda: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CreatePermission<'info> {
    /// CHECK: permissioned account can be any PDA owned by this program
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: created by permission program
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePermission<'info> {
    /// CHECK: permissioned account can be any PDA owned by this program
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: permission account
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: authority must be a member set in permission
    pub authority: Signer<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUndelegatePermission<'info> {
    /// CHECK: permissioned account to commit
    #[account(mut)]
    pub permissioned_account: UncheckedAccount<'info>,
    /// CHECK: permission account
    #[account(mut)]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: authority must be a member set in permission
    pub authority: Signer<'info>,
    /// CHECK: permission program
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: magic program
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: magic context
    pub magic_context: UncheckedAccount<'info>,
}

#[account]
pub struct Profile {
    pub owner: Pubkey,
    pub stars: u64,
    pub completed_jobs: u64,
    pub total_earned: u64,
}

impl Profile {
    pub const SIZE: usize = 32 + 8 + 8 + 8;
}

#[account]
pub struct Escrow {
    pub creator: Pubkey,
    pub client: Pubkey,
    pub contractor: Pubkey,
    pub mint: Pubkey,
    pub vault_token: Pubkey,
    pub per_vault: Pubkey,
    pub escrow_id: u64,
    pub terms_hash: [u8; 32],
    pub milestones_hash: [u8; 32],
    pub funded_amount: u64,
    pub released_amount: u64,
    pub funded_at: i64,
    pub dispute_open: bool,
    pub paid_out: bool,
    pub funding_ok: bool,
    pub ready_to_claim: bool,
    pub timeout_refund_ready: bool,
    pub timeout_funds_ready: bool,
    pub judge: Pubkey,
    pub bump: u8,
    pub per_vault_bump: u8,
}

#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        close = creator
    )]
    pub escrow: Account<'info, Escrow>,
}


impl Escrow {
    pub const SIZE: usize = 32
        + 32
        + 32
        + 32
        + 32
        + 32
        + 8
        + 32
        + 32
        + 8
        + 8
        + 8
        + 1
        + 1
        + 1
        + 1
        + 1
        + 1
        + 32
        + 1
        + 1;
}

#[account]
pub struct Milestone {
    pub escrow: Pubkey,
    pub index: u8,
    pub status: u8,
    pub submitted_at: i64,
    pub creator: Pubkey,
}

impl Milestone {
    pub const SIZE: usize = 32 + 1 + 1 + 8 + 32;
}

#[account]
pub struct Dispute {
    pub escrow: Pubkey,
    pub opened_by: Pubkey,
    pub opened_at: i64,
    pub amount: u64,
    pub client_amount: u64,
    pub contractor_amount: u64,
    pub release_to_contractor: bool,
    pub resolved: bool,
    pub resolved_at: i64,
    pub resolved_by: Pubkey,
}

impl Dispute {
    pub const SIZE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 32;
}

#[account]
pub struct Terms {
    pub escrow: Pubkey,
    pub terms_hash: [u8; 32],
    pub total_payment: u64,
    pub deadline: i64,
    pub encrypted_terms_len: u16,
    pub encrypted_terms: [u8; MAX_TERMS_CIPHERTEXT],
    pub signed_client: bool,
    pub signed_contractor: bool,
    pub signed_at: i64,
}

impl Terms {
    pub const SIZE: usize = 32 + 32 + 8 + 8 + 2 + MAX_TERMS_CIPHERTEXT + 1 + 1 + 8;
}

#[account]
pub struct PrivateMilestone {
    pub escrow: Pubkey,
    pub index: u8,
    pub status: u8,
    pub description_hash: [u8; 32],
    pub encrypted_details_len: u16,
    pub encrypted_details: [u8; MAX_MILESTONE_CIPHERTEXT],
    pub updated_at: i64,
}

impl PrivateMilestone {
    pub const SIZE: usize = 32 + 1 + 1 + 32 + 2 + MAX_MILESTONE_CIPHERTEXT + 8;
}

#[repr(u8)]
pub enum MilestoneStatus {
    Created = 0,
    Submitted = 1,
    Rejected = 2,
    Paid = 3,
    Deleted = 4,
}

#[error_code]
pub enum NebulonError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid state for this action")]
    InvalidState,
    #[msg("Milestones are private; use PER")]
    MilestonesPrivate,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Overflow")]
    Overflow,
    #[msg("Dispute is open")]
    DisputeOpen,
    #[msg("No dispute to resolve")]
    NoDispute,
    #[msg("Missing bump")]
    MissingBump,
    #[msg("Funding exceeds total milestone amount")]
    ExceedsTotal,
    #[msg("Invalid deadline")]
    InvalidDeadline,
    #[msg("Deadline not reached")]
    DeadlineNotReached,
    #[msg("Invalid funding amount")]
    InvalidFundingAmount,
    #[msg("Terms are locked after signing")]
    TermsLocked,
    #[msg("Missing milestone accounts")]
    MissingMilestones,
    #[msg("Invalid dispute split")]
    InvalidSplit,
}

impl From<SessionError> for NebulonError {
    fn from(_: SessionError) -> Self {
        NebulonError::Unauthorized
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    Escrow { client: Pubkey, escrow_id: u64 },
    Milestone { escrow: Pubkey, index: u8 },
    PrivateMilestone { escrow: Pubkey, index: u8 },
    Terms { escrow: Pubkey },
    PerVault { escrow: Pubkey },
    Profile { owner: Pubkey },
    Dispute { escrow: Pubkey },
}

fn derive_seeds_from_account_type(account_type: &AccountType) -> Vec<Vec<u8>> {
    match account_type {
        AccountType::Escrow { client, escrow_id } => vec![
            ESCROW_SEED.to_vec(),
            client.to_bytes().to_vec(),
            escrow_id.to_le_bytes().to_vec(),
        ],
        AccountType::Milestone { escrow, index } => vec![
            MILESTONE_SEED.to_vec(),
            escrow.to_bytes().to_vec(),
            vec![*index],
        ],
        AccountType::PrivateMilestone { escrow, index } => vec![
            PRIVATE_MILESTONE_SEED.to_vec(),
            escrow.to_bytes().to_vec(),
            vec![*index],
        ],
        AccountType::Terms { escrow } => vec![
            TERMS_SEED.to_vec(),
            escrow.to_bytes().to_vec(),
        ],
        AccountType::PerVault { escrow } => vec![
            PER_VAULT_SEED.to_vec(),
            escrow.to_bytes().to_vec(),
        ],
        AccountType::Profile { owner } => vec![
            PROFILE_SEED.to_vec(),
            owner.to_bytes().to_vec(),
        ],
        AccountType::Dispute { escrow } => vec![
            DISPUTE_SEED.to_vec(),
            escrow.to_bytes().to_vec(),
        ],
    }
}
