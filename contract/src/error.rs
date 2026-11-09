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
/// The transaction is one of the contract's own payments; its change counts through
/// `confirm_payment`.
pub const OWN_PAYMENT_TX: &str = "OWN_PAYMENT_TX";
/// The jar has no proven top-up yet, so its allowance clock has not started.
pub const NOT_FUNDED: &str = "NOT_FUNDED";
/// An allowance was already requested in this period (even if it is not yet confirmed); the
/// message says when the next period starts.
pub const ALREADY_PAID: &str = "ALREADY_PAID";
/// The jar's last allowance, from an earlier period, is not yet confirmed (or cancelled); its
/// inputs are still reserved.
pub const PAYMENT_PENDING: &str = "PAYMENT_PENDING";
/// The fee rate is below 1 sat/vB, which Bitcoin nodes do not relay.
pub const FEE_TOO_LOW: &str = "FEE_TOO_LOW";
/// The jar's free coins (its 10 largest) cannot pay the fee plus a payment at the dust floor.
pub const INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";
/// The payment's fee would be over the jar's fee budget (cap / 10).
pub const FEE_OVER_BUDGET: &str = "FEE_OVER_BUDGET";
/// The jar holds too little to pay at least half the cap; the allowance carries over until
/// more top-ups arrive (ADR 0005's size floor).
pub const PAYMENT_TOO_SMALL: &str = "PAYMENT_TOO_SMALL";
/// Paying the cap would leave change below the dust floor, which would go to miners.
pub const CHANGE_BELOW_DUST: &str = "CHANGE_BELOW_DUST";
/// The payment is already proven confirmed.
pub const PAYMENT_ALREADY_CONFIRMED: &str = "PAYMENT_ALREADY_CONFIRMED";
/// The payment was cancelled (development builds only), so it can never be confirmed.
pub const PAYMENT_CANCELLED: &str = "PAYMENT_CANCELLED";
/// The payment is already signed, so it is not signed again.
pub const PAYMENT_ALREADY_SIGNED: &str = "PAYMENT_ALREADY_SIGNED";
/// The payment's current signing round may still be answered; the message says from which
/// block it can be retried.
pub const SIGNING_IN_PROGRESS: &str = "SIGNING_IN_PROGRESS";
/// The payment has no stored signatures, so there is nothing to rebuild.
pub const PAYMENT_NOT_SIGNED: &str = "PAYMENT_NOT_SIGNED";
