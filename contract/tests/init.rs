//! Network settings are init arguments, set once, by the contract account only.

mod common;

use common::*;
use test_support::serde_json::json;

#[tokio::test]
async fn only_the_contract_account_can_initialise_it_and_only_once() {
    let jars = deploy(Build::Locked).await;
    let by_someone_else = jars
        .giver
        .call(jars.contract.id(), "new")
        .args_json(json!({
            "mpc_contract": MPC_CONTRACT,
            "mpc_root_public_key": LIVE_MPC_ROOT_KEY,
            "light_client": LIGHT_CLIENT,
            "network": "regtest",
        }))
        .transact()
        .await
        .unwrap();
    assert!(refusal(&by_someone_else).contains("is private"));

    init(&jars.contract, "regtest").await.into_result().unwrap();
    let again = init(&jars.contract, "testnet").await;
    let reason = refusal(&again);
    assert!(reason.contains("already been initialized"), "{reason}");
}

#[tokio::test]
async fn an_mpc_root_key_that_is_not_a_secp256k1_point_is_refused() {
    // x = y = 1 is not on the curve (libsecp256k1 agrees).
    let mut uncompressed = vec![0x04];
    uncompressed.extend([1u8; 64]);
    assert!(bitcoin::secp256k1::PublicKey::from_slice(&uncompressed).is_err());
    let off_curve = format!("secp256k1:{}", bitcoin::base58::encode(&[1u8; 64]));
    let ed25519 = "ed25519:6j4b6zUaty6fD1awqcGCCU9JYGCWYUgdJhQrzfZhqE25";

    for key in [off_curve.as_str(), ed25519] {
        let jars = deploy(Build::Locked).await;
        let result = jars
            .contract
            .call("new")
            .args_json(json!({
                "mpc_contract": MPC_CONTRACT,
                "mpc_root_public_key": key,
                "light_client": LIGHT_CLIENT,
                "network": "regtest",
            }))
            .transact()
            .await
            .unwrap();
        assert!(refusal(&result).contains("BAD_MPC_ROOT_KEY: "), "{key}");
    }
}
