//! One jar: the giver's create args, kept exactly as sent, and what the contract derives from them.

use crate::emergency::{Emergency, EmergencyView};
use crate::error::{self, refuse};
use crate::handover::{Handover, HandoverView};
use crate::mpc_key::{self, PointBytes};
use crate::rule::{self, Ledger};
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
pub const LARGEST_ONE_INPUT_PAYMENT_VSIZE: u64 = 163;
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

impl JarAddress {
    /// The address whose MPC branch is `mpc_key` and whose exit branch is the key behind
    /// `exit_key_hash`, from `locktime`.
    pub fn new(mpc_key: &PointBytes, exit_key_hash: [u8; 20], locktime: u32) -> JarAddress {
        let witness_script = btc::jar_script(&mpc_key::compress(mpc_key), &exit_key_hash, locktime)
            .unwrap_or_else(|_| env_abort());
        JarAddress {
            witness_script,
            locktime,
            exit_key_hash,
        }
    }

    pub fn script_pubkey(&self) -> Vec<u8> {
        SegwitAddress::p2wsh(&self.witness_script).script_pubkey()
    }
}

/// The allowance clock. It starts at the first proven top-up (ADR 0005), so a new jar has none.
#[near(serializers = [json, borsh])]
#[derive(Debug, Clone, Default)]
pub struct Clock {
    /// Unix seconds.
    pub started_at: Option<U64>,
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
    /// The current address: top-ups and every payment's change go here.
    pub address: JarAddress,
    /// The addresses the jar moved away from, oldest first. `Coin.address` i names
    /// `old_addresses[i]`, and the current address is index `old_addresses.len()`.
    pub old_addresses: Vec<JarAddress>,
    pub clock: Clock,
    pub handover: Handover,
    /// How many coins have been proven; the next coin's index.
    pub coin_count: u32,
    /// Sats in the jar's proven coins not yet spent by a confirmed payment (reserved coins are
    /// still the jar's on Bitcoin until their payment is proven).
    pub proven_balance: u64,
    /// Carry-over, the fee budget and the last allowance (the rule's ledger).
    pub allowance: Ledger,
    pub emergency: Emergency,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct JarView {
    pub jar_id: String,
    pub giver: AccountId,
    pub owner_id: AccountId,
    pub create_args: CreateArgs,
    pub address: String,
    /// The addresses the jar moved away from, oldest first (a top-up sent there is a stray).
    pub old_addresses: Vec<String>,
    /// Hex.
    pub witness_script: String,
    /// `secp256k1:<base58 x‖y>`, as the MPC contract's `derived_public_key` view shows it.
    pub public_key: String,
    pub locktime: u32,
    /// Derived from the settings (`demo_timing`), never from the caller.
    pub demo_timing: bool,
    pub clock: Clock,
    pub handover: HandoverView,
    /// Sats in the jar's proven coins not yet spent by a confirmed payment.
    pub proven_balance: U64,
    /// Sats an allowance requested now may pay (carry-over included); 0 before the first
    /// top-up and once this period is paid.
    pub available_allowance: U64,
    /// Sats of this period's fee budget (cap / 10) not yet spent on allowance fees.
    pub fee_budget_left: U64,
    /// Unix seconds from which the next allowance may be requested (in the past when one is
    /// due now); null before the first top-up.
    pub next_allowance_at: Option<U64>,
    /// The latest emergency payment proposal.
    pub emergency: EmergencyView,
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
        let address = JarAddress::new(&mpc_key, exit_key_hash, locktime);
        Jar {
            giver,
            owner_id: args.family_account.clone(),
            args,
            mpc_key,
            address,
            old_addresses: Vec::new(),
            clock: Clock::default(),
            handover: Handover::default(),
            coin_count: 0,
            proven_balance: 0,
            allowance: Ledger::default(),
            emergency: Emergency::default(),
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
        self.address.script_pubkey()
    }

    /// The current address's index (what `Coin.address` holds for a coin there).
    pub fn address_index(&self) -> u32 {
        // A new address per re-homing: far fewer than 2^32.
        u32::try_from(self.old_addresses.len()).unwrap_or_else(|_| env_abort())
    }

    /// The address with index `index`; a coin's index always names one.
    pub fn address_at(&self, index: u32) -> &JarAddress {
        match (index as usize).cmp(&self.old_addresses.len()) {
            std::cmp::Ordering::Less => &self.old_addresses[index as usize],
            std::cmp::Ordering::Equal => &self.address,
            std::cmp::Ordering::Greater => env_abort(),
        }
    }

    /// The index of the jar address `script_pubkey` pays, if it pays one.
    pub fn address_index_of(&self, script_pubkey: &[u8]) -> Option<u32> {
        (0..=self.address_index())
            .find(|&index| self.address_at(index).script_pubkey() == script_pubkey)
    }

    /// Makes `address` the current address; the old one keeps its index.
    pub fn rehome(&mut self, address: JarAddress) {
        let old = std::mem::replace(&mut self.address, address);
        self.old_addresses.push(old);
    }

    /// The allowance at `now` (unix seconds): what a request may pay, the fee budget left and
    /// when the next allowance may be requested (null before the first top-up). `get_jar` and
    /// the picture both read it.
    pub fn allowance_at(&self, now: u64) -> (u64, u64, Option<u64>) {
        let cap = self.args.cap.0;
        let Some(started_at) = self.clock.started_at else {
            return (0, cap / 10, None);
        };
        let length = self.args.period.0;
        let period = rule::period_index(started_at.0, length, now);
        (
            self.allowance.available(cap, period),
            self.allowance.fee_budget_left(cap, period),
            Some(
                self.allowance
                    .next_allowance_at(started_at.0, length, period),
            ),
        )
    }

    /// The jar as `get_jar` shows it at `now` (unix seconds); `coins_to_move` is how many coins
    /// a completing handover has still to put in a re-homing payment.
    pub fn view(&self, jar_id: &str, network: Network, now: u64, coins_to_move: u32) -> JarView {
        let (available_allowance, fee_budget_left, next_allowance_at) = self.allowance_at(now);
        JarView {
            jar_id: jar_id.to_owned(),
            giver: self.giver.clone(),
            owner_id: self.owner_id.clone(),
            create_args: self.args.clone(),
            address: self.address(network),
            old_addresses: self
                .old_addresses
                .iter()
                .map(|old| SegwitAddress::p2wsh(&old.witness_script).encode(network.into()))
                .collect(),
            witness_script: to_hex(&self.address.witness_script),
            public_key: mpc_key::to_near_string(&self.mpc_key),
            locktime: self.address.locktime,
            demo_timing: demo_timing(self.args.period.0),
            clock: self.clock.clone(),
            handover: self.handover.view(now, coins_to_move),
            proven_balance: U64(self.proven_balance),
            available_allowance: U64(available_allowance),
            fee_budget_left: U64(fee_budget_left),
            next_allowance_at: next_allowance_at.map(U64),
            emergency: self.emergency.view(now, &self.handover),
        }
    }
}

fn env_abort() -> ! {
    near_sdk::env::abort()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
