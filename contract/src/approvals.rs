//! NEP-178 approvals, open only after handover. The holder approves up to 10 accounts per jar;
//! each approval gets an id that never repeats for the jar, even after the list is cleared, so
//! a stale approval never validates again. Approving grants nothing that moves the jar (plain
//! transfers stay refused and `start_transfer` is the holder's), and every move clears the list.
//! The list is bounded, so the contract pays its storage (CODING_STANDARDS).

use crate::error::{self, refuse};
use crate::events::SatsJarEvent;
use crate::handover::Handover;
use crate::{SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::{env, ext_contract, near, AccountId, NearToken, Promise};
use std::collections::HashMap;

/// At most this many approved accounts per jar, so every read and clear of the list is bounded.
const MAX_APPROVALS: usize = 10;

/// A jar's approved accounts and the last approval id it gave out.
#[near(serializers = [borsh])]
#[derive(Debug, Clone, Default)]
pub struct Approvals {
    /// 0 before the first approval; ids start at 1.
    last_approval_id: u64,
    accounts: Vec<(AccountId, u64)>,
}

impl Approvals {
    /// NEP-178's `approved_account_ids`.
    pub fn view(&self) -> HashMap<AccountId, u64> {
        self.accounts.iter().cloned().collect()
    }

    /// Empties the list on a move; the id counter carries on.
    pub fn clear(&mut self) {
        self.accounts.clear();
    }
}

/// NEP-178's receiver interface, called on an approved account when the holder sends a `msg`.
#[ext_contract(ext_approval_receiver)]
#[allow(dead_code)]
trait ApprovalReceiver {
    fn nft_on_approve(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        approval_id: u64,
        msg: String,
    );
}

#[near]
impl SatsJar {
    /// The holder approves `account_id` for the jar, after handover only. At least 1
    /// yoctoNEAR (NEP-178); 1 is kept and any more refunded, since the contract pays the
    /// bounded storage. With `msg`, `account_id`'s `nft_on_approve` hears about it.
    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: String,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        let jar = self.jar(&token_id);
        // Exhaustive on purpose: each new handover state must decide whether approvals open.
        match jar.handover {
            Handover::None
            | Handover::Claimed { .. }
            | Handover::Confirmed { .. }
            | Handover::Completing { .. } => refuse(
                error::APPROVAL_BEFORE_HANDOVER,
                "a jar takes no approvals before handover",
            ),
            Handover::Done { .. } => {}
        }
        let deposit = env::attached_deposit();
        if deposit < NearToken::from_yoctonear(1) {
            env::panic_str("Requires attached deposit of at least 1 yoctoNEAR");
        }
        let owner_id = jar.owner_id.clone();
        let caller = env::predecessor_account_id();
        if owner_id != caller {
            refuse(
                error::NOT_THE_HOLDER,
                &format!("the caller is not the holder of jar {token_id}"),
            );
        }
        let mut approvals = self.approvals.get(&token_id).cloned().unwrap_or_default();
        let listed = approvals
            .accounts
            .iter()
            .position(|(account, _)| *account == account_id);
        if listed.is_none() && approvals.accounts.len() >= MAX_APPROVALS {
            refuse(
                error::TOO_MANY_APPROVALS,
                &format!(
                    "jar {token_id} already has {MAX_APPROVALS} approved accounts; revoke one first"
                ),
            );
        }
        // NEP-178: a new id even when re-approving. 2^64 approvals cost far more gas than exists.
        let approval_id = approvals
            .last_approval_id
            .checked_add(1)
            .unwrap_or_else(|| env::abort());
        approvals.last_approval_id = approval_id;
        match listed {
            Some(i) => approvals.accounts[i].1 = approval_id,
            None => approvals.accounts.push((account_id.clone(), approval_id)),
        }
        self.approvals.insert(token_id.clone(), approvals);
        let refund = deposit.saturating_sub(NearToken::from_yoctonear(1));
        if !refund.is_zero() {
            Promise::new(caller).transfer(refund).detach();
        }
        SatsJarEvent::ApprovalAdded {
            jar_id: token_id.clone(),
            account_id: account_id.clone(),
            approval_id: U64(approval_id),
        }
        .emit();
        // The receiver gets all the gas left (NEP-178's reference keeps 10 Tgas back instead).
        msg.map(|msg| {
            ext_approval_receiver::ext(account_id).nft_on_approve(
                token_id,
                owner_id,
                approval_id,
                msg,
            )
        })
    }

    /// The holder only, with 1 yoctoNEAR.
    #[payable]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        self.check_holder(&token_id);
        let Some(approvals) = self.approvals.get_mut(&token_id) else {
            return;
        };
        let before = approvals.accounts.len();
        approvals
            .accounts
            .retain(|(account, _)| *account != account_id);
        if approvals.accounts.len() < before {
            SatsJarEvent::ApprovalRevoked {
                jar_id: token_id,
                account_id,
            }
            .emit();
        }
    }

    /// As `nft_revoke`, for every approved account.
    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: String) {
        self.check_holder(&token_id);
        let Some(approvals) = self.approvals.get_mut(&token_id) else {
            return;
        };
        if !approvals.accounts.is_empty() {
            approvals.clear();
            SatsJarEvent::ApprovalsRevoked { jar_id: token_id }.emit();
        }
    }

    /// Whether `approved_account_id` is approved for the jar, and, given `approval_id`, under
    /// that id.
    pub fn nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.approvals.get(&token_id).is_some_and(|approvals| {
            approvals.accounts.iter().any(|(account, id)| {
                *account == approved_account_id && approval_id.is_none_or(|wanted| wanted == *id)
            })
        })
    }
}

impl SatsJar {
    /// The jar's approved accounts as NEP-178 shows them.
    pub(crate) fn approved_account_ids(&self, jar_id: &str) -> HashMap<AccountId, u64> {
        self.approvals
            .get(jar_id)
            .map(Approvals::view)
            .unwrap_or_default()
    }

    /// Clears the jar's approvals: every move does (story 59).
    pub(crate) fn clear_approvals(&mut self, jar_id: &str) {
        if let Some(approvals) = self.approvals.get_mut(jar_id) {
            approvals.clear();
        }
    }
}
