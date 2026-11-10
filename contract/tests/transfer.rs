//! Transfer after handover: the holder starts a transfer to a receiver's account, the receiver's
//! own account accepts it with its Bitcoin key, the jar's coins re-home to that key (the same
//! rules as handover), and the NFT moves once every coin held at acceptance has moved and been
//! confirmed. Bitcoin Core judges every re-homing payment and the receiver's exit-branch spend.

mod common;

use bitcoin::{Address, Network, OutPoint, ScriptBuf};
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, Regtest};

async fn buyer(jars: &Jars) -> Account {
    new_account(&jars.worker, "buyer").await
}

fn value(coin: &Value) -> u64 {
    coin["value"].as_str().unwrap().parse().unwrap()
}

fn outpoint(coin: &Value) -> String {
    format!("{}:{}", coin["txid"].as_str().unwrap(), coin["vout"])
}

/// The NEP-171 `nft_transfer` event a call logged, if any.
fn nft_transfer_event(logs: &[String]) -> Option<Value> {
    logs.iter()
        .filter_map(|log| log.strip_prefix("EVENT_JSON:"))
        .map(|json| test_support::serde_json::from_str::<Value>(json).unwrap())
        .find(|event| event["standard"] == "nep171" && event["event"] == "nft_transfer")
}

#[tokio::test]
async fn the_holder_transfers_the_jar_and_its_bitcoin_rehomes_to_the_receivers_key() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let child_address = jars.get_jar(&jar.id).await["address"].clone();

    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started");
    assert_eq!(
        jars.transfer_state(&jar.id).await["started"]["receiver"],
        json!(buyer.id())
    );
    let accepted = jars.accept_transfer(&buyer, &jar.id, &buyer_key(), 1).await;
    let accepted_at = jars.ran_at(&accepted).await;
    let payment = jars
        .get_payment(&accepted.json::<String>().expect("payment id"))
        .await;

    assert_eq!(payment["kind"], "rehoming");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let view = jars.get_jar(&jar.id).await;
    let script = ScriptBuf::from_bytes(from_hex(view["witness_script"].as_str().unwrap()));
    assert_eq!(decode(&raw).output[0].script_pubkey, script.to_p2wsh());
    assert_eq!(
        view["address"],
        json!(Address::p2wsh(&script, Network::Regtest).to_string())
    );
    assert_eq!(view["old_addresses"][1], child_address);
    assert_eq!(view["transfer"]["accepted"]["coins_left"], 1);
    assert_eq!(view["owner_id"], json!(family.child.id()));

    let confirmed = jars.confirmed(&regtest, &payment).await;
    assert!(confirmed.is_success(), "{:?}", confirmed.failures());

    let logs: Vec<String> = confirmed.logs().iter().map(|log| log.to_string()).collect();
    assert_eq!(
        nft_transfer_event(&logs).expect("nft_transfer event")["data"],
        json!([{
            "old_owner_id": family.child.id(),
            "new_owner_id": buyer.id(),
            "token_ids": [jar.id],
        }])
    );
    let view = jars.get_jar(&jar.id).await;
    assert_eq!(view["owner_id"], json!(buyer.id()));
    assert_eq!(view["transfer"], json!("none"));
    let events = jars.history_events(&jar.id).await;
    assert_eq!(
        events[events.len() - 6..],
        [
            "transfer_started",
            "transfer_accepted",
            "rehoming_requested",
            "payment_signed",
            "payment_confirmed",
            "transfer_completed"
        ]
    );

    // The re-homed coin answers to the buyer's key alone down the exit branch, 3 hours (demo
    // timing) after acceptance.
    let locktime = view["locktime"].as_u64().unwrap() as u32;
    assert_eq!(u64::from(locktime), accepted_at + 3 * 3_600);
    let coins = jars.get_coins(&jar.id).await;
    let rehomed = coins.as_array().unwrap().last().unwrap().clone();
    let point = OutPoint {
        txid: rehomed["txid"].as_str().unwrap().parse().unwrap(),
        vout: rehomed["vout"].as_u64().unwrap() as u32,
    };
    let spend = exit_spend(
        &regtest,
        point,
        value(&rehomed),
        &script,
        locktime,
        &buyer_secret(),
    );
    assert_eq!(
        regtest.test_mempool_accept(&spend),
        Err("non-final".to_owned())
    );
    regtest.set_mock_time(locktime + 1);
    assert_eq!(regtest.test_mempool_accept(&spend), Ok(()));

    // The new holder spends through the MPC branch; the old one is no longer the holder.
    let refused = jars.request_spend(&family.child, &jar.id).await;
    assert!(refusal(&refused).contains("NOT_THE_HOLDER: "));
    let spent = jars
        .signed_spend(&buyer, &jar.id, &regtest.new_address(), 20_000, 1)
        .await;
    let raw = from_hex(spent["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
}

#[tokio::test]
async fn only_the_receivers_own_account_supplies_the_key() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over_empty(&family).await;
    jars.start_transfer(&family.child, &jar, &buyer)
        .await
        .into_result()
        .expect("started");

    let by_seller = jars
        .accept_transfer(&family.child, &jar, &buyer_key(), 1)
        .await;
    let by_stranger = jars
        .accept_transfer(&family.stranger, &jar, CHILD_BTC_KEY, 1)
        .await;
    let malformed = jars.accept_transfer(&buyer, &jar, "02abcd", 1).await;
    let no_deposit = jars
        .accept_transfer_with(&buyer, &jar, &buyer_key(), 1, NearToken::from_yoctonear(0))
        .await;

    for result in [&by_seller, &by_stranger] {
        let reason = refusal(result);
        assert!(
            reason.contains(&format!(
                "NOT_THE_RECEIVER: only {} can accept this transfer",
                buyer.id()
            )),
            "{reason}"
        );
    }
    let reason = refusal(&malformed);
    assert!(reason.contains("INVALID_BTC_KEY: "), "{reason}");
    let reason = refusal(&no_deposit);
    assert!(
        reason.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
        "{reason}"
    );
    assert_eq!(
        jars.transfer_state(&jar).await["started"]["receiver"],
        json!(buyer.id())
    );
}

