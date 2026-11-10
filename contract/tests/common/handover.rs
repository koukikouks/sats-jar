//! Handover helpers: a family of real sandbox accounts, demo-timing jars, and the claim,
//! confirm and cancel calls (each with 1 yoctoNEAR, as a full-access key sends them).

use super::{child_address, new_account, Jars};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use test_support::serde_json::{json, Value};

/// T07's BIP-84 testnet key for the public test phrase "abandon x11 about" (m/84'/1'/0'/0/0),
/// compressed, as the child's phone would send it.
pub const CHILD_BTC_KEY: &str =
    "02e7ab2537b5d49e970309aae06e9e49f36ce1c9febbd44ec8e0d1cca0b4f9c319";

/// Demo timing off mainnet: the public delay and the lapse of an unconfirmed claim, in seconds.
pub const DEMO_DELAY: u64 = 3 * 60;
pub const DEMO_LAPSE: u64 = 7 * 60;

/// Everyone a handover involves, as real accounts that can sign.
pub struct Family {
    pub guardians: Vec<Account>,
    pub child: Account,
    pub stranger: Account,
}

impl Jars {
    pub async fn family(&self) -> Family {
        let mut guardians = Vec::new();
        for name in ["grandma", "uncle", "aunt"] {
            guardians.push(new_account(&self.worker, name).await);
        }
        Family {
            guardians,
            child: new_account(&self.worker, "child").await,
            stranger: new_account(&self.worker, "stranger").await,
        }
    }

    /// Create args for a demo-timing jar (60-second period) guarded by `family`'s three
    /// guardians, paying `child_address`, unlocking in a year.
    pub async fn demo_args(&self, family: &Family, child_address: &str) -> Value {
        let mut args = self.valid_args(child_address).await;
        args["period"] = json!("60");
        args["guardians"] = json!(family
            .guardians
            .iter()
            .map(|g| g.id().to_string())
            .collect::<Vec<_>>());
        args
    }

    /// An unfunded demo-timing jar guarded by `family`; returns its id.
    pub async fn demo_jar(&self, family: &Family) -> String {
        let args = self
            .demo_args(family, &child_address(bitcoin::Network::Regtest))
            .await;
        self.create_jar(&args).await.json().expect("jar id")
    }

    /// `claim_handover` from `caller`, naming `caller` as the child's account.
    pub async fn claim(&self, caller: &Account, jar_id: &str, key: &str) -> ExecutionFinalResult {
        self.claim_as(caller, jar_id, caller, key, NearToken::from_yoctonear(1))
            .await
    }

    pub async fn claim_as(
        &self,
        caller: &Account,
        jar_id: &str,
        child_account: &Account,
        key: &str,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "claim_handover")
            .args_json(json!({
                "jar_id": jar_id,
                "child_account": child_account.id(),
                "child_btc_pubkey": key,
            }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send claim_handover")
    }

    /// `confirm_handover` from `guardian`, naming the account whose code they checked.
    pub async fn confirm(
        &self,
        guardian: &Account,
        jar_id: &str,
        child_account: &Account,
    ) -> ExecutionFinalResult {
        self.confirm_with_deposit(
            guardian,
            jar_id,
            child_account,
            NearToken::from_yoctonear(1),
        )
        .await
    }

    pub async fn confirm_with_deposit(
        &self,
        guardian: &Account,
        jar_id: &str,
        child_account: &Account,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        guardian
            .call(self.contract.id(), "confirm_handover")
            .args_json(json!({ "jar_id": jar_id, "child_account": child_account.id() }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send confirm_handover")
    }

    pub async fn cancel(&self, caller: &Account, jar_id: &str) -> ExecutionFinalResult {
        self.cancel_with_deposit(caller, jar_id, NearToken::from_yoctonear(1))
            .await
    }

    pub async fn cancel_with_deposit(
        &self,
        caller: &Account,
        jar_id: &str,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "cancel_handover")
            .args_json(json!({ "jar_id": jar_id }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send cancel_handover")
    }

    /// The child's claim, confirmed by the first two guardians: the public delay is running.
    pub async fn confirmed_claim(&self, family: &Family, jar_id: &str) {
        self.claim(&family.child, jar_id, CHILD_BTC_KEY)
            .await
            .into_result()
            .expect("claimed");
        for guardian in &family.guardians[..2] {
            self.confirm(guardian, jar_id, &family.child)
                .await
                .into_result()
                .expect("confirmed");
        }
    }

    pub async fn handover(&self, jar_id: &str) -> Value {
        self.get_jar(jar_id).await["handover"].clone()
    }

    /// Unix seconds of the block in which the call's contract code ran (its first receipt), read
    /// from the chain.
    pub async fn ran_at(&self, result: &ExecutionFinalResult) -> u64 {
        let hash = result.receipt_outcomes()[0].block_hash;
        self.worker
            .view_block()
            .block_hash(hash)
            .await
            .expect("block")
            .timestamp()
            / 1_000_000_000
    }
}

/// The `satsjar` events a call logged, as NEP-297 JSON.
pub fn satsjar_events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| test_support::serde_json::from_str::<Value>(json).unwrap())
        .filter(|event| event["standard"] == "satsjar")
        .collect()
}
