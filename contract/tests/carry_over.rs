//! Carry-over (ADR 0005): allowance the child did not receive stays available, at most three
//! periods' allowance (3 × cap, the current period included). Bitcoin Core judges each payment.

mod common;

use common::*;
use test_support::{from_hex, Regtest};

/// One-minute periods, so the sandbox can pass several quickly.
const PERIOD: u64 = 60;

#[tokio::test]
async fn two_unpaid_periods_carry_over_into_one_allowance_of_three_caps() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars
        .funded_jar_with_period(&regtest, PERIOD, &[50_000, 20_000])
        .await;
    // The clock started at the first top-up, before now: two whole periods pass unpaid.
    jars.wait_until(now(&jars.worker).await + 2 * PERIOD).await;

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    assert_eq!(paid(&payment).0, 3 * CAP);
    assert_eq!(payment["amount"], (3 * CAP).to_string());
}

#[tokio::test]
async fn at_most_three_caps_wait_however_many_periods_pass() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars
        .funded_jar_with_period(&regtest, PERIOD, &[100_000])
        .await;
    jars.wait_until(now(&jars.worker).await + 5 * PERIOD).await;

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    assert_eq!(paid(&payment).0, 3 * CAP);
}

#[tokio::test]
async fn what_a_short_jar_could_not_pay_is_paid_the_next_period() {
    // Ten-minute periods, so one period passes exactly, whatever the setup takes.
    const LONG: u64 = 600;
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar_with_period(&regtest, LONG, &[15_000]).await;
    let first = jars.signed_allowance(&jar.id, 1).await;
    let paid_at = now(&jars.worker).await;
    let (short, _) = paid(&first);
    assert!(short < CAP);
    let id = first["payment_id"].as_str().unwrap();
    let proof = jars.mine_payment(&regtest, &first).await;
    jars.confirm_payment(id, &proof)
        .await
        .into_result()
        .unwrap();
    let topup = jars.confirmed_topup(&regtest, &jar.address, 50_000).await;
    jars.prove(&jars.giver, &jar.id, &topup)
        .await
        .into_result()
        .unwrap();
    jars.wait_until(paid_at + LONG).await;

    let second = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(second["signed_tx"].as_str().unwrap());
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    // This period's cap plus what the first payment fell short of it.
    assert_eq!(paid(&second).0, CAP + (CAP - short));
}
