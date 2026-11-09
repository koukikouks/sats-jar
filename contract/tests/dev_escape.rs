//! The dev-only escape exists only in builds with the `dev-escape` feature (ADR 0008).

mod common;

use common::*;
use near_workspaces::Contract;
use test_support::serde_json::json;

async fn cancel_payment_as_contract(
    contract: &Contract,
) -> near_workspaces::result::ExecutionFinalResult {
    contract
        .call("dev_cancel_payment")
        .args_json(json!({ "payment_id": "1" }))
        .transact()
        .await
        .unwrap()
}

#[tokio::test]
async fn the_locked_build_has_no_dev_escape() {
    let jars = deploy(Build::Locked).await;
    init(&jars.contract, "regtest").await.into_result().unwrap();

    let result = cancel_payment_as_contract(&jars.contract).await;

    assert!(refusal(&result).contains("MethodNotFound"));
}

#[tokio::test]
async fn the_dev_build_has_the_escape_for_the_contract_account_only() {
    let jars = deploy(Build::Dev).await;
    init(&jars.contract, "regtest").await.into_result().unwrap();

    let by_giver = jars
        .giver
        .call(jars.contract.id(), "dev_cancel_payment")
        .args_json(json!({ "payment_id": "1" }))
        .transact()
        .await
        .unwrap();
    assert!(refusal(&by_giver).contains("is private"));

    // Payments arrive in T04; until then every payment id is unknown.
    let by_contract = cancel_payment_as_contract(&jars.contract).await;
    assert!(refusal(&by_contract).contains("UNKNOWN_PAYMENT: "));
}

/// Run by hand against the reproducible build's output (it needs Docker, so it is not part of
/// `cargo test`): `REPRODUCIBLE_WASM=path/to/sats_jar.wasm cargo test -p sats-jar --test
/// dev_escape -- --ignored`.
#[tokio::test]
#[ignore = "needs the reproducible build's wasm in REPRODUCIBLE_WASM"]
async fn the_reproducible_build_has_no_dev_escape() {
    let wasm = std::fs::read(std::env::var("REPRODUCIBLE_WASM").unwrap()).unwrap();
    let worker = near_workspaces::sandbox().await.unwrap();
    let contract = worker.dev_deploy(&wasm).await.unwrap();
    init(&contract, "testnet").await.into_result().unwrap();

    let result = cancel_payment_as_contract(&contract).await;

    assert!(refusal(&result).contains("MethodNotFound"));
}
