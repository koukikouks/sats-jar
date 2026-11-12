//! Callbacks only move a payment forward: a duplicate confirmation never counts twice. (Late
//! signing answers are covered in `retry_signing.rs`.)

mod common;

use common::*;
use near_workspaces::types::Gas;
use test_support::serde_json::json;
use test_support::Regtest;

#[tokio::test]
async fn two_proofs_of_one_payment_sent_together_confirm_it_once() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let id = payment["payment_id"].as_str().unwrap();
    let proof = jars.mine_payment(&regtest, &payment).await;
    let other = new_account(&jars.worker, "keeper").await;

    let send = |account: &near_workspaces::Account| {
        account
            .call(jars.contract.id(), "confirm_payment")
            .args_json(json!({ "payment_id": id, "proof": proof }))
            .gas(Gas::from_tgas(300))
            .transact_async()
    };
    let a = send(&jars.giver).await.unwrap();
    let b = send(&other).await.unwrap();
    let results = [a.await.unwrap(), b.await.unwrap()];

    assert_eq!(results.iter().filter(|r| r.is_success()).count(), 1);
    let refused = results.iter().find(|r| r.is_failure()).unwrap();
    assert!(refusal(refused).contains("PAYMENT_ALREADY_CONFIRMED: "));
    let (_, change) = paid(&payment);
    let coins = jars.get_coins(&jar.id).await;
    assert_eq!(coins.as_array().unwrap().len(), 2);
    assert_eq!(
        jars.get_jar(&jar.id).await["proven_balance"],
        change.to_string()
    );
    assert_eq!(jars.get_payment(id).await["status"], "confirmed");
}
