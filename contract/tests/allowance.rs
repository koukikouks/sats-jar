//! The money moment: the contract builds the period's allowance from the jar's own coins, the
//! signer signs each input, and Bitcoin Core accepts the signed transaction. Core's
//! `testmempoolaccept` (allowed, vsize, fee) is the judge; rust-bitcoin reads the outputs.

mod common;

use common::*;
use test_support::{from_hex, Regtest};

/// Core's verdict on a signed payment spending `spent` sats: allowed, with a fee rate of at
/// least `fee_rate` on Core's own size. Returns the fee in sats.
fn accepted_at(regtest: &Regtest, raw: &[u8], spent: u64, fee_rate: u64) -> u64 {
    let verdict = core_verdict(regtest, raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let paid: u64 = decode(raw).output.iter().map(|o| o.value.to_sat()).sum();
    let fee = spent - paid;
    let vsize = verdict["vsize"].as_u64().unwrap();
    assert!(fee >= fee_rate * vsize, "{fee} sats for {vsize} vB");
    fee
}

#[tokio::test]
async fn an_allowance_pays_the_child_the_cap_with_change_back_to_the_jar() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;

    let payment = jars.signed_allowance(&jar.id, 2).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let fee = accepted_at(&regtest, &raw, 50_000, 2);
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.output.len(), 2);
    assert_eq!(tx.output[0].script_pubkey, jar.child_script());
    assert_eq!(tx.output[0].value.to_sat(), CAP);
    assert_eq!(tx.output[1].script_pubkey, jar.jar_script());
    // The fee comes from the jar: the child still receives the whole cap.
    assert_eq!(tx.output[1].value.to_sat(), 50_000 - CAP - fee);
    assert_eq!(payment["fee"], fee.to_string());
    assert_eq!(payment["amount"], CAP.to_string());
    assert_eq!(payment["change"], (50_000 - CAP - fee).to_string());
}

#[tokio::test]
async fn a_jar_holding_less_than_the_cap_pays_all_it_has_without_change() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[20_100]).await;

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let fee = accepted_at(&regtest, &raw, 20_100, 1);
    let tx = decode(&raw);
    assert_eq!(tx.output.len(), 1);
    assert_eq!(tx.output[0].script_pubkey, jar.child_script());
    assert_eq!(tx.output[0].value.to_sat(), 20_100 - fee);
    assert!(tx.output[0].value.to_sat() < CAP);
}

#[tokio::test]
async fn a_change_too_small_to_keep_takes_the_next_coin_instead() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    // 20,500 alone pays the cap but leaves change under the dust floor.
    let jar = jars.funded_jar(&regtest, &[1_500, 20_500]).await;

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let fee = accepted_at(&regtest, &raw, 22_000, 1);
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 2);
    assert_eq!(tx.output[0].value.to_sat(), CAP);
    assert_eq!(tx.output[1].script_pubkey, jar.jar_script());
    assert_eq!(tx.output[1].value.to_sat(), 22_000 - CAP - fee);
}

#[tokio::test]
async fn several_inputs_pay_the_cap_with_change() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[6_000, 12_000, 9_000]).await;

    let payment = jars.signed_allowance(&jar.id, 2).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let fee = accepted_at(&regtest, &raw, 27_000, 2);
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 3);
    assert_eq!(tx.output[0].value.to_sat(), CAP);
    assert_eq!(tx.output[1].value.to_sat(), 27_000 - CAP - fee);
}

#[tokio::test]
async fn a_payment_spends_at_most_the_ten_largest_coins() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let coins: Vec<u64> = (0..11).map(|i| 1_500 + 100 * i).collect();
    let jar = jars.funded_jar(&regtest, &coins).await;

    let payment = jars.signed_allowance(&jar.id, 1).await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    // The ten largest: 1,600 to 2,500 sats.
    let fee = accepted_at(&regtest, &raw, 20_500, 1);
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 10);
    assert_eq!(tx.output.len(), 1);
    assert_eq!(tx.output[0].value.to_sat(), 20_500 - fee);
    let left: Vec<_> = jars
        .get_coins(&jar.id)
        .await
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["status"] == "confirmed")
        .map(|c| c["value"].clone())
        .collect();
    assert_eq!(left, vec!["1500"]);
}

#[tokio::test]
async fn a_confirmed_allowance_spends_its_inputs_and_counts_its_change() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    let payment = jars.signed_allowance(&jar.id, 2).await;
    let id = payment["payment_id"].as_str().unwrap();
    let coins = jars.get_coins(&jar.id).await;
    assert_eq!(coins[0]["status"], "reserved");
    assert_eq!(coins[0]["payment_id"], id);

    let proof = jars.mine_payment(&regtest, &payment).await;
    jars.confirm_payment(id, &proof)
        .await
        .into_result()
        .unwrap();

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let change = decode(&raw).output[1].value.to_sat();
    let coins = jars.get_coins(&jar.id).await;
    assert_eq!(coins[0]["status"], "spent");
    assert_eq!(coins[0]["payment_id"], id);
    assert_eq!(coins[1]["txid"], payment["txid"]);
    assert_eq!(coins[1]["vout"], 1);
    assert_eq!(coins[1]["value"], change.to_string());
    assert_eq!(coins[1]["status"], "confirmed");
    assert_eq!(jars.get_payment(id).await["status"], "confirmed");
    assert_eq!(
        jars.get_jar(&jar.id).await["proven_balance"],
        change.to_string()
    );

    // Its change counted once, through confirm_payment; never again as a top-up.
    let as_topup = jars
        .prove_topup(&jars.giver, &jar.id, &raw, 1, &proof)
        .await;
    assert!(refusal(&as_topup).contains("OWN_PAYMENT_TX: "));
}
