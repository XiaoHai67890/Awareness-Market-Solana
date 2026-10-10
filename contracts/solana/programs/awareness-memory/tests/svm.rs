#![cfg(feature = "svm-tests")]

use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use awareness_memory::{
    accounts, instruction, native_space_id, next_state_root, transition_id, Space,
    TransitionReceipt, ID, VERSION, ZERO,
};
use litesvm::{types::TransactionResult, LiteSVM};
use solana_instruction::{error::InstructionError, Instruction};
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
    controller: Keypair,
    authorizer: Keypair,
    salt: [u8; 32],
    space_id: [u8; 32],
    space: Pubkey,
}

impl Harness {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let artifact = std::env::var_os("AWARENESS_SOLANA_PROGRAM_SO")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../target/deploy/awareness_memory.so")
            });
        // This loads the actual compiled ELF, never the host-native entrypoint.
        svm.add_program_from_file(ID, &artifact)
            .expect("build SBF before running svm-tests");
        let payer = Keypair::new();
        let controller = Keypair::new();
        let authorizer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
        let salt = [0x11; 32];
        let space_id = native_space_id(&controller.pubkey(), &salt);
        let (space, _) = Pubkey::find_program_address(&[b"space", &space_id], &ID);
        Self {
            svm,
            payer,
            controller,
            authorizer,
            salt,
            space_id,
            space,
        }
    }
    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> TransactionResult {
        self.svm.expire_blockhash();
        let mut all_signers: Vec<&Keypair> = vec![&self.payer];
        for signer in signers {
            if signer.pubkey() != self.payer.pubkey() {
                all_signers.push(signer);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&self.payer.pubkey()),
            &all_signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx)
    }
    fn register_ix(&self) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::RegisterSpace {
                payer: self.payer.pubkey(),
                controller: self.controller.pubkey(),
                memory_space: self.space,
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            data: instruction::RegisterSpace {
                space_id: self.space_id,
                salt: self.salt,
                authorizer: self.authorizer.pubkey(),
            }
            .data(),
        }
    }
    fn register(&mut self) {
        let ix = self.register_ix();
        let controller = self.controller.insecure_clone();
        self.send(ix, &[&controller]).unwrap();
    }
    fn receipt(&self, sequence: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"transition", &self.space_id, &sequence.to_le_bytes()],
            &ID,
        )
        .0
    }
    fn commit_ix(&self, sequence: u64, prev: [u8; 32]) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::CommitTransition {
                payer: self.payer.pubkey(),
                authorizer: self.authorizer.pubkey(),
                memory_space: self.space,
                receipt: self.receipt(sequence),
                system_program: Pubkey::default(),
            }
            .to_account_metas(None),
            data: instruction::CommitTransition {
                sequence,
                prev_state_root: prev,
                delta_commitment: [0x22; 32],
                provenance_commitment: ZERO,
                profile_id: [0x33; 32],
                locator_commitment: ZERO,
            }
            .data(),
        }
    }
    fn rotate_ix(&self, controller: Pubkey, authorizer: Pubkey, nonce: u64) -> Instruction {
        Instruction {
            program_id: ID,
            accounts: accounts::SetAuthorization {
                controller: self.controller.pubkey(),
                memory_space: self.space,
            }
            .to_account_metas(None),
            data: instruction::SetAuthorization {
                new_controller: controller,
                new_authorizer: authorizer,
                nonce,
            }
            .data(),
        }
    }
    fn state(&self) -> Space {
        Space::try_deserialize(&mut self.svm.get_account(&self.space).unwrap().data.as_slice())
            .unwrap()
    }
    fn state_bytes(&self) -> Vec<u8> {
        self.svm.get_account(&self.space).unwrap().data
    }
    fn assert_failure_rollback(
        &mut self,
        ix: Instruction,
        signers: &[&Keypair],
        sequence: u64,
        expected: Option<u32>,
    ) {
        let before = self.state_bytes();
        let receipt = self.receipt(sequence);
        let previous_receipt = self.svm.get_account(&receipt);
        let failure = self.send(ix, signers).expect_err("transaction must fail");
        if let Some(code) = expected {
            assert_eq!(
                failure.err,
                TransactionError::InstructionError(0, InstructionError::Custom(code)),
                "{}",
                failure.meta.pretty_logs()
            );
        }
        assert_eq!(
            before,
            self.state_bytes(),
            "failed transaction modified Space"
        );
        assert_eq!(
            previous_receipt,
            self.svm.get_account(&receipt),
            "failed transaction changed receipt"
        );
    }
    fn replace_state(&mut self, change: impl FnOnce(&mut Space)) {
        let mut account = self.svm.get_account(&self.space).unwrap();
        let mut state = self.state();
        change(&mut state);
        account.data.clear();
        state.try_serialize(&mut account.data).unwrap();
        self.svm.set_account(self.space, account).unwrap();
    }
}

