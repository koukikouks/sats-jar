//! Allowance helpers: funded jars, payment requests, and payments broadcast, mined and proven
//! on regtest.

use super::{block_of, topup_proof, Jars};
use bitcoin::{Address, Network, ScriptBuf, Transaction};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, to_hex, Regtest};

/// The cap of every jar `funded_jar` makes, in sats.
pub const CAP: u64 = 20_000;

/// A jar on regtest whose child address is a Core wallet address.
pub struct RegtestJar {
    pub id: String,
    pub child: String,
    pub address: String,
}

impl RegtestJar {
    pub fn child_script(&self) -> ScriptBuf {
        script(&self.child)
    }

    pub fn jar_script(&self) -> ScriptBuf {
        script(&self.address)
    }
}

pub fn script(address: &str) -> ScriptBuf {
    address
        .parse::<Address<_>>()
        .unwrap()
        .require_network(Network::Regtest)
        .unwrap()
        .script_pubkey()
}

/// Bitcoin Core's `testmempoolaccept` entry for `raw` (allowed, vsize, fees).
pub fn core_verdict(regtest: &Regtest, raw: &[u8]) -> Value {
    regtest.rpc("testmempoolaccept", &[json!([to_hex(raw)])])[0].clone()
}

pub fn decode(raw: &[u8]) -> Transaction {
    bitcoin::consensus::deserialize(raw).expect("a Bitcoin transaction")
}

impl Jars {
    /// A jar with a 20,000-sat cap, a 30-day period and one proven top-up per entry in `coins`.
    pub async fn funded_jar(&self, regtest: &Regtest, coins: &[u64]) -> RegtestJar {
        let args = self.valid_args(&regtest.new_address()).await;
        self.funded_jar_with(regtest, args, coins).await
    }

    pub async fn funded_jar_with(
        &self,
        regtest: &Regtest,
        args: Value,
        coins: &[u64],
    ) -> RegtestJar {
        let child = args["child_address"].as_str().unwrap().to_owned();
        let id: String = self.create_jar(&args).await.json().expect("jar id");
        let address = self.get_jar(&id).await["address"]
            .as_str()
            .unwrap()
            .to_owned();
        for &sats in coins {
            let topup = self.confirmed_topup(regtest, &address, sats).await;
            self.prove(&self.giver, &id, &topup)
                .await
                .into_result()
                .expect("top-up proven");
        }
        RegtestJar { id, child, address }
    }

    /// `request_allowance` from the giver with 300 Tgas.
    pub async fn request_allowance(&self, jar_id: &str, fee_rate: u64) -> ExecutionFinalResult {
        self.request_allowance_with_gas(jar_id, fee_rate, Gas::from_tgas(300))
            .await
    }

    pub async fn request_allowance_with_gas(
        &self,
        jar_id: &str,
        fee_rate: u64,
        gas: Gas,
    ) -> ExecutionFinalResult {
        self.giver
            .call(self.contract.id(), "request_allowance")
            .args_json(json!({ "jar_id": jar_id, "fee_rate": fee_rate.to_string() }))
            .gas(gas)
            .transact()
            .await
            .expect("send request_allowance")
    }

    /// Requests an allowance that must be signed, and returns its payment.
    pub async fn signed_allowance(&self, jar_id: &str, fee_rate: u64) -> Value {
        let result = self.request_allowance(jar_id, fee_rate).await;
        let id: String = result.json().expect("payment id");
        let payment = self.get_payment(&id).await;
        assert_eq!(payment["status"], "signed", "{payment}");
        payment
    }

    pub async fn get_payment(&self, payment_id: &str) -> Value {
        self.contract
            .view("get_payment")
            .args_json(json!({ "payment_id": payment_id }))
            .await
            .expect("get_payment")
            .json()
            .expect("json")
    }

    /// `confirm_payment` from the giver with 300 Tgas.
    pub async fn confirm_payment(&self, payment_id: &str, proof: &Value) -> ExecutionFinalResult {
        self.giver
            .call(self.contract.id(), "confirm_payment")
            .args_json(json!({ "payment_id": payment_id, "proof": proof }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("send confirm_payment")
    }

    /// Broadcasts a signed payment, gives it three confirmations, registers its block in the
    /// light-client stand-in and returns its proof.
    pub async fn mine_payment(&self, regtest: &Regtest, payment: &Value) -> Value {
        let raw = from_hex(payment["signed_tx"].as_str().unwrap());
        let txid = regtest.rpc("sendrawtransaction", &[json!(to_hex(&raw))]);
        let txid = txid.as_str().unwrap();
        regtest.mine(3);
        // The payment pays the child, a wallet address, so the wallet knows its block.
        let block = block_of(regtest, txid);
        let tip = regtest.rpc("getblockcount", &[]).as_u64().unwrap();
        self.register_block(regtest, &block, tip).await;
        topup_proof(regtest, &block, txid)
    }
}
