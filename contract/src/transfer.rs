//! Transfer after handover (ADR 0009): the holder starts a transfer to a receiver's account and
//! can cancel it until it is accepted; the receiver's own account accepts with its Bitcoin key,
//! so the seller never chooses the key re-homed coins answer to. Acceptance re-homes the jar's
//! coins to a new address whose exit branch is that key, by the same rules as handover, and once
//! every coin held at acceptance has moved and been confirmed the jar NFT moves to the receiver.
//! The state machine is pure (time comes in as `now`); the contract's calls follow it.

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::{parse_key, Handover};
use crate::{hex, history, rehoming, SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, AccountId, PromiseOrValue};

/// Where the jar is in a transfer.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub enum Transfer {
    #[default]
    None,
    /// The holder offered the jar to `receiver` at `started_at` (unix seconds).
    Started {
        receiver: AccountId,
        started_at: u64,
    },
    /// The receiver accepted with `btc_pubkey` (SEC1 compressed) at `accepted_at`: the coins to
    /// move are those free then, all with an index below `fixed_below`; `left` of them are not
    /// yet spent by a confirmed payment.
    Accepted {
        receiver: AccountId,
        btc_pubkey: [u8; 33],
        accepted_at: u64,
        fixed_below: u32,
        left: u32,
    },
}

/// The transfer as `get_jar` shows it.
#[near(serializers = [json])]
#[derive(Debug, Clone)]
#[serde(rename_all = "snake_case")]
pub enum TransferView {
    None,
    Started {
        receiver: AccountId,
        started_at: U64,
    },
    Accepted {
        receiver: AccountId,
        /// Hex.
        btc_pubkey: String,
        accepted_at: U64,
        /// Fixed coins not yet in a re-homing payment.
        coins_to_move: u32,
        /// Fixed coins not yet moved and confirmed; the NFT moves when this reaches 0.
        coins_left: u32,
    },
}

impl Transfer {
    pub fn is_open(&self) -> bool {
        !matches!(self, Transfer::None)
    }

    /// The bound below which coins are fixed to move, once accepted.
    pub fn fixed_below(&self) -> Option<u32> {
        match self {
            Transfer::Accepted { fixed_below, .. } => Some(*fixed_below),
            _ => None,
        }
    }

    /// Once accepted, counts down the fixed coins among `spent` (a confirmed payment's inputs,
    /// whatever its kind); true once none is left.
    pub fn count_down(&mut self, spent: &[u32]) -> bool {
        match self {
            Transfer::Accepted {
                fixed_below, left, ..
            } => rehoming::count_down(*fixed_below, left, spent),
            _ => false,
        }
    }

    /// Ends an accepted transfer; returns the receiver the jar moves to.
    fn finish(&mut self) -> AccountId {
        let Transfer::Accepted { receiver, .. } = std::mem::take(self) else {
            env::abort()
        };
        receiver
    }

    pub fn view(&self, coins_to_move: u32) -> TransferView {
        match self {
            Transfer::None => TransferView::None,
            Transfer::Started {
                receiver,
                started_at,
            } => TransferView::Started {
                receiver: receiver.clone(),
                started_at: U64(*started_at),
            },
            Transfer::Accepted {
                receiver,
                btc_pubkey,
                accepted_at,
                left,
                ..
            } => TransferView::Accepted {
                receiver: receiver.clone(),
                btc_pubkey: hex::encode(btc_pubkey),
                accepted_at: U64(*accepted_at),
                coins_to_move,
                coins_left: *left,
            },
        }
    }
}

