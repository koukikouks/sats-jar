//! Payments built by this crate, signed with a local test key standing in for the MPC key,
//! spend a jar's P2WSH on regtest; Bitcoin Core's `testmempoolaccept` is the judge.

use bitcoin::hashes::Hash;
use bitcoin::secp256k1::{Message, PublicKey, Secp256k1, SecretKey};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::{Amount, Script};
use btc::{jar_script, jar_witness, Network, OutPoint, SegwitAddress, Transaction, TxOut};
use test_support::Regtest;

const COIN: u64 = 50_000;

struct Jar {
    key: SecretKey,
    script: Vec<u8>,
    address: SegwitAddress,
}

fn jar() -> Jar {
    let key = SecretKey::from_slice(&[11; 32]).unwrap();
    let mpc_key = PublicKey::from_secret_key(&Secp256k1::new(), &key).serialize();
    let script = jar_script(&mpc_key, &[0x22; 20], 1_800_000_000).unwrap();
    let address = SegwitAddress::p2wsh(&script);
    Jar {
        key,
        script,
        address,
    }
}

/// Funds the jar with `coins` coins, then builds and signs a payment of all of them to a fresh
/// Core address, with change back to the jar when `change` is set. `high_s` signs with the
/// high-S twin of each signature, which Core refuses unless the witness normalises it.
fn signed_payment(
    regtest: &Regtest,
    jar: &Jar,
    coins: usize,
    change: bool,
    high_s: bool,
) -> Vec<u8> {
    let jar_address = jar.address.encode(Network::Regtest);
    let inputs: Vec<OutPoint> = (0..coins)
        .map(|_| {
            let funding = regtest.fund(&jar_address, COIN);
            OutPoint {
                txid: funding.txid,
                vout: funding.vout,
            }
        })
        .collect();
    let payee = SegwitAddress::decode(&regtest.new_address(), Network::Regtest).unwrap();
    let total = COIN * coins as u64;
    let fee = 2_000;
    let mut outputs = vec![];
    if change {
        outputs.push(TxOut {
            value: 20_000,
            script_pubkey: payee.script_pubkey(),
        });
        outputs.push(TxOut {
            value: total - 20_000 - fee,
            script_pubkey: jar.address.script_pubkey(),
        });
    } else {
        outputs.push(TxOut {
            value: total - fee,
            script_pubkey: payee.script_pubkey(),
        });
    }
    let tx = Transaction::payment(&inputs, outputs);

    let secp = Secp256k1::new();
    let witnesses: Vec<Vec<Vec<u8>>> = (0..coins)
        .map(|i| {
            let sighash = tx.sighash_all(i, &jar.script, COIN).unwrap();
            let sig = secp.sign_ecdsa(&Message::from_digest(sighash), &jar.key);
            let compact = sig.serialize_compact();
            let r: [u8; 32] = compact[..32].try_into().unwrap();
            let mut s: [u8; 32] = compact[32..].try_into().unwrap();
            if high_s {
                s = SecretKey::from_slice(&s).unwrap().negate().secret_bytes();
            }
            jar_witness(&r, &s, &jar.script).unwrap()
        })
        .collect();
    let raw = tx.to_signed_bytes(&witnesses).unwrap();

    // rust-bitcoin computes the same BIP-143 sighash for every input.
    let theirs: bitcoin::Transaction = bitcoin::consensus::deserialize(&raw).unwrap();
    let mut cache = SighashCache::new(&theirs);
    for i in 0..coins {
        let expected = cache
            .p2wsh_signature_hash(
                i,
                Script::from_bytes(&jar.script),
                Amount::from_sat(COIN),
                EcdsaSighashType::All,
            )
            .unwrap();
        assert_eq!(
            tx.sighash_all(i, &jar.script, COIN).unwrap(),
            expected.to_byte_array()
        );
    }
    raw
}

#[test]
fn a_payment_spending_jar_coins_is_accepted_for_one_and_several_inputs_with_and_without_change() {
    let regtest = Regtest::start();
    let jar = jar();
    for coins in [1, 3] {
        for change in [false, true] {
            let raw = signed_payment(&regtest, &jar, coins, change, false);
            assert_eq!(
                regtest.test_mempool_accept(&raw),
                Ok(()),
                "{coins} inputs, change: {change}"
            );
        }
    }
}

#[test]
fn a_high_s_signature_still_makes_an_accepted_payment() {
    let regtest = Regtest::start();
    let raw = signed_payment(&regtest, &jar(), 2, true, true);
    assert_eq!(regtest.test_mempool_accept(&raw), Ok(()));
}

/// Funds a jar whose exit key is `child`'s and returns an exit-branch spend of that coin
/// (witness `[sig, child pubkey, <empty> (ELSE branch), script]`), with lock time `locktime`.
fn exit_branch_spend(regtest: &Regtest, child: &SecretKey, locktime: u32) -> Vec<u8> {
    let secp = Secp256k1::new();
    let child_key = PublicKey::from_secret_key(&secp, child).serialize();
    let child_key_hash = bitcoin::hashes::hash160::Hash::hash(&child_key).to_byte_array();
    let mpc_key = PublicKey::from_secret_key(&secp, &SecretKey::from_slice(&[11; 32]).unwrap());
    let script = jar_script(&mpc_key.serialize(), &child_key_hash, locktime).unwrap();
    let address = SegwitAddress::p2wsh(&script);
    let funding = regtest.fund(&address.encode(Network::Regtest), COIN);

    let payee = SegwitAddress::decode(&regtest.new_address(), Network::Regtest).unwrap();
    let mut tx = Transaction::payment(
        &[OutPoint {
            txid: funding.txid,
            vout: funding.vout,
        }],
        vec![TxOut {
            value: COIN - 1_000,
            script_pubkey: payee.script_pubkey(),
        }],
    );
    // CHECKLOCKTIMEVERIFY needs the spend's own lock time at or past the script's.
    tx.lock_time = locktime;
    let sighash = tx.sighash_all(0, &script, COIN).unwrap();
    let mut sig = secp
        .sign_ecdsa(&Message::from_digest(sighash), child)
        .serialize_der()
        .to_vec();
    sig.push(0x01);
    tx.to_signed_bytes(&[vec![sig, child_key.to_vec(), vec![], script]])
        .unwrap()
}

#[test]
fn the_exit_branch_spends_only_once_mock_time_passes_the_locktime() {
    let regtest = Regtest::start();
    let child = SecretKey::from_slice(&[33; 32]).unwrap();
    // A real date (4-byte script number) and one from 2^31 (5 bytes); both after today.
    let (near, far) = (1_800_000_000, 2_147_483_648);
    let near_spend = exit_branch_spend(&regtest, &child, near);
    let far_spend = exit_branch_spend(&regtest, &child, far);

    for spend in [&near_spend, &far_spend] {
        assert_eq!(
            regtest.test_mempool_accept(spend),
            Err("non-final".to_owned())
        );
    }

    regtest.set_mock_time(near + 1);
    assert_eq!(regtest.test_mempool_accept(&near_spend), Ok(()));
    assert_eq!(
        regtest.test_mempool_accept(&far_spend),
        Err("non-final".to_owned())
    );

    regtest.set_mock_time(far + 1);
    assert_eq!(regtest.test_mempool_accept(&far_spend), Ok(()));
}