#[test]
fn real_sbf_register_commit_chain_preserves_immutable_receipts() {
    let mut h = Harness::new();
    h.register();
    assert_ne!(h.payer.pubkey(), h.authorizer.pubkey());
    let initial = h.state();
    assert_eq!(
        (initial.sequence, initial.config_nonce, initial.state_root),
        (0, 0, ZERO)
    );
    let auth = h.authorizer.insecure_clone();
    h.svm.warp_to_slot(42);
    h.send(h.commit_ix(1, ZERO), &[&auth]).unwrap();
    let first = h.svm.get_account(&h.receipt(1)).unwrap();
    let receipt = TransitionReceipt::try_deserialize(&mut first.data.as_slice()).unwrap();
    let expected_tid = transition_id(
        &h.space_id,
        1,
        &ZERO,
        &[0x22; 32],
        &ZERO,
        &[0x33; 32],
        &ZERO,
    );
    assert_eq!(receipt.transition_id, expected_tid);
    assert_eq!(
        receipt.next_state_root,
        next_state_root(&ZERO, &expected_tid)
    );
    assert_eq!(receipt.authorizer, h.authorizer.pubkey());
    assert_eq!(receipt.sequence, 1);
    assert_eq!(receipt.observed_slot, 42);
    assert_eq!(first.owner, ID);
    h.svm.warp_to_slot(43);
    h.send(h.commit_ix(2, receipt.next_state_root), &[&auth])
        .unwrap();
    assert_eq!(h.svm.get_account(&h.receipt(1)).unwrap(), first);
    assert_eq!(h.state().sequence, 2);
    assert_ne!(h.state().state_root, receipt.next_state_root);
    let before = h.state_bytes();
    assert!(h
        .send(h.register_ix(), &[&h.controller.insecure_clone()])
        .is_err());
    assert_eq!(
        before,
        h.state_bytes(),
        "duplicate register cannot reset a space"
    );
    h.assert_failure_rollback(h.commit_ix(1, ZERO), &[&auth], 1, None);
}

#[test]
fn real_sbf_rejects_bad_sequence_prevroot_commitments_and_rolls_back_rent_init() {
    let mut h = Harness::new();
    h.register();
    let auth = h.authorizer.insecure_clone();
    h.assert_failure_rollback(h.commit_ix(2, ZERO), &[&auth], 2, Some(6004));
    h.assert_failure_rollback(h.commit_ix(1, [1; 32]), &[&auth], 1, Some(6005));
    for (field, code) in [("delta", 6006), ("profile", 6007)] {
        let mut ix = h.commit_ix(1, ZERO);
        let offset = if field == "delta" { 48 } else { 112 };
        ix.data[offset..offset + 32].fill(0);
        h.assert_failure_rollback(ix, &[&auth], 1, Some(code));
    }
    h.send(h.commit_ix(1, ZERO), &[&auth]).unwrap();
    assert_eq!(
        h.state().sequence,
        1,
        "failed init left no poisoned receipt PDA"
    );
}

#[test]
fn real_sbf_requires_current_authority_signature_not_fee_payer() {
    let mut h = Harness::new();
    h.register();
    let wrong = Keypair::new();
    let mut ix = h.commit_ix(1, ZERO);
    ix.accounts[1].pubkey = wrong.pubkey();
    h.assert_failure_rollback(ix, &[&wrong], 1, Some(6003));
    let mut ix = h.commit_ix(1, ZERO);
    ix.accounts[1].is_signer = false;
    h.assert_failure_rollback(ix, &[], 1, Some(3010));
    let mut ix = h.rotate_ix(h.controller.pubkey(), h.authorizer.pubkey(), 1);
    ix.accounts[0].is_signer = false;
    h.assert_failure_rollback(ix, &[], 1, Some(3010));
    // Also exercise transaction signature verification, not only Signer parsing.
    let before = h.state_bytes();
    h.svm.expire_blockhash();
    let mut unsigned =
        Transaction::new_with_payer(&[h.commit_ix(1, ZERO)], Some(&h.payer.pubkey()));
    unsigned.partial_sign(&[&h.payer], h.svm.latest_blockhash());
    assert_eq!(
        h.svm.send_transaction(unsigned).unwrap_err().err,
        TransactionError::SignatureFailure
    );
    assert_eq!(before, h.state_bytes());
    assert!(h.svm.get_account(&h.receipt(1)).is_none());
}

