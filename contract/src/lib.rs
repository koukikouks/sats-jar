//! The Sats Jar contract: one contract holds every jar.

#[cfg(feature = "dev-escape")]
mod dev_escape;
mod error;
mod events;
mod jar;
mod mpc_key;

use error::refuse;
use events::{Nep171Event, NftMintData, SatsJarEvent};
use jar::{CreateArgs, Jar, JarView};
use mpc_key::PointBytes;
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, Promise, PublicKey};

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

    pub fn get_jar(&self, jar_id: String) -> Option<JarView> {
        self.jars
            .get(&jar_id)
            .map(|jar| jar.view(&jar_id, self.network))
    }
}

impl SatsJar {
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
