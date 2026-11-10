//! Handover up to the point the Bitcoin starts moving (ADR 0009): the child's account claims
//! with its Bitcoin key, 2 guardians confirm, a public delay runs, any guardian or the claimer
//! can cancel, and a claim short of 2 confirmations lapses. Demo timing: a 3-minute delay and a
//! 7-minute lapse.

mod common;

use common::*;
use test_support::serde_json::json;

#[tokio::test]
async fn the_childs_account_claims_the_jar_with_its_bitcoin_key() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    let result = jars.claim(&family.child, &jar, CHILD_BTC_KEY).await;

    assert!(result.is_success(), "{:?}", result.failures());
    let at = jars.ran_at(&result).await;
    assert_eq!(
        jars.handover(&jar).await,
        json!({ "claimed": {
            "child_account": family.child.id(),
            "child_btc_pubkey": CHILD_BTC_KEY,
            "claimed_at": at.to_string(),
            "lapses_at": (at + DEMO_LAPSE).to_string(),
            "confirmed_by": [],
        }})
    );
    assert_eq!(
        satsjar_events(&result),
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "handover_claimed",
            "data": {
                "jar_id": jar,
                "child_account": family.child.id(),
                "child_btc_pubkey": CHILD_BTC_KEY,
                "lapses_at": (at + DEMO_LAPSE).to_string(),
            },
        })]
    );
    assert_eq!(
        jars.history_events(&jar).await,
        ["jar_created", "handover_claimed"]
    );
}

#[tokio::test]
async fn a_claim_sent_by_another_account_than_the_childs_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;

    // An adult names the child's account but sends the claim from their own.
    let result = jars
        .claim_as(
            &family.guardians[0],
            &jar,
            &family.child,
            CHILD_BTC_KEY,
            near_workspaces::types::NearToken::from_yoctonear(1),
        )
        .await;

    let reason = refusal(&result);
    assert!(reason.contains("NOT_THE_CHILD_ACCOUNT: "), "{reason}");
    assert_eq!(jars.handover(&jar).await, "none");
}

#[tokio::test]
async fn a_malformed_child_key_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let x = &CHILD_BTC_KEY[2..];
    // The generator point, uncompressed: a real key, but segwit v0 takes only compressed keys.
    let uncompressed = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798\
                        483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    let malformed = [
        x.to_owned(),
        uncompressed.to_owned(),
        format!("05{x}"),
        // x = 5 has no y on secp256k1.
        format!("02{:064x}", 5),
    ];
    // libsecp256k1, through rust-bitcoin, is the oracle: a point on the curve, compressed (the
    // only form segwit v0 relays, BIP-143). It accepts the good key and none of these.
    let parse = |hex: &str| {
        bitcoin::PublicKey::from_slice(&test_support::from_hex(hex)).is_ok_and(|key| key.compressed)
    };
    assert!(parse(CHILD_BTC_KEY));
    for key in &malformed {
        assert!(!parse(key), "{key}");
    }

    for key in malformed.iter().map(String::as_str).chain(["not hex"]) {
        let result = jars.claim(&family.child, &jar, key).await;
        let reason = refusal(&result);
        assert!(reason.contains("INVALID_CHILD_KEY: "), "{key}: {reason}");
    }
    assert_eq!(jars.handover(&jar).await, "none");
}

#[tokio::test]
async fn a_second_claim_while_one_is_open_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    let open = jars.handover(&jar).await;

    let again = jars.claim(&family.child, &jar, CHILD_BTC_KEY).await;
    let other = jars.claim(&family.stranger, &jar, CHILD_BTC_KEY).await;

    assert!(refusal(&again).contains("CLAIM_OPEN: "));
    assert!(refusal(&other).contains("CLAIM_OPEN: "));
    assert_eq!(jars.handover(&jar).await, open);
}

