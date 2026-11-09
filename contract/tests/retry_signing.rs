//! `retry_signing`: a failed or stalled signing is signed again with the identical stored
//! transaction, and never for a payment that is signed, confirmed or still being signed.

mod common;

use common::*;
use test_support::{from_hex, Regtest};

#[tokio::test]
async fn a_failed_signing_is_retried_with_the_same_transaction() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[6_000, 12_000, 9_000]).await;
    jars.signer_mode("fail").await;
    let id: String = jars.request_allowance(&jar.id, 1).await.json().unwrap();
    let failed = jars.get_payment(&id).await;
    assert_eq!(failed["status"], "signing_failed");
    jars.signer_mode("sign").await;

    let retried: String = jars.retry_signing(&id).await.json().unwrap();

    assert_eq!(retried, id);
    let payment = jars.get_payment(&id).await;
    assert_eq!(payment["status"], "signed");
    assert_eq!(payment["failure"], test_support::serde_json::Value::Null);
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    // Bitcoin's own txid of the signed transaction is the one stored at the request.
    assert_eq!(decode(&raw).compute_txid().to_string(), failed["txid"]);
    assert_eq!(payment["inputs"], failed["inputs"]);
    assert_eq!(payment["amount"], failed["amount"]);
}

#[tokio::test]
async fn a_signed_or_confirmed_payment_is_never_signed_again() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let id = payment["payment_id"].as_str().unwrap();

    let signed = jars.retry_signing(id).await;
    let proof = jars.mine_payment(&regtest, &payment).await;
    jars.confirm_payment(id, &proof)
        .await
        .into_result()
        .unwrap();
    let confirmed = jars.retry_signing(id).await;
    let unknown = jars.retry_signing("99").await;

    assert!(refusal(&signed).contains("PAYMENT_ALREADY_SIGNED: "));
    assert!(refusal(&confirmed).contains("PAYMENT_ALREADY_CONFIRMED: "));
    assert!(refusal(&unknown).contains("UNKNOWN_PAYMENT: "));
    let after = jars.get_payment(id).await;
    assert_eq!(after["status"], "confirmed");
    assert_eq!(after["signed_tx"], payment["signed_tx"]);
}

#[tokio::test]
async fn a_retry_needs_gas_for_every_signature_and_passes_extra_gas_to_the_signer() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[6_000, 12_000, 9_000]).await;
    jars.signer_mode("fail").await;
    let id: String = jars.request_allowance(&jar.id, 1).await.json().unwrap();
    jars.signer_mode("sign").await;
    // As if the MPC network voted its floor up from 15 to 25 Tgas after the locked deploy.
    jars.signer
        .call("set_min_gas")
        .args_json(test_support::serde_json::json!({ "tgas": 25 }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();

    let short = jars
        .retry_signing_with_gas(&id, near_workspaces::types::Gas::from_tgas(90))
        .await;
    jars.retry_signing(&id).await.into_result().unwrap();

    assert!(refusal(&short)
        .contains("NOT_ENOUGH_GAS: attach at least 95 Tgas for 3 signatures and the callback"));
    let payment = jars.get_payment(&id).await;
    assert_eq!(payment["status"], "signed");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}

#[tokio::test]
async fn a_signing_still_in_flight_is_not_retried_until_it_fails() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    jars.signer_mode("stall").await;
    let (id, request) = jars.request_allowance_in_flight(&jar.id, 1).await;
    assert_eq!(jars.get_payment(&id).await["status"], "signing");

    let early = jars.retry_signing(&id).await;

    let reason = refusal(&early);
    assert!(reason.contains("SIGNING_IN_PROGRESS: "), "{reason}");
    // The live yield timeout (200 blocks) fails the request; the callback records it.
    jars.worker.fast_forward(210).await.unwrap();
    request.await.unwrap().into_result().unwrap();
    let failed = jars.get_payment(&id).await;
    assert_eq!(failed["status"], "signing_failed");
    jars.signer_mode("sign").await;
    jars.retry_signing(&id).await.into_result().unwrap();
    let payment = jars.get_payment(&id).await;
    assert_eq!(payment["status"], "signed");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}

#[tokio::test]
async fn a_signing_stuck_past_its_window_is_retried_and_its_late_answer_changes_nothing() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let first = jars.funded_jar(&regtest, &[50_000]).await;
    let second = jars.funded_jar(&regtest, &[40_000]).await;
    jars.signer_mode("slow").await;
    let (first_id, first_round) = jars.request_allowance_in_flight(&first.id, 1).await;
    let (second_id, second_round) = jars.request_allowance_in_flight(&second.id, 1).await;
    // Past the 250-block window, with both requests still unanswered.
    jars.worker.fast_forward(260).await.unwrap();
    assert_eq!(jars.get_payment(&first_id).await["status"], "signing");
    assert_eq!(jars.get_payment(&second_id).await["status"], "signing");

    // The first is retried and signed; the second's retry is itself still in flight.
    jars.signer_mode("sign").await;
    jars.retry_signing(&first_id).await.into_result().unwrap();
    jars.signer_mode("stall").await;
    let second_retry = jars
        .giver
        .call(jars.contract.id(), "retry_signing")
        .args_json(test_support::serde_json::json!({ "payment_id": second_id }))
        .gas(near_workspaces::types::Gas::from_tgas(300))
        .transact_async()
        .await
        .unwrap();
    jars.worker.fast_forward(3).await.unwrap();
    let first_signed = jars.get_payment(&first_id).await;
    assert_eq!(first_signed["status"], "signed");
    let second_retrying = jars.get_payment(&second_id).await;
    assert_eq!(second_retrying["status"], "signing");

    let first_history = jars.history_events(&first.id).await;
    let second_history = jars.history_events(&second.id).await;

    // The first rounds now answer, one with a signature and one with a failure. Neither moves
    // a payment: one is already signed, the other is in a newer round.
    jars.signer_respond(true).await;
    jars.signer_respond(false).await;
    first_round.await.unwrap().into_result().unwrap();
    second_round.await.unwrap().into_result().unwrap();
    assert_eq!(jars.get_payment(&first_id).await, first_signed);
    assert_eq!(jars.get_payment(&second_id).await, second_retrying);
    assert_eq!(jars.history_events(&first.id).await, first_history);
    assert_eq!(jars.history_events(&second.id).await, second_history);

    // The newer round still decides: it times out, and a retry signs.
    jars.worker.fast_forward(210).await.unwrap();
    second_retry.await.unwrap().into_result().unwrap();
    assert_eq!(
        jars.get_payment(&second_id).await["status"],
        "signing_failed"
    );
    jars.signer_mode("sign").await;
    jars.retry_signing(&second_id).await.into_result().unwrap();
    for id in [&first_id, &second_id] {
        let payment = jars.get_payment(id).await;
        assert_eq!(payment["status"], "signed");
        let raw = from_hex(payment["signed_tx"].as_str().unwrap());
        assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    }
}
