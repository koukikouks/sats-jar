//! BIP-143 official test vectors (SIGHASH_ALL cases), copied from the BIP text.

use bitcoin::hex::{DisplayHex, FromHex};
use btc::Transaction;

fn hex(s: &str) -> Vec<u8> {
    Vec::from_hex(s).unwrap()
}

#[test]
fn sighash_matches_the_bip143_native_p2wpkh_vector() {
    let unsigned = hex("0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000");
    let tx = Transaction::parse(&unsigned).unwrap();

    let script_code = hex("76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac");
    let sighash = tx.sighash_all(1, &script_code, 600_000_000).unwrap();

    assert_eq!(
        sighash.to_lower_hex_string(),
        "c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670"
    );
}

#[test]
fn sighash_matches_the_bip143_p2sh_p2wsh_vector_for_sighash_all() {
    let unsigned = hex("010000000136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000000ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac00000000");
    let tx = Transaction::parse(&unsigned).unwrap();

    let witness_script = hex("56210307b8ae49ac90a048e9b53357a2354b3334e9c8bee813ecb98e99a7e07e8c3ba32103b28f0c28bfab54554ae8c658ac5c3e0ce6e79ad336331f78c428dd43eea8449b21034b8113d703413d57761b8b9781957b8c0ac1dfe69f492580ca4195f50376ba4a21033400f6afecb833092a9a21cfdf1ed1376e58c5d1f47de74683123987e967a8f42103a6d48b1131e94ba04d9737d61acdaa1322008af9602b3b14862c07a1789aac162102d8b661b0b3302ee2f162b09e07a55ad5dfbe673a9f01d9f0c19617681024306b56ae");
    let sighash = tx.sighash_all(0, &witness_script, 987_654_321).unwrap();

    assert_eq!(
        sighash.to_lower_hex_string(),
        "185c0be5263dce5b4bb50a047973c1b6272bfbd0103a89444597dc40b248ee7c"
    );
}

#[test]
fn sighash_for_an_input_the_transaction_lacks_is_refused() {
    let unsigned = hex("010000000136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000000ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac00000000");
    let tx = Transaction::parse(&unsigned).unwrap();

    assert_eq!(
        tx.sighash_all(1, &[], 1),
        Err(btc::BtcError::InputOutOfRange)
    );
}

#[test]
fn signed_serialisation_reproduces_the_bip143_signed_p2wpkh_transaction() {
    let signed = hex("01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000");
    let tx = Transaction::parse(&signed).unwrap();
    let witnesses = vec![
        vec![],
        vec![
            hex("304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01"),
            hex("025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357"),
        ],
    ];

    assert_eq!(tx.to_signed_bytes(&witnesses).unwrap(), signed);
    assert_eq!(
        tx.to_signed_bytes(&witnesses[..1]),
        Err(btc::BtcError::WitnessCountMismatch)
    );
}
