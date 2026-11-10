//! Sandbox-only stand-in for an account a holder approves, such as a marketplace: NEP-178's
//! `nft_on_approve(token_id, owner_id, approval_id, msg)` (argument names and types from the
//! NEP-178 text), logging what it was sent and who sent it.

use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ApprovalReceiver {}

#[near]
impl ApprovalReceiver {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn nft_on_approve(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        approval_id: u64,
        msg: String,
    ) -> String {
        env::log_str(&format!(
            "nft_on_approve from {}: token_id={token_id} owner_id={owner_id} \
             approval_id={approval_id} msg={msg}",
            env::predecessor_account_id()
        ));
        "listed".to_owned()
    }
}
