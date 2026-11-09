//! The spec's refusal order for `request_allowance`, checked where two refusals both apply:
//! not funded → already paid → payment pending → fee too low → insufficient balance → fee over
//! budget → payment too small → change below dust → not enough gas.

mod common;

use common::*;
use test_support::Regtest;

#[tokio::test]
async fn a_well_funded_jar_at_a_huge_fee_rate_is_over_its_fee_budget() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;

    // At 1,000 sat/vB the fee alone is more than the jar holds, but the jar can pay its budget.
    let result = jars.request_allowance(&jar.id, 1_000).await;

    let reason = refusal(&result);
    assert!(reason.contains("FEE_OVER_BUDGET: "), "{reason}");
}

#[tokio::test]
async fn an_unconfirmed_payment_from_an_earlier_period_holds_the_next_allowance() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars
        .funded_jar_with_period(&regtest, 60, &[50_000, 50_000])
        .await;
    let first = jars.signed_allowance(&jar.id, 1).await;
    let id = first["payment_id"].as_str().unwrap();
    jars.wait_until(now(&jars.worker).await + 60).await;

    // A new period, and a fee rate that is also too low: the pending payment is named first.
    let pending = jars.request_allowance(&jar.id, 0).await;

    let reason = refusal(&pending);
    assert!(
        reason.contains(&format!(
            "PAYMENT_PENDING: payment {id} is not yet confirmed on Bitcoin"
        )),
        "{reason}"
    );
    let proof = jars.mine_payment(&regtest, &first).await;
    jars.confirm_payment(id, &proof)
        .await
        .into_result()
        .unwrap();
    jars.signed_allowance(&jar.id, 1).await;
}

#[tokio::test]
async fn a_fee_rate_too_low_is_named_before_an_insufficient_balance() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[1_050]).await;

    let too_low = jars.request_allowance(&jar.id, 0).await;
    // 20 sat/vB is over the 2,000-sat budget too, but 1,050 sats cannot even pay that.
    let insufficient = jars.request_allowance(&jar.id, 20).await;

    assert!(refusal(&too_low).contains("FEE_TOO_LOW: "));
    assert!(refusal(&insufficient).contains("INSUFFICIENT_BALANCE: "));
}

#[tokio::test]
async fn a_fee_over_budget_is_named_before_a_payment_too_small() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // At 20 sat/vB: a 2,400-sat fee, and a payment of 6,600 under half the cap.
    let jar = jars.funded_jar(&regtest, &[9_000]).await;

    let result = jars.request_allowance(&jar.id, 20).await;

    assert!(refusal(&result).contains("FEE_OVER_BUDGET: "));
}

#[tokio::test]
async fn a_change_below_dust_is_named_before_too_little_gas() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[20_500]).await;

    let result = jars
        .request_allowance_with_gas(&jar.id, 1, near_workspaces::types::Gas::from_tgas(30))
        .await;

    assert!(refusal(&result).contains("CHANGE_BELOW_DUST: "));
}
