//! `confirm_payment` refusals: a payment is confirmed once, only by a proof of its own
//! transaction with enough confirmations.

mod common;

use common::*;
use test_support::Regtest;

#[tokio::test]
async fn an_unknown_payment_or_another_transaction_is_refused() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let id = payment["payment_id"].as_str().unwrap();
    let topup = jars.confirmed_topup(&regtest, &jar.address, 5_000).await;

    let unknown = jars.confirm_payment("99", &topup.proof).await;
    assert!(refusal(&unknown).contains("UNKNOWN_PAYMENT: "));
    let other_tx = jars.confirm_payment(id, &topup.proof).await;
    assert!(refusal(&other_tx).contains("PROOF_TX_MISMATCH: "));
}

#[tokio::test]
async fn a_payment_is_confirmed_once_and_only_with_enough_confirmations() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let id = payment["payment_id"].as_str().unwrap();
    let proof = jars.mine_payment(&regtest, &payment).await;
    let block = regtest.rpc("getblockheader", &[proof["tx_block_blockhash"].clone()])["height"]
        .as_u64()
        .unwrap();

    jars.set_tip(block).await;
    let shallow = jars.confirm_payment(id, &proof).await;
    assert!(refusal(&shallow).contains("NOT_CONFIRMED: 1 of 3 confirmations"));
    assert_eq!(jars.get_payment(id).await["status"], "signed");

    jars.set_tip(block + 2).await;
    jars.confirm_payment(id, &proof)
        .await
        .into_result()
        .unwrap();
    let again = jars.confirm_payment(id, &proof).await;
    assert!(refusal(&again).contains("PAYMENT_ALREADY_CONFIRMED: "));
}