#[tokio::test]
async fn a_guardian_confirms_the_claim_once_and_nobody_else_can() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    let grandma = &family.guardians[0];

    let stranger = jars.confirm(&family.stranger, &jar, &family.child).await;
    let first = jars.confirm(grandma, &jar, &family.child).await;
    let twice = jars.confirm(grandma, &jar, &family.child).await;

    let reason = refusal(&stranger);
    assert!(reason.contains("NOT_A_GUARDIAN: "), "{reason}");
    assert!(first.is_success(), "{:?}", first.failures());
    assert!(refusal(&twice).contains("CLAIM_ALREADY_CONFIRMED: "));
    let handover = jars.handover(&jar).await;
    assert_eq!(handover["claimed"]["confirmed_by"], json!([grandma.id()]));
    assert_eq!(
        satsjar_events(&first),
        vec![json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "handover_confirmed",
            "data": { "jar_id": jar, "guardian": grandma.id(), "delay_ends_at": null },
        })]
    );
}

#[tokio::test]
async fn the_second_guardian_starts_the_public_delay() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let claim = jars.claim(&family.child, &jar, CHILD_BTC_KEY).await;
    let claimed_at = jars.ran_at(&claim).await;
    let [grandma, uncle, aunt] = &family.guardians[..] else {
        unreachable!()
    };
    jars.confirm(grandma, &jar, &family.child)
        .await
        .into_result()
        .unwrap();

    let second = jars.confirm(uncle, &jar, &family.child).await;

    assert!(second.is_success(), "{:?}", second.failures());
    let delay_ends_at = (jars.ran_at(&second).await + DEMO_DELAY).to_string();
    assert_eq!(
        jars.handover(&jar).await,
        json!({ "confirmed": {
            "child_account": family.child.id(),
            "child_btc_pubkey": CHILD_BTC_KEY,
            "claimed_at": claimed_at.to_string(),
            "confirmed_by": [grandma.id(), uncle.id()],
            "delay_ends_at": delay_ends_at,
        }})
    );
    assert_eq!(
        satsjar_events(&second)[0]["data"],
        json!({ "jar_id": jar, "guardian": uncle.id(), "delay_ends_at": delay_ends_at })
    );
    let third = jars.confirm(aunt, &jar, &family.child).await;
    assert!(refusal(&third).contains("CLAIM_ALREADY_CONFIRMED: "));
    let another_claim = jars.claim(&family.stranger, &jar, CHILD_BTC_KEY).await;
    assert!(refusal(&another_claim).contains("CLAIM_OPEN: "));
}

#[tokio::test]
async fn the_claimer_cancels_an_unconfirmed_claim_and_a_fresh_claim_follows() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let nothing = jars.cancel(&family.child, &jar).await;
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    jars.confirm(&family.guardians[0], &jar, &family.child)
        .await
        .into_result()
        .unwrap();

    let stranger = jars.cancel(&family.stranger, &jar).await;
    let cancel = jars.cancel(&family.child, &jar).await;

    assert!(refusal(&nothing).contains("NO_OPEN_CLAIM: "));
    let reason = refusal(&stranger);
    assert!(reason.contains("NOT_GUARDIAN_OR_CLAIMER: "), "{reason}");
    assert!(cancel.is_success(), "{:?}", cancel.failures());
    assert_eq!(jars.handover(&jar).await, "none");
    assert_eq!(
        satsjar_events(&cancel)[0],
        json!({
            "standard": "satsjar",
            "version": "1.0.0",
            "event": "handover_cancelled",
            "data": { "jar_id": jar, "by": family.child.id() },
        })
    );
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .expect("a fresh claim after a cancel");
    assert_eq!(
        jars.history_events(&jar).await,
        [
            "jar_created",
            "handover_claimed",
            "handover_confirmed",
            "handover_cancelled",
            "handover_claimed"
        ]
    );
}

#[tokio::test]
async fn a_guardian_cancels_during_the_delay_and_a_fresh_claim_follows() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.confirmed_claim(&family, &jar).await;
    let aunt = &family.guardians[2];

    // The one guardian who did not confirm stops it.
    let cancel = jars.cancel(aunt, &jar).await;

    assert!(cancel.is_success(), "{:?}", cancel.failures());
    assert_eq!(jars.handover(&jar).await, "none");
    assert_eq!(
        jars.get_history(&jar, 4, 1).await[0]["by"],
        json!(aunt.id())
    );
    jars.claim(&family.stranger, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .expect("a fresh claim after a cancel");
}

