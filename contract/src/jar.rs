//! One jar: the giver's create args, kept exactly as sent, and what the contract derives from them.

use near_sdk::json_types::U64;
use near_sdk::{near, AccountId};

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

#[near(serializers = [borsh])]
#[derive(Debug, Clone)]
pub struct Jar {
    pub giver: AccountId,
    /// The holder (NEP-171 spelling).
    pub owner_id: AccountId,
    pub args: CreateArgs,
}

#[near(serializers = [json])]
#[derive(Debug, Clone)]
pub struct JarView {
    pub jar_id: String,
    pub giver: AccountId,
    pub owner_id: AccountId,
    pub create_args: CreateArgs,
}

impl Jar {
    pub fn view(&self, jar_id: &str) -> JarView {
        JarView {
            jar_id: jar_id.to_owned(),
            giver: self.giver.clone(),
            owner_id: self.owner_id.clone(),
            create_args: self.args.clone(),
        }
    }
}
