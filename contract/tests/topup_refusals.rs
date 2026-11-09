//! Every way `prove_topup` refuses, each with its readable reason and nothing counted.

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::Gas;
use test_support::serde_json::{self, json, Value};
use test_support::{from_hex, Regtest};

/// A regtest contract with jar "1" and its address.
async fn jar_on_regtest() -> (Jars, String) {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    let address = jars.get_jar("1").await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    (jars, address)
}

/// The call was refused with `code` and the jar counted nothing.
async fn assert_refused(jars: &Jars, result: &ExecutionFinalResult, code: &str) -> String {
    let reason = refusal(result);
    assert!(
        reason.contains(&format!("{code}: ")),
        "expected {code}, got {reason}"
    );
    assert_nothing_counted(jars).await;
    reason
}

async fn assert_nothing_counted(jars: &Jars) {
    assert_eq!(jars.get_coins("1").await, json!([]));
    let jar = jars.get_jar("1").await;
    assert_eq!(jar["proven_balance"], json!("0"));
    assert_eq!(jar["clock"], json!({ "started_at": null }));
}

#[tokio::test]
async fn a_top_up_without_three_confirmations_is_refused_with_its_count() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;
    let height = regtest.rpc("getblockheader", &[json!(topup.block)])["height"]
        .as_u64()
        .unwrap();

    // Confirmations = tip − height + 1.
    for (tip, count) in [(height, 1), (height + 1, 2)] {
        jars.set_tip(tip).await;
        let result = jars.prove(&jars.giver, "1", &topup).await;
        let reason = assert_refused(&jars, &result, "NOT_CONFIRMED").await;
        assert!(
            reason.contains(&format!("{count} of 3 confirmations")),
            "{reason}"
        );
    }
    jars.set_tip(height + 2).await;
    jars.prove(&jars.giver, "1", &topup)
        .await
        .into_result()
        .unwrap();
    assert_eq!(jars.get_jar("1").await["proven_balance"], json!("50000"));
}

/// Flips the low bit of the first byte of a display-hex hash.
fn tamper(hash: &Value) -> Value {
    let text = hash.as_str().unwrap();
    let first = u8::from_str_radix(&text[..2], 16).unwrap() ^ 1;
    json!(format!("{first:02x}{}", &text[2..]))
}

#[tokio::test]
async fn a_top_up_the_light_client_does_not_find_in_its_main_chain_is_refused() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;

    let mut unknown_block = topup.proof.clone();
    unknown_block["tx_block_blockhash"] = tamper(&topup.proof["tx_block_blockhash"]);
    let mut wrong_sibling = topup.proof.clone();
    wrong_sibling["merkle_proof"][0] = tamper(&topup.proof["merkle_proof"][0]);
    let mut bad_coinbase_proof = topup.proof.clone();
    bad_coinbase_proof["coinbase_merkle_proof"][0] =
        tamper(&topup.proof["coinbase_merkle_proof"][0]);

    for proof in [unknown_block, wrong_sibling, bad_coinbase_proof] {
        let result = jars
            .prove_topup(
                &jars.giver,
                "1",
                &topup.funding.raw_tx,
                topup.funding.vout,
                &proof,
            )
            .await;
        assert_refused(&jars, &result, "NOT_IN_CHAIN").await;
    }

    jars.set_paused(true).await;
    let result = jars.prove(&jars.giver, "1", &topup).await;
    assert_refused(&jars, &result, "NOT_IN_CHAIN").await;
    jars.set_paused(false).await;
    jars.prove(&jars.giver, "1", &topup)
        .await
        .into_result()
        .unwrap();
}

/// The raw transaction (hex) of a confirmed `txid` in `block`, as Core serialises it.
fn core_tx(regtest: &Regtest, txid: &str, block: &str) -> Value {
    regtest.rpc(
        "getrawtransaction",
        &[json!(txid), json!(true), json!(block)],
    )
}

