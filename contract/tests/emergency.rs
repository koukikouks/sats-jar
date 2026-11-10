//! The emergency payment (ADR 0005): a guardian proposes an amount up to 3 × cap, a second
//! guardian approves, a public delay runs during which the giver can cancel, then anyone
//! executes it, paying only the child's address with a fee from the jar of at most 10% of the
//! amount. Demo timing: a 30-minute delay.

mod common;

use bitcoin::{absolute, transaction, Amount, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness};
use common::*;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, Regtest};

/// The cap `valid_args` gives every jar, in sats.
const JAR_CAP: u64 = 20_000;

#[tokio::test]
async fn a_guardian_proposes_an_emergency_payment() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    let result = jars.propose(&family.guardians[0], &jar, 2 * JAR_CAP).await;

    assert!(result.is_success(), "{:?}", result.failures());
    assert_eq!(result.clone().json::<u32>().unwrap(), 1);
    let at = jars.ran_at(&result).await;
    assert_eq!(
        jars.emergency(&jar).await,
        json!({ "open": {
            "proposal_id": 1,
            "amount": (2 * JAR_CAP).to_string(),
            "approved_by": [family.guardians[0].id()],
            "proposed_at": at.to_string(),
            "delay_ends_at": null,
        }})
    );
    assert_eq!(
        satsjar_events(&result),
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "emergency_proposed",
            "data": {
                "jar_id": jar,
                "proposal_id": 1,
                "guardian": family.guardians[0].id(),
                "amount": (2 * JAR_CAP).to_string(),
            },
        })]
    );
    assert_eq!(
        jars.history_events(&jar).await,
        ["jar_created", "emergency_proposed"]
    );
}

#[tokio::test]
async fn only_a_guardian_can_propose_an_emergency_payment() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    let stranger = jars.propose(&family.stranger, &jar, JAR_CAP).await;
    // The giver created the jar but is not one of its guardians here.
    let giver = jars.propose(&jars.giver, &jar, JAR_CAP).await;

    for result in [stranger, giver] {
        let reason = refusal(&result);
        assert!(reason.contains("NOT_A_GUARDIAN: "), "{reason}");
    }
    assert_eq!(jars.emergency(&jar).await, "none");
}

#[tokio::test]
async fn an_emergency_payment_is_capped_at_three_periods_allowance() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    // ADR 0005: at most three periods' allowance, 3 × the 20,000-sat cap.
    let over = jars.propose(&family.guardians[0], &jar, 60_001).await;
    let at_cap = jars.propose(&family.guardians[0], &jar, 60_000).await;

    let reason = refusal(&over);
    assert!(
        reason.contains("OVER_EMERGENCY_CAP: an emergency payment is at most 60000 sats"),
        "{reason}"
    );
    assert!(at_cap.is_success(), "{:?}", at_cap.failures());
    assert_eq!(jars.emergency(&jar).await["open"]["amount"], "60000");
}

#[tokio::test]
async fn an_emergency_payment_too_small_to_pay_its_own_fee_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    // 10% of 1,629 sats cannot pay a 163-vbyte one-input payment at 1 sat/vB; 1,630 can.
    let small = jars.propose(&family.guardians[0], &jar, 1_629).await;
    let smallest = jars.propose(&family.guardians[0], &jar, 1_630).await;

    let reason = refusal(&small);
    assert!(reason.contains("EMERGENCY_TOO_SMALL: "), "{reason}");
    assert!(smallest.is_success(), "{:?}", smallest.failures());
}

#[tokio::test]
async fn a_second_proposal_while_one_is_open_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.propose(&family.guardians[0], &jar, JAR_CAP)
        .await
        .into_result()
        .unwrap();

    let second = jars.propose(&family.guardians[1], &jar, 2 * JAR_CAP).await;

    let reason = refusal(&second);
    assert!(reason.contains("PROPOSAL_OPEN: "), "{reason}");
    assert_eq!(
        jars.emergency(&jar).await["open"]["amount"],
        JAR_CAP.to_string()
    );
}

