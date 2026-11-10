//! Transfer helpers: start, cancel and accept a transfer (each with 1 yoctoNEAR, as a
//! full-access key sends them), the buyer's test Bitcoin key, and an exit-branch spend.

use super::{Jars, RegtestJar};
use bitcoin::absolute::LockTime;
use bitcoin::secp256k1::{Message, Secp256k1, SecretKey};
use bitcoin::sighash::{EcdsaSighashType, SighashCache};
use bitcoin::transaction::Version;
use bitcoin::Witness;
use bitcoin::{Address, Amount, Network, OutPoint, ScriptBuf, Sequence, Transaction, TxIn, TxOut};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use test_support::serde_json::{json, Value};
use test_support::{to_hex, Regtest};

/// The buyer's test Bitcoin key (any valid secret: Core judges what it can spend).
pub fn buyer_secret() -> SecretKey {
    SecretKey::from_slice(&[0x42; 32]).unwrap()
}

/// The buyer's compressed public key in hex, as rust-bitcoin derives it.
pub fn buyer_key() -> String {
    to_hex(&buyer_secret().public_key(&Secp256k1::new()).serialize())
}

/// An exit-branch spend of the `value`-sat coin at `outpoint` (witness `[sig, key, <empty> for
/// ELSE, script]`), signed with `key`, with the address's locktime as the transaction's lock time.
pub fn exit_spend(
    regtest: &Regtest,
    outpoint: OutPoint,
    value: u64,
    script: &ScriptBuf,
    locktime: u32,
    key: &SecretKey,
) -> Vec<u8> {
    let payee = regtest
        .new_address()
        .parse::<Address<_>>()
        .unwrap()
        .require_network(Network::Regtest)
        .unwrap();
    let mut tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::from_consensus(locktime),
        input: vec![TxIn {
            previous_output: outpoint,
            script_sig: ScriptBuf::new(),
            // Below 0xFFFFFFFF, or CHECKLOCKTIMEVERIFY fails whatever the lock time.
            sequence: Sequence::ENABLE_LOCKTIME_NO_RBF,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::from_sat(value - 1_000),
            script_pubkey: payee.script_pubkey(),
        }],
    };
    let sighash = SighashCache::new(&tx)
        .p2wsh_signature_hash(0, script, Amount::from_sat(value), EcdsaSighashType::All)
        .unwrap();
    let secp = Secp256k1::new();
    let signature = secp.sign_ecdsa(&Message::from(sighash), key);
    let mut sig = signature.serialize_der().to_vec();
    sig.push(EcdsaSighashType::All as u8);
    tx.input[0].witness = Witness::from_slice(&[
        sig,
        key.public_key(&secp).serialize().to_vec(),
        vec![],
        script.to_bytes(),
    ]);
    bitcoin::consensus::serialize(&tx)
}

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

impl Jars {
    pub async fn start_transfer(
        &self,
        caller: &Account,
        jar_id: &str,
        receiver: &Account,
    ) -> ExecutionFinalResult {
        self.start_transfer_with_deposit(caller, jar_id, receiver, ONE_YOCTO)
            .await
    }

    pub async fn start_transfer_with_deposit(
        &self,
        caller: &Account,
        jar_id: &str,
        receiver: &Account,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "start_transfer")
            .args_json(json!({ "jar_id": jar_id, "receiver": receiver.id() }))
            .deposit(deposit)
            .transact()
            .await
            .expect("send start_transfer")
    }

    pub async fn cancel_transfer(&self, caller: &Account, jar_id: &str) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "cancel_transfer")
            .args_json(json!({ "jar_id": jar_id }))
            .deposit(ONE_YOCTO)
            .transact()
            .await
            .expect("send cancel_transfer")
    }

    /// `accept_transfer` from `caller` with `key` (hex) at `fee_rate`, 1 yoctoNEAR and 300 Tgas.
    pub async fn accept_transfer(
        &self,
        caller: &Account,
        jar_id: &str,
        key: &str,
        fee_rate: u64,
    ) -> ExecutionFinalResult {
        self.accept_transfer_with(caller, jar_id, key, fee_rate, ONE_YOCTO)
            .await
    }

    pub async fn accept_transfer_with(
        &self,
        caller: &Account,
        jar_id: &str,
        key: &str,
        fee_rate: u64,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        caller
            .call(self.contract.id(), "accept_transfer")
            .args_json(json!({
                "jar_id": jar_id,
                "btc_pubkey": key,
                "fee_rate": fee_rate.to_string(),
            }))
            .deposit(deposit)
            .gas(Gas::from_tgas(300))
            .transact()
            .await
            .expect("send accept_transfer")
    }

    /// An `accept_transfer` batch that must be signed; returns its payment.
    pub async fn signed_transfer_batch(
        &self,
        caller: &Account,
        jar_id: &str,
        key: &str,
        fee_rate: u64,
    ) -> Value {
        let result = self.accept_transfer(caller, jar_id, key, fee_rate).await;
        let id: String = result.json().expect("payment id");
        let payment = self.get_payment(&id).await;
        assert_eq!(payment["status"], "signed", "{payment}");
        payment
    }

    /// Transfers `jar` from its holder `from` to `to`, who accepts with `key`; re-homes every
    /// coin at 1 sat/vB and confirms each batch until the NFT has moved. Returns the last
    /// batch's signed payment.
    pub async fn transferred(
        &self,
        regtest: &Regtest,
        jar: &RegtestJar,
        from: &Account,
        to: &Account,
        key: &str,
    ) -> Value {
        self.start_transfer(from, &jar.id, to)
            .await
            .into_result()
            .expect("transfer started");
        loop {
            let payment = self.signed_transfer_batch(to, &jar.id, key, 1).await;
            self.confirmed(regtest, &payment)
                .await
                .into_result()
                .expect("batch confirmed");
            if self.get_jar(&jar.id).await["transfer"] == json!("none") {
                return payment;
            }
        }
    }

    pub async fn transfer_state(&self, jar_id: &str) -> Value {
        self.get_jar(jar_id).await["transfer"].clone()
    }
}
