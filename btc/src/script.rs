//! The jar's two-branch witness script (ADR 0006).

use crate::error::BtcError;

const OP_IF: u8 = 0x63;
const OP_ELSE: u8 = 0x67;
const OP_ENDIF: u8 = 0x68;
const OP_DROP: u8 = 0x75;
const OP_DUP: u8 = 0x76;
const OP_EQUALVERIFY: u8 = 0x88;
const OP_HASH160: u8 = 0xa9;
const OP_CHECKSIG: u8 = 0xac;
const OP_CHECKLOCKTIMEVERIFY: u8 = 0xb1;

/// Below this, a locktime is a block height, not a time in seconds.
const LOCKTIME_THRESHOLD: u32 = 500_000_000;

/// `IF <mpc_key> CHECKSIG ELSE <locktime> CHECKLOCKTIMEVERIFY DROP DUP HASH160 <exit_key_hash>
/// EQUALVERIFY CHECKSIG ENDIF`: the jar's MPC key at any time, or after `locktime` (unix seconds)
/// the key behind `exit_key_hash`, which is the Bitcoin-only exit.
pub fn jar_script(
    mpc_key: &[u8; 33],
    exit_key_hash: &[u8; 20],
    locktime: u32,
) -> Result<Vec<u8>, BtcError> {
    if locktime < LOCKTIME_THRESHOLD {
        return Err(BtcError::LocktimeNotATime);
    }
    let locktime = script_number(locktime);
    let mut script = Vec::with_capacity(70);
    script.push(OP_IF);
    push(&mut script, mpc_key);
    script.push(OP_CHECKSIG);
    script.push(OP_ELSE);
    push(&mut script, &locktime);
    script.extend_from_slice(&[OP_CHECKLOCKTIMEVERIFY, OP_DROP, OP_DUP, OP_HASH160]);
    push(&mut script, exit_key_hash);
    script.extend_from_slice(&[OP_EQUALVERIFY, OP_CHECKSIG, OP_ENDIF]);
    Ok(script)
}

/// Minimal little-endian script number; a 0x00 byte is added when the top bit would read as a
/// sign, so times from 2^31 take five bytes (CLTV accepts up to five).
fn script_number(n: u32) -> Vec<u8> {
    let mut bytes: Vec<u8> = n.to_le_bytes().to_vec();
    while bytes.last() == Some(&0) {
        bytes.pop();
    }
    if bytes.last().is_some_and(|b| b & 0x80 != 0) {
        bytes.push(0);
    }
    bytes
}

/// A direct push of up to 75 bytes (every push in the jar script is 3 to 33 bytes).
fn push(script: &mut Vec<u8>, data: &[u8]) {
    script.push(data.len() as u8);
    script.extend_from_slice(data);
}
