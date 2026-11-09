//! Every refusal `request_allowance` makes in T04, each a failed transaction with its code.
//! (T05 adds carry-over, the size floor and "payment pending", and tests the full order.)

mod common;

use common::*;
use near_workspaces::types::Gas;
use test_support::serde_json::json;
use test_support::Regtest;

#[tokio::test]
async fn a_jar_with_no_proven_top_up_is_not_funded() {
    let jars = start_paying(Build::Locked, "regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    let jar: String = jars.create_jar(&args).await.json().unwrap();

    let result = jars.request_allowance(&jar, 1).await;

    assert!(refusal(&result).contains("NOT_FUNDED: "));
}

#[tokio::test]
async fn second_allowance_in_a_period_is_refused_as_already_paid() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000, 50_000]).await;
    jars.signed_allowance(&jar.id, 1).await;

    // The first payment is signed but not yet confirmed on Bitcoin.
    let second = jars.request_allowance(&jar.id, 1).await;

    let reason = refusal(&second);
    assert!(
        reason.contains(
            "ALREADY_PAID: the allowance for this period was already paid; next one in 29d 23h"
        ),
        "{reason}"
    );
}

#[tokio::test]
async fn the_next_period_pays_again() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let mut args = jars.valid_args(&regtest.new_address()).await;
    args["period"] = json!("60");
    let jar = jars
        .funded_jar_with(&regtest, args, &[50_000, 50_000])
        .await;
    jars.signed_allowance(&jar.id, 1).await;
    let refused = jars.request_allowance(&jar.id, 1).await;
    assert!(refusal(&refused).contains("ALREADY_PAID: "));

    let start = now(&jars.worker).await;
    while now(&jars.worker).await < start + 61 {
        jars.worker.fast_forward(100).await.unwrap();
    }

    jars.signed_allowance(&jar.id, 1).await;
}

#[tokio::test]
async fn a_fee_rate_below_one_sat_per_vbyte_is_too_low() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;

    let result = jars.request_allowance(&jar.id, 0).await;

    assert!(refusal(&result).contains("FEE_TOO_LOW: "));
}

#[tokio::test]
async fn coins_that_cannot_pay_the_fee_and_a_dust_floor_payment_are_insufficient() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // At 1 sat/vB a one-input payment costs 120 sats: 1,050 cannot also pay 1,000.
    let jar = jars.funded_jar(&regtest, &[1_050]).await;

    let result = jars.request_allowance(&jar.id, 1).await;

    assert!(refusal(&result).contains("INSUFFICIENT_BALANCE: "));
}

#[tokio::test]
async fn a_fee_over_a_tenth_of_the_cap_is_refused() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;

    // 163 vB at 20 sat/vB is 3,260 sats, over the 2,000-sat budget.
    let result = jars.request_allowance(&jar.id, 20).await;

    assert!(refusal(&result).contains("FEE_OVER_BUDGET: "));
}

#[tokio::test]
async fn a_leftover_that_would_go_to_miners_over_budget_is_refused() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // At 15 sat/vB a one-output payment costs 1,800, within the 2,000 budget. But paying the
    // cap from 23,000 would leave 3,000 for miners, and keeping it as change costs 2,445.
    let jar = jars.funded_jar(&regtest, &[23_000]).await;

    let result = jars.request_allowance(&jar.id, 15).await;

    assert!(refusal(&result).contains("FEE_OVER_BUDGET: "));
}

#[tokio::test]
async fn a_change_below_the_dust_floor_is_refused() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // Paying the cap at 1 sat/vB leaves 337 sats of change and no other coin to add.
    let jar = jars.funded_jar(&regtest, &[20_500]).await;

    let result = jars.request_allowance(&jar.id, 1).await;

    assert!(refusal(&result).contains("CHANGE_BELOW_DUST: the change would be 337 sats"));
}

#[tokio::test]
async fn too_little_gas_for_the_signer_and_the_callback_is_refused() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;

    let result = jars
        .request_allowance_with_gas(&jar.id, 1, Gas::from_tgas(60))
        .await;

    assert!(refusal(&result)
        .contains("NOT_ENOUGH_GAS: attach at least 65 Tgas for 1 signature and the callback"));
}
