//! Sandbox-only stand-in for NEAR's MPC signer (`v1.signer-prod.testnet`, MPC 3.18.0).
//!
//! `sign` checks a request the way MPC 3.18.0's `check_request_preconditions` does (domain, then
//! gas, then 1 yoctoNEAR, refunding any excess), with the same texts, and answers with the live
//! `SignatureResponse` JSON. Instead of yielding until the nodes respond, it signs at once under a
//! fixed test root secret: the key for `(predecessor, path)` is `root + tweak`, the tweak as in
//! MPC's `kdf.rs`, so the jar contract's own derivation of the public key matches it.

use k256::ecdsa::SigningKey;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, NonZeroScalar, ProjectivePoint, Scalar, U256};
use near_sdk::{bs58, env, near, require, AccountId, Gas, NearToken, Promise};

const TWEAK_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";
/// The test root secret. Public on purpose: this signer guards nothing.
const ROOT_SECRET: [u8; 32] = [0x5a; 32];
/// The live config's `sign_call_gas_attachment_requirement_tera_gas`.
const LIVE_MIN_GAS_TGAS: u64 = 15;
/// MPC's `SIGN_DEPOSIT_YOCTONEAR`.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// The only domain served: secp256k1 ECDSA, domain 0 on the live signer.
const ECDSA_DOMAIN: u64 = 0;

#[near(serializers = [json])]
pub struct SignRequestArgs {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

#[near(serializers = [json])]
pub enum Payload {
    /// The 32-byte hash to sign, as hex.
    Ecdsa(String),
}

#[near(serializers = [json])]
pub struct SignatureResponse {
    pub scheme: String,
    pub big_r: BigR,
    pub s: S,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
pub struct BigR {
    /// SEC1 compressed point, hex.
    pub affine_point: String,
}

#[near(serializers = [json])]
pub struct S {
    pub scalar: String,
}

/// How `sign` answers; the tests switch it to see the jar contract handle a failed signing.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Sign with the derived key, as the live network does.
    Sign,
    /// Fail the request, as a timed-out request fails.
    Fail,
    /// Sign with the root key instead of the derived one: a signature for the wrong key.
    WrongKey,
}

#[near(contract_state)]
pub struct Signer {
    mode: Mode,
    min_gas_tgas: u64,
}

impl Default for Signer {
    fn default() -> Self {
        Self {
            mode: Mode::Sign,
            min_gas_tgas: LIVE_MIN_GAS_TGAS,
        }
    }
}

#[near]
impl Signer {
    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) -> SignatureResponse {
        if request.domain_id != ECDSA_DOMAIN {
            env::panic_str(&format!(
                "The provided domain ID, {}, was not found.",
                request.domain_id
            ));
        }
        let required = Gas::from_tgas(self.min_gas_tgas);
        let prepaid = env::prepaid_gas();
        require!(
            prepaid >= required,
            format!(
                "Provided gas is lower than required. Provided: {}, required: {}",
                prepaid.as_gas(),
                required.as_gas()
            )
        );
        let deposit = env::attached_deposit();
        match deposit.checked_sub(SIGN_DEPOSIT) {
            None => env::panic_str(&format!(
                "Attached deposit is lower than required. Attached: {}, required: {}",
                deposit.as_yoctonear(),
                SIGN_DEPOSIT.as_yoctonear()
            )),
            Some(excess) if !excess.is_zero() => Promise::new(env::predecessor_account_id())
                .transfer(excess)
                .detach(),
            Some(_) => {}
        }
        let Payload::Ecdsa(payload) = request.payload_v2;
        let payload: [u8; 32] = decode_hex(&payload)
            .and_then(|bytes| bytes.try_into().ok())
            .filter(|bytes: &[u8; 32]| {
                bool::from(Scalar::from_repr(FieldBytes::from(*bytes)).is_some())
            })
            .unwrap_or_else(|| env::panic_str("Ecdsa payload cannot be converted to Scalar"));

        let secret = match self.mode {
            Mode::Sign => derived_secret(&env::predecessor_account_id(), &request.path),
            Mode::WrongKey => root_secret(),
            Mode::Fail => env::panic_str("Signature request has timed out."),
        };
        let key = SigningKey::from(NonZeroScalar::new(secret).unwrap());
        let (signature, recovery_id) = key
            .sign_prehash_recoverable(&payload)
            .unwrap_or_else(|_| env::panic_str("signing failed"));
        // k256 returns low-S with the recovery id to match, as MPC does. `big_r` is the point
        // that recovery id names; the jar contract reads only its x-coordinate.
        let (r, s) = signature.split_bytes();
        let mut big_r = vec![if recovery_id.is_y_odd() { 0x03 } else { 0x02 }];
        big_r.extend_from_slice(&r);
        SignatureResponse {
            scheme: "Secp256k1".to_owned(),
            big_r: BigR {
                affine_point: encode_hex(&big_r),
            },
            s: S {
                scalar: encode_hex(&s),
            },
            recovery_id: recovery_id.to_byte(),
        }
    }

    /// `secp256k1:<base58 x‖y>`, like the live `public_key` view.
    pub fn public_key(&self) -> String {
        near_key(ProjectivePoint::GENERATOR * root_secret())
    }

    /// Like the live view: the key `sign` uses for `predecessor` and `path`.
    pub fn derived_public_key(
        &self,
        path: String,
        predecessor: AccountId,
        domain_id: u64,
    ) -> String {
        require!(domain_id == ECDSA_DOMAIN, "only domain 0 is served");
        near_key(ProjectivePoint::GENERATOR * derived_secret(&predecessor, &path))
    }

    /// Test control: how `sign` answers.
    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    /// Test control: the gas floor, as an MPC config vote would change it.
    pub fn set_min_gas(&mut self, tgas: u64) {
        self.min_gas_tgas = tgas;
    }
}

fn root_secret() -> Scalar {
    Option::from(Scalar::from_repr(FieldBytes::from(ROOT_SECRET)))
        .unwrap_or_else(|| env::panic_str("root secret"))
}

fn derived_secret(predecessor: &AccountId, path: &str) -> Scalar {
    let hash = env::sha3_256(format!("{TWEAK_PREFIX}{predecessor},{path}"));
    let tweak = <Scalar as Reduce<U256>>::reduce_bytes(&hash.into());
    root_secret() + tweak
}

fn near_key(point: ProjectivePoint) -> String {
    let encoded = point.to_affine().to_encoded_point(false);
    format!(
        "secp256k1:{}",
        bs58::encode(&encoded.as_bytes()[1..]).into_string()
    )
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}
