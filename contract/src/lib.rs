//! The Sats Jar contract: one contract holds every jar.

mod coins;
#[cfg(feature = "dev-escape")]
mod dev_escape;
mod error;
mod events;
mod handover;
mod hex;
mod history;
mod jar;
mod light_client;
mod mpc_key;
mod nft;
mod payment;
mod rehoming;
mod rule;
mod signer;
mod spend;
mod svg;
mod topup;

use btc::{OutPoint, Transaction, TxOut};
use coins::{Coin, CoinStatus, CoinView, OutPointKey};
use error::refuse;
use events::{Nep171Event, NftMintData, SatsJarEvent};
use jar::{CreateArgs, Jar, JarView};
use light_client::TxInclusionInfo;
use mpc_key::PointBytes;
use near_sdk::json_types::U64;
use near_sdk::store::{IterableSet, LookupMap, LookupSet};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseError,
    PublicKey,
};
use payment::{
    FreeCoin, InputView, Output, Payment, PaymentKind, PaymentStatus, PaymentView, RawSignature,
    Shortfall,
};
use topup::TopupProof;

/// At most this many coins or history records per page.
const MAX_PAGE: u32 = 100;

#[near(serializers = [json, borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
    Regtest,
}

impl From<Network> for btc::Network {
    fn from(network: Network) -> btc::Network {
        match network {
            Network::Mainnet => btc::Network::Mainnet,
            Network::Testnet => btc::Network::Testnet,
            Network::Regtest => btc::Network::Regtest,
        }
    }
}

/// Never reorder or remove a variant: each one prefixes a collection's keys.
#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jars,
    Coins,
    SeenOutpoints,
    Payments,
    PaymentTxids,
    FreeCoins,
    Holders,
    HolderJars { account_hash: [u8; 32] },
    History,
    HistoryLengths,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SatsJar {
    mpc_contract: AccountId,
    mpc_root_key: PointBytes,
    light_client: AccountId,
    network: Network,
    jars: LookupMap<String, Jar>,
    next_jar_id: u64,
    /// Every jar's coins, keyed by jar id and the coin's index in that jar.
    coins: LookupMap<(String, u32), Coin>,
    /// Every outpoint ever counted, by any jar. Never shrinks.
    seen_outpoints: LookupSet<OutPointKey>,
    payments: LookupMap<u64, Payment>,
    next_payment_id: u64,
    /// Every payment's txid (internal order), so its transaction is never proven as a top-up.
    payment_txids: LookupMap<[u8; 32], u64>,
    /// Each jar's confirmed coins not reserved by a payment, largest first. Coin selection reads
    /// only this list, never the whole coin history.
    free_coins: LookupMap<String, Vec<FreeCoin>>,
    /// Each holder's jar ids, for NEP-181 enumeration by holder. Whatever moves a jar updates
    /// this together with `Jar.owner_id`.
    holders: LookupMap<AccountId, IterableSet<String>>,
    /// Every jar's history, keyed by jar id and the record's index.
    history: LookupMap<(String, u32), history::Record>,
    /// How many records each jar's history holds.
    history_lengths: LookupMap<String, u32>,
}

