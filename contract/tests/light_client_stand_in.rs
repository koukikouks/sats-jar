//! The light-client stand-in answers like the live `btc-client-v4.testnet`: the same JSON for a
//! proof it accepts, `null` for a wrong merkle proof, and the same panics.

mod common;

use common::*;
use test_support::from_hex;
use test_support::serde_json::{self, json, Value};

const METHOD: &str = "verify_transaction_inclusion_with_heights";

#[tokio::test]
async fn the_stand_in_answers_recorded_live_proofs_as_the_live_light_client_did() {
    let live: Value =
        serde_json::from_str(include_str!("fixtures/light_client_live.json")).unwrap();
    let jars = deploy(Build::Locked).await;
    let client = &jars.light_client;
    client
        .call("add_block")
        .args_json(json!({
            "blockhash": live["block_hash"],
            "height": live["block_height"],
            "merkle_root": live["merkle_root"],
        }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    jars.set_tip(live["light_client_tip_before"].as_u64().unwrap())
        .await;

    for case in live["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let args = from_hex(case["args_hex"].as_str().unwrap());
        let answer = client.view(METHOD).args(args).await;
        match case.get("panic") {
            Some(panic) => {
                let error = format!("{:?}", answer.expect_err(name));
                assert!(error.contains(panic.as_str().unwrap()), "{name}: {error}");
            }
            None => {
                let json: Value = answer.expect(name).json().unwrap();
                assert_eq!(json, case["ok"], "{name}");
            }
        }
    }

    // near-plugins-derive 0.5.2's `#[pause]` check, which the live client's method carries.
    jars.set_paused(true).await;
    let valid = from_hex(live["cases"][0]["args_hex"].as_str().unwrap());
    let error = format!("{:?}", client.view(METHOD).args(valid).await.unwrap_err());
    assert!(error.contains("Pausable: Method is paused"), "{error}");
}
