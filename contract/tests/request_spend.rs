//! Before handover nobody can spend the jar's Bitcoin, guardians and the family account
//! included: only the allowance and an emergency payment pay out, and only to the child's address.

mod common;

use common::*;
use near_workspaces::types::{Gas, NearToken};
use test_support::serde_json::json;
use test_support::{from_hex, Regtest};

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

#[tokio::test]
async fn after_handover_the_holder_spends_a_rehomed_coin_to_any_address() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let rehomed = jars
        .get_coins(&jar.id)
        .await
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    let view = jars.get_jar(&jar.id).await;
    let jar_script = script(view["address"].as_str().unwrap());
    let to = regtest.new_address();

    let payment = jars
        .signed_spend(&family.child, &jar.id, &to, 20_000, 1)
        .await;

    assert_eq!(payment["kind"], "spend");
    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(&regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let tx = decode(&raw);
    assert_eq!(tx.input.len(), 1);
    assert_eq!(
        tx.input[0].previous_output.txid.to_string(),
        rehomed["txid"]
    );
    assert_eq!(tx.output[0].script_pubkey, script(&to));
    assert_eq!(tx.output[0].value.to_sat(), 20_000);
    assert_eq!(tx.output[1].script_pubkey, jar_script);
    let rehomed_value: u64 = rehomed["value"].as_str().unwrap().parse().unwrap();
    let change = tx.output[1].value.to_sat();
    // Core prints small fees with an exponent, so the fee is read as inputs − outputs.
    let fee = rehomed_value - 20_000 - change;
    assert!(fee >= verdict["vsize"].as_u64().unwrap(), "fee {fee}");

    jars.confirmed(&regtest, &payment)
        .await
        .into_result()
        .expect("confirmed");
    let coins = jars.get_coins(&jar.id).await;
    let coins = coins.as_array().unwrap();
    assert_eq!(coins[coins.len() - 2]["status"], "spent");
    let last = &coins[coins.len() - 1];
    assert_eq!(last["status"], "confirmed");
    assert_eq!(last["value"], json!(change.to_string()));
    assert_eq!(
        jars.get_jar(&jar.id).await["proven_balance"],
        json!(change.to_string())
    );
}

#[tokio::test]
async fn the_holder_sets_the_fee_freely_even_above_the_amount() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over(&regtest, &family, &[50_000]).await;
    let coins = jars.get_coins(&jar.id).await;
    let rehomed: u64 = coins.as_array().unwrap().last().unwrap()["value"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    // 8 sat/vB on a two-output spend is well over 1,000 sats; an allowance's or a re-homing's
    // fee bound would refuse it. (Core's own default ceiling is 10 sat/vB.)
    let payment = jars
        .signed_spend(&family.child, &jar.id, &regtest.new_address(), 1_000, 8)
        .await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    let verdict = core_verdict(&regtest, &raw);
    assert_eq!(verdict["allowed"], true, "{verdict}");
    let tx = decode(&raw);
    assert_eq!(tx.output[0].value.to_sat(), 1_000);
    let fee = rehomed - tx.output.iter().map(|o| o.value.to_sat()).sum::<u64>();
    assert!(fee > 1_000, "fee {fee}");
    assert!(fee >= 8 * verdict["vsize"].as_u64().unwrap(), "fee {fee}");
}

