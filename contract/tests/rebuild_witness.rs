//! `rebuild_witness`: the signed transaction re-encoded from the stored signatures, with no new
//! signing.

mod common;

use common::*;
use test_support::serde_json::{json, Value};
use test_support::{from_hex, Regtest};

impl Jars {
    async fn rebuild_witness(&self, payment_id: &str) -> Result<String, String> {
        let result = self
            .giver
            .call(self.contract.id(), "rebuild_witness")
            .args_json(json!({ "payment_id": payment_id }))
            .transact()
            .await
            .unwrap();
        if result.is_failure() {
            return Err(refusal(&result));
        }
        Ok(result.json().unwrap())
    }
}

#[tokio::test]
async fn a_signed_payment_is_rebuilt_from_its_stored_signatures_without_the_signer() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[6_000, 12_000, 9_000]).await;
    let payment = jars.signed_allowance(&jar.id, 1).await;
    let id = payment["payment_id"].as_str().unwrap();
    // Any signer call would now fail.
    jars.signer_mode("fail").await;

    let rebuilt = jars.rebuild_witness(id).await.unwrap();

    let raw = from_hex(&rebuilt);
    assert_eq!(core_verdict(&regtest, &raw)["allowed"], true);
    assert_eq!(decode(&raw).compute_txid().to_string(), payment["txid"]);
    assert_eq!(jars.get_payment(id).await, payment);
}

#[tokio::test]
async fn a_payment_without_signatures_cannot_be_rebuilt() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let jar = jars.funded_jar(&regtest, &[50_000]).await;
    jars.signer_mode("fail").await;
    let id: String = jars.request_allowance(&jar.id, 1).await.json().unwrap();

    let unsigned = jars.rebuild_witness(&id).await.unwrap_err();
    let unknown = jars.rebuild_witness("99").await.unwrap_err();

    assert!(unsigned.contains("PAYMENT_NOT_SIGNED: "), "{unsigned}");
    assert!(unknown.contains("UNKNOWN_PAYMENT: "));
    assert_eq!(jars.get_payment(&id).await["signed_tx"], Value::Null);
}
