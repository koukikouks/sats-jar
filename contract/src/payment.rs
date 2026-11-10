//! Payments the contract builds from a jar's own coins: which coins, how much to whom, and the
//! fee. Pure logic, no I/O; the contract stores the result and asks the signer.

use crate::topup::DUST_FLOOR;
use near_sdk::json_types::U64;
use near_sdk::near;

/// ADR 0006: at most 10 inputs per payment.
pub const MAX_INPUTS: usize = 10;
/// A strict-DER signature with SIGHASH_ALL is at most 72 bytes once S is low (BIP-146).
const MAX_SIGNATURE_LEN: u64 = 72;

/// A coin free to spend, as the jar's free list keeps it: largest first.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FreeCoin {
    pub value: u64,
    /// The coin's index in the jar.
    pub index: u32,
}

/// Adds `coin` to a free list, keeping it largest first (ties in proof order).
pub fn insert_free(list: &mut Vec<FreeCoin>, coin: FreeCoin) {
    let at = list.partition_point(|c| c.value >= coin.value);
    list.insert(at, coin);
}

/// Why a payment cannot be built, in the spec's refusal order.
#[derive(Debug, PartialEq, Eq)]
pub enum Shortfall {
    /// The coins cannot pay the fee (or, if less, the fee budget) plus a payment at the dust
    /// floor.
    InsufficientBalance,
    /// The fee would be over the cap's fee budget (cap / 10).
    FeeOverBudget { fee: u64, budget: u64 },
    /// The payment would be under half the cap (ADR 0005's size floor).
    PaymentTooSmall { amount: u64 },
    /// Paying the cap would leave a change too small to keep (it would go to miners).
    ChangeBelowDust { change: u64 },
}

/// A payment worked out from the free list: the coins to spend (a prefix of the list), the
/// payee's amount, the change back to the jar (0 for none), and the fee they leave.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub inputs: Vec<FreeCoin>,
    pub amount: u64,
    pub change: u64,
    pub fee: u64,
}

/// The scripts a payment's size depends on.
pub struct Shape {
    pub payee_script_len: u64,
    pub change_script_len: u64,
    /// The P2WSH witness script every input spends with.
    pub witness_script_len: u64,
}

/// Plans a payment of up to `target` sats (never under half of `cap`) at `fee_rate` sat/vB from `free` (largest first).
/// Coins are added, at most 10, until they pay the target, the fee and a change worth keeping;
/// a jar holding less pays what it has after the fee. The real fee (inputs − outputs) never
/// exceeds `budget`, and is at least the rate times the largest size the signed transaction can
/// have.
pub fn plan(
    free: &[FreeCoin],
    target: u64,
    cap: u64,
    budget: u64,
    fee_rate: u64,
    shape: &Shape,
) -> Result<Plan, Shortfall> {
    let fees = |inputs: usize| {
        (
            fee_rate.saturating_mul(vsize(inputs, &[shape.payee_script_len], shape)),
            fee_rate.saturating_mul(vsize(
                inputs,
                &[shape.payee_script_len, shape.change_script_len],
                shape,
            )),
        )
    };
    let mut total = 0u64;
    let mut taken = 0;
    for coin in free.iter().take(MAX_INPUTS) {
        // 21 M BTC fits a u64, so the sum of proven coins cannot overflow.
        total = total.saturating_add(coin.value);
        taken += 1;
        let (_, with_change) = fees(taken);
        if total
            >= target
                .saturating_add(with_change)
                .saturating_add(DUST_FLOOR)
        {
            break;
        }
    }
    let (without_change, with_change) = fees(taken);
    // Measured against the budget too, so a jar that could pay its budget hears that the
    // rate is too high rather than that it is short.
    if total < without_change.min(budget).saturating_add(DUST_FLOOR) {
        return Err(Shortfall::InsufficientBalance);
    }
    // Every payment from these coins costs at least this; checked before any `total − fee`.
    if without_change > budget {
        return Err(Shortfall::FeeOverBudget {
            fee: without_change,
            budget,
        });
    }
    let (amount, change) = if total
        >= target
            .saturating_add(with_change)
            .saturating_add(DUST_FLOOR)
    {
        (target, total - target - with_change)
    } else if total - without_change <= target {
        (total - without_change, 0)
    } else {
        // Keeping the change would cost `with_change`; it is the fee this payment would need.
        if with_change > budget {
            return Err(Shortfall::FeeOverBudget {
                fee: with_change,
                budget,
            });
        }
        return Err(Shortfall::ChangeBelowDust {
            change: total.saturating_sub(target).saturating_sub(with_change),
        });
    };
    let fee = total - amount - change;
    if fee > budget {
        return Err(Shortfall::FeeOverBudget { fee, budget });
    }
    // Doubling rather than halving, so an odd cap's floor does not round down.
    if amount.saturating_mul(2) < cap {
        return Err(Shortfall::PaymentTooSmall { amount });
    }
    Ok(Plan {
        inputs: free[..taken].to_vec(),
        amount,
        change,
        fee,
    })
}

