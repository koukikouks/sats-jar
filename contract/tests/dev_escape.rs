//! The dev-only escape exists only in builds with the `dev-escape` feature (ADR 0008).

mod common;

use common::*;
use near_workspaces::Contract;
use test_support::serde_json::json;
use test_support::Regtest;

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

    let by_contract = cancel_payment_as_contract(&jars.contract).await;
    assert!(refusal(&by_contract).contains("UNKNOWN_PAYMENT: "));
}

#[tokio::test]
async fn cancelling_a_payment_frees_its_coins_for_the_next_allowance() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Dev, "regtest").await;
    let mut args = jars.valid_args(&regtest.new_address()).await;
    args["period"] = json!("60");
    let jar = jars.funded_jar_with(&regtest, args, &[50_000]).await;
    let set_mode = |mode: &'static str| {
        jars.signer
            .call("set_mode")
            .args_json(json!({ "mode": mode }))
            .transact()
    };
    set_mode("fail").await.unwrap().into_result().unwrap();
    jars.request_allowance(&jar.id, 1)
        .await
        .into_result()
        .unwrap();
    let topup = jars.confirmed_topup(&regtest, &jar.address, 5_000).await;

    cancel_payment_as_contract(&jars.contract)
        .await
        .into_result()
        .unwrap();

    assert_eq!(jars.get_payment("1").await["status"], "cancelled");
    let events = jars.history_events(&jar.id).await;
    assert_eq!(events.last().unwrap(), "payment_cancelled");
    let coin = &jars.get_coins(&jar.id).await[0];
    assert_eq!(coin["status"], "confirmed");
    assert_eq!(coin["payment_id"], json!(null));
    let confirm = jars.confirm_payment("1", &topup.proof).await;
    assert!(refusal(&confirm).contains("PAYMENT_CANCELLED: "));
    // The period stays paid; the next one can spend the freed coin.
    let start = now(&jars.worker).await;
    while now(&jars.worker).await < start + 61 {
        jars.worker.fast_forward(100).await.unwrap();
    }
    set_mode("sign").await.unwrap().into_result().unwrap();
    let payment = jars.signed_allowance(&jar.id, 1).await;
    assert_eq!(payment["inputs"][0]["value"], "50000");
}

#[tokio::test]
async fn a_confirmed_payment_cannot_be_cancelled() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Dev, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let proof = jars.mine_payment(&regtest, &payment).await;
    jars.confirm_payment("1", &proof)
        .await
        .into_result()
        .unwrap();

    let result = cancel_payment_as_contract(&jars.contract).await;

    assert!(refusal(&result).contains("PAYMENT_ALREADY_CONFIRMED: "));
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
