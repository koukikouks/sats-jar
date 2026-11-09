//! A jar's proven coins. A coin is never deleted, and every outpoint ever counted stays in the
//! contract's seen set, because the light client proves inclusion, not that a coin is unspent.

use near_sdk::json_types::U64;
use near_sdk::near;

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Coin {
    /// Internal byte order.
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
    /// Which of the jar's addresses the coin sits at (0 is the address made at creation);
    /// a coin at an old address keeps that address's own script.
    pub address: u32,
    pub status: CoinStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoinStatus {
    /// Proven and free to spend. Payments (T04) add reserved and spent.
    Confirmed,
}

/// The key of a coin in the seen set: txid (internal order) then vout, little-endian.
pub type OutPointKey = [u8; 36];

pub fn outpoint_key(txid: &[u8; 32], vout: u32) -> OutPointKey {
    let mut key = [0u8; 36];
    key[..32].copy_from_slice(txid);
    key[32..].copy_from_slice(&vout.to_le_bytes());
    key
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct CoinView {
    /// Display hex, as explorers show it.
    pub txid: String,
    pub vout: u32,
    /// Sats.
    pub value: U64,
    pub status: CoinStatus,
}

impl Coin {
    pub fn view(&self) -> CoinView {
        CoinView {
            txid: crate::hex::display(&self.txid),
            vout: self.vout,
            value: U64(self.value),
            status: self.status,
        }
    }
}
