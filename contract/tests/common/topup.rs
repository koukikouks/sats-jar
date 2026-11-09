//! Top-up helpers: regtest blocks registered in the light-client stand-in, and proofs built
//! from Bitcoin Core's own block contents.

use super::Jars;
use bitcoin::hashes::{sha256d, Hash};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::Account;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, to_hex, txid_to_display, Funding, Regtest};

/// A regtest payment to a jar address with three confirmations, its block registered in the
/// light-client stand-in, and its proof.
pub struct RegtestTopup {
    pub funding: Funding,
    /// Display hex.
    pub txid: String,
    pub block: String,
    pub proof: Value,
}

/// The block a wallet transaction confirmed in (display hex).
pub fn block_of(regtest: &Regtest, txid: &str) -> String {
    regtest.rpc("gettransaction", &[json!(txid)])["blockhash"]
        .as_str()
        .expect("a confirmed wallet transaction")
        .to_owned()
}

/// A `prove_topup` proof for `txid` (display hex) in `blockhash`, built from Core's list of the
/// block's transactions the way the light client's `merkle_proof_calculator` does.
pub fn topup_proof(regtest: &Regtest, blockhash: &str, txid: &str) -> Value {
    let block = regtest.rpc("getblock", &[json!(blockhash), json!(1)]);
    let txids: Vec<String> = block["tx"]
        .as_array()
        .expect("tx list")
        .iter()
        .map(|t| t.as_str().unwrap().to_owned())
        .collect();
    let index = txids.iter().position(|t| t == txid).expect("tx in block");
    let leaves: Vec<[u8; 32]> = txids.iter().map(|t| internal(t)).collect();
    json!({
        "tx_id": txid,
        "tx_block_blockhash": blockhash,
        "tx_index": index,
        "merkle_proof": merkle_proof(&leaves, index).iter().map(display).collect::<Vec<_>>(),
        "coinbase_tx_id": txids[0],
        "coinbase_merkle_proof": merkle_proof(&leaves, 0).iter().map(display).collect::<Vec<_>>(),
    })
}

/// Light client `merkle-tools::merkle_proof_calculator`: duplicate the last hash on odd levels,
/// push the sibling at each level.
pub fn merkle_proof(leaves: &[[u8; 32]], mut position: usize) -> Vec<[u8; 32]> {
    let mut proof = Vec::new();
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        if level.len() % 2 == 1 {
            level.push(*level.last().unwrap());
        }
        proof.push(if position % 2 == 1 {
            level[position - 1]
        } else {
            level[position + 1]
        });
        level = level
            .chunks(2)
            .map(|pair| sha256d::Hash::hash(&[pair[0], pair[1]].concat()).to_byte_array())
            .collect();
        position /= 2;
    }
    proof
}

/// Display hex (as Core prints hashes) to internal byte order.
pub fn internal(display_hex: &str) -> [u8; 32] {
    let mut bytes: [u8; 32] = from_hex(display_hex).try_into().expect("32 bytes");
    bytes.reverse();
    bytes
}

pub fn display(internal: &[u8; 32]) -> String {
    let mut bytes = *internal;
    bytes.reverse();
    to_hex(&bytes)
}

impl Jars {
    /// Pays `sats` to `address` on regtest, confirms it three times and registers its block
    /// (tip = Core's height).
    pub async fn confirmed_topup(
        &self,
        regtest: &Regtest,
        address: &str,
        sats: u64,
    ) -> RegtestTopup {
        let funding = regtest.fund(address, sats);
        regtest.mine(2);
        let txid = txid_to_display(&funding.txid);
        let block = block_of(regtest, &txid);
        let tip = regtest.rpc("getblockcount", &[]).as_u64().unwrap();
        self.register_block(regtest, &block, tip).await;
        let proof = topup_proof(regtest, &block, &txid);
        RegtestTopup {
            funding,
            txid,
            block,
            proof,
        }
    }

    /// Proves `topup` for `jar_id` from `caller` with 300 Tgas.
    pub async fn prove(
        &self,
        caller: &Account,
        jar_id: &str,
        topup: &RegtestTopup,
    ) -> ExecutionFinalResult {
        self.prove_topup(
            caller,
            jar_id,
            &topup.funding.raw_tx,
            topup.funding.vout,
            &topup.proof,
        )
        .await
    }

    /// Registers Core's block `blockhash` (height and merkle root) in the light-client stand-in
    /// and sets the stand-in's tip to `tip`.
    pub async fn register_block(&self, regtest: &Regtest, blockhash: &str, tip: u64) {
        let header = regtest.rpc("getblockheader", &[json!(blockhash)]);
        self.light_client
            .call("add_block")
            .args_json(json!({
                "blockhash": blockhash,
                "height": header["height"],
                "merkle_root": header["merkleroot"],
            }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("add_block");
        self.set_tip(tip).await;
    }

    pub async fn set_tip(&self, height: u64) {
        self.light_client
            .call("set_tip")
            .args_json(json!({ "height": height }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("set_tip");
    }

    pub async fn set_paused(&self, paused: bool) {
        self.light_client
            .call("set_paused")
            .args_json(json!({ "paused": paused }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("set_paused");
    }

    /// `prove_topup` from `caller` with 300 Tgas.
    pub async fn prove_topup(
        &self,
        caller: &Account,
        jar_id: &str,
        raw_tx: &[u8],
        vout: u32,
        proof: &Value,
    ) -> ExecutionFinalResult {
        self.prove_topup_with_gas(caller, jar_id, raw_tx, vout, proof, Gas::from_tgas(300))
            .await
    }

    pub async fn prove_topup_with_gas(
        &self,
        caller: &Account,
        jar_id: &str,
        raw_tx: &[u8],
        vout: u32,
        proof: &Value,
        gas: Gas,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "prove_topup")
            .args_json(json!({
                "jar_id": jar_id,
                "tx": to_hex(raw_tx),
                "vout": vout,
                "proof": proof,
            }))
            .gas(gas)
            .transact()
            .await
            .expect("send prove_topup")
    }

    pub async fn get_coins(&self, jar_id: &str) -> Value {
        self.contract
            .view("get_coins")
            .args_json(json!({ "jar_id": jar_id }))
            .await
            .expect("get_coins")
            .json()
            .expect("json")
    }
}