#[near]
impl SatsJar {
    /// The holder offers the jar to `receiver`, after handover only, while no payment from it is
    /// pending. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn start_transfer(&mut self, jar_id: String, receiver: AccountId) {
        let mut jar = self.jar(&jar_id).clone();
        if !matches!(jar.handover, Handover::Done { .. }) {
            refuse(
                error::TRANSFER_BEFORE_HANDOVER,
                "a jar can be transferred only after its handover",
            );
        }
        assert_one_yocto();
        self.refuse_unless_holder(&jar_id, &jar.owner_id);
        if jar.transfer.is_open() {
            refuse(
                error::TRANSFER_OPEN,
                "a transfer of this jar is already open; cancel it first",
            );
        }
        if self.payment_pending(&jar_id, &jar) {
            refuse(
                error::PAYMENT_PENDING,
                "a payment from this jar is not yet confirmed on Bitcoin; a jar cannot change \
                 hands while a payment its holder signed is pending",
            );
        }
        jar.transfer = Transfer::Started {
            receiver: receiver.clone(),
            started_at: env::block_timestamp_ms() / 1_000,
        };
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::TransferStarted {
                receiver: receiver.clone(),
            },
        );
        SatsJarEvent::TransferStarted { jar_id, receiver }.emit();
    }

    /// The holder cancels a transfer not yet accepted. 1 yoctoNEAR: a full-access key only.
    #[payable]
    pub fn cancel_transfer(&mut self, jar_id: String) {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        self.refuse_unless_holder(&jar_id, &jar.owner_id);
        match jar.transfer {
            Transfer::None => refuse(error::NO_OPEN_TRANSFER, "no transfer of this jar is open"),
            Transfer::Accepted { .. } => refuse(
                error::TRANSFER_ACCEPTED,
                "the receiver has accepted this transfer and its Bitcoin is moving, so it can no \
                 longer be cancelled",
            ),
            Transfer::Started { .. } => {}
        }
        jar.transfer = Transfer::None;
        self.jars.insert(jar_id.clone(), jar);
        self.record(&jar_id, history::Event::TransferCancelled);
        SatsJarEvent::TransferCancelled { jar_id }.emit();
    }

    /// The receiver's own account accepts the transfer with its Bitcoin key (SEC1 compressed,
    /// hex). The first call moves the jar to a new address whose exit branch is that key,
    /// timelocked two years ahead, and fixes the coins to move: every coin the jar holds. Each
    /// call builds one re-homing payment of up to 10 of them; once accepted, anyone may call
    /// again with the same key until every coin has moved. The result is the payment id, or
    /// null when the jar was empty and moved to the receiver in this call. 1 yoctoNEAR.
    #[payable]
    pub fn accept_transfer(
        &mut self,
        jar_id: String,
        btc_pubkey: String,
        fee_rate: U64,
    ) -> PromiseOrValue<Option<U64>> {
        assert_one_yocto();
        let mut jar = self.jar(&jar_id).clone();
        let key = match &jar.transfer {
            Transfer::None => refuse(error::NO_OPEN_TRANSFER, "no transfer of this jar is open"),
            Transfer::Started { receiver, .. } => {
                // Story 58a: only the receiver's own account names the key.
                if env::predecessor_account_id() != *receiver {
                    refuse(
                        error::NOT_THE_RECEIVER,
                        &format!("only {receiver} can accept this transfer"),
                    );
                }
                parse_key(
                    &btc_pubkey,
                    error::INVALID_BTC_KEY,
                    "the receiver's Bitcoin key",
                )
            }
            Transfer::Accepted {
                btc_pubkey: accepted,
                ..
            } => {
                let key = parse_key(
                    &btc_pubkey,
                    error::INVALID_BTC_KEY,
                    "the receiver's Bitcoin key",
                );
                if key != *accepted {
                    refuse(
                        error::KEY_CHANGED,
                        "this transfer was accepted with another Bitcoin key",
                    );
                }
                key
            }
        };
        if self.payment_pending(&jar_id, &jar) {
            refuse(
                error::PAYMENT_PENDING,
                "a payment from this jar is not yet confirmed on Bitcoin; confirm it before the \
                 transfer continues",
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        let free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        if let Transfer::Started { receiver, .. } = jar.transfer.clone() {
            let now = env::block_timestamp_ms() / 1_000;
            let (address, locktime) = self.rehome_to(&mut jar, &key, now);
            // Nothing is pending, so every coin not yet spent is free and moves.
            let coins = u32::try_from(free.len()).unwrap_or_else(|_| env::abort());
            jar.transfer = Transfer::Accepted {
                receiver: receiver.clone(),
                btc_pubkey: key,
                accepted_at: now,
                fixed_below: jar.coin_count,
                left: coins,
            };
            let btc_pubkey = hex::encode(&key);
            self.record(
                &jar_id,
                history::Event::TransferAccepted {
                    receiver: receiver.clone(),
                    btc_pubkey: btc_pubkey.clone(),
                    address: address.clone(),
                    locktime,
                    coins,
                },
            );
            SatsJarEvent::TransferAccepted {
                jar_id: jar_id.clone(),
                receiver,
                btc_pubkey,
                address,
                locktime,
                coins,
            }
            .emit();
            if coins == 0 {
                self.jars.insert(jar_id.clone(), jar);
                self.finish_transfer(&jar_id);
                return PromiseOrValue::Value(None);
            }
        }
        let fixed_below = jar.transfer.fixed_below().unwrap_or_else(|| env::abort());
        let batch = self.rehoming_batch(&jar, &free, fixed_below, fee_rate.0);
        PromiseOrValue::Promise(self.start_rehoming(&jar_id, jar, &batch, fee_rate.0))
    }
}

impl SatsJar {
    /// Moves the jar NFT to the receiver once every coin fixed at acceptance has moved and been
    /// confirmed; the transfer is over.
    pub(crate) fn finish_transfer(&mut self, jar_id: &str) {
        let mut jar = self.jar(jar_id).clone();
        let receiver = jar.transfer.finish();
        let from = jar.owner_id.clone();
        self.move_jar(jar_id, &mut jar, receiver.clone());
        self.jars.insert(jar_id.to_owned(), jar);
        self.record(
            jar_id,
            history::Event::TransferCompleted {
                from: from.clone(),
                to: receiver.clone(),
            },
        );
        SatsJarEvent::TransferCompleted {
            jar_id: jar_id.to_owned(),
            from,
            to: receiver,
        }
        .emit();
    }

    fn refuse_unless_holder(&self, jar_id: &str, owner_id: &AccountId) {
        if *owner_id != env::predecessor_account_id() {
            refuse(
                error::NOT_THE_HOLDER,
                &format!("the caller is not the holder of jar {jar_id}"),
            );
        }
    }
}
