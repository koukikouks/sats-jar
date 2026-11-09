//! Witness assembly from the MPC network's raw (r, s) signatures.

use crate::error::BtcError;

/// secp256k1's group order n, big-endian.
const ORDER: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
/// n / 2, the largest low-S value (BIP-146).
const HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];
const SIGHASH_ALL: u8 = 0x01;
/// Selects the IF (MPC key) branch; exactly 0x01 because segwit v0 policy enforces MINIMALIF.
const MPC_BRANCH: u8 = 0x01;

/// The P2WSH witness that spends a jar input down its MPC-key branch:
/// `[DER(r, low-S s) || SIGHASH_ALL, 0x01, witness_script]`.
/// `r` is the x-coordinate of the MPC response's `big_r` (bytes 1..33), `s` its scalar.
/// The MPC network already returns low-S; normalising again is cheap insurance.
pub fn jar_witness(
    r: &[u8; 32],
    s: &[u8; 32],
    witness_script: &[u8],
) -> Result<Vec<Vec<u8>>, BtcError> {
    for scalar in [r, s] {
        if *scalar == [0; 32] || *scalar >= ORDER {
            return Err(BtcError::InvalidSignature);
        }
    }
    let s = if *s > HALF_ORDER { order_minus(s) } else { *s };

    let r = der_integer(r);
    let s = der_integer(&s);
    // Both integers are at most 33 bytes, so every length fits in one byte.
    let mut sig = Vec::with_capacity(6 + r.len() + s.len() + 1);
    sig.push(0x30);
    sig.push((4 + r.len() + s.len()) as u8);
    sig.push(0x02);
    sig.push(r.len() as u8);
    sig.extend_from_slice(&r);
    sig.push(0x02);
    sig.push(s.len() as u8);
    sig.extend_from_slice(&s);
    sig.push(SIGHASH_ALL);

    Ok(vec![sig, vec![MPC_BRANCH], witness_script.to_vec()])
}

/// n - s, for 0 < s < n.
fn order_minus(s: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut diff = i16::from(ORDER[i]) - i16::from(s[i]) - borrow;
        borrow = 0;
        if diff < 0 {
            diff += 256;
            borrow = 1;
        }
        out[i] = diff as u8;
    }
    out
}

/// A BIP-66 strict DER integer: no leading zero bytes, plus a 0x00 when the top bit is set.
fn der_integer(value: &[u8; 32]) -> Vec<u8> {
    let first = value.iter().position(|&b| b != 0).unwrap_or(31);
    let mut out = Vec::with_capacity(33);
    if value[first] & 0x80 != 0 {
        out.push(0);
    }
    out.extend_from_slice(&value[first..]);
    out
}
