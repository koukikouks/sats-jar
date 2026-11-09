//! One jar: the giver's create args, kept exactly as sent, and what the contract derives from them.

use crate::error::{self, refuse};
use crate::mpc_key::{self, PointBytes};
use crate::Network;
use btc::{BtcError, SegwitAddress};
use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};

const DAY: u64 = 86_400;
/// A period shorter than ADR 0005's 30 days makes a jar a demo-timing jar.
const FULL_PERIOD: u64 = 30 * DAY;
/// The Bitcoin-only exit opens two years (730 days) after the unlock date.
const EXIT_DELAY: u64 = 730 * DAY;
/// The largest one-input allowance (72-byte signature, five-byte locktime, child plus change)
/// in vbytes. The fee budget (cap / 10) must pay it at 1 sat/vB, or the jar could never pay.
const LARGEST_ONE_INPUT_PAYMENT_VSIZE: u64 = 163;
/// Short enough for demo timing in the sandbox, long enough that a period always means something.
const MIN_PERIOD: u64 = 60;
const MIN_GUARDIANS: usize = 2;
const MAX_GUARDIANS: usize = 3;
/// Under demo timing off mainnet: testnet3's median time runs ahead, so never less than 3 hours.
const DEMO_EXIT_DELAY: u64 = 3 * 3_600;

/// `create_jar`'s arguments exactly as the giver sent them.
#[near(serializers = [json, borsh])]
#[derive(Debug, Clone)]
pub struct CreateArgs {
    pub child_address: String,
    /// Sats.
    pub cap: U64,
    /// Seconds.
    pub period: U64,
    /// Unix seconds.
    pub unlock_at: U64,
    pub guardians: Vec<AccountId>,
    pub family_account: AccountId,
    pub nickname: String,
}

/// One address a jar's coins can sit at. Re-homing adds more, each with its own exit key.
#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct JarAddress {
    pub witness_script: Vec<u8>,
    /// Unix seconds, from which the exit branch can spend.
    pub locktime: u32,
    pub exit_key_hash: [u8; 20],
}

/// The allowance clock. It starts at the first proven top-up (ADR 0005), so a new jar has none.
#[near(serializers = [json, borsh])]
#[derive(Debug, Clone, Default)]
pub struct Clock {
    /// Unix seconds.
    pub started_at: Option<U64>,
}

