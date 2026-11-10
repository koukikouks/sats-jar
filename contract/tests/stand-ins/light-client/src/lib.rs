//! Sandbox-only stand-in for NEAR's Bitcoin light client (`btc-client-v4.testnet`).
//!
//! `verify_transaction_inclusion_with_heights` and the block lookup are copied line for line
//! from Near-One/btc-light-client-contract @ ac30f6a (contract/src/lib.rs L371-403 and
//! L520-538, merkle-tools/src/lib.rs), with the same panics; a paused client panics with
//! near-plugins-derive 0.5.2's message. Instead of relayed headers, the test registers each
//! block's height and merkle root and sets the tip.
//!
//! One test control is not live behaviour: while `held`, an answer waits (a yield, as the
//! signer stand-in's `slow` mode does) until the test calls `release`, so a test can run another
//! transaction between a proof's call and its callback, as live receipts in different blocks can.
// The copied code keeps the original's style.
#![allow(clippy::manual_is_multiple_of, clippy::ptr_arg)]

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, BorshStorageKey, Gas, GasWeight};

/// The held answer's callback gets this plus all the gas left over (weight 1).
const RELEASE_CALLBACK_GAS: Gas = Gas::from_tgas(5);
const DATA_ID_REGISTER: u64 = 0;
/// Held answers' yield data ids, 32 bytes each, oldest first. Kept outside the contract struct
/// so the method stays `&self` and still answers view calls.
const WAITING_KEY: &[u8] = b"waiting";

/// A 32-byte hash in internal byte order (borsh `[u8; 32]`, like the client's `H256`).
type H256 = [u8; 32];

/// The client's borsh argument (btc-types/src/contract_args.rs).
#[near(serializers = [borsh])]
pub struct TxInclusionProof {
    pub tx_id: H256,
    pub tx_block_blockhash: H256,
    pub tx_index: u64,
    pub merkle_proof: Vec<H256>,
    pub coinbase_tx_id: H256,
    pub coinbase_merkle_proof: Vec<H256>,
}

/// The client's JSON result.
#[near(serializers = [json])]
pub struct TxInclusionInfo {
    pub tx_block_height: u64,
    pub mainchain_tip_height: u64,
}

#[near(serializers = [borsh])]
struct Block {
    height: u64,
    merkle_root: H256,
}

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Blocks,
}

#[near(contract_state)]
pub struct LightClient {
    mainchain: LookupMap<H256, Block>,
    tip_height: Option<u64>,
    paused: bool,
    held: bool,
}

impl Default for LightClient {
    fn default() -> Self {
        Self {
            mainchain: LookupMap::new(StorageKey::Blocks),
            tip_height: None,
            paused: false,
            held: false,
        }
    }
}

#[near]
impl LightClient {
    /// The live method's name and arguments; it answers at once unless held.
    pub fn verify_transaction_inclusion_with_heights(
        &self,
        #[serializer(borsh)] args: TxInclusionProof,
    ) {
        if !self.held {
            let answer = self.inclusion(args);
            let bytes = near_sdk::serde_json::to_vec(&answer).unwrap_or_else(|_| env::abort());
            env::value_return(&bytes);
            return;
        }
        let bytes = near_sdk::borsh::to_vec(&args).unwrap_or_else(|_| env::abort());
        let index = env::promise_yield_create(
            "on_release",
            bytes,
            RELEASE_CALLBACK_GAS,
            GasWeight(1),
            DATA_ID_REGISTER,
        );
        env::promise_return(index);
        let data_id = env::read_register(DATA_ID_REGISTER).unwrap_or_else(|| env::abort());
        let mut waiting = env::storage_read(WAITING_KEY).unwrap_or_default();
        waiting.extend(data_id);
        env::storage_write(WAITING_KEY, &waiting);
    }

    /// A held answer's callback: the answer the call would have had at once.
    #[private]
    pub fn on_release(
        &self,
        #[serializer(borsh)] args: TxInclusionProof,
    ) -> Option<TxInclusionInfo> {
        self.inclusion(args)
    }

