//! The jar is an NFT (NEP-171, 177, 178, 181) whose picture shows its life, and it never moves
//! by a plain transfer.

mod common;

use bitcoin::hashes::{sha256, Hash};
use common::*;
use near_contract_standards::non_fungible_token::metadata::NFTContractMetadata;
use near_contract_standards::non_fungible_token::Token;
use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::types::NearToken;
use test_support::serde_json::{self, json, Value};
use test_support::{sats, Regtest};

const SVG_NS: &str = "http://www.w3.org/2000/svg";
/// The fill's height when the jar is full (the picture's own scale).
const FULL: u64 = 180;

/// A regtest contract with jar "1" created for the family account.
async fn one_jar() -> Jars {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    jars.create_jar(&args).await.into_result().unwrap();
    jars
}

async fn view(jars: &Jars, method: &str, args: Value) -> Value {
    jars.contract
        .view(method)
        .args_json(args)
        .await
        .unwrap_or_else(|e| panic!("{method}: {e:?}"))
        .json()
        .expect("json")
}

/// `nft_token` read through NEP-171's reference type.
async fn token(jars: &Jars, token_id: &str) -> Token {
    serde_json::from_value(view(jars, "nft_token", json!({ "token_id": token_id })).await)
        .expect("a NEP-171 token")
}

/// Jar `jar_id`'s picture, checked against its NEP-177 `media_hash`.
async fn picture(jars: &Jars, jar_id: &str) -> String {
    let metadata = token(jars, jar_id).await.metadata.expect("metadata");
    let media = metadata.media.expect("media");
    let svg = STANDARD
        .decode(
            media
                .strip_prefix("data:image/svg+xml;base64,")
                .expect("an SVG data URL"),
        )
        .expect("base64");
    assert_eq!(
        metadata.media_hash.expect("media_hash").0,
        sha256::Hash::hash(&svg).to_byte_array(),
        "media_hash is the SVG's SHA-256"
    );
    String::from_utf8(svg).expect("utf-8")
}

/// The text of the element with `id` in an SVG.
fn text(svg: &str, id: &str) -> String {
    let doc = roxmltree::Document::parse(svg).expect("well-formed XML");
    let node = doc
        .descendants()
        .find(|n| n.attribute("id") == Some(id))
        .unwrap_or_else(|| panic!("no element {id}"));
    node.descendants()
        .filter(|n| n.is_text())
        .filter_map(|n| n.text())
        .collect()
}

/// The height of the jar's fill.
fn fill(svg: &str) -> u64 {
    let doc = roxmltree::Document::parse(svg).expect("well-formed XML");
    doc.descendants()
        .find(|n| n.attribute("id") == Some("fill"))
        .expect("a fill")
        .attribute("height")
        .expect("height")
        .parse()
        .expect("a whole number")
}

#[tokio::test]
async fn a_new_jar_is_a_standard_nft_held_by_the_family_account() {
    let jars = one_jar().await;

    let token = token(&jars, "1").await;

    assert_eq!(token.token_id, "1");
    assert_eq!(token.owner_id.as_str(), "family.sandbox");
    assert_eq!(token.approved_account_ids, Some(Default::default()));
    let metadata = token.metadata.expect("token metadata");
    metadata.assert_valid();
    assert!(metadata.media.is_some(), "the jar has a picture");
    assert_eq!(
        view(&jars, "nft_token", json!({ "token_id": "2" })).await,
        Value::Null
    );
}

#[tokio::test]
async fn the_contract_metadata_is_standard_nep_177() {
    let jars = start("regtest").await;

    let metadata: NFTContractMetadata =
        serde_json::from_value(view(&jars, "nft_metadata", json!({})).await)
            .expect("NEP-177 contract metadata");

    metadata.assert_valid();
    assert_eq!(metadata.name, "Sats Jar");
    assert_eq!(metadata.symbol, "JAR");
}

#[tokio::test]
async fn a_new_jar_shows_an_empty_jar_with_no_sats() {
    let jars = one_jar().await;

    let svg = picture(&jars, "1").await;

    let doc = roxmltree::Document::parse(&svg).expect("well-formed XML");
    assert_eq!(doc.root_element().tag_name().name(), "svg");
    assert_eq!(doc.root_element().tag_name().namespace(), Some(SVG_NS));
    assert_eq!(text(&svg, "balance"), "0 sats");
    assert_eq!(fill(&svg), 0);
    assert_eq!(text(&svg, "nickname"), "Little Bear");
}

