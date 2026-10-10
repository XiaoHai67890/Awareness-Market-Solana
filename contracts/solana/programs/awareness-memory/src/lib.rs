#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

// Assigned Devnet program identity; its private key is kept outside this repo.
declare_id!("9RQqnFRPg2z7XNtggHLTnw3sREjwivB88mXZjuMnvxit");

pub const VERSION: u8 = 1;
pub const ZERO: [u8; 32] = [0; 32];
pub const NATIVE_SPACE_TYPE: &[u8] =
    b"AwarenessMemorySpace(bytes32 initialController,bytes32 salt)";
pub const DELTA_TYPE: &[u8] = b"ExperienceDelta(bytes32 spaceId,uint64 sequence,bytes32 prevStateRoot,bytes32 deltaCommitment,bytes32 provenanceCommitment,bytes32 profileId,bytes32 locatorCommitment)";
pub const STATE_TYPE: &[u8] = b"MemoryState(bytes32 prevStateRoot,bytes32 transitionId)";

#[program]
pub mod awareness_memory {
    use super::*;

    pub fn register_space(
        ctx: Context<RegisterSpace>,
        space_id: [u8; 32],
        salt: [u8; 32],
        authorizer: Pubkey,
    ) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.controller.key(),
            Pubkey::default(),
            RegistryError::ZeroAuthority
        );
        require_keys_neq!(authorizer, Pubkey::default(), RegistryError::ZeroAuthority);
        require!(space_id != ZERO, RegistryError::ZeroSpaceId);
        require!(
            space_id == native_space_id(&ctx.accounts.controller.key(), &salt),
            RegistryError::InvalidSpaceId
        );
        let space = &mut ctx.accounts.memory_space;
        space.version = VERSION;
        space.bump = ctx.bumps.memory_space;
        space.space_id = space_id;
        space.initial_controller = ctx.accounts.controller.key();
        space.salt = salt;
        space.controller = ctx.accounts.controller.key();
        space.authorizer = authorizer;
        space.sequence = 0;
        space.config_nonce = 0;
        space.transition_id = ZERO;
        space.state_root = ZERO;
        emit!(SpaceRegistered {
            space_id,
            controller: space.controller,
            authorizer
        });
        Ok(())
    }

    pub fn commit_transition(
        ctx: Context<CommitTransition>,
        sequence: u64,
        prev_state_root: [u8; 32],
        delta_commitment: [u8; 32],
        provenance_commitment: [u8; 32],
        profile_id: [u8; 32],
        locator_commitment: [u8; 32],
    ) -> Result<()> {
        let space = &mut ctx.accounts.memory_space;
        require!(space.version == VERSION, RegistryError::UnsupportedVersion);
        let expected = space
            .sequence
            .checked_add(1)
            .ok_or(RegistryError::SequenceOverflow)?;
        require!(sequence == expected, RegistryError::BadSequence);
        require!(
            prev_state_root == space.state_root,
            RegistryError::BadPreviousState
        );
        require!(delta_commitment != ZERO, RegistryError::ZeroDeltaCommitment);
        require!(profile_id != ZERO, RegistryError::ZeroProfileId);
        let transition_id = transition_id(
            &space.space_id,
            sequence,
            &prev_state_root,
            &delta_commitment,
            &provenance_commitment,
            &profile_id,
            &locator_commitment,
        );
        let next_state_root = next_state_root(&prev_state_root, &transition_id);
        let receipt = &mut ctx.accounts.receipt;
        receipt.version = VERSION;
        receipt.bump = ctx.bumps.receipt;
        receipt.space_id = space.space_id;
        receipt.sequence = sequence;
        receipt.prev_state_root = prev_state_root;
        receipt.delta_commitment = delta_commitment;
        receipt.provenance_commitment = provenance_commitment;
        receipt.profile_id = profile_id;
        receipt.locator_commitment = locator_commitment;
        receipt.transition_id = transition_id;
        receipt.next_state_root = next_state_root;
        receipt.authorizer = space.authorizer;
        receipt.observed_slot = Clock::get()?.slot;
        space.sequence = sequence;
        space.transition_id = transition_id;
        space.state_root = next_state_root;
        emit!(TransitionCommitted {
            space_id: space.space_id,
            sequence,
            transition_id,
            prev_state_root,
            next_state_root,
            delta_commitment,
            provenance_commitment,
            profile_id,
            locator_commitment,
            authorizer: space.authorizer,
        });
        Ok(())
    }

    pub fn set_authorization(
        ctx: Context<SetAuthorization>,
        new_controller: Pubkey,
        new_authorizer: Pubkey,
        nonce: u64,
    ) -> Result<()> {
        require_keys_neq!(
            new_controller,
            Pubkey::default(),
            RegistryError::ZeroAuthority
        );
        require_keys_neq!(
            new_authorizer,
            Pubkey::default(),
            RegistryError::ZeroAuthority
        );
        let space = &mut ctx.accounts.memory_space;
        require!(space.version == VERSION, RegistryError::UnsupportedVersion);
        let expected = space
            .config_nonce
            .checked_add(1)
            .ok_or(RegistryError::NonceOverflow)?;
        require!(nonce == expected, RegistryError::BadNonce);
        space.controller = new_controller;
        space.authorizer = new_authorizer;
        space.config_nonce = nonce;
        emit!(AuthorizationUpdated {
            space_id: space.space_id,
            new_controller,
            new_authorizer,
            nonce
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(space_id: [u8; 32])]
pub struct RegisterSpace<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub controller: Signer<'info>,
    #[account(init, payer = payer, space = Space::LEN, seeds = [b"space", space_id.as_ref()], bump)]
    pub memory_space: Account<'info, Space>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct CommitTransition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authorizer: Signer<'info>,
    #[account(mut, seeds = [b"space", memory_space.space_id.as_ref()], bump = memory_space.bump,
        has_one = authorizer @ RegistryError::Unauthorized)]
    pub memory_space: Account<'info, Space>,
    #[account(init, payer = payer, space = TransitionReceipt::LEN,
        seeds = [b"transition", memory_space.space_id.as_ref(), sequence.to_le_bytes().as_ref()], bump)]
    pub receipt: Account<'info, TransitionReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAuthorization<'info> {
    pub controller: Signer<'info>,
    #[account(mut, seeds = [b"space", memory_space.space_id.as_ref()], bump = memory_space.bump,
        has_one = controller @ RegistryError::Unauthorized)]
    pub memory_space: Account<'info, Space>,
}

