# Testnet scripts

Scripts that run the jar contract against NEAR testnet and Bitcoin testnet3. The run itself is evidence, not a test suite: every hash it produces goes to `evidence/`.

## The development contract

`sats-jar-dev.testnet` runs the **development build** (the `dev-escape` feature on, so `dev_cancel_payment` exists). It is not the locked demo contract: that one is deployed once, from the reproducible build, with every key deleted (ADR 0008).

It was initialised with:

| Init argument | Value |
|---|---|
| `mpc_contract` | `v1.signer-prod.testnet` |
| `mpc_root_public_key` | the live `public_key({})` view of `v1.signer-prod.testnet` |
| `light_client` | `btc-client-v4.testnet` |
| `network` | `testnet` |

### Redeploying

Needs cargo-near 0.22.0 and near-cli-rs 0.30.1. The account's key lives in near-cli's legacy keychain (`~/.near-credentials/testnet/sats-jar-dev.testnet.json`) on the machine that created it. It is never committed.

```sh
scripts/dev-deploy.sh                        # sats-jar-dev.testnet
scripts/dev-deploy.sh other-dev.testnet      # a fresh account from the faucet
```

The script builds the dev wasm. If the account does not exist yet, it creates it through the testnet faucet. On an account without code it deploys and calls `new`. On an account that already has code it **redeploys the code only and keeps the state**. That is safe only while the contract's state layout is unchanged. After a change to the stored structs or collections, deploy to a fresh account instead: jar addresses depend on the contract account, so the jars and their coins do not carry over.

Then record the deploy (the code hash is compared with the local build):

```sh
node --env-file=<path to .env> scripts/src/money-moment.ts deploy
```

## The money moment (`src/money-moment.ts`)

One step per command, in this order. Each step appends to `evidence/dev-money-moment.json` and refuses to run before the step it depends on.

| Step | What it does |
|---|---|
| `deploy` | Records the deployed code hash, the local build's hash, the signer and light-client facts |
| `create-jar` | Creates a demo-timing jar (cap 2,500 sats, one-day period). It checks that the jar's key equals the live `derived_public_key` and that the witness script and address, rebuilt independently, match. If they do not, no sats move |
| `topup` | Sends two 2,000-sat coins from the giver wallet to the jar at 1 sat/vB. It refuses a second top-up, waits for the fee floor to be 1 sat/vB, and checks the signed transaction (one known input; the two jar coins; change home; fee ≤ 300) before broadcasting |
| `prove` | Waits for 3 confirmations on the light client, builds the merkle proof from mempool.space and calls `prove_topup` for both coins at 60 TGas |
| `allowance` | Calls `request_allowance` at 80 TGas (2 inputs). A second request follows at once and is refused as `ALREADY_PAID`. A failed signing is retried with `retry_signing` |
| `broadcast` | Checks the signed payment's outputs and txid and broadcasts it to testnet3 |
| `confirm` | Waits for 3 confirmations and calls `confirm_payment` at 60 TGas |

The `.env` file gives `DEMO_GIVER_BTC_ADDRESS` and `DEMO_GIVER_BTC_WIF` (a testnet3 P2WPKH wallet). The WIF never leaves the script's process. Testnet3 confirmations are a demo convenience, not security.

## Tests

`src/merkle.test.ts` checks the proof builder against recorded testnet3 block headers. It also checks it against the argument the live light client accepted (`pnpm test` from the root).
