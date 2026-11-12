//! Regtest harness shared by every Rust test suite: a fresh Bitcoin Core regtest node per
//! `Regtest`, driven over JSON-RPC with plain bytes and strings so callers need no Bitcoin library.
//! Bitcoin Core is downloaded at build time by the `bitcoind` crate (stack notes §6).

pub use bitcoind::serde_json;
use serde_json::{json, Value};

/// One running regtest node with a funded wallet. The node stops when this is dropped.
pub struct Regtest {
    node: bitcoind::BitcoinD,
    miner: String,
}

/// A confirmed output paying the funded address.
#[derive(Debug, Clone)]
pub struct Funding {
    /// Internal byte order (Core shows txids reversed).
    pub txid: [u8; 32],
    pub vout: u32,
    pub value: u64,
    /// The whole funding transaction as Core serialised it.
    pub raw_tx: Vec<u8>,
}

impl Regtest {
    /// Starts a node and mines 101 blocks so the wallet has a spendable coinbase.
    pub fn start() -> Regtest {
        let node = bitcoind::BitcoinD::from_downloaded().expect("start bitcoind regtest");
        let mut regtest = Regtest {
            node,
            miner: String::new(),
        };
        regtest.miner = regtest.new_address();
        regtest.mine(101);
        regtest
    }

    /// Any RPC, for what the helpers below do not cover.
    pub fn rpc(&self, method: &str, args: &[Value]) -> Value {
        self.node
            .client
            .call::<Value>(method, args)
            .unwrap_or_else(|e| panic!("{method} failed: {e}"))
    }

    pub fn new_address(&self) -> String {
        self.rpc("getnewaddress", &[json!(""), json!("bech32")])
            .as_str()
            .expect("address string")
            .to_owned()
    }

    pub fn mine(&self, blocks: u32) {
        self.rpc("generatetoaddress", &[json!(blocks), json!(self.miner)]);
    }

    /// Sends `sats` from the wallet to `address` and confirms it in one block.
    pub fn fund(&self, address: &str, sats: u64) -> Funding {
        let txid_hex = self.rpc("sendtoaddress", &[json!(address), json!(btc_amount(sats))]);
        let txid_hex = txid_hex.as_str().expect("txid");
        let tx = self.rpc("getrawtransaction", &[json!(txid_hex), json!(true)]);
        let vout = tx["vout"]
            .as_array()
            .expect("vout")
            .iter()
            .find(|o| o["scriptPubKey"]["address"] == json!(address))
            .and_then(|o| o["n"].as_u64())
            .expect("an output paying the address") as u32;
        self.mine(1);
        Funding {
            txid: txid_from_display(txid_hex),
            vout,
            value: sats,
            raw_tx: from_hex(tx["hex"].as_str().expect("hex")),
        }
    }

    /// Sets the node's clock to `unix` seconds and mines 11 blocks at that time, so the median
    /// time past (what time locks are checked against, BIP-113) reaches it. A transaction with
    /// lock time `t` is final once this is called with at least `t + 1`. Only move time forward.
    pub fn set_mock_time(&self, unix: u32) {
        self.rpc("setmocktime", &[json!(unix)]);
        self.mine(11);
    }

    /// Bitcoin Core's verdict on a signed transaction: `Ok` if it would enter the mempool,
    /// otherwise the reject reason.
    pub fn test_mempool_accept(&self, raw_tx: &[u8]) -> Result<(), String> {
        let result = self.rpc("testmempoolaccept", &[json!([to_hex(raw_tx)])]);
        let verdict = &result[0];
        if verdict["allowed"] == json!(true) {
            Ok(())
        } else {
            Err(verdict["reject-reason"].as_str().unwrap_or("").to_owned())
        }
    }
}

/// Converts a JSON BTC amount (as Core prints it) to sats without floating-point arithmetic.
pub fn sats(amount: &Value) -> u64 {
    let text = amount.to_string();
    let (whole, frac) = text.split_once('.').unwrap_or((&text, ""));
    let frac = format!("{frac:0<8}");
    whole.parse::<u64>().expect("whole BTC") * 100_000_000 + frac.parse::<u64>().expect("sats")
}

/// The txid as Core and explorers print it (reversed internal order).
pub fn txid_to_display(txid: &[u8; 32]) -> String {
    let mut reversed = *txid;
    reversed.reverse();
    to_hex(&reversed)
}

fn txid_from_display(display: &str) -> [u8; 32] {
    let mut txid: [u8; 32] = from_hex(display).try_into().expect("32-byte txid");
    txid.reverse();
    txid
}

fn btc_amount(sats: u64) -> String {
    format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000)
}

pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn from_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}
