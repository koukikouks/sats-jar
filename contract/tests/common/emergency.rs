//! Emergency payment helpers: propose, approve and cancel (each with 1 yoctoNEAR, as a
//! full-access key sends them) and execute (anyone, no deposit).

use super::{Family, Jars};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use test_support::serde_json::{json, Value};

/// Demo timing off mainnet: the emergency payment's public delay, in seconds (30 days become
/// 30 minutes).
pub const DEMO_EMERGENCY_DELAY: u64 = 30 * 60;

fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}

impl Jars {
    pub async fn propose(
        &self,
        guardian: &Account,
        jar_id: &str,
        amount: u64,
    ) -> ExecutionFinalResult {
        self.propose_with_deposit(guardian, jar_id, amount, one_yocto())
            .await
    }

    pub async fn propose_with_deposit(
        &self,
        guardian: &Account,
        jar_id: &str,
        amount: u64,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        guardian
            .call(self.contract.id(), "propose_emergency")
            .args_json(json!({ "jar_id": jar_id, "amount": amount.to_string() }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send propose_emergency")
    }

    pub async fn approve(
        &self,
        guardian: &Account,
        jar_id: &str,
        proposal_id: u32,
    ) -> ExecutionFinalResult {
        self.approve_with_deposit(guardian, jar_id, proposal_id, one_yocto())
            .await
    }

    pub async fn approve_with_deposit(
        &self,
        guardian: &Account,
        jar_id: &str,
        proposal_id: u32,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        guardian
            .call(self.contract.id(), "approve_emergency")
            .args_json(json!({ "jar_id": jar_id, "proposal_id": proposal_id }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send approve_emergency")
    }

    pub async fn cancel_emergency(&self, caller: &Account, jar_id: &str) -> ExecutionFinalResult {
        self.cancel_emergency_with_deposit(caller, jar_id, one_yocto())
            .await
    }

    pub async fn cancel_emergency_with_deposit(
        &self,
        caller: &Account,
        jar_id: &str,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "cancel_emergency")
            .args_json(json!({ "jar_id": jar_id }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send cancel_emergency")
    }

    /// `execute_emergency` from `caller` with 300 Tgas.
    pub async fn execute(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "execute_emergency")
            .args_json(json!({ "jar_id": jar_id, "fee_rate": fee_rate.to_string() }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("send execute_emergency")
    }

    pub async fn emergency(&self, jar_id: &str) -> Value {
        self.get_jar(jar_id).await["emergency"].clone()
    }

    /// The first guardian proposes `amount`, the second approves: the public delay is running.
    /// Returns the proposal id.
    pub async fn approved_emergency(&self, family: &Family, jar_id: &str, amount: u64) -> u32 {
        let id: u32 = self
            .propose(&family.guardians[0], jar_id, amount)
            .await
            .json()
            .expect("proposal id");
        self.approve(&family.guardians[1], jar_id, id)
            .await
            .into_result()
            .expect("approved");
        id
    }

    /// When the open proposal's public delay ends (unix seconds).
    pub async fn emergency_delay_ends_at(&self, jar_id: &str) -> u64 {
        self.emergency(jar_id).await["open"]["delay_ends_at"]
            .as_str()
            .expect("delay running")
            .parse()
            .unwrap()
    }
}