/// Where the jar is in handover (ADR 0009). Claims arrive in T08.
#[near(serializers = [json, borsh])]
#[derive(Debug, Clone, Default)]
#[serde(rename_all = "snake_case")]
pub enum Handover {
    #[default]
    None,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Jar {
    pub giver: AccountId,
    /// The holder (NEP-171 spelling).
    pub owner_id: AccountId,
    pub args: CreateArgs,
    /// The jar's MPC key (path = jar id), kept uncompressed for `ecrecover`.
    pub mpc_key: PointBytes,
    pub address: JarAddress,
    pub clock: Clock,
    pub handover: Handover,
    /// How many coins have been proven; the next coin's index.
    pub coin_count: u32,
    /// Sats in the jar's proven coins not yet spent by a confirmed payment (reserved coins are
    /// still the jar's on Bitcoin until their payment is proven).
    pub proven_balance: u64,
    /// The period of the last allowance requested. Set when it is requested, so a second
    /// request in that period is refused even while the first is unconfirmed.
    pub paid_period: Option<u64>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct JarView {
    pub jar_id: String,
    pub giver: AccountId,
    pub owner_id: AccountId,
    pub create_args: CreateArgs,
    pub address: String,
    /// Hex.
    pub witness_script: String,
    /// `secp256k1:<base58 x‖y>`, as the MPC contract's `derived_public_key` view shows it.
    pub public_key: String,
    pub locktime: u32,
    /// Derived from the settings (`demo_timing`), never from the caller.
    pub demo_timing: bool,
    pub clock: Clock,
    pub handover: Handover,
    /// Sats in the jar's proven coins not yet spent by a confirmed payment.
    pub proven_balance: U64,
}

/// Whether a jar runs on shortened time; derived from its period, never set by the caller.
pub fn demo_timing(period: u64) -> bool {
    period < FULL_PERIOD
}

/// Seconds from the unlock date (or a re-homing) until the Bitcoin-only exit opens.
pub fn exit_delay(demo_timing: bool, network: Network) -> u64 {
    if demo_timing && network != Network::Mainnet {
        DEMO_EXIT_DELAY
    } else {
        EXIT_DELAY
    }
}

impl Jar {
    /// Checks `args` and builds the jar, refusing with a readable reason. `now` is unix seconds.
    pub fn create(
        args: CreateArgs,
        giver: AccountId,
        mpc_key: PointBytes,
        network: Network,
        now: u64,
    ) -> Jar {
        let exit_key_hash = match SegwitAddress::decode(&args.child_address, network.into()) {
            Ok(SegwitAddress::P2wpkh(hash)) => hash,
            Ok(SegwitAddress::P2wsh(_)) | Err(BtcError::AddressNotSegwitV0) => refuse(
                error::CHILD_ADDRESS_NOT_P2WPKH,
                "the child's address must be a native segwit key address (bc1q or tb1q)",
            ),
            Err(BtcError::AddressWrongNetwork) => refuse(
                error::CHILD_ADDRESS_WRONG_NETWORK,
                "the child's address belongs to another Bitcoin network",
            ),
            Err(_) => refuse(
                error::INVALID_CHILD_ADDRESS,
                "the child's address is not a valid native segwit Bitcoin address",
            ),
        };
        if args.cap.0 / 10 < LARGEST_ONE_INPUT_PAYMENT_VSIZE {
            refuse(
                error::CAP_TOO_SMALL,
                &format!(
                    "a cap under {} sats cannot pay a payment's fee from its 10% fee budget",
                    LARGEST_ONE_INPUT_PAYMENT_VSIZE * 10
                ),
            );
        }
        if args.unlock_at.0 <= now {
            refuse(
                error::UNLOCK_IN_PAST,
                "the unlock date must be in the future",
            );
        }
        match args.guardians.len() {
            0..MIN_GUARDIANS => {
                refuse(error::TOO_FEW_GUARDIANS, "a jar needs at least 2 guardians")
            }
            MIN_GUARDIANS..=MAX_GUARDIANS => {}
            _ => refuse(error::TOO_MANY_GUARDIANS, "a jar has at most 3 guardians"),
        }
        // At most three, so comparing every pair is cheap.
        for (i, guardian) in args.guardians.iter().enumerate() {
            if args.guardians[..i].contains(guardian) {
                refuse(
                    error::DUPLICATE_GUARDIAN,
                    &format!("{guardian} is listed as a guardian twice"),
                );
            }
        }
        if args.period.0 < MIN_PERIOD {
            refuse(
                error::PERIOD_TOO_SHORT,
                &format!("a period must be at least {MIN_PERIOD} seconds"),
            );
        }
        let delay = exit_delay(demo_timing(args.period.0), network);
        let locktime = args
            .unlock_at
            .0
            .checked_add(delay)
            .and_then(|t| u32::try_from(t).ok())
            .unwrap_or_else(|| {
                refuse(
                    error::LOCKTIME_OUT_OF_RANGE,
                    "the exit date after this unlock date is past what Bitcoin can lock to (2106)",
                )
            });
        let witness_script =
            btc::jar_script(&mpc_key::compress(&mpc_key), &exit_key_hash, locktime)
                .unwrap_or_else(|_| env_abort());
        Jar {
            giver,
            owner_id: args.family_account.clone(),
            args,
            mpc_key,
            address: JarAddress {
                witness_script,
                locktime,
                exit_key_hash,
            },
            clock: Clock::default(),
            handover: Handover::default(),
            coin_count: 0,
            proven_balance: 0,
            paid_period: None,
        }
    }

    /// The jar address on `network`.
    pub fn address(&self, network: Network) -> String {
        SegwitAddress::p2wsh(&self.address.witness_script).encode(network.into())
    }

    /// The scriptPubKey of the child's address.
    pub fn child_script_pubkey(&self, network: Network) -> Vec<u8> {
        // Checked at creation, so it always decodes.
        SegwitAddress::decode(&self.args.child_address, network.into())
            .map(|address| address.script_pubkey())
            .unwrap_or_else(|_| env_abort())
    }

    /// The scriptPubKey a top-up to the jar address pays.
    pub fn script_pubkey(&self) -> Vec<u8> {
        SegwitAddress::p2wsh(&self.address.witness_script).script_pubkey()
    }

    pub fn view(&self, jar_id: &str, network: Network) -> JarView {
        JarView {
            jar_id: jar_id.to_owned(),
            giver: self.giver.clone(),
            owner_id: self.owner_id.clone(),
            create_args: self.args.clone(),
            address: self.address(network),
            witness_script: to_hex(&self.address.witness_script),
            public_key: mpc_key::to_near_string(&self.mpc_key),
            locktime: self.address.locktime,
            demo_timing: demo_timing(self.args.period.0),
            clock: self.clock.clone(),
            handover: self.handover.clone(),
            proven_balance: U64(self.proven_balance),
        }
    }
}

fn env_abort() -> ! {
    near_sdk::env::abort()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
