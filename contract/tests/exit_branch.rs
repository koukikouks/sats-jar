//! The Bitcoin-only exit: a proven coin of a contract-made jar spends down the exit branch with
//! the key behind the child's address, once mock time passes the jar's locktime; after handover,
//! a re-homed coin spends down its new exit branch with the child's recovery-phrase key. The
//! spend is built and signed with rust-bitcoin; Bitcoin Core's `testmempoolaccept` is the judge.

mod common;

use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{Secp256k1, SecretKey};
use bitcoin::{Address, CompressedPublicKey, Network, OutPoint, ScriptBuf, Txid};
use common::*;
use test_support::serde_json::json;
use test_support::{from_hex, to_hex, Regtest};

const COIN: u64 = 50_000;

/// The child's test key: its P2WPKH address is the jar's child address.
fn child_key() -> SecretKey {
    SecretKey::from_slice(&[33; 32]).unwrap()
}

fn child_pubkey() -> CompressedPublicKey {
    CompressedPublicKey::from_private_key(
        &Secp256k1::new(),
        &bitcoin::PrivateKey::new(child_key(), Network::Regtest),
    )
    .unwrap()
}

/// T07's BIP-84 testnet key for the public test phrase "abandon x11 about" (m/84'/1'/0'/0/0):
/// the key the child's recovery phrase derives, whose public key the child claims with.
fn phrase_key() -> SecretKey {
    SecretKey::from_slice(&from_hex(
        "a9c4134b73560f43fc5c081e5c1daa7ce068adc806d80e1f37cb658e0fea4c8d",
    ))
    .unwrap()
}

#[tokio::test]
async fn a_proven_coin_spends_down_the_exit_branch_with_the_childs_key_after_the_locktime() {
    let regtest = Regtest::start();
    let jars = start("regtest").await;
    let child = Address::p2wpkh(&child_pubkey(), Network::Regtest).to_string();

    // A demo jar (exit 3 hours after unlock: a 4-byte locktime) first, then a 2039 jar (two
    // years after: past 2^31, 5 bytes); mock time only moves forward.
    let demo_unlock = now(&jars.worker).await + 3_600;
    for (jar_id, period, unlock_at) in [("1", 3_600, demo_unlock), ("2", 30 * DAY, 2_200_000_000)] {
        let mut args = jars.valid_args(&child).await;
        args["period"] = json!(period.to_string());
        args["unlock_at"] = json!(unlock_at.to_string());
        jars.create_jar(&args).await.into_result().unwrap();
        let jar = jars.get_jar(jar_id).await;
        let locktime = jar["locktime"].as_u64().unwrap() as u32;
        assert_eq!(locktime >= 1 << 31, jar_id == "2");
        let script = ScriptBuf::from_bytes(from_hex(jar["witness_script"].as_str().unwrap()));

        let coin = jars
            .confirmed_topup(&regtest, jar["address"].as_str().unwrap(), COIN)
            .await;
        jars.prove(&jars.giver, jar_id, &coin)
            .await
            .into_result()
            .unwrap();
        assert_eq!(
            jars.get_jar(jar_id).await["proven_balance"],
            json!(COIN.to_string())
        );

        let outpoint = OutPoint {
            txid: Txid::from_byte_array(coin.funding.txid),
            vout: coin.funding.vout,
        };
        let spend = exit_spend(&regtest, outpoint, COIN, &script, locktime, &child_key());
        assert_eq!(
            regtest.test_mempool_accept(&spend),
            Err("non-final".to_owned())
        );
        regtest.set_mock_time(locktime + 1);
        assert_eq!(regtest.test_mempool_accept(&spend), Ok(()));
    }
}

#[tokio::test]
async fn a_rehomed_coin_spends_down_the_exit_branch_with_the_childs_recovery_phrase_key() {
    let regtest = Regtest::start();
    let jars = start_paying(Build::Locked, "regtest").await;
    let family = jars.family().await;
    let jar = jars.due_handover(&regtest, &family, &[COIN]).await;
    assert_eq!(
        to_hex(&phrase_key().public_key(&Secp256k1::new()).serialize()),
        CHILD_BTC_KEY
    );

    let started = jars.complete_handover(&family.stranger, &jar.id, 1).await;
    let started_at = jars.ran_at(&started).await;
    let payment_id: String = started.json().expect("payment id");
    let payment = jars.get_payment(&payment_id).await;
    jars.confirmed(&regtest, &payment)
        .await
        .into_result()
        .expect("confirmed");

    // Demo timing: the new exit opens 3 hours after the first call (two years in a real jar).
    let view = jars.get_jar(&jar.id).await;
    let locktime = view["locktime"].as_u64().unwrap() as u32;
    assert_eq!(u64::from(locktime), started_at + 3 * 3_600);
    let script = ScriptBuf::from_bytes(from_hex(view["witness_script"].as_str().unwrap()));
    let coins = jars.get_coins(&jar.id).await;
    let rehomed = coins.as_array().unwrap().last().unwrap();
    assert_eq!(rehomed["status"], "confirmed");
    let outpoint = OutPoint {
        txid: rehomed["txid"].as_str().unwrap().parse().unwrap(),
        vout: rehomed["vout"].as_u64().unwrap() as u32,
    };
    let value: u64 = rehomed["value"].as_str().unwrap().parse().unwrap();

    let spend = exit_spend(&regtest, outpoint, value, &script, locktime, &phrase_key());
    assert_eq!(
        regtest.test_mempool_accept(&spend),
        Err("non-final".to_owned())
    );
    regtest.set_mock_time(locktime + 1);
    assert_eq!(regtest.test_mempool_accept(&spend), Ok(()));
}
