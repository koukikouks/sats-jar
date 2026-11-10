//! Handover helpers: a family of real sandbox accounts, demo-timing jars, and the claim,
//! confirm and cancel calls (each with 1 yoctoNEAR, as a full-access key sends them).

use super::{child_address, new_account, Jars, RegtestJar};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use test_support::serde_json::{json, Value};
use test_support::Regtest;

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
    /// The family account a parent manages, which holds the jar until handover.
    pub parent: Account,
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
            parent: new_account(&self.worker, "parent").await,
            child: new_account(&self.worker, "child").await,
            stranger: new_account(&self.worker, "stranger").await,
        }
    }

    /// Create args for a demo-timing jar (60-second period) held by `family`'s parent account,
    /// guarded by its three guardians, paying `child_address`, unlocking in a year.
    pub async fn demo_args(&self, family: &Family, child_address: &str) -> Value {
        let mut args = self.valid_args(child_address).await;
        args["period"] = json!("60");
        args["guardians"] = json!(family
            .guardians
            .iter()
            .map(|g| g.id().to_string())
            .collect::<Vec<_>>());
        args["family_account"] = json!(family.parent.id());
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

impl Jars {
    /// A demo-timing jar on regtest unlocking in 4 minutes, with one proven top-up per entry in
    /// `coins`, claimed by `family.child` with T07's key and confirmed by two guardians; returns
    /// once the public delay and the unlock date have both passed.
    pub async fn due_handover(
        &self,
        regtest: &Regtest,
        family: &Family,
        coins: &[u64],
    ) -> RegtestJar {
        let mut args = self.demo_args(family, &regtest.new_address()).await;
        let unlock_at = super::now(&self.worker).await + 240;
        args["unlock_at"] = json!(unlock_at.to_string());
        let jar = self.funded_jar_with(regtest, args, coins).await;
        self.confirmed_claim(family, &jar.id).await;
        let delay_ends_at: u64 = self.handover(&jar.id).await["confirmed"]["delay_ends_at"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        self.wait_until(delay_ends_at.max(unlock_at)).await;
        jar
    }

    /// `complete_handover` from `caller` with 300 Tgas.
    pub async fn complete_handover(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
    ) -> ExecutionFinalResult {
        self.complete_handover_with_gas(caller, jar_id, fee_rate, Gas::from_tgas(300))
            .await
    }

    pub async fn complete_handover_with_gas(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
        gas: Gas,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "complete_handover")
            .args_json(json!({ "jar_id": jar_id, "fee_rate": fee_rate.to_string() }))
            .gas(gas)
            .transact()
            .await
            .expect("send complete_handover")
    }

    /// Completes the handover's next re-homing payment from the stranger and returns it signed.
    pub async fn signed_rehoming(&self, family: &Family, jar_id: &str, fee_rate: u64) -> Value {
        let result = self
            .complete_handover(&family.stranger, jar_id, fee_rate)
            .await;
        let id: String = result.json().expect("payment id");
        let payment = self.get_payment(&id).await;
        assert_eq!(payment["status"], "signed", "{payment}");
        payment
    }

    /// Broadcasts, mines and confirms a signed payment.
    pub async fn confirmed(&self, regtest: &Regtest, payment: &Value) -> ExecutionFinalResult {
        let proof = self.mine_payment(regtest, payment).await;
        self.confirm_payment(payment["payment_id"].as_str().unwrap(), &proof)
            .await
    }
}

impl Jars {
    /// `request_spend` from `caller` of 5,000 sats to a regtest address at 1 sat/vB, with
    /// 1 yoctoNEAR and 300 Tgas.
    pub async fn request_spend(&self, caller: &Account, jar_id: &str) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "request_spend")
            .args_json(json!({
                "jar_id": jar_id,
                "to": child_address(bitcoin::Network::Regtest),
                "amount": "5000",
                "fee_rate": "1",
            }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("send request_spend")
    }
}