#[tokio::test]
async fn a_top_up_whose_bytes_or_proof_do_not_match_is_refused_before_the_light_client() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;
    let (raw, vout) = (&topup.funding.raw_tx, topup.funding.vout);
    let block = regtest.rpc("getblock", &[json!(topup.block), json!(2)]);
    let coinbase = &block["tx"][0];
    let wtxid = core_tx(&regtest, &topup.txid, &topup.block)["hash"].clone();
    assert_ne!(json!(topup.txid), wtxid, "a segwit funding tx");

    let refused = |proof: Value, raw: Vec<u8>, vout: u32, jar: &'static str| {
        let jars = &jars;
        async move { jars.prove_topup(&jars.giver, jar, &raw, vout, &proof).await }
    };
    let with = |field: &str, value: Value| {
        let mut proof = topup.proof.clone();
        proof[field] = value;
        proof
    };

    let cases: Vec<(&str, Value, Vec<u8>, u32, &'static str)> = vec![
        ("UNKNOWN_JAR", topup.proof.clone(), raw.clone(), vout, "7"),
        (
            "INVALID_TX",
            topup.proof.clone(),
            b"not a transaction".to_vec(),
            vout,
            "1",
        ),
        (
            "INVALID_TX",
            topup.proof.clone(),
            raw[..raw.len() - 1].to_vec(),
            vout,
            "1",
        ),
        (
            "INVALID_PROOF",
            with("tx_block_blockhash", json!("00ff")),
            raw.clone(),
            vout,
            "1",
        ),
        (
            "PROOF_TX_MISMATCH",
            with("tx_id", coinbase["txid"].clone()),
            raw.clone(),
            vout,
            "1",
        ),
        (
            "PROOF_TX_MISMATCH",
            with("tx_id", wtxid),
            raw.clone(),
            vout,
            "1",
        ),
        // A coinbase that pays no jar reads COINBASE; a mismatched proof of one reads PROOF_TX_MISMATCH.
        (
            "COINBASE",
            with("tx_id", coinbase["txid"].clone()),
            from_hex(coinbase["hex"].as_str().unwrap()),
            0,
            "1",
        ),
        (
            "PROOF_TX_MISMATCH",
            topup.proof.clone(),
            from_hex(coinbase["hex"].as_str().unwrap()),
            0,
            "1",
        ),
        (
            "BAD_TX_INDEX",
            with("tx_index", json!(0)),
            raw.clone(),
            vout,
            "1",
        ),
        (
            "BAD_TX_INDEX",
            with(
                "tx_index",
                json!(1u64 << topup.proof["merkle_proof"].as_array().unwrap().len()),
            ),
            raw.clone(),
            vout,
            "1",
        ),
        // A proof deeper than any block (2^32 transactions) cannot place the transaction.
        (
            "BAD_TX_INDEX",
            {
                let mut proof = with(
                    "merkle_proof",
                    json!(vec![topup.proof["merkle_proof"][0].clone(); 64]),
                );
                proof["coinbase_merkle_proof"] = proof["merkle_proof"].clone();
                proof["tx_index"] = json!(u64::MAX);
                proof
            },
            raw.clone(),
            vout,
            "1",
        ),
    ];
    for (code, proof, raw, vout, jar) in cases {
        let result = refused(proof, raw, vout, jar).await;
        assert_refused(&jars, &result, code).await;
    }
}

#[tokio::test]
async fn an_output_that_does_not_pay_this_jar_or_is_below_the_dust_floor_is_refused() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    let jar_2 = jars.get_jar("2").await["address"]
        .as_str()
        .unwrap()
        .to_owned();

    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;
    let outputs = core_tx(&regtest, &topup.txid, &topup.block)["vout"]
        .as_array()
        .unwrap()
        .len() as u32;
    let change = (0..outputs).find(|&v| v != topup.funding.vout).unwrap();
    let raw = &topup.funding.raw_tx;
    for vout in [outputs, change] {
        let result = jars
            .prove_topup(&jars.giver, "1", raw, vout, &topup.proof)
            .await;
        assert_refused(&jars, &result, "NOT_TO_JAR").await;
    }
    let to_jar_2 = jars.confirmed_topup(&regtest, &jar_2, 50_000).await;
    let result = jars.prove(&jars.giver, "1", &to_jar_2).await;
    assert_refused(&jars, &result, "NOT_TO_JAR").await;

    // The floor is 1,000 sats: 999 is refused, 1,000 counts.
    let dust = jars.confirmed_topup(&regtest, &address, 999).await;
    let result = jars.prove(&jars.giver, "1", &dust).await;
    let reason = assert_refused(&jars, &result, "BELOW_DUST").await;
    assert!(reason.contains("999 sats"), "{reason}");
    let floor = jars.confirmed_topup(&regtest, &address, 1_000).await;
    jars.prove(&jars.giver, "1", &floor)
        .await
        .into_result()
        .unwrap();
    assert_eq!(jars.get_jar("1").await["proven_balance"], json!("1000"));
}

