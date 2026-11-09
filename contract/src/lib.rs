//! The Sats Jar contract: one contract holds every jar.

mod jar;

use jar::{CreateArgs, Jar, JarView};
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, PanicOnDefault, PublicKey};

#[near(serializers = [json, borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
    Regtest,
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
        let _ = mpc_root_public_key;
        Self {
            mpc_contract,
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
        let jar = Jar {
            giver: env::predecessor_account_id(),
            owner_id: args.family_account.clone(),
            args,
        };
        self.jars.insert(jar_id.clone(), jar);
        jar_id
    }

    pub fn get_jar(&self, jar_id: String) -> Option<JarView> {
        self.jars.get(&jar_id).map(|jar| jar.view(&jar_id))
    }
}
