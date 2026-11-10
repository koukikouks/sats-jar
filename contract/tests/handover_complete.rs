//! Handover completes: after the public delay and the unlock date anyone re-homes the jar's coins
//! to a new jar address whose exit branch is the child's key, and once every coin fixed at the
//! first call has moved and been confirmed, the jar NFT moves to the child's account. Bitcoin
//! Core's `testmempoolaccept` judges every re-homing payment.

mod common;

use bitcoin::{Address, Network, ScriptBuf};
use common::*;
use near_workspaces::types::NearToken;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, sats, Regtest};

#[tokio::test]
async fn after_the_delay_and_unlock_anyone_rehomes_the_coins_and_the_jar_moves_to_the_child() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[50_000]).await;
    let coin = jars.get_coins(&jar.id).await[0].clone();

    let payment = jars.signed_rehoming(&family, &jar.id, 1).await;

    assert_eq!(payment["kind"], "rehoming");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let view = jars.get_jar(&jar.id).await;
    let script = ScriptBuf::from_bytes(from_hex(view["witness_script"].as_str().unwrap()));
    let new_address = Address::p2wsh(&script, Network::Regtest).to_string();
    assert_eq!(view["address"], json!(new_address));
    assert_ne!(new_address, jar.address);
    assert_eq!(view["old_addresses"], json!([jar.address]));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output.txid.to_string(), coin["txid"]);
    assert_eq!(tx.output.len(), 1);
    assert_eq!(tx.output[0].script_pubkey, script.to_p2wsh());
    assert_eq!(view["owner_id"], json!(family.parent.id()));

    jars.confirmed(&regtest, &payment)
        .await
        .into_result()
        .expect("confirmed");

    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["owner_id"], json!(family.child.id()));
    assert_eq!(
        view["handover"]["done"]["child_account"],
        json!(family.child.id())
    );
    let events = jars.history_events(&jar.id).await;
    assert_eq!(
        events[events.len() - 5..],
        [
            "rehoming_started",
            "rehoming_requested",
            "payment_signed",
            "payment_confirmed",
            "handover_completed"
        ]
    );
    let history = jars.get_history(&jar.id, 0, 100).await;
    let started = &history[events.len() - 5];
    assert_eq!(started["address"], json!(new_address));
    assert_eq!(started["locktime"], view["locktime"]);
    assert_eq!(started["coins"], 1);
}

#[tokio::test]
async fn ten_coins_rehome_in_one_payment_whose_fee_stays_within_five_percent() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[50_000; 10]).await;

    // 100 sat/vB on ~800 vbytes is far over 5% of the 500,000 sats moved.
    let too_high = jars.complete_handover(&family.stranger, &jar.id, 100).await;
    let reason = refusal(&too_high);
    assert!(reason.contains("FEE_TOO_HIGH: "), "{reason}");

    let payment = jars.signed_rehoming(&family, &jar.id, 20).await;
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(&regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let fee = sats(&verdict["fees"]["base"]);
    let vsize = verdict["vsize"].as_u64().unwrap();
    assert!(fee <= 500_000 * 5 / 100, "fee {fee}");
    assert!(fee >= 20 * vsize, "fee {fee} for {vsize} vbytes");
    assert_eq!(decode(&raw).input.len(), 10);

    jars.confirmed(&regtest, &payment)
        .await
        .into_result()
        .expect("confirmed");
    assert_eq!(
        jars.get_jar(&jar.id).await["owner_id"],
        json!(family.child.id())
    );
}

#[tokio::test]
async fn the_confirmation_that_moves_the_jar_fits_the_minimum_gas_with_fifty_free_coins() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[50_000]).await;
    let payment = jars.signed_rehoming(&family, &jar.id, 1).await;
    // Top-ups to the new address during the window fill the free list the callback rewrites.
    let new_address = jars.get_jar(&jar.id).await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..50 {
        let topup = jars.confirmed_topup(&regtest, &new_address, 1_000).await;
        jars.prove(&jars.giver, &jar.id, &topup)
            .await
            .into_result()
            .expect("top-up proven");
    }

    let proof = jars.mine_payment(&regtest, &payment).await;
    let confirmed = jars
        .giver
        .call(jars.contract.id(), "confirm_payment")
        .args_json(json!({ "payment_id": payment["payment_id"], "proof": proof }))
        .gas(near_workspaces::types::Gas::from_tgas(60))
        .transact()
        .await
        .expect("send confirm_payment");

    confirmed.into_result().expect("confirmed at 60 Tgas");
    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["owner_id"], json!(family.child.id()));
    assert_eq!(jars.get_coins(&jar.id).await.as_array().unwrap().len(), 52);
}

