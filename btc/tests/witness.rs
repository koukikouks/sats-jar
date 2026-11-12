//! Witness assembly from raw (r, s) signatures: low-S and strict DER, checked against libsecp256k1.

use bitcoin::secp256k1::{ecdsa::Signature, Message, Secp256k1, SecretKey};
use btc::{jar_witness, BtcError};

/// A named test over a compact (r || s) signature.
type Shape = (&'static str, fn(&[u8; 64]) -> bool);

const WITNESS_SCRIPT: &[u8] = &[0x51]; // any script; the witness carries it as its last item

fn signature_where(found: impl Fn(&[u8; 64]) -> bool) -> Signature {
    let secp = Secp256k1::new();
    let key = SecretKey::from_slice(&[7; 32]).unwrap();
    (0u32..100_000)
        .map(|i| {
            let mut digest = [0u8; 32];
            digest[..4].copy_from_slice(&i.to_le_bytes());
            secp.sign_ecdsa(&Message::from_digest(digest), &key)
        })
        .find(|sig| found(&sig.serialize_compact()))
        .expect("a signature with that shape")
}

fn r_and_s(sig: &Signature) -> ([u8; 32], [u8; 32]) {
    let compact = sig.serialize_compact();
    (
        compact[..32].try_into().unwrap(),
        compact[32..].try_into().unwrap(),
    )
}

fn libsecp_der_with_sighash_all(sig: &Signature) -> Vec<u8> {
    let mut der = sig.serialize_der().to_vec();
    der.push(0x01);
    der
}

#[test]
fn the_witness_is_a_strict_der_signature_the_mpc_branch_selector_and_the_script() {
    let shapes: [Shape; 4] = [
        ("r with its top bit set", |c| c[0] & 0x80 != 0),
        ("r with its top bit clear", |c| {
            c[0] & 0x80 == 0 && c[0] != 0
        }),
        ("r with a leading zero byte", |c| c[0] == 0),
        ("s with a leading zero byte", |c| c[32] == 0),
    ];
    for (shape, found) in shapes {
        let sig = signature_where(found);
        let (r, s) = r_and_s(&sig);

        let witness = jar_witness(&r, &s, WITNESS_SCRIPT).unwrap();

        assert_eq!(
            witness,
            vec![
                libsecp_der_with_sighash_all(&sig),
                vec![0x01],
                WITNESS_SCRIPT.to_vec()
            ],
            "{shape}"
        );
    }
}

#[test]
fn a_high_s_signature_is_normalised_to_low_s() {
    let sig = signature_where(|_| true);
    let (r, low_s) = r_and_s(&sig);
    // n - s, the high-S twin of the same signature.
    let high_s = SecretKey::from_slice(&low_s)
        .unwrap()
        .negate()
        .secret_bytes();
    assert_ne!(high_s, low_s);

    let witness = jar_witness(&r, &high_s, WITNESS_SCRIPT).unwrap();

    assert_eq!(witness[0], libsecp_der_with_sighash_all(&sig));
}

#[test]
fn a_signature_with_r_or_s_zero_or_not_below_the_curve_order_is_refused() {
    let order: [u8; 32] = [
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36,
        0x41, 0x41,
    ];
    let one = {
        let mut x = [0u8; 32];
        x[31] = 1;
        x
    };
    for (r, s) in [
        ([0; 32], one),
        (one, [0; 32]),
        (order, one),
        (one, order),
        ([0xff; 32], one),
        (one, [0xff; 32]),
    ] {
        assert_eq!(
            jar_witness(&r, &s, WITNESS_SCRIPT),
            Err(BtcError::InvalidSignature)
        );
    }
}