#[tokio::test]
async fn a_second_guardians_approval_starts_the_public_delay() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let [first, second, third] = &family.guardians[..] else {
        unreachable!()
    };
    let id: u32 = jars.propose(first, &jar, JAR_CAP).await.json().unwrap();

    let again = jars.approve(first, &jar, id).await;
    let stranger = jars.approve(&family.stranger, &jar, id).await;
    let approved = jars.approve(second, &jar, id).await;
    let third_approval = jars.approve(third, &jar, id).await;

    let reason = refusal(&again);
    assert!(reason.contains("ALREADY_APPROVED: "), "{reason}");
    let reason = refusal(&stranger);
    assert!(reason.contains("NOT_A_GUARDIAN: "), "{reason}");
    assert!(approved.is_success(), "{:?}", approved.failures());
    let at = jars.ran_at(&approved).await;
    let delay_ends_at = (at + DEMO_EMERGENCY_DELAY).to_string();
    assert_eq!(
        satsjar_events(&approved),
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "emergency_approved",
            "data": {
                "jar_id": jar,
                "proposal_id": id,
                "guardian": second.id(),
                "delay_ends_at": delay_ends_at,
            },
        })]
    );
    let reason = refusal(&third_approval);
    assert!(reason.contains("ALREADY_APPROVED: "), "{reason}");
    let open = &jars.emergency(&jar).await["open"];
    assert_eq!(open["approved_by"], json!([first.id(), second.id()]));
    assert_eq!(open["delay_ends_at"], delay_ends_at);
    assert_eq!(
        jars.history_events(&jar).await,
        ["jar_created", "emergency_proposed", "emergency_approved"]
    );
}

#[tokio::test]
async fn the_giver_cancels_a_proposal_before_and_during_its_delay() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.propose(&family.guardians[0], &jar, JAR_CAP)
        .await
        .into_result()
        .unwrap();

    let by_guardian = jars.cancel_emergency(&family.guardians[0], &jar).await;
    let unapproved = jars.cancel_emergency(&jars.giver, &jar).await;
    let again = jars.cancel_emergency(&jars.giver, &jar).await;
    let id = jars.approved_emergency(&family, &jar, JAR_CAP).await;
    let during_delay = jars.cancel_emergency(&jars.giver, &jar).await;

    let reason = refusal(&by_guardian);
    assert!(reason.contains("NOT_THE_GIVER: "), "{reason}");
    assert!(unapproved.is_success(), "{:?}", unapproved.failures());
    let reason = refusal(&again);
    assert!(reason.contains("EMERGENCY_CANCELLED: "), "{reason}");
    assert!(during_delay.is_success(), "{:?}", during_delay.failures());
    assert_eq!(
        satsjar_events(&during_delay),
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "emergency_cancelled",
            "data": { "jar_id": jar, "proposal_id": id },
        })]
    );
    assert_eq!(id, 2);
    assert_eq!(
        jars.emergency(&jar).await,
        json!({ "cancelled": { "proposal_id": 2 } })
    );
    assert_eq!(
        jars.history_events(&jar).await,
        [
            "jar_created",
            "emergency_proposed",
            "emergency_cancelled",
            "emergency_proposed",
            "emergency_approved",
            "emergency_cancelled",
        ]
    );
}

#[tokio::test]
async fn an_approval_counts_only_toward_the_proposal_it_names() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let first: u32 = jars
        .propose(&family.guardians[0], &jar, JAR_CAP)
        .await
        .json()
        .unwrap();
    jars.cancel_emergency(&jars.giver, &jar)
        .await
        .into_result()
        .unwrap();

    let cancelled = jars.approve(&family.guardians[1], &jar, first).await;
    let second: u32 = jars
        .propose(&family.guardians[0], &jar, 3 * JAR_CAP)
        .await
        .json()
        .unwrap();
    // An approval sent for the first proposal must not count toward the second.
    let stale = jars.approve(&family.guardians[1], &jar, first).await;
    let unknown = jars.approve(&family.guardians[1], &jar, 7).await;

    assert_eq!((first, second), (1, 2));
    let reason = refusal(&cancelled);
    assert!(reason.contains("EMERGENCY_CANCELLED: "), "{reason}");
    for result in [stale, unknown] {
        let reason = refusal(&result);
        assert!(reason.contains("PROPOSAL_CHANGED: "), "{reason}");
    }
    let open = &jars.emergency(&jar).await["open"];
    assert_eq!(open["proposal_id"], 2);
    assert_eq!(open["approved_by"], json!([family.guardians[0].id()]));
}

#[tokio::test]
async fn propose_approve_and_cancel_need_one_yoctonear() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let none = near_workspaces::types::NearToken::from_yoctonear(0);

    let propose = jars
        .propose_with_deposit(&family.guardians[0], &jar, JAR_CAP, none)
        .await;
    jars.propose(&family.guardians[0], &jar, JAR_CAP)
        .await
        .into_result()
        .unwrap();
    let approve = jars
        .approve_with_deposit(&family.guardians[1], &jar, 1, none)
        .await;
    let cancel = jars
        .cancel_emergency_with_deposit(&jars.giver, &jar, none)
        .await;

    for result in [propose, approve, cancel] {
        let reason = refusal(&result);
        assert!(
            reason.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{reason}"
        );
    }
    let open = &jars.emergency(&jar).await["open"];
    assert_eq!(open["proposal_id"], 1);
    assert_eq!(open["approved_by"], json!([family.guardians[0].id()]));
}