#[near]
impl SatsJar {
    #[init]
    #[private]
    pub fn new(
        mpc_contract: AccountId,
        mpc_root_public_key: PublicKey,
        light_client: AccountId,
        network: Network,
    ) -> Self {
        let mpc_root_key = mpc_key::parse_root(&mpc_root_public_key).unwrap_or_else(|| {
            refuse(
                error::BAD_MPC_ROOT_KEY,
                "the MPC root key must be a secp256k1 point",
            )
        });
        Self {
            mpc_contract,
            mpc_root_key,
            light_client,
            network,
            jars: LookupMap::new(StorageKey::Jars),
            next_jar_id: 1,
            coins: LookupMap::new(StorageKey::Coins),
            seen_outpoints: LookupSet::new(StorageKey::SeenOutpoints),
            payments: LookupMap::new(StorageKey::Payments),
            next_payment_id: 1,
            payment_txids: LookupMap::new(StorageKey::PaymentTxids),
            free_coins: LookupMap::new(StorageKey::FreeCoins),
            holders: LookupMap::new(StorageKey::Holders),
            history: LookupMap::new(StorageKey::History),
            history_lengths: LookupMap::new(StorageKey::HistoryLengths),
        }
    }

    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn create_jar(
        &mut self,
        child_address: String,
        cap: U64,
        period: U64,
        unlock_at: U64,
        guardians: Vec<AccountId>,
        family_account: AccountId,
        nickname: String,
    ) -> String {
        let args = CreateArgs {
            child_address,
            cap,
            period,
            unlock_at,
            guardians,
            family_account,
            nickname,
        };
        let jar_id = self.next_jar_id.to_string();
        self.next_jar_id += 1;
        let mpc_key = mpc_key::derive(&self.mpc_root_key, &env::current_account_id(), &jar_id);
        let now = env::block_timestamp_ms() / 1_000;
        let jar = Jar::create(
            args,
            env::predecessor_account_id(),
            mpc_key,
            self.network,
            now,
        );
        let family_account = jar.owner_id.clone();
        let address = jar.address(self.network);
        let storage_before = env::storage_usage();
        self.jars.insert(jar_id.clone(), jar);
        self.jars.flush();
        self.add_to_holder(&family_account, &jar_id);
        self.record(&jar_id, history::Event::JarCreated);
        self.charge_storage(storage_before);

        Nep171Event::NftMint(vec![NftMintData {
            owner_id: family_account,
            token_ids: vec![jar_id.clone()],
        }])
        .emit();
        SatsJarEvent::JarCreated {
            jar_id: jar_id.clone(),
            address,
        }
        .emit();
        jar_id
    }

    /// Proves a confirmed Bitcoin payment to a jar's address through the light client; anyone
    /// may call it. The output counts as a coin once the callback sees enough confirmations.
    pub fn prove_topup(&self, jar_id: String, tx: String, vout: u32, proof: TopupProof) -> Promise {
        let jar = self
            .jars
            .get(&jar_id)
            .unwrap_or_else(|| refuse(error::UNKNOWN_JAR, &format!("there is no jar {jar_id}")));
        let (topup, args) = topup::check(
            &tx,
            vout,
            &proof,
            |script| jar.address_index_of(script),
            |txid| self.payment_txids.contains_key(txid),
        );
        self.refuse_known_coin(&topup.txid, topup.vout);
        if env::prepaid_gas() < light_client::PROVE_TOPUP_GAS {
            refuse(
                error::NOT_ENOUGH_GAS,
                &format!(
                    "attach at least {} Tgas for the light client and its callback",
                    light_client::PROVE_TOPUP_GAS.as_tgas()
                ),
            );
        }
        Promise::new(self.light_client.clone())
            .function_call(
                light_client::METHOD.to_owned(),
                near_sdk::borsh::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                light_client::CALL_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(light_client::CALLBACK_GAS)
                    .on_topup_proven(
                        jar_id,
                        topup.txid,
                        topup.vout,
                        U64(topup.value),
                        topup.address,
                    ),
            )
    }

