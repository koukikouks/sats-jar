//! The signing callback after the inputs are reserved: a failed or wrong signature is recorded
//! as a retryable failure (never a rollback), and extra attached gas reaches the signer.

mod common;

use common::*;
use test_support::serde_json::json;
use test_support::Regtest;

#[tokio::test]
async fn a_failed_signing_keeps_the_inputs_reserved_and_the_period_paid() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000, 50_000]).await;
    jars.signer_mode("fail").await;

    let result = jars.request_allowance(&jar.id, 1).await;

    // The request itself succeeds: the failure is recorded, nothing is rolled back.
    let id: String = result.into_result().unwrap().json().unwrap();
    let payment = jars.get_payment(&id).await;
    assert_eq!(payment["status"], "signing_failed");
    assert!(payment["failure"]
        .as_str()
        .unwrap()
        .contains("sign request 0 failed"));
    assert_eq!(payment["signed_tx"], json!(null));
    let coins = jars.get_coins(&jar.id).await;
    let reserved: Vec<_> = coins
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["status"] == "reserved")
        .collect();
    assert_eq!(reserved.len(), 1);
    assert_eq!(reserved[0]["payment_id"], id);
    let again = jars.request_allowance(&jar.id, 1).await;
    assert!(refusal(&again).contains("ALREADY_PAID: "));
}

#[tokio::test]
async fn a_signature_by_another_key_is_rejected_by_ecrecover() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    jars.signer_mode("wrong_key").await;

    let result = jars.request_allowance(&jar.id, 1).await;

    let id: String = result.into_result().unwrap().json().unwrap();
    let payment = jars.get_payment(&id).await;
    assert_eq!(payment["status"], "signing_failed");
    assert!(payment["failure"]
        .as_str()
        .unwrap()
        .contains("is not the jar key's signature"));
    assert_eq!(jars.get_coins(&jar.id).await[0]["status"], "reserved");
}

#[tokio::test]
async fn extra_attached_gas_reaches_the_signer_when_its_floor_rises() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[6_000, 12_000, 9_000]).await;
    // As if the MPC network voted its floor up from 15 to 25 Tgas after the locked deploy.
    jars.signer
        .call("set_min_gas")
        .args_json(json!({ "tgas": 25 }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = test_support::from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}
