# Sats Jar

A piggy-bank NFT that holds a child's real Bitcoin: anyone can top it up, the child gets a capped allowance each period, and the jar's holder gets full control at the unlock date.

## Jar

**Jar**:
One gift of Bitcoin for one child, with its own rule and its own Bitcoin address. The jar is an NFT.
_Avoid_: Vault, wallet, account, piggy bank

**Jar address**:
The native Bitcoin address that belongs to one jar and receives its top-ups.
_Avoid_: Deposit address, wallet address

**Top-up**:
Bitcoin anyone sends to a jar address from any Bitcoin wallet or exchange app. It counts once it is confirmed on Bitcoin.
_Avoid_: Deposit, contribution, donation

**Rule**:
The limits a jar's Bitcoin can move under before unlock: the allowance, the emergency payment, and nothing else.
_Avoid_: Policy, terms, settings

## People

**Giver**:
The person who creates a jar.
_Avoid_: Owner, parent, creator, donor

**Guardian**:
One of the 2–3 people named when a jar is created, who together can approve an emergency payment.
_Avoid_: Trustee, cosigner, approver

**Holder**:
Whoever holds the jar NFT. Until handover that is the family account; from then on it is the child's account, or whoever the child later transfers the jar to.
_Avoid_: Owner

**Family account**:
The account a parent manages that holds a child's jar until handover.
_Avoid_: Parent wallet, custodial account

**Child's account**:
The account the child sets up on their own phone, whose only key is on that phone; nobody else, the app included, can use or recover it.
_Avoid_: Child wallet, sub-account

**Recovery phrase**:
The words the child saves when setting up their account, the only way to restore it without their phone.
_Avoid_: Seed, mnemonic, backup code

**Handover**:
The moment from the unlock date on when, after the guardians confirm the child's account and a public delay passes, the jar moves from the family account to the child's account and its Bitcoin moves to an address that only the child's recovery phrase can recover. Every adult's access ends there.
_Avoid_: Coming of age, graduation, release

**Handover code**:
The digits a child's phone shows after claiming a jar, which each guardian compares in person with the same code read from the chain before confirming the handover.
_Avoid_: Guardian code, PIN, verification code

**Receive code**:
What a new holder's phone gives the person handing them a jar, so the transfer can only go to keys made on that phone.
_Avoid_: Address, invite code

**Child**:
The person the jar is for.
_Avoid_: Beneficiary, recipient, kid

**Child's address**:
The one Bitcoin address a parent registers for the child, the only place the jar can pay before handover.
_Avoid_: Payout address, destination

## Payments

**Allowance**:
A payment to the child's address of at most the cap in one period.
_Avoid_: Withdrawal, drip, payout

**Cap**:
The most the child's address may receive as allowance in one period.
_Avoid_: Limit, max

**Period**:
The stretch of time one allowance belongs to.
_Avoid_: Month, cycle, epoch

**Fee budget**:
The most a jar may spend on Bitcoin fees for allowances in one period: 10% of the cap.
_Avoid_: Fee cap, gas budget

**Emergency payment**:
A capped extra payment to the child's address before unlock that more than one guardian approves and that waits out a public delay during which it can be cancelled.
_Avoid_: Override, early withdrawal

**Unlock date**:
The earliest date the jar can be handed over. The rule keeps running until handover happens.
_Avoid_: Maturity, release date, 18th birthday

**Carry-over**:
Allowance the child did not receive in a period, still available later, with at most three periods' allowance waiting at once.
_Avoid_: Rollover, backlog

**Re-homing**:
Moving all of a jar's Bitcoin to a new jar address when the jar changes hands (at handover, or a later transfer), so the old holder keeps no claim on it.
_Avoid_: Sweep, migration

**Stray**:
A top-up sent to an address the jar has already moved away from. It still counts, and is moved to the jar's current address.
_Avoid_: Orphan, lost deposit

**Bitcoin-only exit**:
The way to take a jar's coins out with Bitcoin alone, open only two years after the unlock date (or, once re-homed, two years after the move), for when NEAR's signing network has stopped. Before handover it goes to the child's address; after, to the child's recovery phrase.
_Avoid_: Recovery, escape hatch, fallback

## Proof

**Proof view**:
The "see how it works" page of a jar: its NFT, its Bitcoin address, and every NEAR and Bitcoin transaction behind it, including refused attempts, with explorer links.
_Avoid_: Explorer, debug view, admin page

**Refusal**:
A request the rule turned down, kept as a failed transaction with a readable reason.
_Avoid_: Error, rejection, failure