#[tokio::test]
async fn an_empty_jar_moves_to_the_receiver_when_the_transfer_is_accepted() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over_empty(&family).await;
    jars.start_transfer(&family.child, &jar, &buyer)
        .await
        .into_result()
        .expect("started");

    let accepted = jars.accept_transfer(&buyer, &jar, &buyer_key(), 1).await;

    let logs: Vec<String> = accepted.logs().iter().map(|log| log.to_string()).collect();
    assert_eq!(accepted.json::<Option<String>>().unwrap(), None);
    assert_eq!(
        nft_transfer_event(&logs).expect("nft_transfer event")["data"][0]["new_owner_id"],
        json!(buyer.id())
    );
    let view = jars.get_jar(&jar).await;
    assert_eq!(view["owner_id"], json!(buyer.id()));
    assert_eq!(view["transfer"], json!("none"));
    let again = jars.accept_transfer(&buyer, &jar, &buyer_key(), 1).await;
    assert!(refusal(&again).contains("NO_OPEN_TRANSFER: "));
}

#[tokio::test]
async fn a_transfer_starts_only_after_handover_from_the_holder_and_waits_for_pending_payments() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let before = jars.demo_jar(&family).await;
    let by_family = jars.start_transfer(&family.parent, &before, &buyer).await;
    let by_guardian = jars
        .start_transfer(&family.guardians[0], &before, &buyer)
        .await;
    for result in [&by_family, &by_guardian] {
        let reason = refusal(result);
        assert!(
            reason.contains(
                "TRANSFER_BEFORE_HANDOVER: a jar can be transferred only after its handover"
            ),
            "{reason}"
        );
    }

    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let by_stranger = jars.start_transfer(&family.stranger, &jar.id, &buyer).await;
    let by_parent = jars.start_transfer(&family.parent, &jar.id, &buyer).await;
    let no_deposit = jars
        .start_transfer_with_deposit(&family.child, &jar.id, &buyer, NearToken::from_yoctonear(0))
        .await;
    for result in [&by_stranger, &by_parent] {
        let reason = refusal(result);
        assert!(
            reason.contains(&format!(
                "NOT_THE_HOLDER: the caller is not the holder of jar {}",
                jar.id
            )),
            "{reason}"
        );
    }
    assert!(refusal(&no_deposit).contains("Requires attached deposit of exactly 1 yoctoNEAR"));

    // A signed spend not yet confirmed holds the transfer back (story 58).
    let spend = jars
        .signed_spend(&family.child, &jar.id, &regtest.new_address(), 5_000, 1)
        .await;
    let pending = jars.start_transfer(&family.child, &jar.id, &buyer).await;
    let reason = refusal(&pending);
    assert!(reason.contains("PAYMENT_PENDING: "), "{reason}");
    jars.confirmed(&regtest, &spend)
        .await
        .into_result()
        .expect("spend confirmed");
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started once nothing is pending");
    let second = jars
        .start_transfer(&family.child, &jar.id, &family.stranger)
        .await;
    let reason = refusal(&second);
    assert!(reason.contains("TRANSFER_OPEN: "), "{reason}");
}