#[account]
pub struct Space {
    pub version: u8,
    pub bump: u8,
    pub space_id: [u8; 32],
    pub initial_controller: Pubkey,
    pub salt: [u8; 32],
    pub controller: Pubkey,
    pub authorizer: Pubkey,
    pub sequence: u64,
    pub config_nonce: u64,
    pub transition_id: [u8; 32],
    pub state_root: [u8; 32],
}
impl Space {
    pub const LEN: usize = 250;
}

#[account]
pub struct TransitionReceipt {
    pub version: u8,
    pub bump: u8,
    pub space_id: [u8; 32],
    pub sequence: u64,
    pub prev_state_root: [u8; 32],
    pub delta_commitment: [u8; 32],
    pub provenance_commitment: [u8; 32],
    pub profile_id: [u8; 32],
    pub locator_commitment: [u8; 32],
    pub transition_id: [u8; 32],
    pub next_state_root: [u8; 32],
    pub authorizer: Pubkey,
    pub observed_slot: u64,
}
impl TransitionReceipt {
    pub const LEN: usize = 314;
}

// Account instruction transport uses Borsh. These hash preimages intentionally use
// ERC-8350's ABI words, including a big-endian, left-zero-padded uint64.
pub fn native_space_id(controller: &Pubkey, salt: &[u8; 32]) -> [u8; 32] {
    let type_hash = hashv(&[NATIVE_SPACE_TYPE]).to_bytes();
    hashv(&[&type_hash, controller.as_ref(), salt]).to_bytes()
}
pub fn transition_id(
    space_id: &[u8; 32],
    sequence: u64,
    prev: &[u8; 32],
    delta: &[u8; 32],
    provenance: &[u8; 32],
    profile: &[u8; 32],
    locator: &[u8; 32],
) -> [u8; 32] {
    let type_hash = hashv(&[DELTA_TYPE]).to_bytes();
    let mut seq_word = [0u8; 32];
    seq_word[24..].copy_from_slice(&sequence.to_be_bytes());
    hashv(&[
        &type_hash, space_id, &seq_word, prev, delta, provenance, profile, locator,
    ])
    .to_bytes()
}
pub fn next_state_root(prev: &[u8; 32], transition: &[u8; 32]) -> [u8; 32] {
    let type_hash = hashv(&[STATE_TYPE]).to_bytes();
    hashv(&[&type_hash, prev, transition]).to_bytes()
}