#[tokio::test]
async fn a_spend_is_refused_with_its_reason() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.handed_over_empty(&family).await;
    // A top-up to the jar's new address after handover: one 5,000-sat coin.
    let address = jars.get_jar(&jar).await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    let topup = jars.confirmed_topup(&regtest, &address, 5_000).await;
    jars.prove(&jars.giver, &jar, &topup)
        .await
        .into_result()
        .expect("top-up proven");
    let to = regtest.new_address();
    let secp = bitcoin::secp256k1::Secp256k1::new();
    let (taproot_key, _) = bitcoin::secp256k1::SecretKey::from_slice(&[7; 32])
        .unwrap()
        .x_only_public_key(&secp);
    let taproot =
        bitcoin::Address::p2tr(&secp, taproot_key, None, bitcoin::KnownHrp::Regtest).to_string();
    let testnet = child_address(bitcoin::Network::Testnet);
    let one_yocto = NearToken::from_yoctonear(1);
    let gas = Gas::from_tgas(300);

    let cases = [
        (
            jars.spend(&family.stranger, &jar, &to, 2_000, 1).await,
            format!("NOT_THE_HOLDER: the caller is not the holder of jar {jar}"),
        ),
        (
            jars.spend(&family.parent, &jar, &to, 2_000, 1).await,
            format!("NOT_THE_HOLDER: the caller is not the holder of jar {jar}"),
        ),
        (
            jars.spend_with(
                &family.child,
                &jar,
                &to,
                2_000,
                1,
                NearToken::from_yoctonear(0),
                gas,
            )
            .await,
            "Requires attached deposit of exactly 1 yoctoNEAR".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, &taproot, 2_000, 1).await,
            "INVALID_ADDRESS: the address must be a native segwit v0 address".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, &testnet, 2_000, 1).await,
            "INVALID_ADDRESS: the address belongs to another Bitcoin network".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, "not an address", 2_000, 1)
                .await,
            "INVALID_ADDRESS: the address is not a valid native segwit Bitcoin address".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, &to, 999, 1).await,
            "AMOUNT_BELOW_DUST: a spend must send at least 1000 sats".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, &to, 2_000, 0).await,
            "FEE_TOO_LOW: the fee rate must be at least 1 sat/vB".to_owned(),
        ),
        (
            jars.spend(&family.child, &jar, &to, 10_000, 1).await,
            "INSUFFICIENT_BALANCE: ".to_owned(),
        ),
        (
            // 5,000 − 4,000 − a two-output fee leaves change under 1,000.
            jars.spend(&family.child, &jar, &to, 4_000, 1).await,
            "CHANGE_BELOW_DUST: the change would be ".to_owned(),
        ),
        (
            jars.spend_with(
                &family.child,
                &jar,
                &to,
                2_000,
                1,
                one_yocto,
                Gas::from_tgas(30),
            )
            .await,
            "NOT_ENOUGH_GAS: ".to_owned(),
        ),
    ];

    for (result, expected) in &cases {
        let reason = refusal(result);
        assert!(reason.contains(expected.as_str()), "{expected}: {reason}");
    }
    let coins = jars.get_coins(&jar).await;
    assert_eq!(coins[0]["status"], "confirmed", "nothing was reserved");
}

#[tokio::test]
async fn a_spend_after_rehoming_more_than_ten_coins_uses_both_rehomed_coins() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let mut coins = vec![5_000; 10];
    coins.push(1_000);
    let jar = jars.handed_over(&regtest, &family, &coins).await;
    // The two re-homing payments' outputs, at indices 11 and 12; every earlier coin is spent.
    let all = jars.get_coins(&jar.id).await;
    let all = all.as_array().unwrap();
    assert_eq!(all.len(), 13);
    assert!(all[..11].iter().all(|coin| coin["status"] == "spent"));
    let value = |coin: &test_support::serde_json::Value| -> u64 {
        coin["value"].as_str().unwrap().parse().unwrap()
    };
    let (big, small) = (value(&all[11]), value(&all[12]));
    // More than the big coin can pay with its fee and change, leaving change over 1,000 when
    // the small coin joins it.
    let amount = big + small - 1_500;

    let payment = jars
        .signed_spend(&family.child, &jar.id, &regtest.new_address(), amount, 1)
        .await;

    let raw = from_hex(payment["signed_tx"].as_str().unwrap());
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
    let spent: Vec<String> = decode(&raw)
        .input
        .iter()
        .map(|input| input.previous_output.to_string())
        .collect();
    let rehomed: Vec<String> = all[11..]
        .iter()
        .map(|coin| format!("{}:{}", coin["txid"].as_str().unwrap(), coin["vout"]))
        .collect();
    assert_eq!(spent, rehomed);
}
