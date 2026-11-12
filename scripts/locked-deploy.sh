#!/usr/bin/env bash
# Deploys the locked jar contract once: the reproducible build, the testnet init settings, then
# every access key deleted, so nobody can change the contract or its rule (ADR 0008).
# One step per command, run in order; each appends to the evidence file:
#
#   scripts/locked-deploy.sh build
#   scripts/locked-deploy.sh deploy <account>
#   scripts/locked-deploy.sh verify <account>
#   scripts/locked-deploy.sh lock <account> --delete-every-key     # irreversible
#
# DRY_RUN=1 rehearses on a throwaway account: evidence goes to evidence/locked-deploy-dryrun.json
# and `build` accepts a commit not yet on origin (so its NEP-330 link does not resolve). Never
# for the real account. Needs Docker, cargo-near 0.22.0 and near-cli-rs 0.30.1; the account's
# key stays in near-cli's legacy keychain (~/.near-credentials) until `lock` deletes it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/contract/Cargo.toml"
OUT="$ROOT/target/near/locked"
WASM="$OUT/sats_jar.wasm"
BUILD="$OUT/build.json"
RPC="https://rpc.testnet.fastnear.com"
REAL_ACCOUNT="sats-jar.testnet"
if [ "${DRY_RUN:-}" = 1 ]; then
  EVIDENCE="$ROOT/evidence/locked-deploy-dryrun.json"
else
  EVIDENCE="$ROOT/evidence/locked-deploy.json"
fi

die() { echo "$*" >&2; exit 1; }

query() {
  curl -s --retry 3 "$RPC" -H 'content-type: application/json' -d "$1"
}

view_account() {
  query "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$1\"}}"
}

# Prints the account's code hash, or nothing if the account does not exist.
code_hash() {
  view_account "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;if(r)process.stdout.write(r.code_hash)})'
}

key_list() {
  query "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$1\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).result.keys.map(k=>k.public_key))))'
}

# The bs58 SHA-256 of a file: what view_account's code_hash is for deployed code.
checksum() {
  node -e '
    const h=require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest();
    const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n=BigInt("0x"+h.toString("hex")),s="";
    while(n>0n){s=A[Number(n%58n)]+s;n/=58n}
    for(const b of h){if(b)break;s="1"+s}
    process.stdout.write(s)' "$1"
}

# Reads a field from a JSON file: json_field <file> <js expression on `j`>.
json_field() {
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"
}

# Appends one step to the evidence file: evidence <step> <json object>.
evidence() {
  node -e '
    const fs=require("fs"),[file,step,data,dry]=process.argv.slice(1);
    const about=dry==="1"
      ?"DRY RUN on a throwaway account, not the demo contract: the locked deploy (koukikouks/sats-jar#14) rehearsed end to end. Written by scripts/locked-deploy.sh."
      :"The locked demo contract (koukikouks/sats-jar#14, ADR 0008): reproducible build, deploy, on-chain checks and every access key deleted. Written by scripts/locked-deploy.sh.";
    const e=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{about,contract:null,steps:[]};
    const d=JSON.parse(data);
    if(d.account)e.contract=d.account;
    e.steps.push({at:new Date().toISOString(),step,...d});
    fs.writeFileSync(file,JSON.stringify(e,null,2)+"\n")' "$EVIDENCE" "$1" "$2" "${DRY_RUN:-}"
}

# near-cli's output is not evidence and names key files: shown only when a step fails. Prints
# the transaction hash.
near_tx() {
  local out
  out="$(near "$@" 2>&1)" || { echo "$out" | tail -n 5 >&2; return 1; }
  echo "$out" | grep -Eo 'Transaction ID: [1-9A-HJ-NP-Za-km-z]+' | head -n 1 | cut -d' ' -f3
}

# The reproducible_build block of contract/Cargo.toml, as JSON.
manifest_build() {
  cargo metadata --format-version 1 --no-deps --manifest-path "$MANIFEST" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).packages.find(p=>p.name==="sats-jar").metadata.near.reproducible_build)))'
}

require_account() {
  [ -n "${1:-}" ] || die "name the account: scripts/locked-deploy.sh $STEP <account>"
  if [ "$1" = "$REAL_ACCOUNT" ] && [ "${DRY_RUN:-}" = 1 ]; then
    die "DRY_RUN is for throwaway accounts, never $REAL_ACCOUNT"
  fi
}