    /// Reads the light client's answer to `prove_topup`. Nothing was reserved before the call,
    /// so a refusal here simply fails the transaction. `address` is the index of the jar address
    /// the output was checked against: the jar may have moved to a new one since.
    #[private]
    pub fn on_topup_proven(
        &mut self,
        jar_id: String,
        txid: [u8; 32],
        vout: u32,
        value: U64,
        address: u32,
        #[callback_result] inclusion: Result<Option<TxInclusionInfo>, PromiseError>,
    ) {
        let info = included(inclusion);
        // Another proof of the same coin may have landed while this one waited.
        self.refuse_known_coin(&txid, vout);
        self.refuse_unconfirmed(&info);
        let mut jar = self
            .jars
            .get(&jar_id)
            .cloned()
            .unwrap_or_else(|| env::abort());
        let index = jar.coin_count;
        // Neither can overflow (2^32 coins of at least 1,000 sats; 21 M BTC fits a u64).
        jar.coin_count = index.checked_add(1).unwrap_or_else(|| env::abort());
        jar.proven_balance = jar
            .proven_balance
            .checked_add(value.0)
            .unwrap_or_else(|| env::abort());
        // ADR 0005: an empty jar builds up no allowance, so the clock starts here.
        jar.clock
            .started_at
            .get_or_insert(U64(env::block_timestamp_ms() / 1_000));
        self.add_coin(&jar_id, index, txid, vout, value.0, address);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::TopupProven {
                txid: hex::display(&txid),
                vout,
                value,
            },
        );
        SatsJarEvent::TopupProven {
            jar_id,
            txid: hex::display(&txid),
            vout,
            value,
        }
        .emit();
    }

    /// The jar's coins in the order they were proven, spent ones included, `limit` (at most
    /// 100) from `from_index`.
    pub fn get_coins(
        &self,
        jar_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<CoinView> {
        let Some(jar) = self.jars.get(&jar_id) else {
            return Vec::new();
        };
        let from = from_index.unwrap_or(0);
        let to = from
            .saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE))
            .min(jar.coin_count);
        (from..to)
            .filter_map(|i| self.coins.get(&(jar_id.clone(), i)).map(Coin::view))
            .collect()
    }

    /// Builds the period's allowance from the jar's own coins and asks the MPC signer to sign
    /// each input; anyone may call it. The contract picks the coins, the payee (the child's
    /// address), the amount (up to the cap) and the change; the caller proposes only the fee
    /// rate in sat/vB. The result is the payment id.
    pub fn request_allowance(&mut self, jar_id: String, fee_rate: U64) -> Promise {
        let mut jar =
            self.jars.get(&jar_id).cloned().unwrap_or_else(|| {
                refuse(error::UNKNOWN_JAR, &format!("there is no jar {jar_id}"))
            });
        let now = env::block_timestamp_ms() / 1_000;
        if matches!(jar.handover, handover::Handover::Done { .. }) {
            refuse(
                error::HANDOVER_DONE,
                "this jar has been handed over, so its allowances have ended",
            );
        }
        if jar.handover.payouts_stopped(now) {
            refuse(
                error::HANDOVER_IN_PROGRESS,
                "the handover's public delay has ended, so no allowance runs until the handover \
                 completes or is cancelled",
            );
        }
        let started_at = jar.clock.started_at.map(|t| t.0).unwrap_or_else(|| {
            refuse(
                error::NOT_FUNDED,
                "the jar has no proven top-up yet, so it has no allowance",
            )
        });
        let period_length = jar.args.period.0;
        let period = rule::period_index(started_at, period_length, now);
        let cap = jar.args.cap.0;
        if jar.allowance.paid_period == Some(period) {
            let wait = rule::until_next_period(started_at, period_length, period, now);
            refuse(
                error::ALREADY_PAID,
                &format!(
                    "the allowance for this period was already paid; next one in {}",
                    rule::wait(wait)
                ),
            );
        }
        if let Some(pending) = jar
            .allowance
            .payment
            .filter(|id| self.payment(*id).is_pending())
        {
            refuse(
                error::PAYMENT_PENDING,
                &format!(
                    "payment {pending} is not yet confirmed on Bitcoin; confirm it before the next \
                     allowance"
                ),
            );
        }
        if fee_rate.0 < 1 {
            refuse(error::FEE_TOO_LOW, "the fee rate must be at least 1 sat/vB");
        }
        let child_script = jar.child_script_pubkey(self.network);
        let change_script = jar.script_pubkey();
        let free = self.free_coins.get(&jar_id).cloned().unwrap_or_default();
        let shape = payment::Shape {
            payee_script_len: child_script.len() as u64,
            change_script_len: change_script.len() as u64,
            witness_script_len: jar.address.witness_script.len() as u64,
        };
        let plan = payment::plan(
            &free,
            jar.allowance.available(cap, period),
            cap,
            jar.allowance.fee_budget_left(cap, period),
            fee_rate.0,
            &shape,
        )
        .unwrap_or_else(|shortfall| match shortfall {
            Shortfall::InsufficientBalance => refuse(
                error::INSUFFICIENT_BALANCE,
                "the jar's coins cannot pay the fee and a payment above the dust floor",
            ),
            Shortfall::FeeOverBudget { fee, budget } => refuse(
                error::FEE_OVER_BUDGET,
                &format!(
                    "the fee would be {fee} sats, over the {budget} sats left in this period's fee budget; \
                         wait for lower fees"
                ),
            ),
            Shortfall::PaymentTooSmall { amount } => refuse(
                error::PAYMENT_TOO_SMALL,
                &format!(
                    "the payment would be {amount} sats, under half the {cap}-sat cap; \
                             wait for more top-ups"
                ),
            ),
            Shortfall::ChangeBelowDust { change } => refuse(
                error::CHANGE_BELOW_DUST,
                &format!(
                    "the change would be {change} sats, below the {}-sat dust floor; wait \
                         for another top-up",
                    topup::DUST_FLOOR
                ),
            ),
        });
        refuse_short_gas(plan.inputs.len());

        let mut outputs = vec![Output {
            value: plan.amount,
            script_pubkey: child_script,
        }];
        if plan.change > 0 {
            outputs.push(Output {
                value: plan.change,
                script_pubkey: change_script,
            });
        }
        let (payment_id, txid, sighashes) = self.start_payment(
            &jar_id,
            &jar,
            &plan.inputs,
            outputs,
            plan.fee,
            PaymentKind::Allowance { period },
        );
        // With the reservation, the paid period is what stops a second request before the
        // callback.
        jar.allowance
            .record(cap, period, plan.amount, plan.fee, payment_id);
        self.jars.insert(jar_id.clone(), jar);
        self.record(
            &jar_id,
            history::Event::AllowanceRequested {
                payment_id: U64(payment_id),
            },
        );
        SatsJarEvent::AllowanceRequested {
            jar_id: jar_id.clone(),
            payment_id: U64(payment_id),
            period: U64(period),
            amount: U64(plan.amount),
            fee: U64(plan.fee),
            txid: hex::display(&txid),
        }
        .emit();

        self.sign_round(&jar_id, payment_id, &sighashes, 0)
    }

    /// Signs a payment again whose signing failed, or stalled with no request in flight (its
    /// callback never came), with the identical stored transaction; anyone may call it. The
    /// result is the payment id.
    pub fn retry_signing(&mut self, payment_id: U64) -> Promise {
        let mut payment = self.payment(payment_id.0);
        let now = env::block_height();
        match payment.status {
            PaymentStatus::Signed => refuse(
                error::PAYMENT_ALREADY_SIGNED,
                "this payment is already signed; rebuild_witness returns its transaction",
            ),
            PaymentStatus::Confirmed => refuse(
                error::PAYMENT_ALREADY_CONFIRMED,
                "this payment is already confirmed",
            ),
            PaymentStatus::Cancelled => refuse(
                error::PAYMENT_CANCELLED,
                "this payment was cancelled and can never be signed",
            ),
            PaymentStatus::Signing if rule::signing_in_flight(payment.signing_started_at, now) => {
                refuse(
                    error::SIGNING_IN_PROGRESS,
                    &format!(
                        "a signing request for this payment may still be answered; retry from \
                         block {}",
                        rule::signing_stalled_at(payment.signing_started_at)
                    ),
                )
            }
            PaymentStatus::Signing | PaymentStatus::SigningFailed { .. } => {}
        }
        refuse_short_gas(payment.sighashes.len());
        // A new round: the callback of any earlier one no longer matches and is ignored.
        // 2^32 rounds of at least 45 Tgas each would cost far more gas than exists.
        payment.attempt = payment
            .attempt
            .checked_add(1)
            .unwrap_or_else(|| env::abort());
        payment.status = PaymentStatus::Signing;
        payment.signing_started_at = now;
        let (jar_id, attempt, sighashes) = (
            payment.jar_id.clone(),
            payment.attempt,
            payment.sighashes.clone(),
        );
        self.payments.insert(payment_id.0, payment);
        self.record(
            &jar_id,
            history::Event::PaymentSigningRetried {
                payment_id,
                attempt,
            },
        );
        SatsJarEvent::PaymentSigningRetried {
            jar_id: jar_id.clone(),
            payment_id,
            attempt,
        }
        .emit();
        self.sign_round(&jar_id, payment_id.0, &sighashes, attempt)
    }

    /// Reads the joined `sign` answers one by one. The inputs are reserved, so this never
    /// panics: anything wrong is recorded as a retryable signing failure. It acts only on the
    /// signing round it belongs to, so a late answer can never move a payment backwards.
    #[private]
    pub fn on_payment_signed(&mut self, payment_id: U64, attempt: u32) -> U64 {
        let Some(mut payment) = self.payments.get(&payment_id.0).cloned() else {
            return payment_id;
        };
        if payment.status != PaymentStatus::Signing || payment.attempt != attempt {
            return payment_id;
        }
        let Some(jar) = self.jars.get(&payment.jar_id) else {
            return payment_id;
        };
        let signed = self
            .read_signatures(&payment, &jar.mpc_key)
            .and_then(|signatures| {
                let tx = self.signed_tx(&payment, &signatures)?;
                Ok((signatures, tx))
            });
        let jar_id = payment.jar_id.clone();
        match signed {
            Ok((signatures, tx)) => {
                payment.signatures = signatures;
                payment.status = PaymentStatus::Signed;
                self.record(&jar_id, history::Event::PaymentSigned { payment_id });
                SatsJarEvent::PaymentSigned {
                    jar_id,
                    payment_id,
                    txid: hex::display(&payment.txid),
                    tx: hex::encode(&tx),
                }
                .emit();
            }
            Err(reason) => {
                payment.status = PaymentStatus::SigningFailed {
                    reason: reason.clone(),
                };
                self.record(
                    &jar_id,
                    history::Event::PaymentSigningFailed {
                        payment_id,
                        reason: reason.clone(),
                    },
                );
                SatsJarEvent::PaymentSigningFailed {
                    jar_id,
                    payment_id,
                    reason,
                }
                .emit();
            }
        }
        self.payments.insert(payment_id.0, payment);
        payment_id
    }

    /// Proves a payment confirmed on Bitcoin through the light client; anyone may call it, for
    /// a payment in any status but confirmed. The contract knows the payment's txid, so only
    /// the proof is sent.
    pub fn confirm_payment(&self, payment_id: U64, proof: TopupProof) -> Promise {
        let payment = self.payment(payment_id.0);
        refuse_unconfirmable(&payment.status);
        let args = topup::inclusion_args(&proof);
        if args.tx_id != payment.txid {
            refuse(
                error::PROOF_TX_MISMATCH,
                "the proof is for another transaction than this payment's",
            );
        }
        topup::check_index(&args);
        if env::prepaid_gas() < light_client::PROVE_TOPUP_GAS {
            refuse(
                error::NOT_ENOUGH_GAS,
                &format!(
                    "attach at least {} Tgas for the light client and its callback",
                    light_client::PROVE_TOPUP_GAS.as_tgas()
                ),
            );
        }
        Promise::new(self.light_client.clone())
            .function_call(
                light_client::METHOD.to_owned(),
                near_sdk::borsh::to_vec(&args).unwrap_or_else(|_| env::abort()),
                NearToken::from_yoctonear(0),
                light_client::CALL_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(light_client::CALLBACK_GAS)
                    .on_payment_confirmed(payment_id),
            )
    }

    /// Reads the light client's answer to `confirm_payment`. Nothing was reserved before the
    /// call, so a refusal here simply fails the transaction.
    #[private]
    pub fn on_payment_confirmed(
        &mut self,
        payment_id: U64,
        #[callback_result] inclusion: Result<Option<TxInclusionInfo>, PromiseError>,
    ) {
        let info = included(inclusion);
        let mut payment = self.payment(payment_id.0);
        // Another proof of the same payment may have landed while this one waited.
        refuse_unconfirmable(&payment.status);
        self.refuse_unconfirmed(&info);
        let jar_id = payment.jar_id.clone();
        let mut jar = self
            .jars
            .get(&jar_id)
            .cloned()
            .unwrap_or_else(|| env::abort());
        for &index in &payment.inputs {
            let mut coin = self.coin(&jar_id, index);
            coin.status = CoinStatus::Spent(payment_id.0);
            jar.proven_balance = jar
                .proven_balance
                .checked_sub(coin.value)
                .unwrap_or_else(|| env::abort());
            self.coins.insert((jar_id.clone(), index), coin);
        }
        // Every output to one of the jar's addresses is the jar's again, as a coin at that
        // address: an allowance's change, a re-homed coin.
        for (vout, output) in payment.outputs.iter().enumerate() {
            let Some(address) = jar.address_index_of(&output.script_pubkey) else {
                continue;
            };
            let index = jar.coin_count;
            jar.coin_count = index.checked_add(1).unwrap_or_else(|| env::abort());
            jar.proven_balance = jar
                .proven_balance
                .checked_add(output.value)
                .unwrap_or_else(|| env::abort());
            let vout = u32::try_from(vout).unwrap_or_else(|_| env::abort());
            self.add_coin(&jar_id, index, payment.txid, vout, output.value, address);
        }
        let handed_over = jar.handover.count_down(&payment.inputs);
        self.jars.insert(jar_id.clone(), jar);
        let change = payment.change().map_or(0, |output| output.value);
        payment.status = PaymentStatus::Confirmed;
        let txid = hex::display(&payment.txid);
        self.payments.insert(payment_id.0, payment);
        self.record(&jar_id, history::Event::PaymentConfirmed { payment_id });
        SatsJarEvent::PaymentConfirmed {
            jar_id: jar_id.clone(),
            payment_id,
            txid,
            change: U64(change),
        }
        .emit();
        if handed_over {
            self.finish_handover(&jar_id, env::block_timestamp_ms() / 1_000);
        }
    }

    /// The payment's signed transaction (hex), re-encoded from its stored signatures with no
    /// new signing; anyone may call it.
    pub fn rebuild_witness(&self, payment_id: U64) -> String {
        let payment = self.payment(payment_id.0);
        if payment.signatures.is_empty() {
            refuse(
                error::PAYMENT_NOT_SIGNED,
                "this payment has no signatures yet; retry_signing asks for them",
            );
        }
        // The signatures were checked and the transaction built once already; this cannot fail.
        let tx = self
            .signed_tx(&payment, &payment.signatures)
            .unwrap_or_else(|_| env::abort());
        hex::encode(&tx)
    }

    /// The jar's history in order, `limit` (at most 100) records from `from_index`.
    pub fn get_history(
        &self,
        jar_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<history::Entry> {
        let length = self.history_lengths.get(&jar_id).copied().unwrap_or(0);
        let from = from_index.unwrap_or(0);
        let to = from
            .saturating_add(limit.unwrap_or(MAX_PAGE).min(MAX_PAGE))
            .min(length);
        (from..to)
            .filter_map(|index| {
                self.history
                    .get(&(jar_id.clone(), index))
                    .map(|record| history::Entry {
                        index,
                        at: U64(record.at),
                        event: record.event.clone(),
                    })
            })
            .collect()
    }

    pub fn get_payment(&self, payment_id: U64) -> Option<PaymentView> {
        let payment = self.payments.get(&payment_id.0)?;
        let (status, failure) = payment.status.view();
        let (kind, period) = match payment.kind {
            PaymentKind::Allowance { period } => ("allowance", Some(U64(period))),
            PaymentKind::Rehoming => ("rehoming", None),
        };
        let signed_tx = (!payment.signatures.is_empty())
            .then(|| self.signed_tx(payment, &payment.signatures).ok())
            .flatten()
            .map(|tx| hex::encode(&tx));
        Some(PaymentView {
            payment_id,
            jar_id: payment.jar_id.clone(),
            kind: kind.to_owned(),
            period,
            status,
            failure,
            txid: hex::display(&payment.txid),
            amount: U64(payment.outputs[0].value),
            fee: U64(payment.fee),
            change: U64(payment.change().map_or(0, |output| output.value)),
            inputs: payment
                .inputs
                .iter()
                .map(|&index| {
                    let coin = self.coin(&payment.jar_id, index);
                    InputView {
                        txid: hex::display(&coin.txid),
                        vout: coin.vout,
                        value: U64(coin.value),
                    }
                })
                .collect(),
            signed_tx,
        })
    }

    pub fn get_jar(&self, jar_id: String) -> Option<JarView> {
        let jar = self.jars.get(&jar_id)?;
        let coins_to_move = jar.handover.fixed_below().map_or(0, |below| {
            let free = self.free_coins.get(&jar_id).map_or(&[][..], Vec::as_slice);
            // At most every coin the jar has, which fits a u32.
            free.iter().filter(|coin| coin.index < below).count() as u32
        });
        Some(jar.view(
            &jar_id,
            self.network,
            env::block_timestamp_ms() / 1_000,
            coins_to_move,
        ))
    }
}

