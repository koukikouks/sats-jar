//! Strays: a top-up sent to an address the jar has moved away from still counts, and anyone
//! moves it to the current address with `rehome_stray`, without holding up a handover. Bitcoin
//! Core's `testmempoolaccept` judges every sweep.

mod common;

use bitcoin::{Address, Network, ScriptBuf};
use common::*;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, Regtest};

/// The current address's scriptPubKey, from the witness script `get_jar` shows.
async fn current_script(jars: &Jars, jar_id: &str) -> ScriptBuf {
    let view = jars.get_jar(jar_id).await;
    ScriptBuf::from_bytes(from_hex(view["witness_script"].as_str().unwrap())).to_p2wsh()
}

async fn coin_of(jars: &Jars, jar_id: &str, txid: &str) -> Value {
    jars.get_coins(jar_id)
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|coin| coin["txid"] == txid)
        .unwrap_or_else(|| panic!("no coin from {txid}"))
        .clone()
}

fn balance(view: &Value) -> u64 {
    view["proven_balance"].as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn a_top_up_to_an_old_address_after_handover_counts_and_is_swept_to_the_current_address() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let before = balance(&jars.get_jar(&jar.id).await);
    assert_eq!(
        jars.get_jar(&jar.id).await["old_addresses"],
        json!([jar.address])
    );

    let stray = jars.confirmed_topup(&regtest, &jar.address, 20_000).await;
    jars.prove(&family.stranger, &jar.id, &stray)
        .await
        .into_result()
        .expect("stray proven");

    assert_eq!(
        coin_of(&jars, &jar.id, &stray.txid).await["status"],
        "confirmed"
    );
    assert_eq!(balance(&jars.get_jar(&jar.id).await), before + 20_000);

    let payment = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    assert_eq!(payment["kind"], "rehoming");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output.txid.to_string(), stray.txid);
    assert_eq!(tx.input[0].previous_output.vout, stray.funding.vout);
    assert_eq!(tx.output.len(), 1);
    let to = current_script(&jars, &jar.id).await;
    assert_eq!(tx.output[0].script_pubkey, to);
    assert_ne!(
        Address::from_script(&to, Network::Regtest)
            .unwrap()
            .to_string(),
        jar.address
    );

    jars.confirmed(&regtest, &payment)
        .await
        .into_result()
        .expect("sweep confirmed");
    assert_eq!(
        coin_of(&jars, &jar.id, &stray.txid).await["status"],
        "spent"
    );
    let swept = coin_of(&jars, &jar.id, payment["txid"].as_str().unwrap()).await;
    assert_eq!(swept["status"], "confirmed");
    let moved = tx.output[0].value.to_sat();
    assert_eq!(swept["value"], json!(moved.to_string()));
    assert_eq!(balance(&jars.get_jar(&jar.id).await), before + moved);
    let events = jars.history_events(&jar.id).await;
    assert_eq!(
        events[events.len() - 4..],
        [
            "topup_proven",
            "rehoming_requested",
            "payment_signed",
            "payment_confirmed"
        ]
    );
}