#[tokio::test]
async fn an_emergency_payment_waits_for_two_approvals_and_its_delay() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    let nothing = jars.execute(&family.stranger, &jar, 1).await;
    jars.propose(&family.guardians[0], &jar, JAR_CAP)
        .await
        .into_result()
        .unwrap();
    let unapproved = jars.execute(&family.stranger, &jar, 1).await;
    jars.approve(&family.guardians[1], &jar, 1)
        .await
        .into_result()
        .unwrap();
    let during_delay = jars.execute(&family.stranger, &jar, 1).await;
    jars.cancel_emergency(&jars.giver, &jar)
        .await
        .into_result()
        .unwrap();
    let cancelled = jars.execute(&family.stranger, &jar, 1).await;

    let reason = refusal(&nothing);
    assert!(reason.contains("NO_OPEN_PROPOSAL: "), "{reason}");
    let reason = refusal(&unapproved);
    assert!(reason.contains("EMERGENCY_NOT_APPROVED: "), "{reason}");
    let reason = refusal(&during_delay);
    // The wait is named in the two largest units: at most the 30-minute delay.
    assert!(
        reason
            .contains("DELAY_NOT_PASSED: the public delay of emergency proposal 1 ends in 30m 0s")
            || reason.contains(
                "DELAY_NOT_PASSED: the public delay of emergency proposal 1 ends in 29m "
            ),
        "{reason}"
    );
    let reason = refusal(&cancelled);
    assert!(reason.contains("EMERGENCY_CANCELLED: "), "{reason}");
}

/// A demo-timing jar (1-day period, so its fee budget holds through a 30-minute delay) guarded
/// by `family`, with one proven top-up per entry in `coins`.
async fn funded_demo_jar(
    jars: &Jars,
    regtest: &Regtest,
    family: &Family,
    coins: &[u64],
) -> RegtestJar {
    let mut args = jars.demo_args(family, &regtest.new_address()).await;
    args["period"] = json!(DAY.to_string());
    jars.funded_jar_with(regtest, args, coins).await
}

/// The outpoints a signed payment spends, as rust-bitcoin reads them.
fn spent(payment: &Value) -> Vec<OutPoint> {
    decode(&from_hex(payment["signed_tx"].as_str().unwrap()))
        .input
        .iter()
        .map(|input| input.previous_output)
        .collect()
}

#[tokio::test]
async fn anyone_executes_an_approved_emergency_after_its_delay_paying_the_child_exactly() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = funded_demo_jar(&jars, &regtest, &family, &[50_000, 40_000, 40_000]).await;
    // An allowance still pending holds the largest coin; the emergency spends the others.
    let allowance = jars.signed_allowance(&jar.id, 1).await;
    let fee_budget_left = jars.get_jar(&jar.id).await["fee_budget_left"].clone();
    let id = jars.approved_emergency(&family, &jar.id, 3 * JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;

    let giver_too_late = jars.cancel_emergency(&jars.giver, &jar.id).await;
    let result = jars.execute(&family.stranger, &jar.id, 2).await;

    let reason = refusal(&giver_too_late);
    assert!(reason.contains("DELAY_PASSED: "), "{reason}");
    let payment_id: String = result.json().expect("payment id");
    let payment = jars.get_payment(&payment_id).await;
    assert_eq!(payment["kind"], "emergency");
    assert_eq!(payment["period"], Value::Null);
    assert_eq!(payment["status"], "signed", "{payment}");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(&regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 2);
    assert!(spent(&payment)
        .iter()
        .all(|o| !spent(&allowance).contains(o)));
    assert_eq!(tx.output[0].script_pubkey, jar.child_script());
    assert_eq!(tx.output[0].value.to_sat(), 60_000);
    assert_eq!(tx.output[1].script_pubkey, jar.jar_script());
    let paid: u64 = tx.output.iter().map(|o| o.value.to_sat()).sum();
    let fee = 80_000 - paid;
    let vsize = verdict["vsize"].as_u64().unwrap();
    // From the jar, at least the rate on Core's size, at most 10% of the amount.
    assert!(
        fee >= 2 * vsize && fee <= 6_000,
        "{fee} sats for {vsize} vB"
    );
    assert_eq!(payment["fee"], fee.to_string());
    // The emergency fee leaves the allowance's fee budget alone.
    assert_eq!(
        jars.get_jar(&jar.id).await["fee_budget_left"],
        fee_budget_left
    );
    assert_eq!(
        jars.emergency(&jar.id).await,
        json!({ "executed": { "proposal_id": id, "payment_id": payment_id } })
    );
    let again = jars.execute(&family.stranger, &jar.id, 2).await;
    let reason = refusal(&again);
    assert!(reason.contains("NO_OPEN_PROPOSAL: "), "{reason}");
    let history = jars.history_events(&jar.id).await;
    assert_eq!(
        history[history.len() - 2..],
        ["emergency_executed", "payment_signed"]
    );
}

