//! NEAR's MPC signer (MPC 3.18.0, `v1.signer-prod.testnet` on testnet): the `sign` request this
//! contract sends for each input, and the check of each answer (stack notes §4).

use crate::hex;
use crate::mpc_key::PointBytes;
use near_sdk::{env, near, Gas, GasWeight, NearToken, Promise};

pub const METHOD: &str = "sign";
/// The live config's floor per `sign` call. Each call also gets a share of any extra gas the
/// caller attaches (weight 1), so a later rise of the floor is met by attaching more gas.
pub const SIGN_GAS: Gas = Gas::from_tgas(15);
pub const SIGN_WEIGHT: GasWeight = GasWeight(1);
/// MPC's `SIGN_DEPOSIT_YOCTONEAR`.
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// The callback that checks and stores up to 10 signatures.
pub const SIGNED_CALLBACK_GAS: Gas = Gas::from_tgas(30);
/// The caller's own work before the calls (`request_allowance`: coin reads, sighashes, state
/// writes; `retry_signing` does less).
pub const REQUEST_GAS: Gas = Gas::from_tgas(20);
/// What a call must attach to sign `signatures` inputs: each request's floor, the callback
/// and the caller's own work.
pub fn required_gas(signatures: u64) -> Gas {
    Gas::from_gas(
        SIGN_GAS
            .as_gas()
            .saturating_mul(signatures)
            .saturating_add(SIGNED_CALLBACK_GAS.as_gas())
            .saturating_add(REQUEST_GAS.as_gas()),
    )
}

/// The secp256k1 ECDSA domain on the live signer.
const ECDSA_DOMAIN: u64 = 0;
/// A `SignatureResponse` is about 200 bytes; anything longer is not one.
const MAX_RESPONSE_LEN: usize = 1_024;

#[near(serializers = [json])]
struct SignArgs {
    request: SignRequest,
}

#[near(serializers = [json])]
struct SignRequest {
    path: String,
    payload_v2: Payload,
    domain_id: u64,
}

#[near(serializers = [json])]
enum Payload {
    /// The sighash as hex, in the order the sighash function outputs it.
    Ecdsa(String),
}

/// The live response (`SignatureResponse::Secp256k1`, serde tag `scheme`).
#[near(serializers = [json])]
struct SignatureResponse {
    scheme: String,
    big_r: BigR,
    s: SScalar,
    recovery_id: u8,
}

#[near(serializers = [json])]
struct BigR {
    affine_point: String,
}

#[near(serializers = [json])]
struct SScalar {
    scalar: String,
}

/// One `sign` request for `sighash` under the jar's path (its id), on `signer`.
pub fn sign(signer: &near_sdk::AccountId, jar_id: &str, sighash: &[u8; 32]) -> Promise {
    let args = SignArgs {
        request: SignRequest {
            path: jar_id.to_owned(),
            payload_v2: Payload::Ecdsa(hex::encode(sighash)),
            domain_id: ECDSA_DOMAIN,
        },
    };
    Promise::new(signer.clone()).function_call_weight(
        METHOD,
        near_sdk::serde_json::to_vec(&args).unwrap_or_else(|_| env::abort()),
        SIGN_DEPOSIT,
        SIGN_GAS,
        SIGN_WEIGHT,
    )
}

/// Reads the answer to request `index` (a joined promise's result) and checks it is a signature
/// of `sighash` by `key`, as the MPC contract's own verifier does: `ecrecover` with low-S
/// required. Returns `(r, s)`, or why not. Never panics: it runs after the inputs are reserved.
pub fn read_signature(
    index: u64,
    sighash: &[u8; 32],
    key: &PointBytes,
) -> Result<([u8; 32], [u8; 32]), String> {
    let bytes = env::promise_result_checked(index, MAX_RESPONSE_LEN)
        .map_err(|_| format!("sign request {index} failed"))?;
    let response: SignatureResponse = near_sdk::serde_json::from_slice(&bytes)
        .map_err(|_| format!("sign request {index} returned no secp256k1 signature"))?;
    let big_r = hex::decode(&response.big_r.affine_point)
        .filter(|b| b.len() == 33)
        .and_then(|b| <[u8; 32]>::try_from(&b[1..]).ok());
    let s = hex::decode(&response.s.scalar).and_then(|b| <[u8; 32]>::try_from(b).ok());
    // The host function rejects (rather than refuses) a recovery id above 3 or a bad length.
    let (Some(r), Some(s), "Secp256k1", 0..=3) =
        (big_r, s, response.scheme.as_str(), response.recovery_id)
    else {
        return Err(format!(
            "sign request {index} returned a malformed signature"
        ));
    };
    let mut signature = [0u8; 64];
    signature[..32].copy_from_slice(&r);
    signature[32..].copy_from_slice(&s);
    match env::ecrecover(sighash, &signature, response.recovery_id, true) {
        Some(signer) if signer == *key => Ok((r, s)),
        _ => Err(format!(
            "signature {index} is not the jar key's signature of its input"
        )),
    }
}
