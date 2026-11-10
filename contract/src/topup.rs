//! A top-up proof's checks before the light client is asked: the contract reads the raw
//! transaction itself (txid, outputs), so the caller supplies no hash or amount it trusts.

use crate::error::{self, refuse};
use crate::light_client::TxInclusionProof;
use crate::Network;
use btc::Transaction;
use near_sdk::near;

/// Confirmations a top-up needs before it counts. Testnet's are a demo convenience, not
/// security; mainnet takes Bitcoin's usual six.
pub fn required_confirmations(network: Network) -> u64 {
    match network {
        Network::Mainnet => 6,
        Network::Testnet | Network::Regtest => 3,
    }
}

/// The smallest top-up that counts, in sats. Above every standard dust limit (330 sats for
/// P2WSH), and each coin costs an attacker more in Bitcoin than its storage costs the contract.
pub const DUST_FLOOR: u64 = 1_000;

/// The deepest merkle proof a block can need.
const MAX_PROOF_DEPTH: usize = 32;

/// A transaction's inclusion proof as a caller sends it, for a top-up or a payment. Hashes are
/// display hex, the order explorers and Bitcoin Core print them (the light client's own JSON
/// form of its argument).
#[near(serializers = [json])]
pub struct TopupProof {
    pub tx_id: String,
    pub tx_block_blockhash: String,
    pub tx_index: u64,
    pub merkle_proof: Vec<String>,
    pub coinbase_tx_id: String,
    pub coinbase_merkle_proof: Vec<String>,
}

/// The output a top-up proof claims for the jar.
pub struct Topup {
    /// Internal byte order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
    /// The index of the jar address the output pays.
    pub address: u32,
}

/// Checks a top-up of a jar, refusing in the spec's order, and returns the output and the
/// light client's argument. `address_of` gives the index of the jar address a scriptPubKey
/// pays (current or old: a top-up to an old one is a stray), and `is_payment` says whether a
/// txid is one of the contract's own payments.
pub fn check(
    tx_hex: &str,
    vout: u32,
    proof: &TopupProof,
    address_of: impl Fn(&[u8]) -> Option<u32>,
    is_payment: impl Fn(&[u8; 32]) -> bool,
) -> (Topup, TxInclusionProof) {
    let tx = crate::hex::decode(tx_hex)
        .and_then(|bytes| Transaction::parse(&bytes).ok())
        .unwrap_or_else(|| refuse(error::INVALID_TX, "the transaction could not be read"));
    let args = inclusion_args(proof);
    let txid = tx.txid();
    if args.tx_id != txid {
        refuse(
            error::PROOF_TX_MISMATCH,
            "the proof is for another transaction than the one sent",
        );
    }
    if tx.is_coinbase() {
        refuse(error::COINBASE, "a coinbase transaction is not a top-up");
    }
    check_index(&args);
    // Its change is counted by `confirm_payment`, once, with the payment's own record.
    if is_payment(&txid) {
        refuse(
            error::OWN_PAYMENT_TX,
            "this is a jar payment; prove it with confirm_payment",
        );
    }
    let output = tx.outputs.get(vout as usize).unwrap_or_else(|| {
        refuse(
            error::NOT_TO_JAR,
            &format!("the transaction has no output {vout}"),
        )
    });
    let address = address_of(&output.script_pubkey).unwrap_or_else(|| {
        refuse(
            error::NOT_TO_JAR,
            &format!("output {vout} does not pay any of this jar's addresses"),
        )
    });
    if output.value < DUST_FLOOR {
        refuse(
            error::BELOW_DUST,
            &format!(
                "{} sats is below the {DUST_FLOOR}-sat floor a top-up must reach",
                output.value
            ),
        );
    }
    (
        Topup {
            txid,
            vout,
            value: output.value,
            address,
        },
        args,
    )
}

/// The light client's argument for `proof`, refusing a hash that is not 32 bytes of hex.
pub fn inclusion_args(proof: &TopupProof) -> TxInclusionProof {
    TxInclusionProof {
        tx_id: hash(&proof.tx_id),
        tx_block_blockhash: hash(&proof.tx_block_blockhash),
        tx_index: proof.tx_index,
        merkle_proof: proof.merkle_proof.iter().map(|h| hash(h)).collect(),
        coinbase_tx_id: hash(&proof.coinbase_tx_id),
        coinbase_merkle_proof: proof
            .coinbase_merkle_proof
            .iter()
            .map(|h| hash(h))
            .collect(),
    }
}

/// Refuses a transaction index that does not fit its merkle proof.
pub fn check_index(args: &TxInclusionProof) {
    // Index 0 is the coinbase's place, and a proof of `n` hashes holds 2^n places. No block
    // holds 2^32 transactions, which also keeps the shift in range.
    let depth = args.merkle_proof.len();
    if args.tx_index == 0 || depth > MAX_PROOF_DEPTH || args.tx_index >> depth != 0 {
        refuse(
            error::BAD_TX_INDEX,
            "the transaction's index does not fit its merkle proof",
        );
    }
}

/// A display-hex hash in internal byte order.
fn hash(display_hex: &str) -> [u8; 32] {
    crate::hex::decode(display_hex)
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .map(|mut bytes| {
            bytes.reverse();
            bytes
        })
        .unwrap_or_else(|| {
            refuse(
                error::INVALID_PROOF,
                "every hash in the proof must be 64 hex characters",
            )
        })
}