/// The coin with display txid `txid` in the jar's `get_coins` page.
async fn coin_of(jars: &Jars, jar_id: &str, txid: &str) -> test_support::serde_json::Value {
    jars.get_coins(jar_id)
        .await
        .as_array()
        .unwrap()
        .iter()
        .find(|coin| coin["txid"] == txid)
        .unwrap_or_else(|| panic!("no coin from {txid}"))
        .clone()
}

#[tokio::test]
async fn more_than_ten_coins_rehome_one_payment_at_a_time_down_to_a_single_small_coin() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut coins = vec![5_000; 10];
    coins.push(1_000);
    let jar = jars.due_handover(&regtest, &family, &coins).await;
    let small = jars.get_coins(&jar.id).await[10].clone();

    // The first payment moves the 10 largest; the rest wait for it to be confirmed.
    let first = jars.signed_rehoming(&family, &jar.id, 1).await;
    let raw = from_hex(first["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 10);
    assert!(tx
        .input
        .iter()
        .all(|input| input.previous_output.txid.to_string() != small["txid"]));
    let completing = &jars.handover(&jar.id).await["completing"];
    assert_eq!(
        (
            completing["coins_to_move"].clone(),
            completing["coins_left"].clone()
        ),
        (json!(1), json!(11))
    );
    let pending = jars.complete_handover(&family.stranger, &jar.id, 1).await;
    assert!(refusal(&pending).contains("PAYMENT_PENDING: "));

    // The window: no allowance, no cancel, no new claim; a top-up to the new address counts.
    let allowance = jars.request_allowance(&jar.id, 1).await;
    assert!(refusal(&allowance).contains("HANDOVER_IN_PROGRESS: "));
    for result in [
        jars.cancel(&family.guardians[0], &jar.id).await,
        jars.cancel(&family.child, &jar.id).await,
        jars.claim(&family.stranger, &jar.id, CHILD_BTC_KEY).await,
    ] {
        let reason = refusal(&result);
        assert!(reason.contains("HANDOVER_COMPLETING: "), "{reason}");
    }
    let new_address = jars.get_jar(&jar.id).await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    let late = jars.confirmed_topup(&regtest, &new_address, 3_000).await;
    jars.prove(&jars.giver, &jar.id, &late)
        .await
        .into_result()
        .expect("top-up proven");

    jars.confirmed(&regtest, &first)
        .await
        .into_result()
        .expect("confirmed");
    assert_eq!(
        jars.get_jar(&jar.id).await["owner_id"],
        json!(family.parent.id())
    );

    // The single small coin moves alone at 1 sat/vB: 5% of it is less than its cost.
    let two = jars.complete_handover(&family.stranger, &jar.id, 2).await;
    let reason = refusal(&two);
    assert!(reason.contains("FEE_TOO_HIGH: "), "{reason}");
    let last = jars.signed_rehoming(&family, &jar.id, 1).await;
    let raw = from_hex(last["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(tx.input[0].previous_output.txid.to_string(), small["txid"]);
    // The coins picked were taken off the free list by index, the larger ones left in it.
    let completing = &jars.handover(&jar.id).await["completing"];
    assert_eq!(
        (
            completing["coins_to_move"].clone(),
            completing["coins_left"].clone()
        ),
        (json!(0), json!(1))
    );

    jars.confirmed(&regtest, &last)
        .await
        .into_result()
        .expect("confirmed");
    assert_eq!(
        jars.get_jar(&jar.id).await["owner_id"],
        json!(family.child.id())
    );
    let first_txid = first["txid"].as_str().unwrap();
    assert_eq!(
        coin_of(&jars, &jar.id, first_txid).await["status"],
        "confirmed"
    );
    assert_eq!(
        coin_of(&jars, &jar.id, &late.txid).await["status"],
        "confirmed"
    );
    assert_eq!(
        coin_of(&jars, &jar.id, small["txid"].as_str().unwrap()).await["status"],
        "spent"
    );
}

#[tokio::test]
async fn completion_waits_for_a_pending_allowance_and_enough_gas() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    let unlock_at = now(&jars.worker).await + 240;
    args["unlock_at"] = json!(unlock_at.to_string());
    let jar = jars
        .funded_jar_with(&regtest, args, &[50_000, 50_000])
        .await;
    jars.confirmed_claim(&family, &jar.id).await;
    // Signed during the delay, not yet confirmed when the delay ends.
    let allowance = jars.signed_allowance(&jar.id, 1).await;
    let delay_ends_at: u64 = jars.handover(&jar.id).await["confirmed"]["delay_ends_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    jars.wait_until(delay_ends_at.max(unlock_at)).await;

    let pending = jars.complete_handover(&family.stranger, &jar.id, 1).await;
    let reason = refusal(&pending);
    assert!(reason.contains("PAYMENT_PENDING: "), "{reason}");

    jars.confirmed(&regtest, &allowance)
        .await
        .into_result()
        .expect("allowance confirmed");
    // Two coins (a top-up and the allowance's change) need 2 x 15 + 30 + 20 Tgas.
    let short = jars
        .complete_handover_with_gas(
            &family.stranger,
            &jar.id,
            1,
            near_workspaces::types::Gas::from_tgas(79),
        )
        .await;
    let reason = refusal(&short);
    assert!(reason.contains("NOT_ENOUGH_GAS: "), "{reason}");
    let payment = jars.signed_rehoming(&family, &jar.id, 1).await;
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
}

/// An unfunded demo-timing jar unlocking in 5 minutes, held by `family`'s parent.
async fn empty_jar(jars: &Jars, family: &Family) -> String {
    let mut args = jars
        .demo_args(family, &child_address(Network::Regtest))
        .await;
    let unlock_at = now(&jars.worker).await + 300;
    args["unlock_at"] = json!(unlock_at.to_string());
    jars.create_jar(&args).await.json().expect("jar id")
}

#[tokio::test]
async fn completion_is_refused_until_two_guardians_the_delay_and_the_unlock_date_allow_it() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = empty_jar(&jars, &family).await;
    let complete = || jars.complete_handover(&family.stranger, &jar, 1);

    let unclaimed = complete().await;
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    let unconfirmed = complete().await;
    for guardian in &family.guardians[..2] {
        jars.confirm(guardian, &jar, &family.child)
            .await
            .into_result()
            .unwrap();
    }
    let during_delay = complete().await;

    for result in [&unclaimed, &unconfirmed] {
        let reason = refusal(result);
        assert!(
            reason.contains(
                "HANDOVER_NOT_CONFIRMED: 2 guardians have not confirmed a handover claim"
            ),
            "{reason}"
        );
    }
    let reason = refusal(&during_delay);
    assert!(
        reason.contains("HANDOVER_DELAY_RUNNING: the handover's public delay ends in "),
        "{reason}"
    );

    // The 3-minute delay ends before the 5-minute unlock date.
    let delay_ends_at: u64 = jars.handover(&jar).await["confirmed"]["delay_ends_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    jars.wait_until(delay_ends_at).await;
    let unlock_at: u64 = jars.get_jar(&jar).await["create_args"]["unlock_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(now(&jars.worker).await < unlock_at);
    let reason = refusal(&complete().await);
    assert!(
        reason.contains("BEFORE_UNLOCK: the jar unlocks in "),
        "{reason}"
    );
    jars.wait_until(unlock_at).await;
    let free_fee = jars.complete_handover(&family.stranger, &jar, 0).await;
    let reason = refusal(&free_fee);
    assert!(reason.contains("FEE_TOO_LOW: "), "{reason}");
}

/// An empty jar whose handover is due: claimed, confirmed and past its delay and unlock date.
async fn due_empty_jar(jars: &Jars, family: &Family) -> String {
    let jar = empty_jar(jars, family).await;
    jars.confirmed_claim(family, &jar).await;
    let unlock_at: u64 = jars.get_jar(&jar).await["create_args"]["unlock_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    jars.wait_until(unlock_at).await;
    jar
}

async fn view(jars: &Jars, method: &str, args: Value) -> Value {
    jars.contract
        .view(method)
        .args_json(args)
        .await
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        .json()
        .expect("json")
}

#[tokio::test]
async fn an_empty_jar_moves_to_the_child_at_once_as_a_standard_nft_transfer() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = due_empty_jar(&jars, &family).await;

    let completed = jars.complete_handover(&family.stranger, &jar, 1).await;

    let logs: Vec<String> = completed.logs().iter().map(|log| log.to_string()).collect();
    assert_eq!(completed.json::<Option<String>>().unwrap(), None);
    // NEP-171's `nft_transfer` event, as the standard spells it.
    let transfer = json!({
        "standard": "nep171",
        "version": "1.0.0",
        "event": "nft_transfer",
        "data": [{
            "old_owner_id": family.parent.id(),
            "new_owner_id": family.child.id(),
            "token_ids": [jar],
        }],
    });
    assert!(
        logs.iter().any(|log| log
            .strip_prefix("EVENT_JSON:")
            .map(|json| { test_support::serde_json::from_str::<Value>(json).unwrap() })
            == Some(transfer.clone())),
        "{logs:?}"
    );
    let token = view(&jars, "nft_token", json!({ "token_id": jar })).await;
    assert_eq!(token["owner_id"], json!(family.child.id()));
    assert_eq!(token["approved_account_ids"], json!({}));
    for (holder, held) in [(&family.parent, 0), (&family.child, 1)] {
        let supply = view(
            &jars,
            "nft_supply_for_owner",
            json!({ "account_id": holder.id() }),
        )
        .await;
        assert_eq!(supply, json!(held.to_string()));
        let tokens = view(
            &jars,
            "nft_tokens_for_owner",
            json!({ "account_id": holder.id() }),
        )
        .await;
        assert_eq!(tokens.as_array().unwrap().len(), held);
    }
    assert_eq!(
        view(
            &jars,
            "nft_is_approved",
            json!({ "token_id": jar, "approved_account_id": family.stranger.id() })
        )
        .await,
        false
    );
    assert_eq!(
        jars.handover(&jar).await["done"]["child_account"],
        json!(family.child.id())
    );
}

#[tokio::test]
async fn after_handover_the_family_account_is_not_the_holder_and_nothing_restarts_it() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = due_empty_jar(&jars, &family).await;
    jars.complete_handover(&family.stranger, &jar, 1)
        .await
        .into_result()
        .expect("completed");

    let spend = jars.request_spend(&family.parent, &jar).await;
    let revoke = family
        .parent
        .call(jars.contract.id(), "nft_revoke_all")
        .args_json(json!({ "token_id": jar }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap();
    for result in [&spend, &revoke] {
        let reason = refusal(result);
        assert!(
            reason.contains(&format!(
                "NOT_THE_HOLDER: the caller is not the holder of jar {jar}"
            )),
            "{reason}"
        );
    }
    let allowance = jars.request_allowance(&jar, 1).await;
    let again = jars.complete_handover(&family.stranger, &jar, 1).await;
    let claim = jars.claim(&family.stranger, &jar, CHILD_BTC_KEY).await;
    let cancel = jars.cancel(&family.guardians[0], &jar).await;
    for result in [&allowance, &again, &claim, &cancel] {
        let reason = refusal(result);
        assert!(reason.contains("HANDOVER_DONE: "), "{reason}");
    }
    let approve = family
        .child
        .call(jars.contract.id(), "nft_approve")
        .args_json(json!({ "token_id": jar, "account_id": family.stranger.id(), "msg": null }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await
        .unwrap();
    let reason = refusal(&approve);
    assert!(reason.contains("APPROVALS_UNAVAILABLE: "), "{reason}");
}