#[tokio::test]
async fn a_confirmation_naming_a_cancelled_claims_account_is_refused() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    // While grandma checks the child's code in person, the claim is swapped for another account.
    jars.cancel(&family.child, &jar)
        .await
        .into_result()
        .unwrap();
    jars.claim(&family.stranger, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();

    let result = jars
        .confirm(&family.guardians[0], &jar, &family.child)
        .await;

    let reason = refusal(&result);
    assert!(reason.contains("CLAIM_CHANGED: "), "{reason}");
    assert_eq!(
        jars.handover(&jar).await["claimed"]["confirmed_by"],
        json!([])
    );
}

#[tokio::test]
async fn a_claim_no_guardian_confirms_lapses_and_a_fresh_claim_follows() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let claim = jars.claim(&family.child, &jar, CHILD_BTC_KEY).await;
    let lapses_at = jars.ran_at(&claim).await + DEMO_LAPSE;

    jars.wait_until(lapses_at).await;

    assert_eq!(jars.handover(&jar).await, "none");
    let confirm = jars
        .confirm(&family.guardians[0], &jar, &family.child)
        .await;
    assert!(refusal(&confirm).contains("NO_OPEN_CLAIM: "));
    let cancel = jars.cancel(&family.child, &jar).await;
    assert!(refusal(&cancel).contains("NO_OPEN_CLAIM: "));
    let fresh = jars.claim(&family.stranger, &jar, CHILD_BTC_KEY).await;
    assert!(fresh.is_success(), "{:?}", fresh.failures());
    assert_eq!(
        satsjar_events(&fresh)[0]["data"],
        json!({ "jar_id": jar, "lapsed_at": lapses_at.to_string() })
    );
    assert_eq!(
        jars.history_events(&jar).await,
        [
            "jar_created",
            "handover_claimed",
            "handover_lapsed",
            "handover_claimed"
        ]
    );
    // A guardian who checked the lapsed claim's code cannot count it toward the new one.
    let stale = jars
        .confirm(&family.guardians[0], &jar, &family.child)
        .await;
    assert!(refusal(&stale).contains("CLAIM_CHANGED: "));
}

#[tokio::test]
async fn a_claim_short_of_two_confirmations_lapses_but_a_confirmed_one_does_not() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let once = jars.demo_jar(&family).await;
    let twice = jars.demo_jar(&family).await;
    let claim = jars.claim(&family.child, &once, CHILD_BTC_KEY).await;
    let lapses_at = jars.ran_at(&claim).await + DEMO_LAPSE;
    jars.confirm(&family.guardians[0], &once, &family.child)
        .await
        .into_result()
        .unwrap();
    jars.confirmed_claim(&family, &twice).await;

    jars.wait_until(lapses_at + 60).await;

    assert_eq!(jars.handover(&once).await, "none");
    assert!(jars.handover(&twice).await["confirmed"].is_object());
}

#[tokio::test]
async fn claim_confirm_and_cancel_need_one_yocto_from_a_full_access_key() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let none = near_workspaces::types::NearToken::from_yoctonear(0);
    let child = &family.child;

    let claim = jars.claim_as(child, &jar, child, CHILD_BTC_KEY, none).await;
    jars.claim(child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    let confirm = jars
        .confirm_with_deposit(&family.guardians[0], &jar, child, none)
        .await;
    let cancel = jars.cancel_with_deposit(child, &jar, none).await;

    for result in [claim, confirm, cancel] {
        let reason = refusal(&result);
        assert!(
            reason.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{reason}"
        );
    }
    assert_eq!(
        jars.handover(&jar).await["claimed"]["confirmed_by"],
        json!([])
    );
}

#[tokio::test]
async fn approvals_stay_refused_while_a_claim_is_open_and_during_the_delay() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.demo_jar(&family).await;
    let approve = || {
        family
            .stranger
            .call(jars.contract.id(), "nft_approve")
            .args_json(json!({
                "token_id": jar,
                "account_id": family.stranger.id(),
                "msg": null,
            }))
            .deposit(near_workspaces::types::NearToken::from_millinear(10))
            .transact()
    };
    jars.claim(&family.child, &jar, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();

    let claimed = approve().await.unwrap();
    for guardian in &family.guardians[..2] {
        jars.confirm(guardian, &jar, &family.child)
            .await
            .into_result()
            .unwrap();
    }
    let delay = approve().await.unwrap();

    for result in [claimed, delay] {
        let reason = refusal(&result);
        assert!(reason.contains("APPROVAL_BEFORE_HANDOVER: "), "{reason}");
    }
}
