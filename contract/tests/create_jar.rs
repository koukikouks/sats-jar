//! Creating a jar and reading it back through `get_jar`.

mod common;

use common::*;

#[tokio::test]
async fn a_created_jar_is_held_by_the_family_account_with_its_exact_create_args() {
    let jars = start("regtest").await;
    let args = jars
        .valid_args(&child_address(bitcoin::Network::Regtest))
        .await;

    let result = jars.create_jar(&args).await;

    assert_eq!(
        result
            .clone()
            .into_result()
            .unwrap()
            .json::<String>()
            .unwrap(),
        "1"
    );
    let jar = jars.get_jar("1").await;
    assert_eq!(jar["jar_id"], "1");
    assert_eq!(jar["create_args"], args);
    assert_eq!(jar["owner_id"], "family.sandbox");
    assert_eq!(jar["giver"], jars.giver.id().as_str());
}