impl SatsJar {
    /// One signing round: a `sign` request per sighash, joined, then the checking callback,
    /// which acts only if the payment is still in round `attempt`.
    fn sign_round(
        &self,
        jar_id: &str,
        payment_id: u64,
        sighashes: &[[u8; 32]],
        attempt: u32,
    ) -> Promise {
        let requests = sighashes
            .iter()
            .map(|sighash| signer::sign(&self.mpc_contract, jar_id, sighash))
            .reduce(Promise::and)
            .unwrap_or_else(|| env::abort());
        requests.then(
            Self::ext(env::current_account_id())
                .with_static_gas(signer::SIGNED_CALLBACK_GAS)
                .with_unused_gas_weight(0)
                .on_payment_signed(U64(payment_id), attempt),
        )
    }

    /// Reserves `chosen` for a new payment of `kind` to `outputs`, removing each from the jar's
    /// free list by its index (a re-homing picks a filtered subset, never a prefix), and records
    /// the payment and its txid. Returns the payment id, the txid and each input's sighash. The
    /// guard goes in before the signer is called: other transactions run before the callback,
    /// and the reservation is what stops them.
    fn start_payment(
        &mut self,
        jar_id: &str,
        jar: &Jar,
        chosen: &[FreeCoin],
        outputs: Vec<Output>,
        fee: u64,
        kind: PaymentKind,
    ) -> (u64, [u8; 32], Vec<[u8; 32]>) {
        let inputs: Vec<Coin> = chosen
            .iter()
            .map(|free| self.coin(jar_id, free.index))
            .collect();
        let tx = unsigned_tx(&inputs, &outputs);
        let txid = tx.txid();
        // Each input signs with its own address's script.
        let sighashes: Vec<[u8; 32]> = inputs
            .iter()
            .enumerate()
            .map(|(i, coin)| {
                tx.sighash_all(i, &jar.address_at(coin.address).witness_script, coin.value)
                    .unwrap_or_else(|_| env::abort())
            })
            .collect();
        let payment_id = self.next_payment_id;
        self.next_payment_id += 1;
        for (free, mut coin) in chosen.iter().zip(inputs) {
            coin.status = CoinStatus::Reserved(payment_id);
            self.coins.insert((jar_id.to_owned(), free.index), coin);
        }
        let mut free = self.free_coins.get(jar_id).cloned().unwrap_or_default();
        free.retain(|coin| chosen.iter().all(|taken| taken.index != coin.index));
        self.free_coins.insert(jar_id.to_owned(), free);
        self.payments.insert(
            payment_id,
            Payment {
                jar_id: jar_id.to_owned(),
                kind,
                inputs: chosen.iter().map(|free| free.index).collect(),
                outputs,
                txid,
                sighashes: sighashes.clone(),
                fee,
                attempt: 0,
                signing_started_at: env::block_height(),
                status: PaymentStatus::Signing,
                signatures: Vec::new(),
            },
        );
        self.payment_txids.insert(txid, payment_id);
        (payment_id, txid, sighashes)
    }

