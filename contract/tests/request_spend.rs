//! Before handover nobody can spend the jar's Bitcoin, guardians and the family account
//! included: only the allowance and an emergency payment pay out, and only to the child's address.

mod common;

use common::*;
use near_workspaces::types::NearToken;
use test_support::serde_json::json;
use test_support::Regtest;

const BEFORE_HANDOVER: &str = "SPEND_BEFORE_HANDOVER: before handover only the allowance and an \
                               emergency payment can pay out, and only to the child's address";

#[tokio::test]
async fn a_spend_before_handover_is_refused_for_everyone_until_the_jar_has_moved() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut args = jars.demo_args(&family, &regtest.new_address()).await;
    args["unlock_at"] = json!((now(&jars.worker).await + 240).to_string());
    let jar = jars.funded_jar_with(&regtest, args, &[50_000]).await;

    let mut refused = vec![
        jars.request_spend(&family.guardians[0], &jar.id).await,
        jars.request_spend(&family.parent, &jar.id).await,
        // Even without the deposit a holder call needs, a guardian reads why.
        family.guardians[1]
            .call(jars.contract.id(), "request_spend")
            .args_json(json!({
                "jar_id": jar.id,
                "to": family.guardians[1].id().to_string(),
                "amount": "50000",
                "fee_rate": "1",
            }))
            .deposit(NearToken::from_yoctonear(0))
            .transact()
            .await
            .unwrap(),
    ];
    jars.claim(&family.child, &jar.id, CHILD_BTC_KEY)
        .await
        .into_result()
        .unwrap();
    refused.push(jars.request_spend(&family.child, &jar.id).await);
    for guardian in &family.guardians[..2] {
        jars.confirm(guardian, &jar.id, &family.child)
            .await
            .into_result()
            .unwrap();
    }
    let unlock_at: u64 = jars.get_jar(&jar.id).await["create_args"]["unlock_at"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    jars.wait_until(unlock_at).await;
    jars.signed_rehoming(&family, &jar.id, 1).await;
    // Completing: the Bitcoin is moving but the jar has not moved yet.
    refused.push(jars.request_spend(&family.child, &jar.id).await);
    refused.push(jars.request_spend(&family.parent, &jar.id).await);

    for result in &refused {
        let reason = refusal(result);
        assert!(reason.contains(BEFORE_HANDOVER), "{reason}");
    }
}
