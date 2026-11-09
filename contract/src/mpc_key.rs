//! A jar's MPC public key, derived here the way NEAR's MPC network derives it (MPC 3.18.0
//! `kdf.rs`): `root + tweak·G`, tweak from the contract account and the path (the jar id).

use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use k256::{AffinePoint, EncodedPoint, ProjectivePoint, Scalar, U256};
use near_sdk::{bs58, env, AccountId, CurveType, PublicKey};

const TWEAK_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";

/// An uncompressed secp256k1 point without its 0x04 tag (`x ‖ y`), the form the MPC views use.
pub type PointBytes = [u8; 64];

/// The root key as 64 bytes, if it is a secp256k1 key on the curve.
pub fn parse_root(key: &PublicKey) -> Option<PointBytes> {
    if key.curve_type() != CurveType::SECP256K1 {
        return None;
    }
    let bytes: PointBytes = key.as_bytes()[1..].try_into().ok()?;
    to_point(&bytes)?;
    Some(bytes)
}

/// The key the MPC network signs with for `path` when `predecessor` asks.
pub fn derive(root: &PointBytes, predecessor: &AccountId, path: &str) -> PointBytes {
    let hash = env::sha3_256(format!("{TWEAK_PREFIX}{predecessor},{path}"));
    let tweak = <Scalar as Reduce<U256>>::reduce_bytes(&hash.into());
    // The root was checked on the way in, so it is always a point.
    let root = to_point(root).unwrap_or_else(|| env::abort());
    let derived = (ProjectivePoint::GENERATOR * tweak + ProjectivePoint::from(root)).to_affine();
    let encoded = derived.to_encoded_point(false);
    encoded.as_bytes()[1..]
        .try_into()
        .unwrap_or_else(|_| env::abort())
}

/// SEC1 compressed form, as the jar's witness script carries it.
pub fn compress(key: &PointBytes) -> [u8; 33] {
    let mut out = [0u8; 33];
    out[0] = if key[63] & 1 == 0 { 0x02 } else { 0x03 };
    out[1..].copy_from_slice(&key[..32]);
    out
}

/// `secp256k1:<base58>`, the format of the MPC contract's `derived_public_key` view.
pub fn to_near_string(key: &PointBytes) -> String {
    format!("secp256k1:{}", bs58::encode(key).into_string())
}

fn to_point(bytes: &PointBytes) -> Option<AffinePoint> {
    let encoded = EncodedPoint::from_untagged_bytes(bytes[..].into());
    AffinePoint::from_encoded_point(&encoded).into()
}