    /// Appends `event` to the jar's history, written at once so `create_jar` can measure it.
    fn record(&mut self, jar_id: &str, event: history::Event) {
        let index = self.history_lengths.get(jar_id).copied().unwrap_or(0);
        self.history.insert(
            (jar_id.to_owned(), index),
            history::Record {
                at: env::block_timestamp_ms() / 1_000,
                event,
            },
        );
        // 2^32 state changes for one jar would cost far more gas than exists.
        let length = index.checked_add(1).unwrap_or_else(|| env::abort());
        self.history_lengths.insert(jar_id.to_owned(), length);
        self.history.flush();
        self.history_lengths.flush();
    }

    fn payment(&self, payment_id: u64) -> Payment {
        self.payments.get(&payment_id).cloned().unwrap_or_else(|| {
            refuse(
                error::UNKNOWN_PAYMENT,
                &format!("there is no payment {payment_id}"),
            )
        })
    }

    /// A coin the contract recorded; its absence would be a broken invariant.
    fn coin(&self, jar_id: &str, index: u32) -> Coin {
        self.coins
            .get(&(jar_id.to_owned(), index))
            .cloned()
            .unwrap_or_else(|| env::abort())
    }

    /// Records a newly proven coin at the jar's address `address` as confirmed and free, and its
    /// outpoint as seen for good.
    fn add_coin(
        &mut self,
        jar_id: &str,
        index: u32,
        txid: [u8; 32],
        vout: u32,
        value: u64,
        address: u32,
    ) {
        self.coins.insert(
            (jar_id.to_owned(), index),
            Coin {
                txid,
                vout,
                value,
                address,
                status: CoinStatus::Confirmed,
            },
        );
        self.seen_outpoints.insert(coins::outpoint_key(&txid, vout));
        let mut free = self.free_coins.get(jar_id).cloned().unwrap_or_default();
        payment::insert_free(
            &mut free,
            FreeCoin {
                value,
                index,
                address,
            },
        );
        self.free_coins.insert(jar_id.to_owned(), free);
    }

