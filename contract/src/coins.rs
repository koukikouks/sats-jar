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

/// Each input is reserved by exactly one payment until that payment is confirmed (ADR 0006).
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoinStatus {
    /// Proven and free to spend.
    Confirmed,
    /// An input of this payment, which is not yet proven on Bitcoin.
    Reserved(u64),
    /// Spent by this payment, proven on Bitcoin.
    Spent(u64),
}

#[near(serializers = [json])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoinStatusView {
    Confirmed,
    Reserved,
    Spent,
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
    pub status: CoinStatusView,
    /// The payment that reserved or spent the coin.
    pub payment_id: Option<U64>,
}

impl Coin {
    pub fn view(&self) -> CoinView {
        let (status, payment_id) = match self.status {
            CoinStatus::Confirmed => (CoinStatusView::Confirmed, None),
            CoinStatus::Reserved(id) => (CoinStatusView::Reserved, Some(U64(id))),
            CoinStatus::Spent(id) => (CoinStatusView::Spent, Some(U64(id))),
        };
        CoinView {
            txid: crate::hex::display(&self.txid),
            vout: self.vout,
            value: U64(self.value),
            status,
            payment_id,
        }
    }
}
