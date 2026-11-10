//! The holder's own spend after handover. Before handover nobody spends, guardians included:
//! the rule pays out only the allowance and an emergency payment, and only to the child's address.

use crate::error::{self, refuse};
use crate::handover::Handover;
use crate::{SatsJar, SatsJarExt};
use near_sdk::json_types::U64;
use near_sdk::{assert_one_yocto, env, near, Promise};

#[near]
impl SatsJar {
    /// The holder sends `amount` sats of the jar's Bitcoin to `to` at `fee_rate` sat/vB, only
    /// after handover. 1 yoctoNEAR: a full-access key only.
    #[payable]
    #[allow(unused_variables)]
    pub fn request_spend(
        &mut self,
        jar_id: String,
        to: String,
        amount: U64,
        fee_rate: U64,
    ) -> Promise {
        let jar = self.jar(&jar_id);
        // Before the deposit check, so anyone trying, a guardian included, reads this reason.
        if !matches!(jar.handover, Handover::Done { .. }) {
            refuse(
                error::SPEND_BEFORE_HANDOVER,
                "before handover only the allowance and an emergency payment can pay out, and \
                 only to the child's address",
            );
        }
        assert_one_yocto();
        if jar.owner_id != env::predecessor_account_id() {
            refuse(
                error::NOT_THE_HOLDER,
                &format!("the caller is not the holder of jar {jar_id}"),
            );
        }
        // Placeholder until T12 builds the holder's spend; it must be gone before T14.
        refuse(
            error::SPEND_UNAVAILABLE,
            "the holder's own spends are not in this build yet",
        )
    }
}
