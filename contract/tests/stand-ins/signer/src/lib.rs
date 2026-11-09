//! Sandbox-only stand-in for NEAR's MPC signer (`v1.signer-prod.testnet`, MPC 3.18.0).
//!
//! `sign` checks a request the way MPC 3.18.0's `check_request_preconditions` does (domain, then
//! gas, then 1 yoctoNEAR, refunding any excess), with the same texts, and answers with the live
//! `SignatureResponse` JSON. Instead of yielding until the nodes respond, it signs at once under a
//! fixed test root secret: the key for `(predecessor, path)` is `root + tweak`, the tweak as in
//! MPC's `kdf.rs`, so the jar contract's own derivation of the public key matches it.
//!
//! Two test modes do yield, as the live `sign` does: `stall` never answers, so the request fails
//! after the protocol's 200-block yield timeout with the live text; `slow` answers only when the
//! test calls `respond`, after that timeout (a second yield keeps the request open), so the
//! answer reaches the jar contract later than any live answer could.

use k256::ecdsa::SigningKey;
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{FieldBytes, NonZeroScalar, ProjectivePoint, Scalar, U256};
use near_sdk::{
    bs58, env, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError,
};

const TWEAK_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";
/// The test root secret. Public on purpose: this signer guards nothing.
const ROOT_SECRET: [u8; 32] = [0x5a; 32];
/// The live config's `sign_call_gas_attachment_requirement_tera_gas`.
const LIVE_MIN_GAS_TGAS: u64 = 15;
/// MPC's `SIGN_DEPOSIT_YOCTONEAR`.
const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);
/// The only domain served: secp256k1 ECDSA, domain 0 on the live signer.
const ECDSA_DOMAIN: u64 = 0;
/// MPC's text when a request's yield times out.
const TIMED_OUT: &str = "Signature request has timed out.";
/// Each yield's callback gets this plus all the gas left over (weight 1), so the first can open
/// the second yield and the second can sign.
const YIELD_CALLBACK_GAS: Gas = Gas::from_tgas(5);
const DATA_ID_REGISTER: u64 = 0;

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
    /// Yield and never answer: the request times out after 200 blocks, as a live one does.
    Stall,
    /// Yield, and after the timeout keep the request open until the test calls `respond`.
    Slow,
}

/// What a yielded request needs to be answered later.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pending {
    pub predecessor: AccountId,
    pub path: String,
    /// Hex.
    pub payload: String,
}

#[near(contract_state)]
pub struct Signer {
    mode: Mode,
    min_gas_tgas: u64,
    /// `slow` requests waiting for `respond`, oldest first: (data id, request).
    waiting: Vec<(Vec<u8>, Pending)>,
}

impl Default for Signer {
    fn default() -> Self {
        Self {
            mode: Mode::Sign,
            min_gas_tgas: LIVE_MIN_GAS_TGAS,
            waiting: Vec::new(),
        }
    }
}

#[near]
impl Signer {
    #[payable]
    pub fn sign(&mut self, request: SignRequestArgs) {
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

        let pending = Pending {
            predecessor: env::predecessor_account_id(),
            path: request.path,
            payload: encode_hex(&payload),
        };
        match self.mode {
            Mode::Sign => respond_with(signature(&pending, false)),
            Mode::WrongKey => respond_with(signature(&pending, true)),
            Mode::Fail => env::panic_str(TIMED_OUT),
            Mode::Stall | Mode::Slow => {
                let args = near_sdk::serde_json::json!({
                    "pending": pending,
                    "slow": self.mode == Mode::Slow,
                });
                yield_to("on_timeout", &args);
            }
        }
    }

    /// The first yield's callback; nobody resumes it, so it runs when it times out. A `stall`
    /// request fails here; a `slow` one opens a second yield for `respond`.
    #[private]
    pub fn on_timeout(
        &mut self,
        pending: Pending,
        slow: bool,
        #[callback_result] _answer: Result<(), PromiseError>,
    ) {
        if !slow {
            env::panic_str(TIMED_OUT);
        }
        let args = near_sdk::serde_json::json!({ "pending": pending });
        let data_id = yield_to("on_respond", &args);
        self.waiting.push((data_id, pending));
    }

    /// The second yield's callback: `respond`'s verdict, `true` to sign.
    #[private]
    pub fn on_respond(
        &mut self,
        pending: Pending,
        #[callback_result] ok: Result<bool, PromiseError>,
    ) {
        match ok {
            Ok(true) => respond_with(signature(&pending, false)),
            _ => env::panic_str(TIMED_OUT),
        }
    }

    /// Test control: answers the oldest waiting `slow` request, with a signature if `ok`.
    pub fn respond(&mut self, ok: bool) {
        require!(!self.waiting.is_empty(), "no request is waiting");
        let (data_id, _) = self.waiting.remove(0);
        let data_id: [u8; 32] = data_id.try_into().unwrap_or_else(|_| env::abort());
        env::promise_yield_resume(&data_id, if ok { &b"true"[..] } else { &b"false"[..] });
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

/// Yields to `method` on this contract with `args`, returning the yield as this call's result.
/// Returns the data id `respond` resumes it with.
fn yield_to(method: &str, args: &near_sdk::serde_json::Value) -> Vec<u8> {
    let index = env::promise_yield_create(
        method,
        args.to_string(),
        YIELD_CALLBACK_GAS,
        GasWeight(1),
        DATA_ID_REGISTER,
    );
    env::promise_return(index);
    env::read_register(DATA_ID_REGISTER).unwrap_or_else(|| env::abort())
}

/// Returns `response` as this call's JSON result.
fn respond_with(response: SignatureResponse) {
    let bytes = near_sdk::serde_json::to_vec(&response).unwrap_or_else(|_| env::abort());
    env::value_return(&bytes);
}

/// The live response for `pending`, signed with the derived key (or the root key).
fn signature(pending: &Pending, wrong_key: bool) -> SignatureResponse {
    let secret = if wrong_key {
        root_secret()
    } else {
        derived_secret(&pending.predecessor, &pending.path)
    };
    let payload: [u8; 32] = decode_hex(&pending.payload)
        .and_then(|bytes| bytes.try_into().ok())
        .unwrap_or_else(|| env::abort());
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
