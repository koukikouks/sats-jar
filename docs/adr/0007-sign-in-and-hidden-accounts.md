# Sign in with a passkey; keys stay on the user's device

> Amended by ADR 0009: keys are made on the device and unlocked with Face ID or a PIN; the child's account also gets a recovery phrase, and no server stores any blob for it.
> Amended by ADR 0009 on gas: the sponsor funds every person's account with a little NEAR, and nothing is relayed as a meta-transaction.

Users must never see NEAR (ADR 0004), yet the child's account holds the jar and at unlock its holder controls the Bitcoin, so no server of ours may hold a usable key to it. Givers, parents and guardians sign in with a passkey (Face ID, fingerprint or device PIN). The app creates each person's NEAR account behind the scenes; the account's key is generated on the device and encrypted with the passkey (WebAuthn PRF), so the app's server stores at most a blob it cannot use. The app pays every NEAR fee through a sponsor account whose key can pay gas but cannot move a jar's coins or change its rule. Guardians join from an invite link.

## Considered Options

- Email login with server-held or custodial keys: simplest, but the app would hold the keys to every jar at unlock. Rejected (rule 3, R2).
- A NEAR wallet: shows NEAR, wallet pop-ups. Rejected (rule 1).