#[tokio::test]
async fn a_stray_proven_mid_window_does_not_hold_up_the_jar_and_is_swept_after() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[50_000]).await;
    let rehoming = jars.signed_rehoming(&family, &jar.id, 1).await;

    let stray = jars.confirmed_topup(&regtest, &jar.address, 20_000).await;
    jars.prove(&family.stranger, &jar.id, &stray)
        .await
        .into_result()
        .expect("stray proven");
    let completing = &jars.handover(&jar.id).await["completing"];
    assert_eq!(
        (
            completing["coins_to_move"].clone(),
            completing["coins_left"].clone()
        ),
        (json!(0), json!(1))
    );
    let early = jars.rehome_stray(&family.stranger, &jar.id, 1).await;
    let reason = refusal(&early);
    assert!(reason.contains("REHOMING_IN_PROGRESS: "), "{reason}");

    jars.confirmed(&regtest, &rehoming)
        .await
        .into_result()
        .expect("re-homing confirmed");
    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["owner_id"], json!(family.child.id()));
    assert_eq!(
        view["handover"]["done"]["child_account"],
        json!(family.child.id())
    );
    assert_eq!(
        coin_of(&jars, &jar.id, &stray.txid).await["status"],
        "confirmed"
    );

    let sweep = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    let raw = from_hex(sweep["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output.txid.to_string(), stray.txid);
    assert_eq!(
        tx.output[0].script_pubkey,
        current_script(&jars, &jar.id).await
    );
}

#[tokio::test]
async fn a_top_up_whose_proof_lands_after_the_jar_moved_counts_at_the_address_it_paid() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[50_000]).await;
    // Checked against the jar's address while it is still the current one...
    let topup = jars.confirmed_topup(&regtest, &jar.address, 20_000).await;
    jars.hold_light_client(true).await;
    let proving = jars.prove_in_flight(&jar.id, &topup).await;
    jars.hold_light_client(false).await;

    // ...which the first complete_handover moves away from before the proof's callback runs.
    let rehoming = jars.signed_rehoming(&family, &jar.id, 1).await;
    jars.release_light_client().await;
    proving
        .await
        .expect("prove_topup outcome")
        .into_result()
        .expect("top-up proven");

    assert_eq!(
        coin_of(&jars, &jar.id, &topup.txid).await["status"],
        "confirmed"
    );
    assert_eq!(jars.handover(&jar.id).await["completing"]["coins_left"], 1);
    jars.confirmed(&regtest, &rehoming)
        .await
        .into_result()
        .expect("re-homing confirmed");
    assert_eq!(
        jars.get_jar(&jar.id).await["owner_id"],
        json!(family.child.id())
    );

    // A stray signed with its own (old) address's script: Core accepts it.
    let sweep = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    let raw = from_hex(sweep["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output.txid.to_string(), topup.txid);
}

/// The fee a signed payment leaves (its inputs' values minus its outputs'), given its inputs'
/// total, and Core's vsize for it.
fn fee_and_vsize(regtest: &Regtest, payment: &Value, inputs: u64) -> (u64, u64) {
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let paid: u64 = decode(&raw).output.iter().map(|o| o.value.to_sat()).sum();
    (inputs - paid, verdict["vsize"].as_u64().unwrap())
}

#[tokio::test]
async fn a_stray_sweep_pays_at_most_five_percent_or_the_cost_at_one_sat_per_vbyte() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;

    // A single small stray: 5% of 1,000 is less than its cost, so it moves at 1 sat/vB only.
    jars.proven_topup(&regtest, &jar.id, &jar.address, 1_000)
        .await;
    let two = jars.rehome_stray(&family.stranger, &jar.id, 2).await;
    let reason = refusal(&two);
    assert!(reason.contains("FEE_TOO_HIGH: "), "{reason}");
    let small = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    let (fee, vsize) = fee_and_vsize(&regtest, &small, 1_000);
    // The contract sizes a 72-byte signature; Core measures the real one, at most a byte shorter
    // in a quarter-weight witness.
    assert!(
        fee >= vsize && fee <= vsize + 1,
        "fee {fee} for {vsize} vbytes"
    );

    // Three larger strays move together within 5% of their value.
    for _ in 0..3 {
        jars.proven_topup(&regtest, &jar.id, &jar.address, 50_000)
            .await;
    }
    // 100 sat/vB on three inputs is far over 5% of the 150,000 sats moved.
    let too_high = jars.rehome_stray(&family.stranger, &jar.id, 100).await;
    let reason = refusal(&too_high);
    assert!(reason.contains("FEE_TOO_HIGH: "), "{reason}");
    let large = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 20)
        .await;
    assert_eq!(large["inputs"].as_array().unwrap().len(), 3);
    let (fee, vsize) = fee_and_vsize(&regtest, &large, 150_000);
    assert!(fee <= 150_000 * 5 / 100, "fee {fee}");
    assert!(fee >= 20 * vsize, "fee {fee} for {vsize} vbytes");
}

#[tokio::test]
async fn eleven_strays_sweep_in_payments_of_at_most_ten_coins() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let mut strays = Vec::new();
    for _ in 0..11 {
        let topup = jars.confirmed_topup(&regtest, &jar.address, 2_000).await;
        jars.prove(&jars.giver, &jar.id, &topup)
            .await
            .into_result()
            .expect("stray proven");
        strays.push(format!("{}:{}", topup.txid, topup.funding.vout));
    }

    let first = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    // At once, with the first unconfirmed: only the stray it did not take is left.
    let second = jars
        .signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;

    let mut spent = Vec::new();
    for (payment, count) in [(&first, 10), (&second, 1)] {
        let raw = from_hex(payment["signed_tx"].as_str().unwrap());
        assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
        let tx = decode(&raw);
        assert_eq!(tx.input.len(), count);
        spent.extend(tx.input.iter().map(|i| i.previous_output.to_string()));
    }
    spent.sort();
    strays.sort();
    assert_eq!(spent, strays);
}

#[tokio::test]
async fn rehome_stray_is_refused_without_a_stray_to_move_or_a_fee_rate_or_gas() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let never_moved = jars.funded_jar(&regtest, &[5_000]).await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;

    let unknown = jars.rehome_stray(&family.stranger, "99", 1).await;
    let reason = refusal(&unknown);
    assert!(reason.contains("UNKNOWN_JAR: "), "{reason}");
    for jar_id in [&never_moved.id, &jar.id] {
        let none = jars.rehome_stray(&family.stranger, jar_id, 1).await;
        let reason = refusal(&none);
        assert!(reason.contains("NO_STRAYS: "), "{reason}");
    }

    jars.proven_topup(&regtest, &jar.id, &jar.address, 5_000)
        .await;
    let zero = jars.rehome_stray(&family.stranger, &jar.id, 0).await;
    let reason = refusal(&zero);
    assert!(reason.contains("FEE_TOO_LOW: "), "{reason}");
    let short = jars
        .rehome_stray_with_gas(
            &family.stranger,
            &jar.id,
            1,
            near_workspaces::types::Gas::from_tgas(40),
        )
        .await;
    let reason = refusal(&short);
    assert!(reason.contains("NOT_ENOUGH_GAS: "), "{reason}");

    // Its only stray already in a sweep, the jar has none left to move.
    jars.signed_stray_rehoming(&family.stranger, &jar.id, 1)
        .await;
    let again = jars.rehome_stray(&family.stranger, &jar.id, 1).await;
    let reason = refusal(&again);
    assert!(reason.contains("NO_STRAYS: "), "{reason}");
}
