//! The signer stand-in answers like the live `v1.signer-prod.testnet` (MPC 3.18.0): the same
//! request rules (domain, then gas, then 1 yoctoNEAR) with the same texts, and a response of the
//! same shape whose `big_r` and `recovery_id` recover the signing key the same way.

mod common;

use common::*;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use near_workspaces::types::{Gas, NearToken};
use test_support::serde_json::{self, json, Value};
use test_support::{from_hex, to_hex};

fn live() -> Value {
    serde_json::from_str(include_str!("fixtures/mpc_sign_live.json")).unwrap()
}

/// The key that signed `payload`, read from a `SignatureResponse` as the jar contract reads it:
/// r is `big_r` without its parity byte, and `recovery_id` picks the point.
fn recover(payload: &str, response: &Value) -> String {
    let big_r = from_hex(response["big_r"]["affine_point"].as_str().unwrap());
    let s = from_hex(response["s"]["scalar"].as_str().unwrap());
    let signature = Signature::from_slice(&[&big_r[1..33], &s[..]].concat()).unwrap();
    let recovery_id =
        RecoveryId::from_byte(response["recovery_id"].as_u64().unwrap() as u8).unwrap();
    let key =
        VerifyingKey::recover_from_prehash(&from_hex(payload), &signature, recovery_id).unwrap();
    let point = key.to_encoded_point(false);
    format!(
        "secp256k1:{}",
        near_sdk::bs58::encode(&point.as_bytes()[1..]).into_string()
    )
}

/// The shape of a JSON value: object keys and value kinds, with hex strings as their length.
fn shape(value: &Value) -> Value {
    match value {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), shape(v))).collect(),
        Value::String(s) => json!(format!("string of {}", s.len())),
        Value::Number(_) => json!("number"),
        other => other.clone(),
    }
}

#[tokio::test]
async fn the_live_response_recovers_the_live_derived_key() {
    let live = live();
    let payload = live["args"]["request"]["payload_v2"]["Ecdsa"]
        .as_str()
        .unwrap();

    assert_eq!(
        recover(payload, &live["response"]),
        live["derived_public_key"]
    );
}

#[tokio::test]
async fn the_stand_in_signs_in_the_live_shape_with_its_derived_key() {
    let live = live();
    let jars = deploy(Build::Locked).await;
    let payload = "3c367012deb0aada7a5dcfebafc2c1261a4daad127e64dcdf8ea4c85bfe348b8";

    let response: Value = jars
        .giver
        .call(jars.signer.id(), "sign")
        .args_json(json!({ "request": {
            "domain_id": 0, "path": "7", "payload_v2": { "Ecdsa": payload },
        }}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(15))
        .transact()
        .await
        .unwrap()
        .json()
        .unwrap();

    assert_eq!(shape(&response), shape(&live["response"]));
    let derived: String = jars
        .signer
        .view("derived_public_key")
        .args_json(json!({ "path": "7", "predecessor": jars.giver.id(), "domain_id": 0 }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(recover(payload, &response), derived);
}

#[tokio::test]
async fn the_stand_in_refuses_like_the_live_signer() {
    let jars = deploy(Build::Locked).await;
    let payload = to_hex(&[7; 32]);
    let sign = |domain: u64, tgas: u64, yocto: u128| {
        jars.giver
            .call(jars.signer.id(), "sign")
            .args_json(json!({ "request": {
                "domain_id": domain, "path": "1", "payload_v2": { "Ecdsa": payload },
            }}))
            .deposit(NearToken::from_yoctonear(yocto))
            .gas(Gas::from_tgas(tgas))
            .transact()
    };

    let unknown_domain = sign(3, 15, 1).await.unwrap();
    assert!(refusal(&unknown_domain).contains("The provided domain ID, 3, was not found."));
    // Domain first, then gas, then deposit.
    let low_gas = sign(0, 14, 0).await.unwrap();
    assert!(refusal(&low_gas).contains(
        "Provided gas is lower than required. Provided: 14000000000000, required: 15000000000000"
    ));
    let no_deposit = sign(0, 15, 0).await.unwrap();
    assert!(refusal(&no_deposit)
        .contains("Attached deposit is lower than required. Attached: 0, required: 1"));
}
