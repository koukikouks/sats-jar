//! A confirmed Bitcoin payment to a jar address, proven through the light client, counts.

mod common;

use common::*;
use test_support::serde_json::{json, Value};
use test_support::{sats, Regtest};

/// Starts a regtest contract with jar "1" for a regtest child address.
async fn jar_on_regtest() -> Jars {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    jars
}

fn address_of(jar: &Value) -> String {
    jar["address"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_confirmed_top_up_proven_by_anyone_is_counted_as_a_coin() {
    let regtest = Regtest::start();
    let jars = jar_on_regtest().await;
    let address = address_of(&jars.get_jar("1").await);

    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;
    let anyone = new_account(&jars.worker, "anyone").await;
    let result = jars.prove(&anyone, "1", &topup).await;
    assert!(result.is_success(), "{:?}", result.failures());
    let (txid, block, funding) = (&topup.txid, &topup.block, &topup.funding);

    let core_tx = regtest.rpc(
        "getrawtransaction",
        &[json!(txid), json!(true), json!(block)],
    );
    let core_value = sats(&core_tx["vout"][funding.vout as usize]["value"]);
    assert_eq!(
        jars.get_coins("1").await,
        json!([{
            "txid": core_tx["txid"],
            "vout": funding.vout,
            "value": core_value.to_string(),
            "status": "confirmed",
        }])
    );
    assert_eq!(
        jars.get_jar("1").await["proven_balance"],
        json!(core_value.to_string())
    );
    let events: Vec<Value> = result
        .logs()
        .iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| test_support::serde_json::from_str(json).unwrap())
        .collect();
    assert_eq!(
        events,
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "topup_proven",
            "data": {
                "jar_id": "1",
                "txid": core_tx["txid"],
                "vout": funding.vout,
                "value": core_value.to_string(),
            },
        })]
    );
}

#[tokio::test]
async fn the_allowance_clock_starts_at_the_first_proven_top_up_not_at_creation() {
    let regtest = Regtest::start();
    let jars = jar_on_regtest().await;
    let address = address_of(&jars.get_jar("1").await);
    let first = jars.confirmed_topup(&regtest, &address, 20_000).await;
    let second = jars.confirmed_topup(&regtest, &address, 30_000).await;
    assert_eq!(
        jars.get_jar("1").await["clock"],
        json!({ "started_at": null })
    );

    let before = now(&jars.worker).await;
    jars.prove(&jars.giver, "1", &first)
        .await
        .into_result()
        .unwrap();
    let after = now(&jars.worker).await;
    let started_at = jars.get_jar("1").await["clock"]["started_at"].clone();
    let started: u64 = started_at.as_str().unwrap().parse().unwrap();
    assert!(
        (before..=after).contains(&started),
        "{before} <= {started} <= {after}"
    );

    jars.worker.fast_forward(5).await.unwrap();
    jars.prove(&jars.giver, "1", &second)
        .await
        .into_result()
        .unwrap();
    let jar = jars.get_jar("1").await;
    assert_eq!(jar["clock"]["started_at"], started_at);
    assert_eq!(jar["proven_balance"], json!("50000"));
}

#[tokio::test]
async fn coins_are_listed_in_the_order_they_were_proven_a_page_at_a_time() {
    let regtest = Regtest::start();
    let jars = jar_on_regtest().await;
    let address = address_of(&jars.get_jar("1").await);
    for sats in [20_000, 30_000, 40_000] {
        let topup = jars.confirmed_topup(&regtest, &address, sats).await;
        jars.prove(&jars.giver, "1", &topup)
            .await
            .into_result()
            .unwrap();
    }
    let values = |coins: Value| -> Vec<String> {
        coins
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["value"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        values(jars.get_coins("1").await),
        ["20000", "30000", "40000"]
    );
    let page = jars
        .contract
        .view("get_coins")
        .args_json(json!({ "jar_id": "1", "from_index": 1, "limit": 1 }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(values(page), ["30000"]);
    assert_eq!(jars.get_coins("2").await, json!([]));
}
