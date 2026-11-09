# The jar contract is deployed locked, and the README names what it trusts

During development the contract is redeployed freely on throwaway accounts. The demo contract is deployed once, by about Nov 11, built reproducibly (`cargo near build` reproducible mode) with its code hash published, and then all of its access keys are deleted, so nobody, the team included, can change it or its rule (R2, O17). A new contract account means new jar addresses (pitfall 1), so test Bitcoin waits in the demo giver's wallet and goes into jars only once the account is final.

The README's trust section (R14, O19) names: NEAR's MPC signing network and its committee and upgrade process; the light client's one full-access key, its pause managers and its one relayer (ADR 0002); and the app's sponsor and keeper accounts, which can pay fees and trigger payments but cannot move coins outside the rule. It separates what is verified (tests, transactions) from what is trusted.