#[tokio::test]
async fn a_coin_already_counted_is_refused_however_it_is_proven_again() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;

    // Sent at once from two accounts: both pass the first checks, the light client answers
    // both, and the second callback finds the coin already counted.
    let keeper = new_account(&jars.worker, "keeper").await;
    let call = |caller: &near_workspaces::Account| {
        caller
            .call(jars.contract.id(), "prove_topup")
            .args_json(json!({
                "jar_id": "1",
                "tx": test_support::to_hex(&topup.funding.raw_tx),
                "vout": topup.funding.vout,
                "proof": topup.proof,
            }))
            .max_gas()
            .transact_async()
    };
    let (first, second) = (
        call(&jars.giver).await.unwrap(),
        call(&keeper).await.unwrap(),
    );
    let results = [first.await.unwrap(), second.await.unwrap()];
    let refused: Vec<_> = results.iter().filter(|r| r.is_failure()).collect();
    assert_eq!(refused.len(), 1, "exactly one of two racing proofs counts");
    assert!(refusal(refused[0]).contains("COIN_ALREADY_KNOWN: "));
    assert!(
        refused[0]
            .outcomes()
            .iter()
            .any(|o| o.executor_id.as_str() == LIGHT_CLIENT),
        "the losing proof reached the light client, so the callback refused it"
    );
    assert_eq!(jars.get_coins("1").await.as_array().unwrap().len(), 1);

    // Proven again later, even with too little gas: still the same coin.
    for gas in [Gas::from_tgas(300), Gas::from_tgas(10)] {
        let result = jars
            .prove_topup_with_gas(
                &jars.giver,
                "1",
                &topup.funding.raw_tx,
                topup.funding.vout,
                &topup.proof,
                gas,
            )
            .await;
        assert!(refusal(&result).contains("COIN_ALREADY_KNOWN: "));
    }
    assert_eq!(jars.get_jar("1").await["proven_balance"], json!("50000"));
}

#[tokio::test]
async fn two_jar_outputs_of_one_transaction_are_two_coins() {
    let regtest = Regtest::start();
    let (jars, address_1) = jar_on_regtest().await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    let address_2 = jars.get_jar("2").await["address"]
        .as_str()
        .unwrap()
        .to_owned();

    let txid = regtest.rpc(
        "sendmany",
        &[
            json!(""),
            json!({ address_1.clone(): 0.0002, address_2.clone(): 0.0003 }),
        ],
    );
    let txid = txid.as_str().unwrap().to_owned();
    regtest.mine(3);
    let block = block_of(&regtest, &txid);
    let tip = regtest.rpc("getblockcount", &[]).as_u64().unwrap();
    jars.register_block(&regtest, &block, tip).await;
    let tx = core_tx(&regtest, &txid, &block);
    let raw = from_hex(tx["hex"].as_str().unwrap());
    let proof = topup_proof(&regtest, &block, &txid);
    let vout_of = |address: &str| {
        tx["vout"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["scriptPubKey"]["address"] == json!(address))
            .unwrap()["n"]
            .as_u64()
            .unwrap() as u32
    };

    for (jar, address, sats) in [("1", &address_1, "20000"), ("2", &address_2, "30000")] {
        jars.prove_topup(&jars.giver, jar, &raw, vout_of(address), &proof)
            .await
            .into_result()
            .unwrap();
        assert_eq!(jars.get_jar(jar).await["proven_balance"], json!(sats));
    }
}

/// What `prove_topup` asks callers to attach: 20 Tgas for the light client, 20 Tgas for the
/// callback, 20 Tgas for the checks.
const PROVE_TOPUP_GAS: u64 = 60_000_000_000_000;

#[tokio::test]
async fn a_proof_with_too_little_gas_for_the_light_client_and_callback_is_refused() {
    let regtest = Regtest::start();
    let (jars, address) = jar_on_regtest().await;
    let topup = jars.confirmed_topup(&regtest, &address, 50_000).await;
    let short = jars
        .prove_topup_with_gas(
            &jars.giver,
            "1",
            &topup.funding.raw_tx,
            topup.funding.vout,
            &topup.proof,
            Gas::from_gas(PROVE_TOPUP_GAS - 1),
        )
        .await;
    let reason = assert_refused(&jars, &short, "NOT_ENOUGH_GAS").await;
    assert!(reason.contains("attach at least 60 Tgas"), "{reason}");

    // At the floor it counts, even for a large transaction (300 outputs, about 10 kB).
    let mut outputs = serde_json::Map::new();
    outputs.insert(address.clone(), json!(0.0005));
    for _ in 0..299 {
        outputs.insert(regtest.new_address(), json!(0.00001));
    }
    let txid = regtest.rpc("sendmany", &[json!(""), Value::Object(outputs)]);
    let txid = txid.as_str().unwrap().to_owned();
    regtest.mine(3);
    let block = block_of(&regtest, &txid);
    let tip = regtest.rpc("getblockcount", &[]).as_u64().unwrap();
    jars.register_block(&regtest, &block, tip).await;
    let tx = core_tx(&regtest, &txid, &block);
    let raw = from_hex(tx["hex"].as_str().unwrap());
    assert!(raw.len() > 9_000, "{} bytes", raw.len());
    let vout = tx["vout"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["scriptPubKey"]["address"] == json!(address))
        .unwrap()["n"]
        .as_u64()
        .unwrap() as u32;
    let proof = topup_proof(&regtest, &block, &txid);
    let counted = jars
        .prove_topup_with_gas(
            &jars.giver,
            "1",
            &raw,
            vout,
            &proof,
            Gas::from_gas(PROVE_TOPUP_GAS),
        )
        .await;
    counted.into_result().unwrap();
    assert_eq!(jars.get_jar("1").await["proven_balance"], json!("50000"));
}
