//! The jar's witness script and P2WSH address, read back by Bitcoin Core's `decodescript`.

use btc::{jar_script, BtcError, Network, SegwitAddress};
use test_support::serde_json::json;
use test_support::{from_hex, to_hex, Regtest};

const MPC_KEY: &str = "025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357";
const EXIT_KEY_HASH: &str = "1d0f172a0ecb48aee1be1f2687d2963ae33f71a1";

fn key() -> [u8; 33] {
    from_hex(MPC_KEY).try_into().unwrap()
}

fn key_hash() -> [u8; 20] {
    from_hex(EXIT_KEY_HASH).try_into().unwrap()
}

#[test]
fn bitcoin_core_reads_the_jar_script_and_its_p2wsh_address() {
    let regtest = Regtest::start();
    // Core prints script numbers of up to 4 bytes in decimal and longer pushes in hex,
    // so the 5-byte locktimes show their minimal little-endian encoding.
    let cases = [
        (500_000_000u32, "500000000"),
        (1_800_000_000, "1800000000"),
        (2_147_483_647, "2147483647"),
        (2_147_483_648, "0000008000"),
        (u32::MAX, "ffffffff00"),
    ];
    for (locktime, shown) in cases {
        let script = jar_script(&key(), &key_hash(), locktime).unwrap();
        let core = regtest.rpc("decodescript", &[json!(to_hex(&script))]);

        assert_eq!(
            core["asm"].as_str().unwrap(),
            format!(
                "OP_IF {MPC_KEY} OP_CHECKSIG OP_ELSE {shown} OP_CHECKLOCKTIMEVERIFY OP_DROP \
                 OP_DUP OP_HASH160 {EXIT_KEY_HASH} OP_EQUALVERIFY OP_CHECKSIG OP_ENDIF"
            )
        );
        let jar_address = SegwitAddress::p2wsh(&script);
        assert_eq!(
            jar_address.encode(Network::Regtest),
            core["segwit"]["address"].as_str().unwrap()
        );
        assert_eq!(
            jar_address.script_pubkey(),
            from_hex(core["segwit"]["hex"].as_str().unwrap())
        );
    }
}

#[test]
fn a_locktime_below_500_million_is_a_block_height_and_is_refused() {
    for locktime in [0, 16, 499_999_999] {
        assert_eq!(
            jar_script(&key(), &key_hash(), locktime),
            Err(BtcError::LocktimeNotATime)
        );
    }
}
