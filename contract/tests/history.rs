//! `get_history`: every state change of a jar, in order, with when it happened.

mod common;

use common::*;
use test_support::serde_json::json;
use test_support::Regtest;

#[tokio::test]
async fn the_history_lists_every_step_of_an_allowance_in_order() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    jars.signer_mode("fail").await;
    let id: String = jars.request_allowance(&jar.id, 1).await.json().unwrap();
    jars.signer_mode("sign").await;
    jars.retry_signing(&id).await.into_result().unwrap();
    let payment = jars.get_payment(&id).await;
    let proof = jars.mine_payment(&regtest, &payment).await;
    jars.confirm_payment(&id, &proof)
        .await
        .into_result()
        .unwrap();

    let history = jars.get_history(&jar.id, 0, 100).await;

    let events = jars.history_events(&jar.id).await;
    assert_eq!(
        events,
        [
            "jar_created",
            "topup_proven",
            "allowance_requested",
            "payment_signing_failed",
            "payment_signing_retried",
            "payment_signed",
            "payment_confirmed",
        ]
    );
    let entries = history.as_array().unwrap();
    let coin = &jars.get_coins(&jar.id).await[0];
    assert_eq!(entries[1]["txid"], coin["txid"]);
    assert_eq!(entries[1]["vout"], coin["vout"]);
    assert_eq!(entries[1]["value"], "50000");
    for entry in &entries[2..] {
        assert_eq!(entry["payment_id"], json!(id));
    }
    assert!(entries[3]["reason"]
        .as_str()
        .unwrap()
        .contains("sign request 0 failed"));
    assert_eq!(entries[4]["attempt"], 1);
    let times: Vec<u64> = entries
        .iter()
        .map(|e| e["at"].as_str().unwrap().parse().unwrap())
        .collect();
    assert!(times.windows(2).all(|w| w[0] <= w[1]));
    assert!(times[6] <= now(&jars.worker).await);
    let page = jars.get_history(&jar.id, 2, 2).await;
    assert_eq!(page, json!([entries[2], entries[3]]));
    assert_eq!(page[0]["index"], 2);
    assert_eq!(jars.get_history("99", 0, 10).await, json!([]));
}
