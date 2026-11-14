# Web app parity

Everything a person can do through the App SDK, and where the web app does it. The SDK's live checks (`packages/sdk/src/verify-testnet.ts`, `verify-testnet-2.ts`) are the command-line bar; the web app calls the same SDK methods with the same arguments, so it sends the same transactions. Stories are spec #1's numbers.

The last three columns record the proof. **Screen test**: the file under `app/src/` (`*.test.tsx`) that renders the screen over a stand-in SDK and checks its text and its SDK call. **Testnet journey**: the step of `app/journeys/web-testnet.journey.ts` that did it live on `sats-jar-dev-2.testnet`; the passing run is `evidence/web-testnet.json` (every step, with its transaction). **Walk**: "journey" is the same journey run twice, in Chromium at desktop width and at a phone's width with touch (`evidence/web-testnet-phone.json`), driving each screen with the console checked; "in-app" is a walk in the in-app browser at desktop and phone width.

Not proven yet: the "Counted" top-up and "Paid" allowance states on testnet (rows 12, 13), since no test device holds a funded jar; their screen tests use the SDK's real answers for `sats-jar-dev.testnet` jar 1. The phone-width run reused the child's phone from the desktop run, so it skipped the restore (row 18), which needs the phrase shown at set-up; the desktop run did it.

## People's actions and reads

| # | Action | Persona | SDK call | Stories | Screen | Screen test | Testnet journey | Walk |
|---|---|---|---|---|---|---|---|---|
| 1 | Set up this device with a PIN | giver, guardian | `device.setUp` | 1, 2, 32 | PIN gate | pin-gate | journey ✓ | journey |
| 2 | Unlock with the PIN (wrong PIN refused) | everyone | `device.unlock`, `device.state` | 2 | PIN gate | pin-gate | journey ✓ | journey |
| 3 | Lock the app | everyone | `device.lock` | 2 | header | pin-gate | journey ✓ | journey |
| 4 | Start a jar: nickname, 2 or 3 guardians | giver | `invites.start` | 10, 12 | `/new` | giver | journey ✓ | journey |
| 5 | See the invite links and who joined | giver | `invites.mine`, `invites.progress` | 10 | `/draft/:id`, home | giver, home | journey ✓ | journey |
| 6 | See what an invite is for | guardian | `invites.preview` | 32 | `/join/:token` | giver | journey ✓ | journey |
| 7 | Join as a guardian (a used link refused) | guardian, giver | `invites.join` | 11, 32 | `/join/:token`, `/draft/:id` | giver | journey ✓ (a used link) | journey |
| 8 | Create the jar (every create refusal readable) | giver | `jars.create` | 4–9, 13, 40b | `/draft/:id` | giver | journey ✓: 6 refusals and a real create; PERIOD_TOO_SHORT and TOO_FEW_GUARDIANS can't be sent from the screens | journey |
| 9 | List my jars | everyone | `jars.mine` | 17, 60 | home | home | journey ✓ | in-app (new device), desktop and phone; journey |
| 10 | See a jar: balance, picture, settings, allowance, exit, Demo timing | family | `jars.status` | 14, 17, 22–25, 53, 60–62 | `/jar/:id` | jar-page | journey ✓ (an empty demo jar; UNKNOWN_JAR) | journey |
| 11 | Top up by QR code and address | giver, relative | `jars.status` (`qrPayload`) | 13, 15 | `/jar/:id`, `/proof/:id` | jar-page, proof-page | journey ✓ (QR shown) | in-app (public record), desktop and phone; journey |
| 12 | See top-ups and how far each has got | family | `jars.topUps` | 16, 18, 20 | `/jar/:id` | jar-page, on recorded live data | empty state only: no test device holds a funded jar | journey (empty) |
| 13 | See allowances and how far each has got | family | `jars.allowances` | 22, 26, 30, 31 | `/jar/:id` | jar-page, on recorded live data | empty state only: no test device holds a funded jar | journey (empty) |
| 14 | Propose an emergency payment | guardian | `emergency.propose` | 33, 34, 37 | `/jar/:id` | emergency-handover | journey ✓ | journey |
| 15 | Approve it | guardian | `emergency.approve` | 35 | `/jar/:id` | emergency-handover | journey ✓ | journey |
| 16 | Cancel it during the delay (a guardian refused) | giver | `emergency.cancel` | 38 | `/jar/:id` | emergency-handover | journey ✓ (the giver's cancel; NOT_THE_GIVER can't be sent: no cancel is offered) | journey |
| 17 | Set up a phone with a recovery phrase (wrong words refused) | child, new holder | `child.startSetUp`, `child.finishSetUp` | 41–45, 58a | `/jar/:id/set-up`, `/receive` | child, holder | journey ✓ (wrong words refused) | journey |
| 18 | Restore the child's phone from the phrase | child | `child.restore` | 43 | `/restore` | child | journey ✓ | journey |
| 19 | Show the code the guardians check | child | `child.guardianCode` | 46 | `/jar/:id/set-up`, `/jar/:id` | child, emergency-handover | journey ✓ | journey |
| 20 | Claim the jar | child | `child.claim` | 41, 46 | `/jar/:id/set-up` | child | journey ✓ (claim, re-claim) | journey |
| 21 | Check the child's code | guardian | `handover.check` | 46, 47 | `/jar/:id` | emergency-handover | journey ✓ | journey |
| 22 | Confirm the claim | guardian | `handover.confirm` | 47 | `/jar/:id` | emergency-handover | journey ✓ | journey |
| 23 | Cancel the claim | guardian, child | `handover.cancel` | 48, 49 | `/jar/:id` | emergency-handover | journey ✓ | journey |
| 24 | Follow the handover to done | family, child | `jars.status` (`handover`) | 50, 51, 53a, 53b, 54 | `/jar/:id` | emergency-handover | journey ✓ (keeper pressed) | journey |
| 25 | Spend the jar's Bitcoin | holder | `holder.spend` | 55 | `/jar/:id` | holder | journey ✓ (INSUFFICIENT_BALANCE) | journey |
| 26 | Show my receive code | new holder | `holder.receiveCode` | 56, 58a | `/receive` | holder | journey ✓ | journey |
| 27 | Start a transfer to a receive code | holder | `holder.startTransfer` | 56, 58 | `/jar/:id` | holder | journey ✓ | journey |
| 28 | Cancel the transfer | holder | `holder.cancelTransfer` | 56 | `/jar/:id` | holder | journey ✓ | journey |
| 29 | Accept the transfer with my own key | new holder | `holder.acceptTransfer` | 57, 58a, 59 | `/jar/:id/accept` | holder | journey ✓ | journey |
| 30 | Try an early spend: refused | anyone | `tryIt.earlySpend` | 40a | `/proof/:id` | proof-page | journey ✓ | journey |
| 31 | Try a spend after handover without holding the jar: refused "not the holder" | giver, anyone | `tryIt.afterHandover` | 52 | `/proof/:id` | proof-page | journey ✓ (NOT_THE_HOLDER) | journey |
| 32 | Try an outsider's approval: refused | anyone | `tryIt.outsiderApproval` | 36 | `/proof/:id` | proof-page | journey ✓ (NOT_A_GUARDIAN) | journey |
| 33 | See a jar's public record, no sign-in | anyone | `@sats-jar/proof` (`jar`, `nearTransactions`, `bitcoinTransactions`) | 69, 70, 71 | `/proof/:id` | proof-page | journey ✓ | in-app, desktop and phone; journey |

