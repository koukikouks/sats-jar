//! Every way `create_jar` refuses, each with its readable reason and no jar left behind.

mod common;

use bitcoin::hashes::Hash as _;
use common::*;
use test_support::serde_json::{json, Value};
use test_support::Regtest;

async fn assert_refused(jars: &Jars, args: &Value, code: &str) {
    let result = jars.create_jar(args).await;
    let reason = refusal(&result);
    assert!(
        reason.contains(&format!("{code}: ")),
        "expected {code}, got {reason}"
    );
    assert_eq!(
        jars.get_jar("1").await,
        Value::Null,
        "a refused create left a jar"
    );
}

#[tokio::test]
async fn a_child_address_that_is_not_p2wpkh_on_the_contract_network_is_refused() {
    let regtest = Regtest::start();
    let core_address = |kind: &str| {
        regtest
            .rpc("getnewaddress", &[json!(""), json!(kind)])
            .as_str()
            .unwrap()
            .to_owned()
    };
    let p2wsh = bitcoin::Address::p2wsh(
        &bitcoin::ScriptBuf::from_bytes(vec![0x51]),
        bitcoin::Network::Regtest,
    )
    .to_string();
    let mut bad_checksum = child_address(bitcoin::Network::Regtest);
    let last = bad_checksum.pop().unwrap();
    bad_checksum.push(if last == 'q' { 'p' } else { 'q' });

    let cases = [
        ("not an address".to_owned(), "INVALID_CHILD_ADDRESS"),
        (bad_checksum, "INVALID_CHILD_ADDRESS"),
        (core_address("legacy"), "INVALID_CHILD_ADDRESS"),
        (core_address("p2sh-segwit"), "INVALID_CHILD_ADDRESS"),
        (
            child_address(bitcoin::Network::Testnet),
            "CHILD_ADDRESS_WRONG_NETWORK",
        ),
        (
            child_address(bitcoin::Network::Bitcoin),
            "CHILD_ADDRESS_WRONG_NETWORK",
        ),
        (p2wsh, "CHILD_ADDRESS_NOT_P2WPKH"),
        (core_address("bech32m"), "CHILD_ADDRESS_NOT_P2WPKH"),
    ];
    let jars = start("regtest").await;
    for (address, code) in cases {
        let args = jars.valid_args(&address).await;
        assert_refused(&jars, &args, code).await;
    }
}

/// The vsize of the largest one-input allowance a jar can make: the MPC branch with a 72-byte
/// signature and a five-byte locktime, paying the child and change back to the jar. Measured
/// by rust-bitcoin, independently of the contract.
fn largest_one_input_payment_vsize() -> u64 {
    use bitcoin::opcodes::all::*;
    let script = bitcoin::script::Builder::new()
        .push_opcode(OP_IF)
        .push_slice([2u8; 33])
        .push_opcode(OP_CHECKSIG)
        .push_opcode(OP_ELSE)
        .push_int(i64::from(u32::MAX))
        .push_opcode(OP_CLTV)
        .push_opcode(OP_DROP)
        .push_opcode(OP_DUP)
        .push_opcode(OP_HASH160)
        .push_slice([0u8; 20])
        .push_opcode(OP_EQUALVERIFY)
        .push_opcode(OP_CHECKSIG)
        .push_opcode(OP_ENDIF)
        .into_script();
    let mut witness = bitcoin::Witness::new();
    witness.push([0x30; 72]);
    witness.push([0x01]);
    witness.push(script.as_bytes());
    let tx = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO,
        lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![bitcoin::TxIn {
            witness,
            ..Default::default()
        }],
        output: vec![
            bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(10_000),
                script_pubkey: bitcoin::ScriptBuf::new_p2wpkh(
                    &bitcoin::WPubkeyHash::from_byte_array(CHILD_KEY_HASH),
                ),
            },
            bitcoin::TxOut {
                value: bitcoin::Amount::from_sat(10_000),
                script_pubkey: bitcoin::ScriptBuf::new_p2wsh(&script.wscript_hash()),
            },
        ],
    };
    let vsize = tx.vsize() as u64;
    assert_eq!(vsize, 163, "650 weight units, worked by hand");
    vsize
}

#[tokio::test]
async fn a_cap_whose_fee_budget_cannot_pay_one_payment_at_1_sat_per_vbyte_is_refused() {
    // The fee budget is cap / 10 per period (ADR 0005).
    let smallest_cap = 10 * largest_one_input_payment_vsize();
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;

    args["cap"] = json!((smallest_cap - 1).to_string());
    assert_refused(&jars, &args, "CAP_TOO_SMALL").await;

    args["cap"] = json!(smallest_cap.to_string());
    jars.create_jar(&args).await.into_result().unwrap();
}

#[tokio::test]
async fn an_unlock_date_that_is_not_in_the_future_is_refused() {
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    // The create lands a block or two after this reading, so `now` is already past by then.
    let now = now(&jars.worker).await;
    for unlock_at in [now - 1, now] {
        args["unlock_at"] = json!(unlock_at.to_string());
        assert_refused(&jars, &args, "UNLOCK_IN_PAST").await;
    }
    args["unlock_at"] = json!((now + 60).to_string());
    jars.create_jar(&args).await.into_result().unwrap();
}

#[tokio::test]
async fn a_jar_needs_two_or_three_guardians() {
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for (guardians, code) in [
        (json!([]), "TOO_FEW_GUARDIANS"),
        (json!(["grandma.test.near"]), "TOO_FEW_GUARDIANS"),
        (
            json!(["a.test.near", "b.test.near", "c.test.near", "d.test.near"]),
            "TOO_MANY_GUARDIANS",
        ),
    ] {
        args["guardians"] = guardians;
        assert_refused(&jars, &args, code).await;
    }
    args["guardians"] = json!(["a.test.near", "b.test.near", "c.test.near"]);
    jars.create_jar(&args).await.into_result().unwrap();
}

#[tokio::test]
async fn the_same_guardian_listed_twice_is_refused() {
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for guardians in [
        json!(["a.test.near", "a.test.near"]),
        json!(["a.test.near", "b.test.near", "a.test.near"]),
    ] {
        args["guardians"] = guardians;
        assert_refused(&jars, &args, "DUPLICATE_GUARDIAN").await;
    }
}

#[tokio::test]
async fn a_period_under_a_minute_is_refused() {
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for period in ["0", "59"] {
        args["period"] = json!(period);
        assert_refused(&jars, &args, "PERIOD_TOO_SHORT").await;
    }
    args["period"] = json!("60");
    jars.create_jar(&args).await.into_result().unwrap();
}

#[tokio::test]
async fn an_exit_locktime_past_the_last_bitcoin_lock_time_is_refused() {
    // A 30-day jar's exit opens 730 days (63,072,000 s) after unlock; a lock time is 32 bits.
    let last_unlock = u64::from(u32::MAX) - 63_072_000;
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for unlock_at in [last_unlock + 1, u64::from(u32::MAX), u64::MAX] {
        args["unlock_at"] = json!(unlock_at.to_string());
        assert_refused(&jars, &args, "LOCKTIME_OUT_OF_RANGE").await;
    }
    args["unlock_at"] = json!(last_unlock.to_string());
    jars.create_jar(&args).await.into_result().unwrap();
    assert_eq!(jars.get_jar("1").await["locktime"], u32::MAX);
}