    fn refuse_unconfirmed(&self, info: &TxInclusionInfo) {
        let required = topup::required_confirmations(self.network);
        let confirmations = info.confirmations();
        if confirmations < required {
            refuse(
                error::NOT_CONFIRMED,
                &format!("{confirmations} of {required} confirmations; wait for more"),
            );
        }
    }

    /// The signer's answers for `payment`, each checked against the jar's key.
    fn read_signatures(
        &self,
        payment: &Payment,
        key: &PointBytes,
    ) -> Result<Vec<RawSignature>, String> {
        let expected = payment.sighashes.len() as u64;
        let answered = env::promise_results_count();
        if answered != expected {
            return Err(format!("{answered} answers for {expected} sign requests"));
        }
        payment
            .sighashes
            .iter()
            .enumerate()
            .map(|(i, sighash)| {
                signer::read_signature(i as u64, sighash, key).map(|(r, s)| RawSignature { r, s })
            })
            .collect()
    }

    /// The payment's transaction with each input's witness built from its signature.
    fn signed_tx(&self, payment: &Payment, signatures: &[RawSignature]) -> Result<Vec<u8>, String> {
        let jar = self.jars.get(&payment.jar_id).ok_or("unknown jar")?;
        let inputs: Vec<Coin> = payment
            .inputs
            .iter()
            .map(|&index| self.coin(&payment.jar_id, index))
            .collect();
        // Each input spends with its own address's script (a re-homing spends an old address).
        let witnesses = signatures
            .iter()
            .zip(&inputs)
            .map(|(sig, coin)| {
                btc::jar_witness(&sig.r, &sig.s, &jar.address_at(coin.address).witness_script)
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "a signature is not a valid secp256k1 signature".to_owned())?;
        unsigned_tx(&inputs, &payment.outputs)
            .to_signed_bytes(&witnesses)
            .map_err(|_| "one signature per input is needed".to_owned())
    }

    fn refuse_known_coin(&self, txid: &[u8; 32], vout: u32) {
        if self
            .seen_outpoints
            .contains(&coins::outpoint_key(txid, vout))
        {
            refuse(
                error::COIN_ALREADY_KNOWN,
                &format!("{}:{vout} has already been counted", hex::display(txid)),
            );
        }
    }

    /// Takes the cost of the storage added since `before` from the attached deposit and refunds
    /// the rest; refuses if the deposit does not cover it.
    fn charge_storage(&self, before: u64) {
        let added = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(added));
        let deposit = env::attached_deposit();
        if deposit < cost {
            refuse(
                error::STORAGE_DEPOSIT_TOO_LOW,
                &format!(
                    "attach at least {} yoctoNEAR for the jar's storage",
                    cost.as_yoctonear()
                ),
            );
        }
        let refund = deposit.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
    }
}