## Command line only

| Action | Who | Contract method | Why there is no screen |
|---|---|---|---|
| Prove a top-up | keeper | `prove_topup` | The keeper proves every top-up within about 2 minutes of its 3rd confirmation on the light client (backend README); no person has a proof to submit. |
| Pay the period's allowance | keeper, anyone | `request_allowance` | The keeper pays it each period. Story 29's "anyone can trigger it" holds on chain: the method takes no account check, so anyone can call it from the command line. The SDK has no screen method for it. |
| Retry signing, rebuild a witness, confirm a payment | keeper | `retry_signing`, `rebuild_witness`, `confirm_payment` | Plumbing behind every payment; the jar page shows each payment's status instead. |
| Send an emergency payment after its delay | keeper | `execute_emergency` | Anyone may call it once the delay ends; the keeper does. |
| Complete the handover, move later batches of a transfer, sweep strays | keeper | `complete_handover`, `accept_transfer` (later batches), `rehome_stray` | Anyone may call them; the keeper does. The jar page shows the progress. |
| Run the keeper now | operator | `POST /keeper/run` | Operations, not a person's action. The testnet journey presses it where the SDK check called `complete_handover` itself. |
| Deploy, lock and check the contract | operator | `scripts/locked-deploy.sh` | Done once (evidence/locked-deploy.json). |
| Plain NFT transfer and approval | nobody | `nft_transfer`, `nft_transfer_call`, `nft_approve` | Refused before handover by the contract; after handover a jar changes hands only through a transfer (row 27). |