build() {
  # cargo-near opens the main checkout of a git worktree, so it would build another HEAD.
  [ "$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)" = "$(git -C "$ROOT" rev-parse --absolute-git-dir)" ] ||
    die "run from a plain clone, not a git worktree: cargo-near would build the main checkout's HEAD"
  # This script's own evidence may be uncommitted between steps; it is not built.
  [ -z "$(git -C "$ROOT" status --porcelain -- . ':!evidence/locked-deploy*.json')" ] ||
    die "commit first: the reproducible build uses HEAD"
  local commit start size seconds printed sum head on_origin=false
  commit="$(git -C "$ROOT" rev-parse HEAD)"
  # Against the remote's live branches, not local tracking refs, which can be stale.
  git -C "$ROOT" fetch -q origin
  for head in $(git -C "$ROOT" ls-remote --heads origin | cut -f1); do
    git -C "$ROOT" merge-base --is-ancestor "$commit" "$head" 2>/dev/null && { on_origin=true; break; }
  done
  if [ "$on_origin" = false ]; then
    [ "${DRY_RUN:-}" = 1 ] || die "push $commit first: the NEP-330 metadata names it, so it must resolve on the public repo"
    echo "DRY_RUN: building $commit, which is not on origin"
  fi
  rm -rf "$OUT"
  start="$(date +%s)"
  printed="$(cargo near build reproducible-wasm --manifest-path "$MANIFEST" --out-dir "$OUT" 2>&1 | tee /dev/stderr |
    sed $'s/\x1b\\[[0-9;]*m//g' | grep -Eo 'SHA-256 checksum bs58: +[1-9A-HJ-NP-Za-km-z]+' | awk '{print $NF}' | sort -u)"
  seconds=$(($(date +%s) - start))
  [ -f "$WASM" ] || die "no wasm at $WASM"
  sum="$(checksum "$WASM")"
  [ "$sum" = "$printed" ] || die "checksum $sum differs from cargo-near's $printed"
  size="$(wc -c <"$WASM" | tr -d ' ')"
  node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({commit:process.argv[2],checksum:process.argv[3],dry_run:process.argv[4]==="1"})+"\n")' \
    "$BUILD" "$commit" "$sum" "${DRY_RUN:-}"
  evidence build "$(node -e 'const [c,s,b,n,t,d]=process.argv.slice(1);process.stdout.write(JSON.stringify({commit:c,checksum_bs58:s,wasm_bytes:Number(b),reproducible_build:JSON.parse(n),build_seconds:Number(t),commit_on_origin:d==="true"}))' \
    "$commit" "$sum" "$size" "$(manifest_build)" "$seconds" "$on_origin")"
  echo "Built $commit: $sum ($size bytes, ${seconds}s)"
}

deploy() {
  local account="$1" commit sum hash root_key args tx balance
  [ -f "$BUILD" ] || die "run build first"
  commit="$(json_field "$BUILD" j.commit)"
  sum="$(json_field "$BUILD" j.checksum)"
  [ "$commit" = "$(git -C "$ROOT" rev-parse HEAD)" ] || die "the wasm was built from $commit, not HEAD: run build again"
  [ "$(checksum "$WASM")" = "$sum" ] || die "the wasm on disk is not the one build checked: run build again"
  if [ "$(json_field "$BUILD" j.dry_run)" = true ] && [ "${DRY_RUN:-}" != 1 ]; then
    die "that build was a dry run: run build again without DRY_RUN"
  fi

  hash="$(code_hash "$account")"
  if [ -z "$hash" ]; then
    echo "Creating $account through the testnet faucet"
    near_tx account create-account sponsor-by-faucet-service "$account" \
      autogenerate-new-keypair save-to-legacy-keychain network-config testnet create >/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do hash="$(code_hash "$account")"; [ -n "$hash" ] && break; sleep 3; done
    [ -n "$hash" ] || die "account creation failed"
  fi
  [ "$hash" = "11111111111111111111111111111111" ] || die "$account already has code: the locked contract is deployed once, never redeployed"

  root_key="$(query '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"v1.signer-prod.testnet","method_name":"public_key","args_base64":"e30="}}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(Buffer.from(JSON.parse(s).result.result).toString())))')"
  args="{\"mpc_contract\":\"v1.signer-prod.testnet\",\"mpc_root_public_key\":\"$root_key\",\"light_client\":\"btc-client-v4.testnet\",\"network\":\"testnet\"}"
  echo "Deploying and initialising $account"
  tx="$(near_tx contract deploy "$account" use-file "$WASM" with-init-call new json-args "$args" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config testnet sign-with-legacy-keychain send)"
  # Views read final blocks, a few seconds behind.
  for _ in 1 2 3 4 5 6 7 8 9 10; do hash="$(code_hash "$account")"; [ "$hash" = "$sum" ] && break; sleep 3; done
  [ "$hash" = "$sum" ] || die "deploy failed: code hash is $hash"
  balance="$(view_account "$account" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).result.amount))')"
  evidence deploy "$(node -e 'const [a,c,s,i,t,b]=process.argv.slice(1);process.stdout.write(JSON.stringify({account:a,commit:c,checksum_bs58:s,init_args:JSON.parse(i),near_tx:t||null,explorer:t?"https://testnet.nearblocks.io/txns/"+t:null,balance_yocto:b}))' \
    "$account" "$commit" "$sum" "$args" "$tx" "$balance")"
  echo "Deployed $account (tx $tx). Next: scripts/locked-deploy.sh verify $account"
}

