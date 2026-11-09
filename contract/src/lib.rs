//! The Sats Jar contract: one contract holds every jar.

mod coins;
#[cfg(feature = "dev-escape")]
mod dev_escape;
mod error;
mod events;
mod hex;
mod jar;
mod light_client;
mod mpc_key;
mod topup;

use coins::{Coin, CoinStatus, CoinView, OutPointKey};
use error::refuse;
use events::{Nep171Event, NftMintData, SatsJarEvent};
use jar::{CreateArgs, Jar, JarView};
use light_client::TxInclusionInfo;
use mpc_key::PointBytes;
use near_sdk::json_types::U64;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PromiseError,
    PublicKey,
};
use topup::TopupProof;

/// At most this many coins per `get_coins` page.
const MAX_COINS_PAGE: u32 = 100;

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
        let (topup, args) = topup::check(&tx, vout, &proof, &jar.script_pubkey());
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
                    .on_topup_proven(jar_id, topup.txid, topup.vout, U64(topup.value)),
            )
    }

    /// Reads the light client's answer to `prove_topup`. Nothing was reserved before the call,
    /// so a refusal here simply fails the transaction.
    #[private]
    pub fn on_topup_proven(
        &mut self,
        jar_id: String,
        txid: [u8; 32],
        vout: u32,
        value: U64,
        #[callback_result] inclusion: Result<Option<TxInclusionInfo>, PromiseError>,
    ) {
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
            Ok(Some(info)) => {
                // Another proof of the same coin may have landed while this one waited.
                self.refuse_known_coin(&txid, vout);
                let required = topup::required_confirmations(self.network);
                let confirmations = info.confirmations();
                if confirmations < required {
                    refuse(
                        error::NOT_CONFIRMED,
                        &format!("{confirmations} of {required} confirmations; wait for more"),
                    );
                }
            }
        }
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
        self.coins.insert(
            (jar_id.clone(), index),
            Coin {
                txid,
                vout,
                value: value.0,
                address: 0,
                status: CoinStatus::Confirmed,
            },
        );
        self.seen_outpoints.insert(coins::outpoint_key(&txid, vout));
        self.jars.insert(jar_id.clone(), jar);
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
            .saturating_add(limit.unwrap_or(MAX_COINS_PAGE).min(MAX_COINS_PAGE))
            .min(jar.coin_count);
        (from..to)
            .filter_map(|i| self.coins.get(&(jar_id.clone(), i)).map(Coin::view))
            .collect()
    }

    pub fn get_jar(&self, jar_id: String) -> Option<JarView> {
        self.jars
            .get(&jar_id)
            .map(|jar| jar.view(&jar_id, self.network))
    }
}

impl SatsJar {
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