#[tokio::test]
async fn a_jar_holding_exactly_the_amount_and_fee_pays_without_change() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    args["period"] = json!(DAY.to_string());
    let id: String = jars.create_jar(&args).await.json().unwrap();
    let view = jars.get_jar(&id).await;
    // rust-bitcoin's size of the largest signed one-input payment to the child: a 72-byte
    // signature, the branch selector and the witness script.
    let witness_script = ScriptBuf::from_bytes(from_hex(view["witness_script"].as_str().unwrap()));
    let largest = bitcoin::Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::from_slice(&[vec![0u8; 72], vec![1u8], witness_script.to_bytes()]),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(JAR_CAP),
            script_pubkey: script(args["child_address"].as_str().unwrap()),
        }],
    };
    let fee = largest.vsize() as u64;
    let address = view["address"].as_str().unwrap().to_owned();
    let topup = jars
        .confirmed_topup(&regtest, &address, JAR_CAP + fee)
        .await;
    jars.prove(&jars.giver, &id, &topup)
        .await
        .into_result()
        .unwrap();
    jars.approved_emergency(&family, &id, JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&id).await)
        .await;

    let payment_id: String = jars
        .execute(&family.stranger, &id, 1)
        .await
        .json()
        .expect("payment id");

    let payment = jars.get_payment(&payment_id).await;
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(&regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let tx = decode(&raw);
    assert_eq!(tx.output.len(), 1);
    assert_eq!(tx.output[0].value.to_sat(), JAR_CAP);
    assert_eq!(payment["fee"], fee.to_string());
}

#[tokio::test]
async fn an_emergency_payment_refuses_a_low_rate_a_fee_over_its_tenth_and_a_short_jar() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = funded_demo_jar(&jars, &regtest, &family, &[30_000]).await;
    jars.approved_emergency(&family, &jar.id, 2 * JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;

    let zero = jars.execute(&family.stranger, &jar.id, 0).await;
    // 10% of 40,000 sats is 4,000; a one-input payment is well over 100 vB, so 40 sat/vB is
    // over it by Core's size of any such payment.
    let costly = jars.execute(&family.stranger, &jar.id, 40).await;
    let short = {
        let short_jar = funded_demo_jar(&jars, &regtest, &family, &[30_000]).await;
        jars.approved_emergency(&family, &short_jar.id, 3 * JAR_CAP)
            .await;
        jars.wait_until(jars.emergency_delay_ends_at(&short_jar.id).await)
            .await;
        jars.execute(&family.stranger, &short_jar.id, 1).await
    };

    let reason = refusal(&zero);
    assert!(reason.contains("FEE_TOO_LOW: "), "{reason}");
    let reason = refusal(&costly);
    assert!(reason.contains("FEE_OVER_BUDGET: "), "{reason}");
    assert!(reason.contains("over 4000 sats"), "{reason}");
    let reason = refusal(&short);
    assert!(reason.contains("INSUFFICIENT_BALANCE: "), "{reason}");
    assert!(jars.emergency(&jar.id).await["open"].is_object());
}

#[tokio::test]
async fn a_pending_emergency_payment_holds_the_next_one_until_it_is_confirmed() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = funded_demo_jar(&jars, &regtest, &family, &[50_000, 50_000]).await;
    jars.approved_emergency(&family, &jar.id, JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;
    let first: String = jars
        .execute(&family.stranger, &jar.id, 1)
        .await
        .json()
        .unwrap();
    jars.approved_emergency(&family, &jar.id, JAR_CAP).await;
    jars.wait_until(jars.emergency_delay_ends_at(&jar.id).await)
        .await;

    let held = jars.execute(&family.stranger, &jar.id, 1).await;
    let payment = jars.get_payment(&first).await;
    let proof = jars.mine_payment(&regtest, &payment).await;
    jars.confirm_payment(&first, &proof)
        .await
        .into_result()
        .unwrap();
    let released = jars.execute(&family.stranger, &jar.id, 1).await;

    let reason = refusal(&held);
    assert!(
        reason.contains(&format!("PAYMENT_PENDING: emergency payment {first} ")),
        "{reason}"
    );
    let second: String = released.json().expect("payment id");
    let raw = from_hex(
        jars.get_payment(&second).await["signed_tx"]
            .as_str()
            .unwrap(),
    );
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
}