# Checks the deployed code against the build; prints the NEP-330 metadata JSON.
check() {
  local account="$1" commit sum hash metadata
  [ -f "$BUILD" ] || die "run build first"
  commit="$(json_field "$BUILD" j.commit)"
  sum="$(json_field "$BUILD" j.checksum)"
  hash="$(code_hash "$account")"
  [ "$hash" = "$sum" ] || die "on-chain code hash $hash is not the build's $sum"
  metadata="$(query "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$account\",\"method_name\":\"contract_source_metadata\",\"args_base64\":\"e30=\"}}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(Buffer.from(JSON.parse(s).result.result).toString()))')" ||
    die "could not read contract_source_metadata"
  # The rebuild a third party runs uses exactly these: image@digest, command, no env, commit.
  # `|| exit 1` because verify calls check inside $(...), where bash ignores set -e.
  node -e '
    const [m,b,c]=process.argv.slice(1).map((x,i)=>i<2?JSON.parse(x):x);
    const i=m.build_info||{},fail=w=>{console.error("metadata: "+w);process.exit(1)};
    if(i.build_environment!==b.image+"@"+b.image_digest)fail("image "+i.build_environment);
    if(JSON.stringify(i.build_command)!==JSON.stringify(b.container_build_command))fail("command "+JSON.stringify(i.build_command));
    if(b.passed_env.length)fail("passed_env is not empty");
    if(!String(i.source_code_snapshot).endsWith("?rev="+c))fail("snapshot "+i.source_code_snapshot);' \
    "$metadata" "$(manifest_build)" "$commit" || exit 1
  echo "$metadata"
}

verify() {
  local account="$1" metadata
  metadata="$(check "$account")"
  evidence verify "$(node -e 'const [a,h,m]=process.argv.slice(1);process.stdout.write(JSON.stringify({account:a,on_chain_code_hash:h,code_hash_matches_build:true,contract_source_metadata:JSON.parse(m)}))' \
    "$account" "$(code_hash "$account")" "$metadata")"
  echo "Verified $account: code hash and NEP-330 metadata match the build"
}

# Safe to re-run: it deletes whatever keys remain, in one transaction, and records the count.
lock() {
  local account="$1" keys tx left
  [ "${2:-}" = --delete-every-key ] || die "lock deletes every key for good: pass --delete-every-key"
  check "$account" >/dev/null
  keys="$(key_list "$account")"
  if [ "$keys" != "[]" ]; then
    echo "Deleting every key of $account: $keys"
    tx="$(near_tx account delete-keys "$account" public-keys "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).join(","))' "$keys")" \
      network-config testnet sign-with-legacy-keychain send)"
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do left="$(key_list "$account")"; [ "$left" = "[]" ] && break; sleep 3; done
  evidence lock "$(node -e 'const [a,k,t,l]=process.argv.slice(1);process.stdout.write(JSON.stringify({account:a,deleted_keys:JSON.parse(k),near_tx:t||null,explorer:t?"https://testnet.nearblocks.io/txns/"+t:null,access_key_count:JSON.parse(l).length}))' \
    "$account" "$keys" "${tx:-}" "$left")"
  [ "$left" = "[]" ] || die "$account still has keys: $left"
  echo "Locked $account: 0 access keys"
}

STEP="${1:-}"
case "$STEP" in
  build) build ;;
  deploy | verify) require_account "${2:-}"; "$STEP" "$2" ;;
  lock) require_account "${2:-}"; lock "$2" "${3:-}" ;;
  *) die "usage: scripts/locked-deploy.sh build | deploy <account> | verify <account> | lock <account> --delete-every-key" ;;
esac
