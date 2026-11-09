# The app hides NEAR; a separate proof view shows it

Sats Jar is for a grandparent or parent with no crypto experience, and people like that leave at the first wallet pop-up, gas fee or account name (no wallet pop-ups, no gas, no account names). So givers, parents and children never see NEAR: the app signs them in simply, creates and manages their NEAR accounts behind the scenes (including the account that holds a child's jar), and pays their NEAR gas and signing fees. The one place Bitcoin shows is where it must: sending Bitcoin into a jar, and the child's Bitcoin address. Every jar also has a "check it yourself" view with the contract, the NEAR transactions and the Bitcoin transactions behind it, so a judge or a sceptical giver can verify every claim without trusting the app (R15).

## Consequences

- The app's own accounts and gas sponsor hold keys, but none of them can move a jar's coins or change its rule (R2 still holds; only the jar contract can ask for a signature).
- Whoever holds a child's login holds the jar at unlock. The app says so plainly (R14).