    /// Test control: hold every answer from now until `release`, or answer at once again.
    pub fn set_held(&mut self, held: bool) {
        self.held = held;
    }

    /// Test control: answers the oldest held call.
    pub fn release(&mut self) {
        let mut waiting = env::storage_read(WAITING_KEY).unwrap_or_default();
        require!(waiting.len() >= 32, "no answer is held");
        let data_id: [u8; 32] = waiting.drain(..32).collect::<Vec<_>>().try_into().unwrap();
        env::storage_write(WAITING_KEY, &waiting);
        env::promise_yield_resume(&data_id, b"null");
    }

    /// Test control: a main-chain block, hashes in display (explorer) hex.
    pub fn add_block(&mut self, blockhash: String, height: u64, merkle_root: String) {
        self.mainchain.insert(
            from_display_hex(&blockhash),
            Block {
                height,
                merkle_root: from_display_hex(&merkle_root),
            },
        );
    }

    /// Test control: the main-chain tip height.
    pub fn set_tip(&mut self, height: u64) {
        self.tip_height = Some(height);
    }

    /// Test control: pause or unpause, as the client's pause managers can.
    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }
}

impl LightClient {
    /// The live `verify_transaction_inclusion_with_heights` body.
    fn inclusion(&self, args: TxInclusionProof) -> Option<TxInclusionInfo> {
        require!(!self.paused, "Pausable: Method is paused");
        require!(
            args.merkle_proof.len() == args.coinbase_merkle_proof.len(),
            "Coinbase merkle proof and transaction merkle proof should have the same length"
        );

        let (target_block_height, tip_block_height, expected_merkle_root) =
            self.lookup_tx_block_meta(&args.tx_block_blockhash);

        require!(
            compute_root_from_merkle_proof(args.coinbase_tx_id, 0, &args.coinbase_merkle_proof)
                == expected_merkle_root,
            "Incorrect coinbase merkle proof"
        );

        require!(!args.merkle_proof.is_empty(), "Merkle proof is empty");

        let computed_root = compute_root_from_merkle_proof(
            args.tx_id,
            usize::try_from(args.tx_index).unwrap(),
            &args.merkle_proof,
        );

        (computed_root == expected_merkle_root).then_some(TxInclusionInfo {
            tx_block_height: target_block_height,
            mainchain_tip_height: tip_block_height,
        })
    }

    fn lookup_tx_block_meta(&self, tx_block_blockhash: &H256) -> (u64, u64, H256) {
        let tip_block_height = self
            .tip_height
            .unwrap_or_else(|| env::panic_str("ERR_KEY_NOT_EXIST"));
        let block = self
            .mainchain
            .get(tx_block_blockhash)
            .unwrap_or_else(|| env::panic_str("block does not belong to the current main chain"));
        (block.height, tip_block_height, block.merkle_root)
    }
}

fn compute_root_from_merkle_proof(
    transaction_hash: H256,
    transaction_position: usize,
    merkle_proof: &Vec<H256>,
) -> H256 {
    let mut current_hash = transaction_hash;
    let mut current_position = transaction_position;

    for proof_hash in merkle_proof {
        if current_position % 2 == 0 {
            current_hash = compute_hash(&current_hash, proof_hash);
        } else {
            current_hash = compute_hash(proof_hash, &current_hash);
        }
        current_position /= 2;
    }

    current_hash
}

fn compute_hash(first_tx_hash: &H256, second_tx_hash: &H256) -> H256 {
    let mut concat_inputs = Vec::with_capacity(64);
    concat_inputs.extend(first_tx_hash);
    concat_inputs.extend(second_tx_hash);
    env::sha256_array(env::sha256_array(&concat_inputs))
}

fn from_display_hex(text: &str) -> H256 {
    require!(text.len() == 64, "expected 32 bytes of hex");
    let mut bytes = [0u8; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16)
            .unwrap_or_else(|_| env::panic_str("expected hex"));
    }
    bytes.reverse();
    bytes
}
