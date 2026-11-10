//! Seam 1 harness: builds the contract wasm, starts a sandbox and deploys the jar contract at
//! `jar.<root>`, the account the live `derived_public_key` vectors were recorded for.
#![allow(dead_code)]

mod handover;
mod payment;
mod strays;
mod topup;
#[allow(unused_imports)]
pub use handover::*;
#[allow(unused_imports)]
pub use payment::*;
#[allow(unused_imports)]
pub use strays::*;
#[allow(unused_imports)]
pub use topup::*;

use bitcoin::hashes::Hash;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use std::collections::HashMap;
use std::sync::Mutex;
use test_support::serde_json::{json, Value};

/// `public_key({})` on `v1.signer-prod.testnet` (MPC 3.18.0), read 2026-11-09.
pub const LIVE_MPC_ROOT_KEY: &str = "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

pub const MPC_CONTRACT: &str = "v1.signer-prod.testnet";
/// Where the light-client stand-in is deployed in every sandbox.
pub const LIGHT_CLIENT: &str = "light-client.test.near";
/// Where the signer stand-in is deployed in every sandbox.
pub const SIGNER: &str = "signer.test.near";

pub const DAY: u64 = 86_400;

/// Which wasm to build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Build {
    /// The jar contract with default features: what the reproducible (locked) build compiles.
    Locked,
    /// The jar contract with the `dev-escape` feature.
    Dev,
    /// The light-client stand-in (`tests/stand-ins/light-client`).
    LightClient,
    /// The MPC signer stand-in (`tests/stand-ins/signer`).
    Signer,
}

static WASM: Mutex<Option<HashMap<Build, Vec<u8>>>> = Mutex::new(None);

/// The contract wasm for `build`, compiled once per test binary. Each feature set gets its own
/// target and output directory, so a locked-features test can never read the dev wasm.
pub fn wasm(build: Build) -> Vec<u8> {
    let mut cache = WASM.lock().unwrap_or_else(|e| e.into_inner());
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(wasm) = cache.get(&build) {
        return wasm.clone();
    }
    let root = env!("CARGO_MANIFEST_DIR");
    let (name, manifest) = match build {
        Build::Locked => ("locked", format!("{root}/Cargo.toml")),
        Build::Dev => ("dev", format!("{root}/Cargo.toml")),
        Build::LightClient => (
            "light-client",
            format!("{root}/tests/stand-ins/light-client/Cargo.toml"),
        ),
        Build::Signer => (
            "signer",
            format!("{root}/tests/stand-ins/signer/Cargo.toml"),
        ),
    };
    let opts = cargo_near_build::BuildOpts {
        manifest_path: Some(manifest.into()),
        features: (build == Build::Dev).then(|| "dev-escape".to_owned()),
        no_abi: true,
        out_dir: Some(format!("{root}/../target/near-test/{name}/out").into()),
        override_cargo_target_dir: Some(format!("{root}/../target/near-test/{name}/target")),
        ..Default::default()
    };
    let path = cargo_near_build::build_with_cli(opts).expect("contract builds");
    let wasm = std::fs::read(path).expect("read wasm");
    cache.insert(build, wasm.clone());
    wasm
}

pub struct Jars {
    pub worker: Worker<Sandbox>,
    pub contract: Contract,
    pub giver: Account,
    pub light_client: Contract,
    pub signer: Contract,
}

/// A sandbox with the jar contract deployed at `jar.<root>` (not yet initialised).
pub async fn deploy(build: Build) -> Jars {
    let worker = near_workspaces::sandbox().await.expect("sandbox");
    let root = worker.root_account().expect("root account");
    let account = root
        .create_subaccount("jar")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await
        .expect("create jar account")
        .into_result()
        .expect("jar account created");
    let contract = account
        .deploy(&wasm(build))
        .await
        .expect("deploy")
        .into_result()
        .expect("deployed");
    let giver = new_account(&worker, "giver").await;
    let light_client = root
        .create_subaccount("light-client")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await
        .expect("create light-client account")
        .into_result()
        .expect("light-client account created")
        .deploy(&wasm(Build::LightClient))
        .await
        .expect("deploy light client")
        .into_result()
        .expect("light client deployed");
    let signer = stand_in(&root, "signer", Build::Signer).await;
    Jars {
        worker,
        contract,
        giver,
        light_client,
        signer,
    }
}