/// The light client's inclusion answer, refusing when it did not find the transaction.
fn included(inclusion: Result<Option<TxInclusionInfo>, PromiseError>) -> TxInclusionInfo {
    match inclusion {
        Err(_) => refuse(
            error::NOT_IN_CHAIN,
            "the light client refused the proof (unknown or side-chain block, bad coinbase \
             proof, or paused)",
        ),
        Ok(None) => refuse(
            error::NOT_IN_CHAIN,
            "the merkle proof does not lead to the block's merkle root",
        ),
        Ok(Some(info)) => info,
    }
}

/// Refuses unless the attached gas covers `signatures` sign requests, the callback and the
/// caller's own work.
fn refuse_short_gas(signatures: usize) {
    let required = signer::required_gas(signatures as u64);
    if env::prepaid_gas() < required {
        refuse(
            error::NOT_ENOUGH_GAS,
            &format!(
                "attach at least {} Tgas for {signatures} signature{} and the callback",
                required.as_tgas(),
                if signatures == 1 { "" } else { "s" }
            ),
        );
    }
}

fn refuse_unconfirmable(status: &PaymentStatus) {
    match status {
        PaymentStatus::Confirmed => refuse(
            error::PAYMENT_ALREADY_CONFIRMED,
            "this payment is already confirmed",
        ),
        PaymentStatus::Cancelled => refuse(
            error::PAYMENT_CANCELLED,
            "this payment was cancelled and can never be confirmed",
        ),
        _ => {}
    }
}

/// The unsigned payment spending `inputs` to `outputs`.
fn unsigned_tx(inputs: &[Coin], outputs: &[Output]) -> Transaction {
    let outpoints: Vec<OutPoint> = inputs
        .iter()
        .map(|coin| OutPoint {
            txid: coin.txid,
            vout: coin.vout,
        })
        .collect();
    Transaction::payment(
        &outpoints,
        outputs
            .iter()
            .map(|output| TxOut {
                value: output.value,
                script_pubkey: output.script_pubkey.clone(),
            })
            .collect(),
    )
}
