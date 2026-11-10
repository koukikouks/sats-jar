//! Stray helpers: a jar whose handover is done, and `rehome_stray`.

use super::{Family, Jars, RegtestJar, RegtestTopup};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use near_workspaces::Account;
use test_support::serde_json::{json, Value};
use test_support::{to_hex, Regtest};

impl Jars {
    /// A `due_handover` jar with one proven top-up per entry in `coins` (at most 10), whose
    /// re-homing is confirmed: the jar NFT is the child's, and `jar.address` is now old.
    pub async fn handed_over(
        &self,
        regtest: &Regtest,
        family: &Family,
        coins: &[u64],
    ) -> RegtestJar {
        let jar = self.due_handover(regtest, family, coins).await;
        let payment = self.signed_rehoming(family, &jar.id, 1).await;
        self.confirmed(regtest, &payment)
            .await
            .into_result()
            .expect("re-homing confirmed");
        jar
    }

    /// `rehome_stray` from `caller` with 300 Tgas.
    pub async fn rehome_stray(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
    ) -> ExecutionFinalResult {
        self.rehome_stray_with_gas(caller, jar_id, fee_rate, Gas::from_tgas(300))
            .await
    }

    pub async fn rehome_stray_with_gas(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
        gas: Gas,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "rehome_stray")
            .args_json(json!({ "jar_id": jar_id, "fee_rate": fee_rate.to_string() }))
            .gas(gas)
            .transact()
            .await
            .expect("send rehome_stray")
    }

    /// Sweeps the jar's strays from `caller` and returns the payment, signed.
    pub async fn signed_stray_rehoming(
        &self,
        caller: &Account,
        jar_id: &str,
        fee_rate: u64,
    ) -> Value {
        let result = self.rehome_stray(caller, jar_id, fee_rate).await;
        let id: String = result.json().expect("payment id");
        let payment = self.get_payment(&id).await;
        assert_eq!(payment["status"], "signed", "{payment}");
        payment
    }

    /// Proves a confirmed top-up of `sats` to `address` from the giver.
    pub async fn proven_topup(&self, regtest: &Regtest, jar_id: &str, address: &str, sats: u64) {
        let topup = self.confirmed_topup(regtest, address, sats).await;
        self.prove(&self.giver, jar_id, &topup)
            .await
            .into_result()
            .expect("top-up proven");
    }
}

impl Jars {
    /// The light-client stand-in's test control: hold every answer until `release_light_client`.
    pub async fn hold_light_client(&self, held: bool) {
        self.light_client
            .call("set_held")
            .args_json(json!({ "held": held }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("set_held");
    }

    /// Answers the light client's oldest held call.
    pub async fn release_light_client(&self) {
        self.light_client
            .call("release")
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("release");
    }

    /// Sends `prove_topup` of `topup` (300 Tgas) from the giver without waiting for it, and
    /// returns once the held light client has its call.
    pub async fn prove_in_flight(
        &self,
        jar_id: &str,
        topup: &RegtestTopup,
    ) -> near_workspaces::operations::TransactionStatus {
        let status = self
            .giver
            .call(self.contract.id(), "prove_topup")
            .args_json(json!({
                "jar_id": jar_id,
                "tx": to_hex(&topup.funding.raw_tx),
                "vout": topup.funding.vout,
                "proof": topup.proof,
            }))
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await
            .expect("send prove_topup");
        loop {
            let held = self
                .worker
                .view_state(self.light_client.id())
                .prefix(b"waiting")
                .await
                .expect("light-client state");
            if held.get(&b"waiting"[..]).is_some_and(|ids| !ids.is_empty()) {
                return status;
            }
            self.worker.fast_forward(1).await.expect("fast_forward");
        }
    }
}