#[tokio::test]
async fn the_holder_cancels_a_transfer_until_it_is_accepted_and_cannot_spend_while_one_is_open() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let to = regtest.new_address();
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started");

    let spend_while_started = jars.spend(&family.child, &jar.id, &to, 5_000, 1).await;
    let cancel_by_buyer = jars.cancel_transfer(&buyer, &jar.id).await;
    jars.cancel_transfer(&family.child, &jar.id)
        .await
        .into_result()
        .expect("cancelled");
    let accept_after_cancel = jars.accept_transfer(&buyer, &jar.id, &buyer_key(), 1).await;
    let cancel_again = jars.cancel_transfer(&family.child, &jar.id).await;

    let reason = refusal(&spend_while_started);
    assert!(
        reason.contains("TRANSFER_OPEN: a transfer of this jar is open"),
        "{reason}"
    );
    assert!(refusal(&cancel_by_buyer).contains("NOT_THE_HOLDER: "));
    assert_eq!(jars.transfer_state(&jar.id).await, json!("none"));
    for result in [&accept_after_cancel, &cancel_again] {
        let reason = refusal(result);
        assert!(reason.contains("NO_OPEN_TRANSFER: "), "{reason}");
    }
    let history = jars.history_events(&jar.id).await;
    assert_eq!(
        history[history.len() - 2..],
        ["transfer_started", "transfer_cancelled"]
    );

    // Started again and accepted: no cancel, no spend.
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started again");
    jars.signed_transfer_batch(&buyer, &jar.id, &buyer_key(), 1)
        .await;
    let cancel_accepted = jars.cancel_transfer(&family.child, &jar.id).await;
    let spend_while_accepted = jars.spend(&family.child, &jar.id, &to, 5_000, 1).await;
    let reason = refusal(&cancel_accepted);
    assert!(reason.contains("TRANSFER_ACCEPTED: "), "{reason}");
    let reason = refusal(&spend_while_accepted);
    assert!(reason.contains("TRANSFER_OPEN: "), "{reason}");
    // A stray sweep waits until the jar has moved, as during a completing handover.
    let sweep = jars.rehome_stray(&family.stranger, &jar.id, 1).await;
    let reason = refusal(&sweep);
    assert!(reason.contains("REHOMING_IN_PROGRESS: "), "{reason}");
}

