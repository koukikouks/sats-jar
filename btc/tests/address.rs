//! Segwit address encoding and validation against BIP-173, BIP-350 and BIP-84 vectors and Bitcoin Core.

use btc::{BtcError, Network, SegwitAddress};
use test_support::serde_json::json;
use test_support::{from_hex, Regtest};

#[test]
fn bip173_v0_addresses_decode_to_their_script_pubkeys_and_encode_back() {
    let vectors = [
        (
            "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
            Network::Mainnet,
            "0014751e76e8199196d454941c45d1b3a323f1433bd6",
        ),
        (
            "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7",
            Network::Testnet,
            "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262",
        ),
        (
            "tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy",
            Network::Testnet,
            "0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433",
        ),
    ];
    for (address, network, script_pubkey) in vectors {
        let decoded = SegwitAddress::decode(address, network).unwrap();
        assert_eq!(
            decoded.script_pubkey(),
            from_hex(script_pubkey),
            "{address}"
        );
        assert_eq!(decoded.encode(network), address.to_lowercase());
    }
}

#[test]
fn the_bip84_first_receive_address_round_trips_as_p2wpkh() {
    let address = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    let decoded = SegwitAddress::decode(address, Network::Mainnet).unwrap();
    assert!(matches!(decoded, SegwitAddress::P2wpkh(_)));
    assert_eq!(decoded.encode(Network::Mainnet), address);
}

#[test]
fn valid_addresses_of_witness_version_one_and_above_are_refused_as_not_v0() {
    for (address, network) in [
        (
            "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
            Network::Mainnet,
        ),
        ("BC1SW50QGDZ25J", Network::Mainnet),
        ("bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", Network::Mainnet),
        (
            "tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c",
            Network::Testnet,
        ),
        (
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
            Network::Mainnet,
        ),
    ] {
        assert_eq!(
            SegwitAddress::decode(address, network),
            Err(BtcError::AddressNotSegwitV0),
            "{address}"
        );
    }
}

#[test]
fn bip173_and_bip350_invalid_addresses_are_refused() {
    let invalid = [
        // BIP-173
        "tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty",
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5",
        "BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2",
        "bc1rw5uspcuh",
        "bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90",
        "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P",
        "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7",
        "bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du",
        "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv",
        "bc1gmk9yu",
        // BIP-350
        "tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut",
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd",
        "tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf",
        "BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL",
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh",
        "tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47",
        "bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4",
        "BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R",
        "bc1pw5dgrnzv",
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav",
        "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq",
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf",
        "tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j",
        // Not bech32 at all.
        "",
        "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn",
    ];
    for address in invalid {
        for network in [Network::Mainnet, Network::Testnet, Network::Regtest] {
            let result = SegwitAddress::decode(address, network);
            assert!(
                matches!(
                    result,
                    Err(BtcError::AddressInvalid | BtcError::AddressWrongNetwork)
                ),
                "{address} on {network:?} gave {result:?}"
            );
        }
    }
}

#[test]
fn an_address_for_another_network_is_refused_as_wrong_network() {
    let testnet = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
    assert_eq!(
        SegwitAddress::decode(testnet, Network::Mainnet),
        Err(BtcError::AddressWrongNetwork)
    );
    assert_eq!(
        SegwitAddress::decode(testnet, Network::Regtest),
        Err(BtcError::AddressWrongNetwork)
    );
}

#[test]
fn a_bitcoin_core_regtest_address_decodes_to_cores_script_pubkey() {
    let regtest = Regtest::start();
    let address = regtest.new_address();
    let info = regtest.rpc("getaddressinfo", &[json!(address)]);

    let decoded = SegwitAddress::decode(&address, Network::Regtest).unwrap();

    assert_eq!(
        decoded.script_pubkey(),
        from_hex(info["scriptPubKey"].as_str().unwrap())
    );
    assert_eq!(decoded.encode(Network::Regtest), address);
}