/// A deployed contract initialised by its own account for `network`.
pub async fn start(network: &str) -> Jars {
    let sandbox = deploy(Build::Locked).await;
    init(&sandbox.contract, network)
        .await
        .into_result()
        .expect("init");
    sandbox
}

/// A deployed `build` initialised for `network` with the signer stand-in as its MPC network, so
/// its payments are really signed. Key derivation itself is pinned to the live vectors elsewhere.
pub async fn start_paying(build: Build, network: &str) -> Jars {
    let sandbox = deploy(build).await;
    let root_key: String = sandbox
        .signer
        .view("public_key")
        .await
        .expect("public_key")
        .json()
        .expect("json");
    sandbox
        .contract
        .call("new")
        .args_json(json!({
            "mpc_contract": SIGNER,
            "mpc_root_public_key": root_key,
            "light_client": LIGHT_CLIENT,
            "network": network,
        }))
        .transact()
        .await
        .expect("send init")
        .into_result()
        .expect("init");
    sandbox
}

async fn stand_in(root: &Account, name: &str, build: Build) -> Contract {
    root.create_subaccount(name)
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await
        .expect("create stand-in account")
        .into_result()
        .expect("stand-in account created")
        .deploy(&wasm(build))
        .await
        .expect("deploy stand-in")
        .into_result()
        .expect("stand-in deployed")
}

pub async fn init(contract: &Contract, network: &str) -> ExecutionFinalResult {
    contract
        .call("new")
        .args_json(json!({
            "mpc_contract": MPC_CONTRACT,
            "mpc_root_public_key": LIVE_MPC_ROOT_KEY,
            "light_client": LIGHT_CLIENT,
            "network": network,
        }))
        .transact()
        .await
        .expect("send init")
}

pub async fn new_account(worker: &Worker<Sandbox>, name: &str) -> Account {
    worker
        .root_account()
        .expect("root")
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await
        .expect("create account")
        .into_result()
        .expect("account created")
}

/// Current sandbox block time in unix seconds.
pub async fn now(worker: &Worker<Sandbox>) -> u64 {
    worker.view_block().await.expect("block").timestamp() / 1_000_000_000
}

impl Jars {
    /// Calls `create_jar` from the giver with 1 NEAR attached.
    pub async fn create_jar(&self, args: &Value) -> ExecutionFinalResult {
        self.create_jar_with_deposit(args, NearToken::from_near(1))
            .await
    }

    pub async fn create_jar_with_deposit(
        &self,
        args: &Value,
        deposit: NearToken,
    ) -> ExecutionFinalResult {
        self.giver
            .call(self.contract.id(), "create_jar")
            .args_json(args)
            .deposit(deposit)
            .max_gas()
            .transact()
            .await
            .expect("send create_jar")
    }

    pub async fn get_jar(&self, jar_id: &str) -> Value {
        self.contract
            .view("get_jar")
            .args_json(json!({ "jar_id": jar_id }))
            .await
            .expect("get_jar")
            .json()
            .expect("json")
    }

    /// Valid create args for a jar with a 30-day period that unlocks in a year.
    pub async fn valid_args(&self, child_address: &str) -> Value {
        let unlock_at = now(&self.worker).await + 365 * DAY;
        json!({
            "child_address": child_address,
            "cap": "20000",
            "period": (30 * DAY).to_string(),
            "unlock_at": unlock_at.to_string(),
            "guardians": ["grandma.sandbox", "uncle.sandbox"],
            "family_account": "family.sandbox",
            "nickname": "Little Bear",
        })
    }
}

/// The refusal message of a failed call (its first failure), for matching on the code.
pub fn refusal(result: &ExecutionFinalResult) -> String {
    assert!(result.is_failure(), "expected a refusal, got success");
    format!("{:?}", result.failures())
}

/// The child's P2WPKH address for `network`, encoded by rust-bitcoin.
pub fn child_address(network: bitcoin::Network) -> String {
    let hash = bitcoin::WPubkeyHash::from_byte_array(CHILD_KEY_HASH);
    bitcoin::Address::from_script(&bitcoin::ScriptBuf::new_p2wpkh(&hash), network)
        .expect("p2wpkh address")
        .to_string()
}

/// BIP-173's example key hash (`bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4`).
pub const CHILD_KEY_HASH: [u8; 20] = [
    0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23,
    0xf1, 0x43, 0x3b, 0xd6,
];