#[tokio::test]
async fn every_approval_is_cleared_when_the_jar_moves() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    for i in 0..10 {
        family
            .child
            .call(jars.contract.id(), "nft_approve")
            .args_json(json!({ "token_id": jar.id, "account_id": format!("m{i}.test.near") }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .unwrap()
            .into_result()
            .expect("approved");
    }
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started");
    let payment = jars
        .signed_transfer_batch(&buyer, &jar.id, &buyer_key(), 1)
        .await;

    // The confirmation that moves the jar, with ten approvals to clear, at the 60 Tgas floor.
    let proof = jars.mine_payment(&regtest, &payment).await;
    let confirmed = jars
        .giver
        .call(jars.contract.id(), "confirm_payment")
        .args_json(json!({ "payment_id": payment["payment_id"], "proof": proof }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await
        .expect("send confirm_payment");

    confirmed.into_result().expect("confirmed at 60 Tgas");
    let token: Value = jars
        .contract
        .view("nft_token")
        .args_json(json!({ "token_id": jar.id }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(token["owner_id"], json!(buyer.id()));
    assert_eq!(token["approved_account_ids"], json!({}));
    let approved: bool = jars
        .contract
        .view("nft_is_approved")
        .args_json(json!({ "token_id": jar.id, "approved_account_id": "m0.test.near" }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(!approved);
    // Ids never repeat: the buyer's first approval comes after the child's ten.
    buyer
        .call(jars.contract.id(), "nft_approve")
        .args_json(json!({ "token_id": jar.id, "account_id": "m0.test.near" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap()
        .into_result()
        .expect("approved by the buyer");
    let token: Value = jars
        .contract
        .view("nft_token")
        .args_json(json!({ "token_id": jar.id }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(token["approved_account_ids"], json!({ "m0.test.near": 11 }));
}

/// The vsize Core reads for a signed payment (already mined, so decoded rather than tested).
fn core_vsize(regtest: &Regtest, payment: &Value) -> u64 {
    regtest.rpc("decoderawtransaction", &[json!(payment["signed_tx"])])["vsize"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn a_coin_too_small_to_rehome_alone_moves_with_a_carrier_and_anyone_drives_later_batches() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    // Each transfer of a lone coin at 1 sat/vB shrinks it by one re-homing's fee.
    let jar = jars.handed_over(&regtest, &family, &[1_000]).await;
    jars.transferred(&regtest, &jar, &family.child, &buyer, &buyer_key())
        .await;
    // A transfer to oneself re-homes to the key given and leaves the holder unchanged.
    jars.transferred(&regtest, &jar, &buyer, &buyer, &buyer_key())
        .await;
    assert_eq!(jars.get_jar(&jar.id).await["owner_id"], json!(buyer.id()));
    jars.transferred(&regtest, &jar, &buyer, &family.child, CHILD_BTC_KEY)
        .await;
    let last = jars
        .transferred(&regtest, &jar, &family.child, &family.child, CHILD_BTC_KEY)
        .await;
    let coins = jars.get_coins(&jar.id).await;
    let small = coins.as_array().unwrap().last().unwrap().clone();
    // Alone, at 1 sat/vB, its re-homed output would fall under Bitcoin's 330-sat P2WSH dust.
    assert!(value(&small) < 330 + core_vsize(&regtest, &last), "{small}");

    // Ten top-ups to the child's address join it: 11 coins, so two batches.
    let address = jars.get_jar(&jar.id).await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..10 {
        let topup = jars.confirmed_topup(&regtest, &address, 1_000).await;
        jars.prove(&jars.giver, &jar.id, &topup)
            .await
            .into_result()
            .expect("top-up proven");
    }
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started");
    let first = jars
        .signed_transfer_batch(&buyer, &jar.id, &buyer_key(), 1)
        .await;
    assert_eq!(first["inputs"].as_array().unwrap().len(), 10);
    let accepted = &jars.transfer_state(&jar.id).await["accepted"];
    assert_eq!(accepted["coins_to_move"], 1);
    assert_eq!(accepted["coins_left"], 11);
    let pending = jars.accept_transfer(&buyer, &jar.id, &buyer_key(), 1).await;
    assert!(refusal(&pending).contains("PAYMENT_PENDING: "));
    jars.confirmed(&regtest, &first)
        .await
        .into_result()
        .expect("first batch confirmed");
    let other_key = jars
        .accept_transfer(&family.stranger, &jar.id, CHILD_BTC_KEY, 1)
        .await;
    let reason = refusal(&other_key);
    assert!(reason.contains("KEY_CHANGED: "), "{reason}");

    // Anyone continues with the stored key: a stranger (the keeper, whose function-call key
    // attaches no deposit) sends the last batch.
    let second = jars
        .signed_transfer_batch_with(
            &family.stranger,
            &jar.id,
            &buyer_key(),
            1,
            NearToken::from_yoctonear(0),
        )
        .await;

    let raw = from_hex(second["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let tx = decode(&raw);
    assert!(tx.output[0].value.to_sat() >= 330);
    let mut spent: Vec<String> = tx
        .input
        .iter()
        .map(|input| input.previous_output.to_string())
        .collect();
    spent.sort();
    let mut expected = vec![
        outpoint(&small),
        format!("{}:0", first["txid"].as_str().unwrap()),
    ];
    expected.sort();
    // The small coin and the first batch's output (its only output, vout 0) as the carrier.
    assert_eq!(spent, expected);
    jars.confirmed(&regtest, &second)
        .await
        .into_result()
        .expect("second batch confirmed");
    assert_eq!(jars.get_jar(&jar.id).await["owner_id"], json!(buyer.id()));
}

#[tokio::test]
async fn later_batches_need_no_deposit_and_the_receiver_may_still_attach_one() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let buyer = buyer(&jars).await;
    let jar = jars.handed_over(&regtest, &family, &[2_000]).await;
    // 20 top-ups join the re-homed coin: 21 coins, so three batches of at most 10.
    let address = jars.get_jar(&jar.id).await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..20 {
        let topup = jars.confirmed_topup(&regtest, &address, 2_000).await;
        jars.prove(&jars.giver, &jar.id, &topup)
            .await
            .into_result()
            .expect("top-up proven");
    }
    jars.start_transfer(&family.child, &jar.id, &buyer)
        .await
        .into_result()
        .expect("started");

    let first = jars
        .signed_transfer_batch(&buyer, &jar.id, &buyer_key(), 1)
        .await;
    jars.confirmed(&regtest, &first)
        .await
        .into_result()
        .expect("first batch confirmed");
    // A keeper's function-call key can attach no deposit.
    let second = jars
        .signed_transfer_batch_with(
            &family.stranger,
            &jar.id,
            &buyer_key(),
            1,
            NearToken::from_yoctonear(0),
        )
        .await;
    jars.confirmed(&regtest, &second)
        .await
        .into_result()
        .expect("second batch confirmed");
    // The receiver's app may still attach 1 yoctoNEAR.
    let third = jars
        .signed_transfer_batch(&buyer, &jar.id, &buyer_key(), 1)
        .await;
    jars.confirmed(&regtest, &third)
        .await
        .into_result()
        .expect("third batch confirmed");

    assert_eq!(jars.get_jar(&jar.id).await["owner_id"], json!(buyer.id()));
    assert_eq!(jars.transfer_state(&jar.id).await, json!("none"));
}