/// The largest virtual size (BIP-141) of a payment with `inputs` jar inputs and outputs with
/// these scripts, signed down the MPC branch: weight = 4 × base + witness, rounded up.
pub fn vsize(inputs: usize, output_script_lens: &[u64], shape: &Shape) -> u64 {
    let inputs = inputs as u64;
    let outputs = output_script_lens.len() as u64;
    // Version and lock time, the input and output counts.
    let mut base = 8 + compact_size_len(inputs) + compact_size_len(outputs);
    // Each input: outpoint 36, empty scriptSig 1, sequence 4.
    base += 41 * inputs;
    for len in output_script_lens {
        base += 8 + compact_size_len(*len) + len;
    }
    // Marker and flag, then per input: item count, signature, branch selector, witness script.
    let script = shape.witness_script_len;
    let per_input = 1 + (1 + MAX_SIGNATURE_LEN) + (1 + 1) + compact_size_len(script) + script;
    let witness = 2 + per_input * inputs;
    (4 * base + witness).div_ceil(4)
}

fn compact_size_len(n: u64) -> u64 {
    match n {
        0..=0xfc => 1,
        0xfd..=0xffff => 3,
        0x1_0000..=0xffff_ffff => 5,
        _ => 9,
    }
}

/// One payment the contract built. Never deleted: it is the jar's history and the guard on its
/// inputs.
#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Payment {
    pub jar_id: String,
    pub kind: PaymentKind,
    /// The spent coins' indices in the jar, in input order.
    pub inputs: Vec<u32>,
    /// The payee first, then any change back to the jar.
    pub outputs: Vec<Output>,
    /// Internal byte order.
    pub txid: [u8; 32],
    /// BIP-143 SIGHASH_ALL per input: what the signer is asked to sign.
    pub sighashes: Vec<[u8; 32]>,
    pub fee: u64,
    /// Which signing round a callback belongs to; a callback from another round is ignored.
    pub attempt: u32,
    /// The block height the current signing round began at.
    pub signing_started_at: u64,
    pub status: PaymentStatus,
    /// One per input once signed, checked against the jar's key.
    pub signatures: Vec<RawSignature>,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub enum PaymentKind {
    Allowance { period: u64 },
    Emergency { proposal_id: u32 },
}

/// Moves only forward: signing → signed or signing failed, signed → confirmed. A failed or
/// stalled signing goes back to signing only through `retry_signing`, in a new round with the
/// same transaction; confirmed and cancelled are final.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaymentStatus {
    Signing,
    SigningFailed {
        reason: String,
    },
    Signed,
    Confirmed,
    /// Only the dev-only escape cancels.
    Cancelled,
}

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Output {
    pub value: u64,
    pub script_pubkey: Vec<u8>,
}

/// An MPC signature as returned: r (the x-coordinate of `big_r`) and s.
#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct RawSignature {
    pub r: [u8; 32],
    pub s: [u8; 32],
}

impl Payment {
    /// Neither confirmed nor cancelled: its inputs are still reserved.
    pub fn is_pending(&self) -> bool {
        !matches!(
            self.status,
            PaymentStatus::Confirmed | PaymentStatus::Cancelled
        )
    }

    /// The change back to the jar, if the payment has one (always the second output).
    pub fn change(&self) -> Option<&Output> {
        self.outputs.get(1)
    }
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct PaymentView {
    pub payment_id: U64,
    pub jar_id: String,
    /// `"allowance"` or `"emergency"`.
    pub kind: String,
    /// The allowance's period; null for an emergency payment.
    pub period: Option<U64>,
    pub status: StatusView,
    /// Why signing failed, for a `signing_failed` payment.
    pub failure: Option<String>,
    /// Display hex.
    pub txid: String,
    /// Sats paid to the payee.
    pub amount: U64,
    /// Sats the payment leaves for miners, from the jar.
    pub fee: U64,
    /// Sats back to the jar address (0 for none).
    pub change: U64,
    pub inputs: Vec<InputView>,
    /// The signed transaction, hex, ready to broadcast; once signed.
    pub signed_tx: Option<String>,
}

#[near(serializers = [json])]
#[derive(Debug, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum StatusView {
    Signing,
    SigningFailed,
    Signed,
    Confirmed,
    Cancelled,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct InputView {
    /// Display hex.
    pub txid: String,
    pub vout: u32,
    pub value: U64,
}

impl PaymentStatus {
    pub fn view(&self) -> (StatusView, Option<String>) {
        match self {
            PaymentStatus::Signing => (StatusView::Signing, None),
            PaymentStatus::SigningFailed { reason } => {
                (StatusView::SigningFailed, Some(reason.clone()))
            }
            PaymentStatus::Signed => (StatusView::Signed, None),
            PaymentStatus::Confirmed => (StatusView::Confirmed, None),
            PaymentStatus::Cancelled => (StatusView::Cancelled, None),
        }
    }
}
