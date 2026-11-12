//! The size floor (a payment under half the cap waits for more top-ups) and the period's fee
//! budget (all allowance fees in a period at most cap / 10), from ADR 0005.

mod common;

use common::*;
use test_support::{from_hex, Regtest};

#[tokio::test]
async fn a_payment_under_half_the_cap_waits_for_more_top_ups() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // 9,000 sats could pay the child about 8,880: under half the 20,000 cap.
    let jar = jars.funded_jar(&regtest, &[9_000]).await;

    let refused = jars.request_allowance(&jar.id, 1).await;

    let reason = refusal(&refused);
    assert!(
        reason.contains("PAYMENT_TOO_SMALL: the payment would be 8880 sats"),
        "{reason}"
    );
    // The refusal does not use up the period: a top-up lets it pay now.
    let topup = jars.confirmed_topup(&regtest, &jar.address, 20_000).await;
    jars.prove(&jars.giver, &jar.id, &topup)
        .await
        .into_result()
        .unwrap();
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    assert_eq!(paid(&payment).0, CAP);
}

#[tokio::test]
async fn the_jar_shows_its_allowance_fee_budget_and_next_allowance_time() {
    const PERIOD: u64 = 600;
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let mut args = jars.valid_args(&regtest.new_address()).await;
    args["period"] = test_support::serde_json::json!(PERIOD.to_string());
    let empty: String = jars.create_jar(&args).await.json().unwrap();
    let view = jars.get_jar(&empty).await;
    assert_eq!(view["available_allowance"], "0");
    assert_eq!(view["fee_budget_left"], "2000");
    assert!(view["next_allowance_at"].is_null());

    let jar = jars
        .funded_jar_with_period(&regtest, PERIOD, &[50_000])
        .await;
    let view = jars.get_jar(&jar.id).await;
    let started: u64 = view["clock"]["started_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(view["available_allowance"], CAP.to_string());
    assert_eq!(view["fee_budget_left"], "2000");
    // Due now: the current period's start.
    assert_eq!(view["next_allowance_at"], started.to_string());

    let payment = jars.signed_allowance(&jar.id, 2).await;
    let (amount, change) = paid(&payment);
    let fee = 50_000 - amount - change;
    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["available_allowance"], "0");
    assert_eq!(view["fee_budget_left"], (2_000 - fee).to_string());
    assert_eq!(view["next_allowance_at"], (started + PERIOD).to_string());

    jars.wait_until(started + PERIOD).await;
    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["available_allowance"], CAP.to_string());
    assert_eq!(view["fee_budget_left"], "2000");
}
