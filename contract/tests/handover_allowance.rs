//! The allowance around a handover: it runs during the public delay, stops from the delay's end
//! ("handover in progress", refused first), resumes after a cancel or a lapse, and keeps running
//! past the unlock date while no handover has happened. Demo timing: 60-second periods, a
//! 3-minute delay, a 7-minute lapse.

mod common;

use common::*;
use test_support::serde_json::json;
use test_support::{from_hex, Regtest};

#[tokio::test]
async fn allowances_run_during_the_delay_stop_when_it_ends_and_resume_after_a_cancel() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let args = jars.demo_args(&family, &regtest.new_address()).await;
    let jar = jars
        .funded_jar_with(&regtest, args, &[50_000, 50_000, 50_000])
        .await;
    jars.confirmed_claim(&family, &jar.id).await;
    let delay_ends_at: u64 = jars.handover(&jar.id).await["confirmed"]["delay_ends_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    // During the delay the allowance runs as before.
    assert!(now(&jars.worker).await < delay_ends_at);
    let during = jars.signed_allowance(&jar.id, 1).await;
    let raw = from_hex(during["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);

    // From the delay's end it is refused, before the pending payment is even named.
    jars.wait_until(delay_ends_at).await;
    let after = jars.request_allowance(&jar.id, 1).await;
    let reason = refusal(&after);
    assert!(reason.contains("HANDOVER_IN_PROGRESS: "), "{reason}");

    // A guardian cancels after the delay: allowances resume.
    jars.cancel(&family.guardians[2], &jar.id)
        .await
        .into_result()
        .unwrap();
    let proof = jars.mine_payment(&regtest, &during).await;
    jars.confirm_payment(during["payment_id"].as_str().unwrap(), &proof)
        .await
        .into_result()
        .unwrap();
    let resumed = jars.signed_allowance(&jar.id, 1).await;
    let raw = from_hex(resumed["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}

#[tokio::test]
async fn handover_in_progress_is_refused_before_not_funded() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let during = jars.request_allowance(&jar, 1).await;
    jars.confirmed_claim(&family, &jar).await;
    let delay_ends_at = jars.handover(&jar).await["confirmed"]["delay_ends_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    jars.wait_until(delay_ends_at).await;
    let after = jars.request_allowance(&jar, 1).await;

    assert!(refusal(&during).contains("NOT_FUNDED: "));
    let reason = refusal(&after);
    assert!(
        reason.contains(
            "HANDOVER_IN_PROGRESS: the handover's public delay has ended, so no allowance runs \
             until the handover completes or is cancelled"
        ),
        "{reason}"
    );
}

#[tokio::test]
async fn the_rule_keeps_running_past_the_unlock_date_while_no_handover_has_happened() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    let unlock_at = now(&jars.worker).await + 120;
    args["unlock_at"] = json!(unlock_at.to_string());
    let jar = jars
        .funded_jar_with(&regtest, args, &[50_000, 50_000])
        .await;
    // A claim is open but unconfirmed, so it never stops the rule; it lapses on its own.
    let claim = jars.claim(&family.child, &jar.id, CHILD_BTC_KEY).await;
    let lapses_at = jars.ran_at(&claim).await + DEMO_LAPSE;

    jars.wait_until(unlock_at + 1).await;
    let past_unlock = jars.signed_allowance(&jar.id, 1).await;
    let raw = from_hex(past_unlock["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    let proof = jars.mine_payment(&regtest, &past_unlock).await;
    jars.confirm_payment(past_unlock["payment_id"].as_str().unwrap(), &proof)
        .await
        .into_result()
        .unwrap();
    jars.wait_until(lapses_at).await;
    let after_lapse = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(after_lapse["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    assert_eq!(jars.handover(&jar.id).await, "none");
}
