#!/usr/bin/env bash
# Builds the development contract (dev-escape on) and deploys it to a testnet dev account.
# The first run creates the account through the testnet faucet and initialises the contract;
# later runs redeploy the code only, keeping the state (only valid while the state layout is
# unchanged). The account's key stays in near-cli's legacy keychain (~/.near-credentials).
# Needs cargo-near 0.22.0 and near-cli-rs 0.30.1. Usage: scripts/dev-deploy.sh [account]
set -euo pipefail

ACCOUNT="${1:-sats-jar-dev.testnet}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASM="$ROOT/target/near/sats_jar/sats_jar.wasm"
RPC="https://rpc.testnet.fastnear.com"

query() {
  curl -s --retry 3 "$RPC" -H 'content-type: application/json' -d "$1"
}

account_exists() {
  query "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$ACCOUNT\"}}" |
    grep -q '"code_hash"'
}

has_code() {
  ! query "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$ACCOUNT\"}}" |
    grep -q '"code_hash":"11111111111111111111111111111111"'
}

# near-cli's output is not evidence and names key files: shown only when a step fails.
near_quiet() {
  local out
  out="$(near "$@" 2>&1)" || { echo "$out" | tail -n 5 >&2; return 1; }
}

cargo near build non-reproducible-wasm --manifest-path "$ROOT/contract/Cargo.toml" \
  --features dev-escape --no-abi

if ! account_exists; then
  echo "Creating $ACCOUNT through the testnet faucet"
  near_quiet account create-account sponsor-by-faucet-service "$ACCOUNT" \
    autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
  for _ in 1 2 3 4 5 6 7 8 9 10; do account_exists && break; sleep 3; done
  account_exists || { echo "account creation failed" >&2; exit 1; }
fi

if has_code; then
  echo "Redeploying the code of $ACCOUNT (state kept)"
  near_quiet contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
    network-config testnet sign-with-legacy-keychain send
else
  ROOT_KEY="$(query '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"v1.signer-prod.testnet","method_name":"public_key","args_base64":"e30="}}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(Buffer.from(JSON.parse(s).result.result).toString())))')"
  ARGS="{\"mpc_contract\":\"v1.signer-prod.testnet\",\"mpc_root_public_key\":\"$ROOT_KEY\",\"light_client\":\"btc-client-v4.testnet\",\"network\":\"testnet\"}"
  echo "Deploying and initialising $ACCOUNT"
  near_quiet contract deploy "$ACCOUNT" use-file "$WASM" with-init-call new json-args "$ARGS" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config testnet sign-with-legacy-keychain send
fi

# Views read final blocks, a few seconds behind.
for _ in 1 2 3 4 5 6 7 8 9 10; do has_code && break; sleep 3; done
has_code || { echo "deploy failed" >&2; exit 1; }
echo "Deployed. Record it with: node --env-file=<.env> scripts/src/money-moment.ts deploy"
