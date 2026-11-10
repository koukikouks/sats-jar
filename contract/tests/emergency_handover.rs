//! The emergency payment around a handover (ADR 0009, story 53a): its calls run during the
//! handover's public delay, are refused from the delay's end ("handover in progress"), and an
//! open proposal lapses when the delay ends, for good, even if the claim is cancelled after.
//! Demo timing: a 30-minute emergency delay, a 3-minute handover delay.

mod common;

use common::*;
use test_support::serde_json::json;
use test_support::{from_hex, Regtest};

const JAR_CAP: u64 = 20_000;

async fn handover_delay_ends_at(jars: &Jars, jar_id: &str) -> u64 {
    jars.handover(jar_id).await["confirmed"]["delay_ends_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn emergency_calls_run_during_the_handover_delay() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    args["period"] = json!(DAY.to_string());
    let jar = jars.funded_jar_with(&regtest, args, &[50_000]).await;
    jars.approved_emergency(&family, &jar.id, JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;
    jars.confirmed_claim(&family, &jar.id).await;
    let delay_ends_at = handover_delay_ends_at(&jars, &jar.id).await;

    let executed = jars.execute(&family.stranger, &jar.id, 1).await;
    let proposed = jars.propose(&family.guardians[1], &jar.id, JAR_CAP).await;
    let approved = jars.approve(&family.guardians[2], &jar.id, 2).await;
    let cancelled = jars.cancel_emergency(&jars.giver, &jar.id).await;

    assert!(now(&jars.worker).await < delay_ends_at);
    let payment_id: String = executed.json().expect("payment id");
    let payment = jars.get_payment(&payment_id).await;
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    for result in [proposed, approved, cancelled] {
        assert!(result.is_success(), "{:?}", result.failures());
    }
}

#[tokio::test]
async fn an_open_proposal_lapses_when_the_handover_delay_ends_and_stays_lapsed_after_a_cancel() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let id = jars.approved_emergency(&family, &jar, JAR_CAP).await;
    let emergency_delay_ends_at = jars.emergency_delay_ends_at(&jar).await;
    jars.confirmed_claim(&family, &jar).await;
    let delay_ends_at = handover_delay_ends_at(&jars, &jar).await;
    jars.wait_until(delay_ends_at).await;

    let propose = jars.propose(&family.guardians[2], &jar, JAR_CAP).await;
    let approve = jars.approve(&family.guardians[2], &jar, id).await;
    let cancel = jars.cancel_emergency(&jars.giver, &jar).await;
    let execute = jars.execute(&family.stranger, &jar, 1).await;
    let lapsed = jars.emergency(&jar).await;
    let handover_cancelled = jars.cancel(&family.guardians[2], &jar).await;

    for result in [propose, approve, cancel, execute] {
        let reason = refusal(&result);
        assert!(
            reason.contains(
                "HANDOVER_IN_PROGRESS: the handover's public delay has ended, so no emergency \
                 payment runs and open proposals have lapsed"
            ),
            "{reason}"
        );
    }
    let expected = json!({ "lapsed": { "proposal_id": id } });
    assert_eq!(lapsed, expected);
    assert_eq!(
        satsjar_events(&handover_cancelled)[0],
        json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "emergency_lapsed",
            "data": {
                "jar_id": jar,
                "proposal_id": id,
                "lapsed_at": delay_ends_at.to_string(),
            },
        })
    );
    let history = jars.history_events(&jar).await;
    assert_eq!(
        history[history.len() - 2..],
        ["emergency_lapsed", "handover_cancelled"]
    );
    // The cancel does not revive it, even once its own delay has passed.
    assert_eq!(jars.emergency(&jar).await, expected);
    jars.wait_until(emergency_delay_ends_at).await;
    let reason = refusal(&jars.execute(&family.stranger, &jar, 1).await);
    assert!(reason.contains("NO_OPEN_PROPOSAL: "), "{reason}");
    let fresh = jars.propose(&family.guardians[0], &jar, JAR_CAP).await;
    assert_eq!(fresh.json::<u32>().unwrap(), id + 1);
}

#[tokio::test]
async fn a_handover_cancelled_before_its_delay_ends_leaves_the_proposal_open() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    args["period"] = json!(DAY.to_string());
    let jar = jars.funded_jar_with(&regtest, args, &[50_000]).await;
    let id = jars.approved_emergency(&family, &jar.id, JAR_CAP).await;
    jars.confirmed_claim(&family, &jar.id).await;
    let delay_ends_at = handover_delay_ends_at(&jars, &jar.id).await;

    jars.cancel(&family.guardians[2], &jar.id)
        .await
        .into_result()
        .unwrap();

    assert!(now(&jars.worker).await < delay_ends_at);
    assert_eq!(jars.emergency(&jar.id).await["open"]["proposal_id"], id);
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;
    let payment_id: String = jars
        .execute(&family.stranger, &jar.id, 1)
        .await
        .json()
        .expect("payment id");
    let raw = from_hex(
        jars.get_payment(&payment_id).await["signed_tx"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}