#[tokio::test]
async fn the_picture_shows_the_unlock_date() {
    let jars = start("regtest").await;
    // Dates from BSD `date -u -r <seconds> +%F`.
    let dates = [
        (2_000_000_000u64, "2033-05-18"),
        (2_147_483_647, "2038-01-19"),
        (1_835_395_200, "2028-02-29"),
        (4_102_444_800, "2100-01-01"),
        (4_107_542_400, "2100-03-01"),
    ];
    for (unlock_at, _) in dates {
        let mut args = jars
            .valid_args(&child_address(bitcoin::Network::Regtest))
            .await;
        args["unlock_at"] = json!(unlock_at.to_string());
        jars.create_jar(&args).await.into_result().unwrap();
    }

    for (i, (_, date)) in dates.iter().enumerate() {
        let svg = picture(&jars, &(i + 1).to_string()).await;
        assert_eq!(text(&svg, "unlock"), format!("Unlocks {date}"));
    }
}

#[tokio::test]
async fn the_jar_fills_with_its_proven_balance() {
    let regtest = Regtest::start();
    let jars = start("regtest").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    args["unlock_at"] = json!("2000000000");
    jars.create_jar(&args).await.into_result().unwrap();
    let address = jars.get_jar("1").await["address"]
        .as_str()
        .unwrap()
        .to_owned();
    let anyone = new_account(&jars.worker, "anyone").await;
    // The cap is 20,000 sats, so the jar is full at a year of allowances: 240,000 sats.
    // Each step: (sats sent, fill height, balance shown).
    let steps = [
        (1_000, 1, "1,000"), // 180 × 1,000 / 240,000 rounds to 0: a sliver still shows.
        (49_000, 37, "50,000"), // 180 × 50,000 / 240,000 = 37.5.
        (200_000, FULL, "250,000"), // Past a year of allowances: full, never over.
    ];

    for (sent, height, balance) in steps {
        let topup = jars.confirmed_topup(&regtest, &address, sent).await;
        let core_tx = regtest.rpc(
            "getrawtransaction",
            &[json!(topup.txid), json!(true), json!(topup.block)],
        );
        assert_eq!(
            sats(&core_tx["vout"][topup.funding.vout as usize]["value"]),
            sent,
            "Core paid the jar"
        );
        let proven = jars.prove(&anyone, "1", &topup).await;
        assert!(proven.is_success(), "{:?}", proven.failures());

        let svg = picture(&jars, "1").await;
        assert_eq!(fill(&svg), height, "after {sent} sats");
        assert_eq!(text(&svg, "balance"), format!("{balance} sats"));
        let metadata = token(&jars, "1").await.metadata.unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Sats Jar #1"));
        assert_eq!(
            metadata.description,
            Some(format!("Little Bear: {balance} sats, unlocks 2033-05-18"))
        );
    }
}

#[tokio::test]
async fn a_nickname_cannot_break_or_script_the_picture() {
    let jars = start("regtest").await;
    // (nickname, what the picture shows: the first 24 characters, minus any XML 1.0 forbids).
    let nicknames = [
        (
            r#"<script>alert(1)</script> & "q""#,
            "<script>alert(1)</script",
        ),
        (&"&".repeat(30), &"&".repeat(24)),
        ("Bear\u{1}\u{8}\u{1f} Cub\u{fffe}\u{ffff}", "Bear Cub"),
    ];
    for (nickname, _) in nicknames {
        let mut args = jars
            .valid_args(&child_address(bitcoin::Network::Regtest))
            .await;
        args["nickname"] = json!(nickname);
        jars.create_jar(&args).await.into_result().unwrap();
    }

    for (i, (_, shown)) in nicknames.iter().enumerate() {
        let svg = picture(&jars, &(i + 1).to_string()).await;
        let doc = roxmltree::Document::parse(&svg).expect("well-formed XML");
        assert!(
            doc.descendants().all(|n| n.tag_name().name() != "script"),
            "no script element in {svg}"
        );
        assert_eq!(text(&svg, "nickname"), *shown);
    }
}

