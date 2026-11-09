//! Parsing against transactions Bitcoin Core made, and malformed bytes.

use btc::Transaction;
use test_support::serde_json::json;
use test_support::{from_hex, sats, txid_to_display, Regtest};

#[test]
fn a_core_wallet_segwit_transaction_parses_with_cores_txid_and_outputs() {
    let regtest = Regtest::start();
    let funding = regtest.fund(&regtest.new_address(), 123_456);
    let core = regtest.rpc(
        "decoderawtransaction",
        &[json!(test_support::to_hex(&funding.raw_tx))],
    );
    assert!(
        core["vin"][0]["txinwitness"].is_array(),
        "Core's tx is segwit"
    );

    let tx = Transaction::parse(&funding.raw_tx).unwrap();

    assert_eq!(txid_to_display(&tx.txid()), core["txid"].as_str().unwrap());
    assert!(!tx.is_coinbase());
    let core_outputs = core["vout"].as_array().unwrap();
    assert_eq!(tx.outputs.len(), core_outputs.len());
    for (ours, theirs) in tx.outputs.iter().zip(core_outputs) {
        assert_eq!(ours.value, sats(&theirs["value"]));
        assert_eq!(
            ours.script_pubkey,
            from_hex(theirs["scriptPubKey"]["hex"].as_str().unwrap())
        );
    }
}

#[test]
fn a_regtest_coinbase_is_detected_with_cores_txid() {
    let regtest = Regtest::start();
    let tip = regtest.rpc("getbestblockhash", &[]);
    let block = regtest.rpc("getblock", &[tip, json!(2)]);
    let coinbase = &block["tx"][0];

    let tx = Transaction::parse(&from_hex(coinbase["hex"].as_str().unwrap())).unwrap();

    assert!(tx.is_coinbase());
    assert_eq!(
        txid_to_display(&tx.txid()),
        coinbase["txid"].as_str().unwrap()
    );
}

/// BIP-143's native P2WPKH example: unsigned (legacy serialisation) and signed (segwit, with a scriptSig on input 0).
const BIP143_UNSIGNED: &str = "0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000";
const BIP143_SIGNED: &str = "01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000";

fn rust_bitcoin_txid(raw: &[u8]) -> String {
    let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(raw).unwrap();
    tx.compute_txid().to_string()
}

#[test]
fn legacy_and_segwit_serialisations_give_rust_bitcoins_txid() {
    for raw in [from_hex(BIP143_UNSIGNED), from_hex(BIP143_SIGNED)] {
        let tx = Transaction::parse(&raw).unwrap();
        assert_eq!(txid_to_display(&tx.txid()), rust_bitcoin_txid(&raw));
    }
}

#[test]
fn malformed_transactions_are_refused_like_rust_bitcoin_refuses_them() {
    let signed = from_hex(BIP143_SIGNED);
    let mut trailing = signed.clone();
    trailing.push(0);
    let mut non_canonical_count = from_hex(BIP143_UNSIGNED);
    // Input count 2 written as 0xfd 0x0200 instead of 0x02.
    non_canonical_count.splice(4..5, [0xfd, 0x02, 0x00]);
    let mut huge_count = from_hex(BIP143_UNSIGNED);
    huge_count.splice(4..5, [0xfe, 0xff, 0xff, 0xff, 0x7f]);
    let mut bad_flag = signed.clone();
    bad_flag[5] = 0x02;

    let cases = [
        ("truncated", signed[..signed.len() - 1].to_vec()),
        ("trailing byte", trailing),
        ("non-canonical count", non_canonical_count),
        ("count beyond the bytes", huge_count),
        ("segwit flag not 1", bad_flag),
        ("empty", vec![]),
    ];
    for (name, raw) in cases {
        assert!(
            bitcoin::consensus::deserialize::<bitcoin::Transaction>(&raw).is_err(),
            "{name}: rust-bitcoin should refuse it too"
        );
        assert!(Transaction::parse(&raw).is_err(), "{name} was accepted");
    }
}

#[test]
fn a_transaction_without_inputs_is_refused() {
    // Segwit form with no inputs and one output; Bitcoin Core rejects it (bad-txns-vin-empty).
    let raw = from_hex("020000000001000100000000000000000000000000");
    assert_eq!(Transaction::parse(&raw), Err(btc::BtcError::NoInputs));
}
