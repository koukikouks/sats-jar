//! NEAR's Bitcoin light client (ADR 0002): the borsh argument of
//! `verify_transaction_inclusion_with_heights` and its JSON result, as defined in
//! Near-One/btc-light-client-contract @ ac30f6a (btc-types/src/contract_args.rs). Hashes are in
//! internal byte order. The client proves inclusion only; confirmations are counted here.

use near_sdk::{near, Gas};

pub const METHOD: &str = "verify_transaction_inclusion_with_heights";
/// Gas for the light client's call, and for the callback that reads its answer.
pub const CALL_GAS: Gas = Gas::from_tgas(20);
pub const CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// What a `prove_topup` caller must attach: the two above plus the checks before the call.
pub const PROVE_TOPUP_GAS: Gas = Gas::from_tgas(60);

#[near(serializers = [borsh])]
pub struct TxInclusionProof {
    pub tx_id: [u8; 32],
    pub tx_block_blockhash: [u8; 32],
    pub tx_index: u64,
    pub merkle_proof: Vec<[u8; 32]>,
    pub coinbase_tx_id: [u8; 32],
    pub coinbase_merkle_proof: Vec<[u8; 32]>,
}

/// The client's answer for a proof it accepts (it returns `null` when the merkle proof does not
/// lead to the block's root, and panics for an unknown block or while paused).
#[near(serializers = [json])]
pub struct TxInclusionInfo {
    pub tx_block_height: u64,
    pub mainchain_tip_height: u64,
}

impl TxInclusionInfo {
    /// Blocks from the transaction's block to the tip, both included.
    pub fn confirmations(&self) -> u64 {
        self.mainchain_tip_height
            .checked_sub(self.tx_block_height)
            .and_then(|depth| depth.checked_add(1))
            .unwrap_or(0)
    }
}
