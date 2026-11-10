//! NEP-178 approvals after handover: the holder approves accounts (at most 10 per jar), each
//! approval gets an id that never repeats, an approved account with a `msg` hears about it
//! through `nft_on_approve`, and the holder revokes them. Before handover no approval is taken
//! (tests/nft.rs); every move clears them (tests/transfer.rs).

mod common;

use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use test_support::serde_json::{json, Value};

impl Jars {
    async fn approve(
        &self,
        caller: &Account,
        jar: &str,
        account: &str,
        msg: Option<&str>,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "nft_approve")
            .args_json(json!({ "token_id": jar, "account_id": account, "msg": msg }))
            .deposit(deposit)
            .gas(Gas::from_tgas(100))
            .transact()
            .await
            .expect("send nft_approve")
    }

    async fn view_json(&self, method: &str, args: Value) -> Value {
        self.contract
            .view(method)
            .args_json(args)
            .await
            .unwrap_or_else(|e| panic!("{method}: {e:?}"))
            .json()
            .expect("json")
    }

    async fn approvals(&self, jar: &str) -> Value {
        self.view_json("nft_token", json!({ "token_id": jar }))
            .await["approved_account_ids"]
            .clone()
    }

    async fn is_approved(&self, jar: &str, account: &str, approval_id: Option<u64>) -> bool {
        self.view_json(
            "nft_is_approved",
            json!({ "token_id": jar, "approved_account_id": account, "approval_id": approval_id }),
        )
        .await
        .as_bool()
        .unwrap()
    }
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[tokio::test]
async fn after_handover_the_holder_approves_accounts_and_ids_never_repeat() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    let market = "market.test.near";

    jars.approve(&family.child, &jar, market, None, ONE_YOCTO)
        .await
        .into_result()
        .expect("approved");

    assert_eq!(jars.approvals(&jar).await, json!({ market: 1 }));
    assert!(jars.is_approved(&jar, market, None).await);
    assert!(jars.is_approved(&jar, market, Some(1)).await);
    assert!(!jars.is_approved(&jar, market, Some(2)).await);
    assert!(!jars.is_approved(&jar, "other.test.near", None).await);

    // NEP-178: re-approving an account still increments the id.
    jars.approve(&family.child, &jar, market, None, ONE_YOCTO)
        .await
        .into_result()
        .expect("approved again");
    jars.approve(&family.child, &jar, "other.test.near", None, ONE_YOCTO)
        .await
        .into_result()
        .expect("approved");
    assert_eq!(
        jars.approvals(&jar).await,
        json!({ market: 2, "other.test.near": 3 })
    );
    assert!(!jars.is_approved(&jar, market, Some(1)).await);
    assert!(jars.is_approved(&jar, market, Some(2)).await);
}

#[tokio::test]
async fn an_approval_keeps_one_yocto_and_refunds_the_rest_of_the_deposit() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    // Account views read final blocks, a few behind the last transaction's refunds.
    jars.worker.fast_forward(5).await.unwrap();
    let before = family.child.view_account().await.unwrap().balance;

    // A wallet attaches a storage deposit, as for other NFT contracts.
    let result = jars
        .approve(
            &family.child,
            &jar,
            "market.test.near",
            None,
            NearToken::from_millinear(10),
        )
        .await;

    assert!(result.is_success(), "{:?}", result.failures());
    jars.worker.fast_forward(5).await.unwrap();
    let after = family.child.view_account().await.unwrap().balance;
    let gas_paid: u128 = result
        .outcomes()
        .iter()
        .map(|o| o.tokens_burnt.as_yoctonear())
        .sum();
    assert_eq!(before.as_yoctonear() - after.as_yoctonear() - gas_paid, 1);
}

