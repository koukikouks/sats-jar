//! The jar address: the contract's witness script and P2WSH address, read by Bitcoin Core and
//! rebuilt independently with rust-bitcoin.

mod common;

use bitcoin::opcodes::all::*;
use bitcoin::script::Builder;
use common::*;
use test_support::serde_json::{self, json, Value};
use test_support::{from_hex, to_hex, Regtest};

/// The live MPC key for jar `"1"` on `jar.test.near`, compressed by libsecp256k1.
fn live_key_of_jar_1() -> bitcoin::secp256k1::PublicKey {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/derived_public_key.json")).unwrap();
    let text = fixture["vectors"][0]["public_key"].as_str().unwrap();
    let xy = bitcoin::base58::decode(text.strip_prefix("secp256k1:").unwrap()).unwrap();
    let mut uncompressed = vec![0x04];
    uncompressed.extend(xy);
    bitcoin::secp256k1::PublicKey::from_slice(&uncompressed).unwrap()
}

/// The jar's witness script as ADR 0006 describes it, built by rust-bitcoin (`push_int` is the
/// minimal script number).
fn expected_script(locktime: i64) -> bitcoin::ScriptBuf {
    Builder::new()
        .push_opcode(OP_IF)
        .push_slice(live_key_of_jar_1().serialize())
        .push_opcode(OP_CHECKSIG)
        .push_opcode(OP_ELSE)
        .push_int(locktime)
        .push_opcode(OP_CLTV)
        .push_opcode(OP_DROP)
        .push_opcode(OP_DUP)
        .push_opcode(OP_HASH160)
        .push_slice(CHILD_KEY_HASH)
        .push_opcode(OP_EQUALVERIFY)
        .push_opcode(OP_CHECKSIG)
        .push_opcode(OP_ENDIF)
        .into_script()
}

#[tokio::test]
async fn bitcoin_core_reads_the_jar_address_with_the_mpc_key_and_the_child_exit_branch() {
    let regtest = Regtest::start();
    // A 30-day jar's locktime is past 2^31 (five bytes); a demo jar's is not (four bytes).
    for period in [30 * DAY, 3_600] {
        let jars = start("regtest").await;
        let child = child_address(bitcoin::Network::Regtest);
        let mut args = jars.valid_args(&child).await;
        args["period"] = json!(period.to_string());
        let unlock_at = if period < 30 * DAY {
            now(&jars.worker).await + 3_600
        } else {
            2_200_000_000 // 2039
        };
        args["unlock_at"] = json!(unlock_at.to_string());
        jars.create_jar(&args).await.into_result().unwrap();
        let jar = jars.get_jar("1").await;
        let script = jar["witness_script"].as_str().unwrap();
        let locktime = jar["locktime"].as_i64().unwrap();
        assert_eq!(locktime >= 1 << 31, period == 30 * DAY);

        let core = regtest.rpc("decodescript", &[json!(script)]);
        let shown = if locktime < 1 << 31 {
            locktime.to_string()
        } else {
            to_hex(&(locktime as u64).to_le_bytes()[..5])
        };
        let child_program = regtest.rpc("validateaddress", &[json!(child)])["witness_program"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            core["asm"].as_str().unwrap(),
            format!(
                "OP_IF {} OP_CHECKSIG OP_ELSE {shown} OP_CHECKLOCKTIMEVERIFY OP_DROP OP_DUP \
                 OP_HASH160 {child_program} OP_EQUALVERIFY OP_CHECKSIG OP_ENDIF",
                live_key_of_jar_1()
            )
        );
        assert_eq!(jar["address"], core["segwit"]["address"]);
        assert_eq!(from_hex(script), expected_script(locktime).to_bytes());
    }
}

#[tokio::test]
async fn a_testnet_contract_gives_a_tb1q_jar_address() {
    let jars = start("testnet").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Testnet))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    let jar = jars.get_jar("1").await;

    let script = bitcoin::ScriptBuf::from_bytes(from_hex(jar["witness_script"].as_str().unwrap()));
    let expected = bitcoin::Address::p2wsh(&script, bitcoin::Network::Testnet);
    assert_eq!(jar["address"], expected.to_string());
    assert!(expected.to_string().starts_with("tb1q"));
}