/// The token ids in an NFT view's answer.
fn ids(tokens: Value) -> Vec<String> {
    tokens
        .as_array()
        .expect("a list of tokens")
        .iter()
        .map(|t| {
            let token: Token = serde_json::from_value(t.clone()).expect("a NEP-171 token");
            token.token_id
        })
        .collect()
}

#[tokio::test]
async fn jars_are_enumerable_overall_and_by_holder() {
    let jars = start("regtest").await;
    for family in ["family.sandbox", "neighbours.sandbox", "family.sandbox"] {
        let mut args = jars
            .valid_args(&child_address(bitcoin::Network::Regtest))
            .await;
        args["family_account"] = json!(family);
        jars.create_jar(&args).await.into_result().unwrap();
    }

    assert_eq!(view(&jars, "nft_total_supply", json!({})).await, "3");
    assert_eq!(
        ids(view(&jars, "nft_tokens", json!({})).await),
        ["1", "2", "3"]
    );
    assert_eq!(
        ids(view(
            &jars,
            "nft_tokens",
            json!({ "from_index": "1", "limit": 1 })
        )
        .await),
        ["2"]
    );
    for past_the_end in ["3", "340282366920938463463374607431768211455"] {
        assert_eq!(
            ids(view(&jars, "nft_tokens", json!({ "from_index": past_the_end })).await),
            Vec::<String>::new()
        );
    }
    let family = json!({ "account_id": "family.sandbox" });
    assert_eq!(
        view(&jars, "nft_supply_for_owner", family.clone()).await,
        "2"
    );
    assert_eq!(
        ids(view(&jars, "nft_tokens_for_owner", family).await),
        ["1", "3"]
    );
    assert_eq!(
        ids(view(
            &jars,
            "nft_tokens_for_owner",
            json!({ "account_id": "family.sandbox", "from_index": "1", "limit": 1 })
        )
        .await),
        ["3"]
    );
    let stranger = json!({ "account_id": "stranger.sandbox" });
    assert_eq!(
        view(&jars, "nft_supply_for_owner", stranger.clone()).await,
        "0"
    );
    assert_eq!(
        ids(view(&jars, "nft_tokens_for_owner", stranger).await),
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn the_giver_pays_for_the_jar_in_its_holders_list() {
    let jars = start("regtest").await;
    // A first jar for a family, a second for the same family, then one for a new holder.
    for family in ["family.sandbox", "family.sandbox", "neighbours.sandbox"] {
        let mut args = jars
            .valid_args(&child_address(bitcoin::Network::Regtest))
            .await;
        args["family_account"] = json!(family);
        // Account views read final blocks, a few behind the last transaction's refunds.
        jars.worker.fast_forward(5).await.unwrap();
        let storage_before = jars.contract.view_account().await.unwrap().storage_usage;
        let balance_before = jars.giver.view_account().await.unwrap().balance;
        let result = jars.create_jar(&args).await;
        assert!(result.is_success(), "{:?}", result.failures());
        jars.worker.fast_forward(5).await.unwrap();
        let storage_after = jars.contract.view_account().await.unwrap().storage_usage;
        let balance_after = jars.giver.view_account().await.unwrap().balance;

        // 10^19 yoctoNEAR per byte (protocol config).
        let storage_cost = u128::from(storage_after - storage_before) * 10u128.pow(19);
        let gas_paid: u128 = result
            .outcomes()
            .iter()
            .map(|o| o.tokens_burnt.as_yoctonear())
            .sum();
        let paid = balance_before.as_yoctonear() - balance_after.as_yoctonear();
        assert_eq!(
            paid - gas_paid,
            storage_cost,
            "the giver paid for exactly the storage the jar added ({family})"
        );
    }
}

#[tokio::test]
async fn an_enumeration_page_holds_at_most_50_jars() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    for _ in 0..51 {
        jars.create_jar(&args).await.into_result().unwrap();
    }

    let page = ids(view(&jars, "nft_tokens", json!({ "limit": 60 })).await);
    assert_eq!(page.len(), 50);
    assert_eq!(page.last().map(String::as_str), Some("50"));
    let held = json!({ "account_id": "family.sandbox", "limit": 60 });
    assert_eq!(
        ids(view(&jars, "nft_tokens_for_owner", held).await).len(),
        50
    );

    // A full page's cost, measured as a transaction (views report no gas).
    let measured = jars
        .giver
        .call(jars.contract.id(), "nft_tokens")
        .args_json(json!({}))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(measured.is_success());
    println!(
        "a 50-jar page burns {} Tgas",
        measured.total_gas_burnt.as_tgas()
    );
}

/// A regtest contract with jar "1" held by a real family account that can sign.
async fn held_jar() -> (Jars, near_workspaces::Account) {
    let jars = start("regtest").await;
    let family = new_account(&jars.worker, "family").await;
    let mut args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;
    args["family_account"] = json!(family.id());
    jars.create_jar(&args).await.into_result().unwrap();
    (jars, family)
}

#[tokio::test]
async fn a_plain_transfer_is_refused_and_points_to_start_transfer() {
    let (jars, family) = held_jar().await;
    let buyer = new_account(&jars.worker, "buyer").await;

    let transfer = family
        .call(jars.contract.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": buyer.id(), "token_id": "1" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap();
    let transfer_call = family
        .call(jars.contract.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": buyer.id(), "token_id": "1", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await
        .unwrap();

    for refused in [transfer, transfer_call] {
        let reason = refusal(&refused);
        assert!(reason.contains("PLAIN_TRANSFER_REFUSED: "), "{reason}");
        assert!(reason.contains("start_transfer"), "{reason}");
    }
    assert_eq!(
        token(&jars, "1").await.owner_id.as_str(),
        family.id().as_str()
    );
}

#[tokio::test]
async fn approvals_are_refused_before_handover() {
    let (jars, family) = held_jar().await;
    let market = new_account(&jars.worker, "market").await;
    let approve = |token_id: &'static str| {
        family
            .call(jars.contract.id(), "nft_approve")
            .args_json(json!({ "token_id": token_id, "account_id": market.id(), "msg": null }))
            .deposit(NearToken::from_millinear(10))
            .max_gas()
            .transact()
    };

    let refused = approve("1").await.unwrap();
    let reason = refusal(&refused);
    assert!(reason.contains("APPROVAL_BEFORE_HANDOVER: "), "{reason}");
    let unknown = approve("9").await.unwrap();
    assert!(refusal(&unknown).contains("UNKNOWN_JAR: "));
    assert_eq!(
        view(
            &jars,
            "nft_is_approved",
            json!({ "token_id": "1", "approved_account_id": market.id() })
        )
        .await,
        false
    );
    assert_eq!(
        token(&jars, "1").await.approved_account_ids,
        Some(Default::default())
    );
}

#[tokio::test]
async fn only_the_holder_revokes_with_one_yocto() {
    let (jars, family) = held_jar().await;
    let stranger = new_account(&jars.worker, "stranger").await;
    let market = new_account(&jars.worker, "market").await;
    let revokes = [
        (
            "nft_revoke",
            json!({ "token_id": "1", "account_id": market.id() }),
        ),
        ("nft_revoke_all", json!({ "token_id": "1" })),
    ];

    for (method, args) in revokes {
        let call = |caller: &near_workspaces::Account, args: Value, yocto: u128| {
            caller
                .call(jars.contract.id(), method)
                .args_json(args)
                .deposit(NearToken::from_yoctonear(yocto))
                .transact()
        };
        // NEP-178: exactly 1 yoctoNEAR (near-sdk's own refusal text), from the holder.
        let unpaid = call(&family, args.clone(), 0).await.unwrap();
        assert!(
            refusal(&unpaid).contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{method}"
        );
        let not_holder = call(&stranger, args.clone(), 1).await.unwrap();
        assert!(
            refusal(&not_holder).contains("NOT_THE_HOLDER: "),
            "{method}"
        );
        let mut unknown = args.clone();
        unknown["token_id"] = json!("9");
        assert!(refusal(&call(&family, unknown, 1).await.unwrap()).contains("UNKNOWN_JAR: "));
        let revoked = call(&family, args, 1).await.unwrap();
        assert!(revoked.is_success(), "{method}: {:?}", revoked.failures());
    }
}
