//! Creating a jar and reading it back through `get_jar`.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use test_support::serde_json::{self, json, Value};

#[tokio::test]
async fn a_created_jar_is_held_by_the_family_account_with_its_exact_create_args() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;

    let result = jars.create_jar(&args).await;

    assert_eq!(
        result
            .clone()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap(),
        "1"
    );
    let jar = jars.get_jar("1").await;
    assert_eq!(jar["jar_id"], "1");
    assert_eq!(jar["create_args"], args);
    assert_eq!(jar["owner_id"], "family.sandbox");
    assert_eq!(jar["giver"], jars.giver.id().as_str());
}

#[tokio::test]
async fn each_jar_key_matches_the_live_mpc_derived_public_key_for_its_id() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/derived_public_key.json")).unwrap();
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for vector in fixture["vectors"].as_array().unwrap() {
        assert_eq!(vector["predecessor"], jars.contract.id().as_str());
        let jar_id = jars.create_jar(&args).await.json::<String>().unwrap();
        assert_eq!(jar_id, vector["path"]);
        assert_eq!(
            jars.get_jar(&jar_id).await["public_key"],
            vector["public_key"]
        );
    }
}

#[tokio::test]
async fn the_exit_opens_730_days_after_unlock_or_3_hours_for_a_demo_jar_off_mainnet() {
    let cases = [
        // (network, period, demo timing, exit delay)
        ("regtest", 30 * DAY, false, 63_072_000),
        ("regtest", 3_600, true, 10_800),
        ("testnet", 30 * DAY - 1, true, 10_800),
        ("testnet", DAY, true, 10_800),
        ("mainnet", 3_600, true, 63_072_000),
        ("mainnet", 30 * DAY, false, 63_072_000),
    ];
    for (network, period, demo, delay) in cases {
        let jars = start(network).await;
        let bitcoin_network = match network {
            "mainnet" => bitcoin::Network::Bitcoin,
            "testnet" => bitcoin::Network::Testnet,
            _ => bitcoin::Network::Regtest,
        };
        let mut args = jars.valid_args(&child_address(bitcoin_network)).await;
        args["period"] = json!(period.to_string());
        let unlock_at: u64 = args["unlock_at"].as_str().unwrap().parse().unwrap();

        jars.create_jar(&args).await.into_result().unwrap();

        let jar = jars.get_jar("1").await;
        assert_eq!(jar["demo_timing"], demo, "{network} {period}");
        assert_eq!(jar["locktime"], unlock_at + delay, "{network} {period}");
    }
}

#[tokio::test]
async fn a_caller_cannot_set_the_demo_timing_flag() {
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    args["period"] = json!("3600");
    args["demo_timing"] = json!(false);

    jars.create_jar(&args).await.into_result().unwrap();

    assert_eq!(jars.get_jar("1").await["demo_timing"], true);
}

#[tokio::test]
async fn the_caller_pays_for_the_jar_storage_and_gets_the_rest_of_the_deposit_back() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;

    let refused = jars
        .create_jar_with_deposit(&args, NearToken::from_yoctonear(0))
        .await;
    assert!(refusal(&refused).contains("STORAGE_DEPOSIT_TOO_LOW: "));

    // Account views read final blocks, a few behind the last transaction's refunds.
    jars.worker.fast_forward(5).await.unwrap();
    let storage_before = jars.contract.view_account().await.unwrap().storage_usage;
    let balance_before = jars.giver.view_account().await.unwrap().balance;
    let result = jars.create_jar(&args).await;
    assert!(result.is_success());
    jars.worker.fast_forward(5).await.unwrap();
    let storage_after = jars.contract.view_account().await.unwrap().storage_usage;
    let balance_after = jars.giver.view_account().await.unwrap().balance;

    // 10^19 yoctoNEAR per byte (protocol config).
    let storage_cost = u128::from(storage_after - storage_before) * 10u128.pow(19);
    let gas_paid: u128 = result
        .outcomes()
        .iter()
        .map(|o| o.tokens_burnt.as_yoctonear())
        .sum();
    let paid = balance_before.as_yoctonear() - balance_after.as_yoctonear();
    assert!(storage_cost > 0);
    assert!(paid >= storage_cost, "paid {paid} < storage {storage_cost}");
    assert!(
        paid <= storage_cost + gas_paid,
        "paid {paid} > storage {storage_cost} + gas {gas_paid}: the excess was not refunded"
    );
}

fn events(result: &near_workspaces::result::ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

#[tokio::test]
async fn creating_a_jar_mints_its_nft_to_the_family_account_and_logs_the_jar() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;

    let result = jars.create_jar(&args).await;

    let jar = jars.get_jar("1").await;
    assert_eq!(
        events(&result),
        vec![
            // NEP-171's nft_mint event, shaped as in the standard's own example.
            json!({
                "standard": "nep171",
                "version": "1.0.0",
                "event": "nft_mint",
                "data": [{ "owner_id": "family.sandbox", "token_ids": ["1"] }],
            }),
            json!({
                "standard": "satsjar",
                "version": "1.0.0",
                "event": "jar_created",
                "data": { "jar_id": "1", "address": jar["address"] },
            }),
        ]
    );
}

#[tokio::test]
async fn a_new_jar_has_no_allowance_clock_and_no_handover_yet() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();

    let jar = jars.get_jar("1").await;
    // The clock starts at the first proven top-up (ADR 0005), not at creation.
    assert_eq!(jar["clock"], json!({ "started_at": null }));
    assert_eq!(jar["handover"], "none");
}

#[tokio::test]
async fn an_unknown_jar_reads_as_null() {
    let jars = start("regtest").await;
    assert_eq!(jars.get_jar("1").await, Value::Null);
}
