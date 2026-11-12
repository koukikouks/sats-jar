//! Pure Bitcoin logic for the jar contract: parse, build, BIP-143, witness, address, script.
//! Hand-rolled because the `bitcoin` crate's secp256k1 C imports break the contract at runtime.

mod address;
mod error;
mod hash;
mod script;
mod tx;
mod witness;

pub use address::{Network, SegwitAddress};
pub use error::BtcError;
pub use script::jar_script;
pub use tx::{OutPoint, Transaction, TxIn, TxOut};
pub use witness::jar_witness;