#[test]
fn real_sbf_enforces_space_receipt_seeds_and_program_owner() {
    let mut h = Harness::new();
    h.register();
    let auth = h.authorizer.insecure_clone();
    let fake = Pubkey::new_unique();
    h.svm
        .set_account(fake, h.svm.get_account(&h.space).unwrap())
        .unwrap();
    let mut ix = h.commit_ix(1, ZERO);
    ix.accounts[2].pubkey = fake;
    h.assert_failure_rollback(ix, &[&auth], 1, Some(2006));
    let mut ix = h.commit_ix(1, ZERO);
    ix.accounts[3].pubkey = Pubkey::new_unique();
    h.assert_failure_rollback(ix, &[&auth], 1, Some(2006));
    let mut account = h.svm.get_account(&h.space).unwrap();
    account.owner = Pubkey::default();
    h.svm.set_account(h.space, account).unwrap();
    h.assert_failure_rollback(h.commit_ix(1, ZERO), &[&auth], 1, Some(3007));
}

#[test]
fn real_sbf_authorization_rotation_nonce_replay_and_stable_identity() {
    let mut h = Harness::new();
    h.register();
    let old_controller = h.controller.insecure_clone();
    let old_authorizer = h.authorizer.insecure_clone();
    let new_controller = Keypair::new();
    let new_authorizer = Keypair::new();
    let initial_controller = h.state().initial_controller;
    h.send(
        h.rotate_ix(new_controller.pubkey(), new_authorizer.pubkey(), 1),
        &[&old_controller],
    )
    .unwrap();
    let rotated = h.state();
    assert_eq!(rotated.config_nonce, 1);
    assert_eq!(rotated.space_id, h.space_id);
    assert_eq!(rotated.initial_controller, initial_controller);
    assert_eq!(rotated.salt, h.salt);
    h.assert_failure_rollback(h.commit_ix(1, ZERO), &[&old_authorizer], 1, Some(6003));
    h.assert_failure_rollback(
        h.rotate_ix(old_controller.pubkey(), old_authorizer.pubkey(), 2),
        &[&old_controller],
        1,
        Some(6003),
    );
    h.controller = new_controller;
    h.authorizer = new_authorizer;
    let controller = h.controller.insecure_clone();
    let authorizer = h.authorizer.insecure_clone();
    h.assert_failure_rollback(
        h.rotate_ix(h.controller.pubkey(), h.authorizer.pubkey(), 1),
        &[&controller],
        1,
        Some(6009),
    );
    h.assert_failure_rollback(
        h.rotate_ix(h.controller.pubkey(), Pubkey::default(), 2),
        &[&controller],
        1,
        Some(6000),
    );
    h.send(h.commit_ix(1, ZERO), &[&authorizer]).unwrap();
    assert_eq!(h.state().sequence, 1);
}

#[test]
fn real_sbf_checked_overflow_and_unsupported_versions_cannot_mutate_accounts() {
    let mut h = Harness::new();
    h.register();
    let auth = h.authorizer.insecure_clone();
    let controller = h.controller.insecure_clone();
    // Only the test harness can inject these otherwise unreachable states.
    h.replace_state(|s| s.sequence = u64::MAX);
    h.assert_failure_rollback(h.commit_ix(0, ZERO), &[&auth], 0, Some(6008));
    h.replace_state(|s| {
        s.sequence = 0;
        s.config_nonce = u64::MAX;
    });
    h.assert_failure_rollback(
        h.rotate_ix(h.controller.pubkey(), h.authorizer.pubkey(), 0),
        &[&controller],
        1,
        Some(6010),
    );
    h.replace_state(|s| {
        s.config_nonce = 0;
        s.version = VERSION + 1;
    });
    h.assert_failure_rollback(h.commit_ix(1, ZERO), &[&auth], 1, Some(6011));
}

#[test]
fn real_sbf_registration_rejects_invalid_identity_authority_and_missing_signer() {
    let mut h = Harness::new();
    let controller = h.controller.insecure_clone();
    let mut ix = h.register_ix();
    ix.data[8..40].fill(0);
    ix.accounts[2].pubkey = Pubkey::find_program_address(&[b"space", &ZERO], &ID).0;
    assert!(h
        .send(ix, &[&controller])
        .unwrap_err()
        .meta
        .logs
        .iter()
        .any(|s| s.contains("ZeroSpaceId")));
    assert!(h.svm.get_account(&h.space).is_none());
    let mut ix = h.register_ix();
    ix.data[8..40].fill(9);
    ix.accounts[2].pubkey = Pubkey::find_program_address(&[b"space", &[9; 32]], &ID).0;
    assert!(h
        .send(ix, &[&controller])
        .unwrap_err()
        .meta
        .logs
        .iter()
        .any(|s| s.contains("InvalidSpaceId")));
    let mut ix = h.register_ix();
    ix.data[72..104].fill(0);
    assert!(h
        .send(ix, &[&controller])
        .unwrap_err()
        .meta
        .logs
        .iter()
        .any(|s| s.contains("ZeroAuthority")));
    let mut ix = h.register_ix();
    ix.accounts[1].is_signer = false;
    assert_eq!(
        h.send(ix, &[]).unwrap_err().err,
        TransactionError::InstructionError(0, InstructionError::Custom(3010))
    );
    assert!(h.svm.get_account(&h.space).is_none());
    h.register();
}