#[tokio::test]
async fn an_approved_account_with_a_message_hears_about_it_through_nft_on_approve() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    let root = jars.worker.root_account().unwrap();
    let receiver = stand_in(&root, "market", Build::ApprovalReceiver).await;
    receiver
        .call("new")
        .transact()
        .await
        .unwrap()
        .into_result()
        .expect("receiver initialised");

    let result = jars
        .approve(
            &family.child,
            &jar,
            receiver.id().as_str(),
            Some("list for 0.01 BTC"),
            ONE_YOCTO,
        )
        .await;

    let logs: Vec<String> = result.logs().iter().map(|log| log.to_string()).collect();
    assert_eq!(
        result.json::<String>().expect("receiver's answer"),
        "listed"
    );
    let heard = format!(
        "nft_on_approve from {}: token_id={jar} owner_id={} approval_id=1 msg=list for 0.01 BTC",
        jars.contract.id(),
        family.child.id()
    );
    assert!(logs.contains(&heard), "{logs:?}");
}

#[tokio::test]
async fn a_jar_takes_at_most_ten_approvals_and_only_from_its_holder() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    for i in 0..10 {
        jars.approve(
            &family.child,
            &jar,
            &format!("m{i}.test.near"),
            None,
            ONE_YOCTO,
        )
        .await
        .into_result()
        .expect("approved");
    }

    let eleventh = jars
        .approve(&family.child, &jar, "m10.test.near", None, ONE_YOCTO)
        .await;
    let stranger = jars
        .approve(&family.stranger, &jar, "m11.test.near", None, ONE_YOCTO)
        .await;
    let parent = jars
        .approve(&family.parent, &jar, "m11.test.near", None, ONE_YOCTO)
        .await;
    let no_deposit = jars
        .approve(
            &family.child,
            &jar,
            "m0.test.near",
            None,
            NearToken::from_yoctonear(0),
        )
        .await;

    let reason = refusal(&eleventh);
    assert!(
        reason.contains("TOO_MANY_APPROVALS: jar ") && reason.contains("10 approved accounts"),
        "{reason}"
    );
    for result in [&stranger, &parent] {
        let reason = refusal(result);
        assert!(
            reason.contains(&format!(
                "NOT_THE_HOLDER: the caller is not the holder of jar {jar}"
            )),
            "{reason}"
        );
    }
    let reason = refusal(&no_deposit);
    assert!(
        reason.contains("Requires attached deposit of at least 1 yoctoNEAR"),
        "{reason}"
    );
    // A listed account can still be approved again when the list is full.
    jars.approve(&family.child, &jar, "m0.test.near", None, ONE_YOCTO)
        .await
        .into_result()
        .expect("re-approved");
    assert_eq!(jars.approvals(&jar).await["m0.test.near"], json!(11));
}

#[tokio::test]
async fn the_holder_revokes_one_approval_or_all_of_them() {
    let jars = start("regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    for account in ["a.test.near", "b.test.near", "c.test.near"] {
        jars.approve(&family.child, &jar, account, None, ONE_YOCTO)
            .await
            .into_result()
            .expect("approved");
    }
    let revoke = |caller: &Account, method: &'static str, args: Value| {
        caller
            .call(jars.contract.id(), method)
            .args_json(args)
            .deposit(ONE_YOCTO)
            .transact()
    };

    let by_stranger = revoke(
        &family.stranger,
        "nft_revoke",
        json!({ "token_id": jar, "account_id": "a.test.near" }),
    )
    .await
    .unwrap();
    revoke(
        &family.child,
        "nft_revoke",
        json!({ "token_id": jar, "account_id": "a.test.near" }),
    )
    .await
    .unwrap()
    .into_result()
    .expect("revoked");
    assert_eq!(
        jars.approvals(&jar).await,
        json!({ "b.test.near": 2, "c.test.near": 3 })
    );
    revoke(&family.child, "nft_revoke_all", json!({ "token_id": jar }))
        .await
        .unwrap()
        .into_result()
        .expect("all revoked");

    assert!(refusal(&by_stranger).contains("NOT_THE_HOLDER: "));
    assert_eq!(jars.approvals(&jar).await, json!({}));
    assert!(!jars.is_approved(&jar, "b.test.near", None).await);
}