#[event]
pub struct SpaceRegistered {
    pub space_id: [u8; 32],
    pub controller: Pubkey,
    pub authorizer: Pubkey,
}
#[event]
pub struct AuthorizationUpdated {
    pub space_id: [u8; 32],
    pub new_controller: Pubkey,
    pub new_authorizer: Pubkey,
    pub nonce: u64,
}
#[event]
pub struct TransitionCommitted {
    pub space_id: [u8; 32],
    pub sequence: u64,
    pub transition_id: [u8; 32],
    pub prev_state_root: [u8; 32],
    pub next_state_root: [u8; 32],
    pub delta_commitment: [u8; 32],
    pub provenance_commitment: [u8; 32],
    pub profile_id: [u8; 32],
    pub locator_commitment: [u8; 32],
    pub authorizer: Pubkey,
}

#[error_code]
pub enum RegistryError {
    #[msg("Controller and authorizer must be nonzero")]
    ZeroAuthority,
    #[msg("Space ID must be nonzero")]
    ZeroSpaceId,
    #[msg("Space ID does not derive from the initial controller and salt")]
    InvalidSpaceId,
    #[msg("Current controller or authorizer must sign")]
    Unauthorized,
    #[msg("Sequence must advance by exactly one")]
    BadSequence,
    #[msg("Previous root does not equal the current root")]
    BadPreviousState,
    #[msg("Delta commitment must be nonzero")]
    ZeroDeltaCommitment,
    #[msg("Profile ID must be nonzero")]
    ZeroProfileId,
    #[msg("Sequence cannot exceed u64")]
    SequenceOverflow,
    #[msg("Authorization nonce must advance by exactly one")]
    BadNonce,
    #[msg("Authorization nonce cannot exceed u64")]
    NonceOverflow,
    #[msg("Account version is unsupported")]
    UnsupportedVersion,
}

#[cfg(test)]
mod hash_tests {
    use super::*;
    use serde_json::Value;

    fn bytes(value: &Value) -> [u8; 32] {
        let text = value.as_str().unwrap().trim_start_matches("0x");
        let mut out = [0; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn matches_all_five_erc8350_transitions_and_roots() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/erc8350-vectors-v2.json"
        ))
        .unwrap();
        for row in fixture["chain"].as_array().unwrap() {
            let d = &row["delta"];
            let sequence = d["sequence"].as_str().unwrap().parse().unwrap();
            let tid = transition_id(
                &bytes(&d["spaceId"]),
                sequence,
                &bytes(&d["prevStateRoot"]),
                &bytes(&d["deltaCommitment"]),
                &bytes(&d["provenanceCommitment"]),
                &bytes(&d["profileId"]),
                &bytes(&d["locatorCommitment"]),
            );
            assert_eq!(tid, bytes(&row["expected"]["transitionId"]));
            assert_eq!(
                next_state_root(&bytes(&d["prevStateRoot"]), &tid),
                bytes(&row["expected"]["nextStateRoot"])
            );
        }
    }

    #[test]
    fn native_identity_matches_independent_javascript_golden() {
        use std::str::FromStr;
        let controller = Pubkey::from_str("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB").unwrap();
        let expected =
            serde_json::json!("0x2b10fa2b5154c831bff6e036d1e683cf1e817d4763e910f20f64cd1778ed85e0");
        assert_eq!(native_space_id(&controller, &[0x11; 32]), bytes(&expected));
    }

    #[test]
    fn serialized_account_lengths_and_layout_are_pinned() {
        let space = Space {
            version: VERSION,
            bump: 0,
            space_id: ZERO,
            initial_controller: Pubkey::default(),
            salt: ZERO,
            controller: Pubkey::default(),
            authorizer: Pubkey::default(),
            sequence: 0,
            config_nonce: 0,
            transition_id: ZERO,
            state_root: ZERO,
        };
        let mut data = Vec::new();
        space.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), Space::LEN);
        let receipt = TransitionReceipt {
            version: VERSION,
            bump: 0,
            space_id: ZERO,
            sequence: 0,
            prev_state_root: ZERO,
            delta_commitment: ZERO,
            provenance_commitment: ZERO,
            profile_id: ZERO,
            locator_commitment: ZERO,
            transition_id: ZERO,
            next_state_root: ZERO,
            authorizer: Pubkey::default(),
            observed_slot: 0,
        };
        let mut data = Vec::new();
        receipt.try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), TransitionReceipt::LEN);
    }
}
