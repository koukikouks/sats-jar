//! Refusal codes. Each refusal is `CODE: sentence`; the SDK maps the code to a user message, so
//! a code never changes once released.

use near_sdk::env;

/// The root key passed to `new` is not a secp256k1 point.
pub const BAD_MPC_ROOT_KEY: &str = "BAD_MPC_ROOT_KEY";

/// Refuses the call: the transaction fails with `CODE: sentence`.
pub fn refuse(code: &str, sentence: &str) -> ! {
    env::panic_str(&format!("{code}: {sentence}"))
}

/// The child's address is not a valid bech32 segwit address.
pub const INVALID_CHILD_ADDRESS: &str = "INVALID_CHILD_ADDRESS";
/// The child's address is valid for another Bitcoin network.
pub const CHILD_ADDRESS_WRONG_NETWORK: &str = "CHILD_ADDRESS_WRONG_NETWORK";
/// The child's address is segwit but not P2WPKH (a script hash or taproot); the exit branch
/// needs the key behind a key hash.
pub const CHILD_ADDRESS_NOT_P2WPKH: &str = "CHILD_ADDRESS_NOT_P2WPKH";
/// The cap's fee budget (cap / 10) cannot pay one payment's fee at 1 sat/vB.
pub const CAP_TOO_SMALL: &str = "CAP_TOO_SMALL";
/// The unlock date is not after the current block time.
pub const UNLOCK_IN_PAST: &str = "UNLOCK_IN_PAST";
/// Fewer than 2 guardians.
pub const TOO_FEW_GUARDIANS: &str = "TOO_FEW_GUARDIANS";
/// More than 3 guardians.
pub const TOO_MANY_GUARDIANS: &str = "TOO_MANY_GUARDIANS";
/// The same account is listed as a guardian more than once.
pub const DUPLICATE_GUARDIAN: &str = "DUPLICATE_GUARDIAN";
/// The period is shorter than 60 seconds.
pub const PERIOD_TOO_SHORT: &str = "PERIOD_TOO_SHORT";
/// The exit locktime (unlock date plus exit delay) does not fit Bitcoin's 32-bit lock time.
pub const LOCKTIME_OUT_OF_RANGE: &str = "LOCKTIME_OUT_OF_RANGE";
/// The attached deposit does not cover the new jar's storage.
pub const STORAGE_DEPOSIT_TOO_LOW: &str = "STORAGE_DEPOSIT_TOO_LOW";
/// No payment has this id.
#[cfg_attr(not(feature = "dev-escape"), allow(dead_code))]
pub const UNKNOWN_PAYMENT: &str = "UNKNOWN_PAYMENT";
/// No jar has this id.
pub const UNKNOWN_JAR: &str = "UNKNOWN_JAR";
/// The top-up's transaction is not hex or does not parse as a Bitcoin transaction.
pub const INVALID_TX: &str = "INVALID_TX";
/// A hash in the top-up's proof is not 32 bytes of hex.
pub const INVALID_PROOF: &str = "INVALID_PROOF";
/// The output is past the transaction's last output or does not pay the jar's address.
pub const NOT_TO_JAR: &str = "NOT_TO_JAR";
/// The light client did not find the transaction in its main chain (unknown or side-chain
/// block, a merkle proof that does not lead to the block's root, or the client is paused).
pub const NOT_IN_CHAIN: &str = "NOT_IN_CHAIN";
/// The top-up's block is not yet deep enough; the message says how many confirmations it has.
pub const NOT_CONFIRMED: &str = "NOT_CONFIRMED";
/// The proof's `tx_id` is not the txid of the transaction sent (SHA256d of its bytes without
/// witnesses).
pub const PROOF_TX_MISMATCH: &str = "PROOF_TX_MISMATCH";
/// A coinbase transaction cannot be a top-up.
pub const COINBASE: &str = "COINBASE";
/// The proof's transaction index is 0 (the coinbase's place) or does not fit the proof's depth.
pub const BAD_TX_INDEX: &str = "BAD_TX_INDEX";
/// The output is below the dust floor (1,000 sats), so it does not count.
pub const BELOW_DUST: &str = "BELOW_DUST";
/// This outpoint has already been counted, by this jar or another.
pub const COIN_ALREADY_KNOWN: &str = "COIN_ALREADY_KNOWN";
/// The attached gas cannot cover the light client's call and the callback.
pub const NOT_ENOUGH_GAS: &str = "NOT_ENOUGH_GAS";
