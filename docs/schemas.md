# Schemas: assisted accounts, stakes, the fund and escrow

Design settled 2026-10-23. This file is the specification for the build laid
out in `build-plan.md`, and the paperwork for every table, transaction,
follow-up object and message that build adds. The README describes what is
built today and is brought up to date as part of the build; where the two
disagree before then, this file wins.

## 1. Conventions

- Every object a validator receives is `{ payload, signatures }`, or
  `{ payload, signature }` for a validator-to-validator message. The payload
  is signed as its RFC 8785 canonical bytes, as everything is today.
- Ids are SHA-256 digests: 64 lowercase hex characters on the wire, 32 raw
  bytes (BYTEA) in the database. Base64 is accepted wherever hex is.
- Signatures are P-256 (64 bytes, r||s) and ML-DSA-87 (4627 bytes), hex.
  Follow-up objects never carry public keys: every key comes from the
  accounts table.
- Money is millionths of an anos: decimal strings in JSON, BIGINT in the
  database. Values given in anos below are multiplied by 1,000,000.
- Timestamps are ISO 8601 strings.
- One account signing rule, **any two pairs**, shared by transactions and
  follow-ups: at least two of the three pairs key1/postQuantumKey1,
  key2/postQuantumKey2 and walletKey/walletPostQuantumKey, both halves of
  each pair present, every signature present verifying against the
  account's stored key. Until 2026-11-07 assisted transfers had a rule of
  their own, pair one and the wallet pair (section 20). Since 2026-11-08 a
  second rule, **the break-glass pair**, for the `breakGlassTransfer` and
  its `breakGlassCancel` alone: breakGlassKey/breakGlassPostQuantumKey,
  both present and verifying against `break_glass_pk` and
  `break_glass_pk_pq`, and no signature from the three pairs beside them
  (section 22).
- A transaction waits in a **holding table** until a leader round writes it.
  There are five: `pending`, `locked_transactions`, `assisted_transfers`,
  `escrow_transfers` and `fund_proposals`. All five share: `transaction_id`
  is the primary key; `account_id` is unique, so an account has one
  outstanding transaction at a time; `og_transaction` holds the submission
  exactly as received; `approved` starts false and turns true once every
  validator accepted the transaction. A submission whose transaction id or
  account id is found in any holding table or on the chain is refused.
- A **follow-up** is a signed object attached to a transaction that is
  waiting in a holding table: an attestation, a cancellation (the sender's
  `assistedTransferCancel`, since 2026-11-08 the break-glass pair's
  `breakGlassCancel`, or since 2026-11-11 the sender's
  `lockedTransferCancel` of a guarded or vault transfer, section 28), a
  vote, an escrow signature or verdict. Each is stored in or next to the
  row with its own approved flag and goes round the validators the way a
  transaction does (section 9).
- A row that leaves a holding table is deleted (`pending`,
  `locked_transactions`) or moved whole to `logs` or `archives` (the other
  three; section 7). Since 2026-11-11 a locked transfer that its sender
  cancelled is not deleted: its row moves whole to `logs` (section 28). A
  row still unapproved `UNAPPROVED_AGE_LIMIT_SECONDS` after it was stored
  is dropped by the validator holding it, a plain delete in any of the
  five (section 21).
- Every validator keeps its own copy of every table and does every move to
  logs or archives for itself, at the same logical moment, so the copies
  stay identical.

## 2. Roles and stakes

An account takes a role by staking anos with the fund: a `transferToFund`
naming the purpose (section 4.4). The `stakes` table records, per account,
how much is staked for each purpose. A role is held while the amount for its
purpose is at or above the purpose's minimum. A fund proposal that returns
stake reduces the amount (section 4.5), and the row is deleted when every
amount is zero.

| `stakeFor`  | Column             | Minimum, env variable       | Default | Behaviour today |
| ----------- | ------------------ | --------------------------- | ------: | --------------- |
| `daoVote`   | `dao_vote_stake`   | `STAKE_MIN_DAO_VOTE_ANOS`   |      10 | read by the masterpod for DAO votes (section 23) |
| `moderator` | `moderator_stake`  | `STAKE_MIN_MODERATOR_ANOS`  |   1,000 | recorded only; the pod must be appointed to stake (section 24) |
| `attestor`  | `attestor_stake`   | `STAKE_MIN_ATTESTOR_ANOS`   |   1,000 | attests assisted transfers, arbitrates escrow disputes; the pod must be appointed to stake (section 24) |
| `guardian`  | `guardian_stake`   | `STAKE_MIN_GUARDIAN_ANOS`   |   1,000 | proposes and votes on fund proposals |
| `validator` | `validator_stake`  | `STAKE_MIN_VALIDATOR_ANOS`  |  50,000 | recorded only; the `validators` table is unchanged; the pod must be appointed to stake (section 26) |
| `masterPod` | `master_pod_stake` | `STAKE_MIN_MASTER_POD_ANOS` | 500,000 | recorded only; the pod must be appointed to stake (section 26) |

Minimums are in anos in the env file and apply to the amount of one
`transferToFund`.

Guardian votes: one vote per `GUARDIAN_VOTE_ANOS` (default 1,000 anos) of
guardian stake, rounded down. An account with at least one vote may propose
and vote. The vote itself is in section 5.4, the tally in section 6.

## 3. Tables

Every table has `created_at` and `updated_at` with the `set_updated_at`
trigger, and `COMMENT ON` for the table and each column, as the existing
ones do. `logs` and `archives` have `created_at` only: their rows never
change. None of the new tables has a foreign key, like the existing ones.
All are added with `CREATE TABLE IF NOT EXISTS`, so `npm run db:setup`
adds them to a live database without a reset.

### stakes

```sql
CREATE TABLE IF NOT EXISTS stakes (
  account_id        BYTEA   PRIMARY KEY CHECK (octet_length(account_id) = 32),
  dao_vote_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (dao_vote_stake >= 0),
  moderator_stake   BIGINT  NOT NULL DEFAULT 0 CHECK (moderator_stake >= 0),
  attestor_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (attestor_stake >= 0),
  guardian_stake    BIGINT  NOT NULL DEFAULT 0 CHECK (guardian_stake >= 0),
  validator_stake   BIGINT  NOT NULL DEFAULT 0 CHECK (validator_stake >= 0),
  master_pod_stake  BIGINT  NOT NULL DEFAULT 0 CHECK (master_pod_stake >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

One row per account that has stake. Amounts in millionths. A row is created
by the first `transferToFund` from the account and deleted when a fund
proposal returns the last of its stake. No flags: a role is `column >=
minimum`.

### assisted_transfers

```sql
CREATE TABLE IF NOT EXISTS assisted_transfers (
  transaction_id          BYTEA   PRIMARY KEY CHECK (octet_length(transaction_id) = 32),
  account_id              BYTEA   NOT NULL UNIQUE CHECK (octet_length(account_id) = 32),
  og_transaction          JSONB   NOT NULL,
  approved                BOOLEAN NOT NULL DEFAULT false,
  attestation_1           JSONB,
  attestation_1_approved  BOOLEAN NOT NULL DEFAULT false,
  attestation_2           JSONB,
  attestation_2_approved  BOOLEAN NOT NULL DEFAULT false,
  cancellation            JSONB,
  cancellation_approved   BOOLEAN NOT NULL DEFAULT false,
  future_date             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Pending's twin for assisted transfers and, since 2026-11-08, for break-glass
moves (`breakGlassTransfer`, section 22), told apart by
`og_transaction.payload.transactionType`. `attestation_1` and `attestation_2`
hold whole attestation objects, `{ payload, signatures }` as received, the
first to arrive in slot 1. `cancellation` holds the sender's signed
`assistedTransferCancel`, or on a break-glass row the break-glass pair's
`breakGlassCancel`, while its round runs; once approved on a validator,
that validator moves the row to `logs`. `future_date` is the moment a
break-glass move may be written, its `createdAt` when the sender is a
guarded or vault account; NULL for an assisted transfer and for a move out
of a spending or assisted account. A row with a moment is ready only once it
has passed.

### escrow_transfers

```sql
CREATE TABLE IF NOT EXISTS escrow_transfers (
  transaction_id              BYTEA   PRIMARY KEY CHECK (octet_length(transaction_id) = 32),
  account_id                  BYTEA   NOT NULL UNIQUE CHECK (octet_length(account_id) = 32),
  account_id_to               BYTEA   NOT NULL CHECK (octet_length(account_id_to) = 32),
  og_transaction              JSONB   NOT NULL,
  approved                    BOOLEAN NOT NULL DEFAULT false,
  success_signature           JSONB,
  success_signature_approved  BOOLEAN NOT NULL DEFAULT false,
  cancel_signature            JSONB,
  cancel_signature_approved   BOOLEAN NOT NULL DEFAULT false,
  dispute_signature           JSONB,
  dispute_signature_approved  BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`account_id` is the seller, who sends the anos; `account_id_to` the buyer,
who pays off-chain. The three slots hold the signed objects of section 5.5.

### escrow_arbitrations

```sql
CREATE TABLE IF NOT EXISTS escrow_arbitrations (
  transaction_id         BYTEA   NOT NULL CHECK (octet_length(transaction_id) = 32),
  arbitrator_account_id  BYTEA   NOT NULL CHECK (octet_length(arbitrator_account_id) = 32),
  verdict                TEXT    NOT NULL CHECK (verdict IN ('success', 'cancel')),
  signature              JSONB   NOT NULL,
  approved               BOOLEAN NOT NULL DEFAULT false,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, arbitrator_account_id)
);
```

One row per arbitrator per disputed escrow. `signature` is the whole
`escrowVerdict` object as received. The first verdict to have two approved
rows decides the escrow (section 5.6).

### fund_proposals

```sql
CREATE TABLE IF NOT EXISTS fund_proposals (
  transaction_id   BYTEA   PRIMARY KEY CHECK (octet_length(transaction_id) = 32),
  account_id       BYTEA   NOT NULL UNIQUE CHECK (octet_length(account_id) = 32),
  og_transaction   JSONB   NOT NULL,
  approved         BOOLEAN NOT NULL DEFAULT false,
  vote_closes_at   TIMESTAMPTZ NOT NULL,
  proposer_weight  INTEGER NOT NULL CHECK (proposer_weight >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`account_id` is always the fund's id, so the UNIQUE means one open proposal
at a time. `vote_closes_at` is the proposal's `createdAt` plus
`GUARDIAN_VOTE_MINUTES`. `proposer_weight` is the proposer's votes when the
proposal was stored; the proposer's own vote for is counted from it, so the
proposer has no `guardian_votes` row.

### guardian_votes

```sql
CREATE TABLE IF NOT EXISTS guardian_votes (
  transaction_id       BYTEA   NOT NULL CHECK (octet_length(transaction_id) = 32),
  guardian_account_id  BYTEA   NOT NULL CHECK (octet_length(guardian_account_id) = 32),
  vote                 TEXT    NOT NULL CHECK (vote IN ('for', 'against')),
  weight               INTEGER NOT NULL CHECK (weight >= 1),
  signature            JSONB   NOT NULL,
  approved             BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (transaction_id, guardian_account_id)
);
```

One row per guardian per proposal; `transaction_id` is the proposal's.
`weight` is the guardian's votes at the moment they voted, kept for the
record and used in the tally. `signature` is the whole `guardianVote` object.

### logs and archives

```sql
CREATE TABLE IF NOT EXISTS logs (
  transaction_id  BYTEA   PRIMARY KEY CHECK (octet_length(transaction_id) = 32),
  source          TEXT    NOT NULL,
  outcome         TEXT    NOT NULL,
  account_id      BYTEA   NOT NULL CHECK (octet_length(account_id) = 32),
  record          JSONB   NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- archives: the same columns.
```

Where rows go when they leave `assisted_transfers`, `escrow_transfers` or
`fund_proposals`, and since 2026-11-11 where the row of a cancelled locked
transfer goes when it leaves `locked_transactions` (section 28). `source`
is the table the row left, `outcome` why (section 7), `record` the whole
row as JSON plus its child rows: `{ row }`, `{ row, arbitrations }` or
`{ row, votes }`. Logs may be purged after a time; archives are kept.

### Changes to existing tables

- `garlic_chain_apply_anos_transfer` fires for eight link types:
  `anosTransfer`, `guardedAnosTransfer`, `vaultAnosTransfer`,
  `assistedAnosTransfer`, `escrowTransfer`, `breakGlassTransfer` (since
  2026-11-08, section 22), `transferToFund` and `transferFromFund`. Its
  error messages name `NEW.type` instead of `anosTransfer`.
- The comments on `locked_transactions` no longer say assisted accounts
  have a time lock. They do not.
- `pending`, `garlic_chain`, `accounts` and `validators` are unchanged.

## 4. Transactions

A transaction is `{ payload, signatures }` with `payload.transactionType`
naming its kind. The four existing kinds, `accountCreation`,
`anosTransfer`, `guardedAnosTransfer` and `vaultAnosTransfer`, are
unchanged and documented in the README. Four kinds are added here, and a
fifth, the `breakGlassTransfer`, on 2026-11-08 (4.5, section 22).

Shared by every transfer kind, old and new, unless a section says
otherwise: the transfer payload of the README (`accountId`,
`transactionId`, `previousTransactionId`, `transactionType`, `amount`,
`accountIdTo`, `createdAt`); `transactionId` the SHA-256 of the canonical
payload without itself; `previousTransactionId` the sender's newest chain
link; `accountIdTo` a different, existing account; the uniqueness checks
across the five holding tables and the chain; the balance covering the
amount; the signing rule **any two pairs**; the validator-to-validator
approval and proof messages, with every validator storing the transaction
in the same holding table. Every transfer kind is written as one chain link
with the sender as `account_id`, the receiver as `account_id_to`, the
amount, and the kind as `type`, and the balance trigger moves the amount.
Since 2026-11-11 (section 27) every transfer's date is checked against the
validator's clock when it comes in: `createdAt` of a guarded or vault
transfer is the lock ahead, at least the lock and at most the lock plus
`LOCK_OFFSET_MINUTES`, as before; `createdAt` of every other transfer is
within `LOCK_OFFSET_MINUTES` of now, before or after, where until then it
was not checked at all.

### 4.1 assistedAnosTransfer

Sent from an **assisted** account at `POST /anos-transfer`. Signing rule
**any two pairs**, like every other transfer (section 20). No time lock.
Since 2026-11-11 `createdAt` must be within `LOCK_OFFSET_MINUTES` of the
validator's clock, before or after (section 27); until then it was not
checked. Held in `assisted_transfers`. Ready for a leader round when
approved, both attestations approved, and no cancellation present. After
the write the row moves to `logs` with outcome `written`, attestations
included; the attestations are not written to the chain.

### 4.2 escrowTransfer

Sent from a **spending** account, the seller, to the buyer at
`POST /anos-transfer`. Since 2026-11-11 `createdAt` must be within
`LOCK_OFFSET_MINUTES` of the validator's clock, before or after (section
27); until then it was not checked. Held in `escrow_transfers` with
`account_id_to` filled from the payload. Ready when approved, no cancel
signature present, and either the seller's success signature is approved,
or the dispute signature is approved and two approved verdicts say
`success`. After the write the row moves to `logs`, outcome `written`,
when there was no dispute, or to `archives`, outcome `arbitratedSuccess`,
with its arbitrations, when there was.

### 4.3 transferToFund

Sent from a **spending** account at `POST /transfer-to-fund`. The transfer
payload plus one field:

```
payload: {
  ...the transfer payload, with
  transactionType: "transferToFund"
  accountIdTo:     the fund's account id (the SHA-256 of "anosFund"; the id in src/genesis/fund-account.json)
  stakeFor:        one of daoVote, moderator, attestor, guardian, validator, masterPod
}
signatures: the sender's, any two pairs
```

Extra checks: `accountIdTo` is the fund; `stakeFor` is one of the six;
`amount` is at least the minimum for that purpose. Since 2026-11-11
`createdAt` must be within `LOCK_OFFSET_MINUTES` of the validator's clock,
before or after (section 27); until then it was not checked. Held in
`pending` like a plain transfer and written at the next round as a link of
type `transferToFund`. In the same database transaction the sender's
`stakes` row gets the amount added to the purpose's column, the row
created if the account has none. Nothing else happens: the role follows
from the amount.

Since 2026-11-08 (section 24) a `transferToFund` for `moderator` or
`attestor`, and since 2026-11-10 (section 26) one for `validator` or
`masterPod`, passes one more check, on the receiving validator only, after
the checks above: it asks the masterpod
`POST MASTERPOD_URL/get-anos-account { accountId }` for the sending account
(`src/masterpod/masterpod.client.js`, 5-second timeout, the same call as
the binding check of create-account) and goes on only when the answer
binds the account to a vouched anoPod whose `role` is the `stakeFor`. No
answer, or an account not bound, is refused with
`the masterpod could not confirm the sending account's anoPod`; a bound
anoPod whose `role` is anything else with
`the sending account's anoPod is not appointed as <stakeFor>`. The handler
logs `failed: <reason>` and answers `400 { error }` like any refusal. The
peers approving the stake, the replay of a chain chunk and the held-row
checks do not ask.

### 4.4 fundProposal

A guardian's list of payments from the fund, submitted at
`POST /fund-proposal`, voted on by the guardians for `GUARDIAN_VOTE_MINUTES`,
then written or dropped. The proposal is a transaction like any other: its
id is its `transactionId`, so every receipt and table treats it as one.

```
payload: {
  accountId:       the fund's account id
  guardianId:      the proposer's account id
  transactionType: "fundProposal"
  createdAt:       ISO 8601; at most LOCK_OFFSET_MINUTES before or after the validator's clock
  payouts: [                       at least one
    {
      accountIdTo: the recipient's account id
      amount:      millionths, decimal string, positive
      reason:      free text
      stakeFor:    optional; a purpose, when this payout returns stake
    }, ...
  ]
  transactionId:   the SHA-256 of the canonical payload without transactionId
}
signatures: the proposer's account keys, any two pairs
```

No `previousTransactionId`: the fund cannot sign, its newest link depends
on batch order, and one open proposal at a time plus the unique
`transactionId` already rule out replay and reordering.

Checks, in order: the shape; `accountId` is the fund; `createdAt` within
`LOCK_OFFSET_MINUTES` of now, because the voting window is counted from it;
the proposer's account exists and has at least one guardian vote; the
signatures; `transactionId`; each payout's recipient is an existing account
other than the fund, its amount a positive integer, its `stakeFor`, when
present, a purpose; for each recipient and purpose, that recipient's stake
for the purpose covers the sum of the payouts returning it; the sum of all
amounts is within the fund's balance; the uniqueness checks, which for the
fund mean no open proposal.

Stored in `fund_proposals` with `vote_closes_at = createdAt +
GUARDIAN_VOTE_MINUTES` and `proposer_weight` the proposer's votes now, and
sent round like every transaction. Votes: section 5.4. Tally: section 6.

Written, when the vote passes, as one proposal link followed by one payout
link per payout, in index order, in the round's batch:

- The proposal link: `type` `fundProposal`, `account_id` the fund,
  `account_id_to` null, `amount` 0, `og_transaction` the proposal as
  received, `trans_hash` the hash of its payload.
- Each payout link: `type` `transferFromFund`, `account_id` the fund,
  `account_id_to` the recipient, the amount, and `og_transaction`
  `{ payload }` holding the payout object below. Its `transaction_id` and
  `trans_hash` are the SHA-256 of that object's canonical form. The balance
  trigger moves the amount. For a payout with `stakeFor`, the recipient's
  stake column is reduced by the amount, and the `stakes` row is deleted
  when all six amounts are then zero.

```
payout object: {
  proposalId:      the proposal's transactionId
  index:           the payout's position in payouts, from 0
  accountIdTo, amount, reason, stakeFor (when present)
  transactionType: "transferFromFund"
}
```

The official list names the proposal's `transactionId` only; the payout
links are implied. After the write the row and its votes move to
`archives`, outcome `written`. A proposal whose vote fails moves to
`archives`, outcome `voteFailed`, and nothing is written.

### 4.5 breakGlassTransfer

Added 2026-11-08 (section 22). Sent from an account of **any** of the four
types at `POST /anos-transfer`, by the break-glass pair the account was
created with, once its user keys died with the passkey: the whole balance,
to a new account of the **same type** in the same pod. Signing rule **the
break-glass pair alone**: `breakGlassKey` and `breakGlassPostQuantumKey`
both present and verifying against `break_glass_pk` and `break_glass_pk_pq`,
and no signature from the three user pairs beside them (one rule per
object, no mixing). The receiver must be an existing account of the
sender's type, checked right after the receiver's existence
(`payload.accountIdTo is not an account of the same type as
payload.accountId`); the masterpod checks it again when the moves are
filed. It follows the sender's type's lock: from a guarded or vault account
`createdAt` is checked as the account's own transfers are, at least the
lock and at most the lock plus `LOCK_OFFSET_MINUTES` ahead, and that moment
is kept as `future_date`; from a spending or assisted account `createdAt`
is, since 2026-11-11 (section 27), checked as every transfer without a
lock is, within `LOCK_OFFSET_MINUTES` of the validator's clock, before or
after, and `future_date` stays NULL. Held in `assisted_transfers`.
Ready for a leader round as 4.1, approved, both attestations approved, no
cancellation present, and, when it has one, its moment passed
(`future_date IS NULL OR future_date <= now()`). The write is one link of
type `breakGlassTransfer` with the balance trigger, and in the same
database transaction the sender's `stakes` row moves to the receiver, every
purpose added to the receiver's row (created when it has none) and the
sender's row deleted, so the roles move with the money; the catch-up replay
does the same. After the write the row moves to `logs`, outcome `written`,
as an assisted transfer does. The attestations are the same two, from two
attestors with attestor stake, neither the sender (5.2); the cancel is
either 5.3 by the account's own keys or 5.7 by the break-glass pair.

## 5. Follow-ups

### 5.1 Common rules

Every follow-up is `{ payload, signatures }`:

```
payload: {
  type:          the kind, one of the nine below
  transactionId: the held transaction it attaches to
  <signer>:      the signer's account id, under the field the kind names
  signedAt:      ISO 8601, recorded, not compared with the clock
  ...the kind's own fields
}
signatures: the signer's account keys, any two pairs; a breakGlassCancel the break-glass pair (5.7)
```

Checks every kind runs, in order: the shape; the held row exists in the
kind's table and is approved on this validator; the signer's account exists
and holds the stake the kind requires, if any; the signatures verify against
that account's keys; the kind's own checks; a place to store it. Then the
object is stored with `approved = false` and goes round the validators
(section 9): the originating validator marks it approved once every peer
answered, sends the proof, and each peer marks its copy approved. When a
validator marks a follow-up approved it applies the kind's effect, if the
kind has one. The signer's answer is `202` + `{ transactionId }` once stored
on the originating validator, or `400` + `{ error }`.

A slot or row is **present** once stored, approved or not, and present
blocks. Outcomes need **approved**. Surplus and late follow-ups are refused
with `400` and nothing is stored: a third attestation, a second dispute, a
vote after the window, a second vote or verdict from the same account, a
verdict without a dispute, anything for a transaction no longer held.

Validators identify a follow-up by its `attachmentId`, the SHA-256 of its
canonical payload, which they compute; the signer does not send it.

### 5.2 attestation

```
payload: { type: "attestation", transactionId, accountId, attestorId, signedAt }
```

For an `assistedAnosTransfer` or a `breakGlassTransfer` (4.5). `accountId`
is the transfer's sender and must equal the row's `account_id`. Signer:
`attestorId`, with
`attestor_stake` at or above its minimum. Own checks: `attestorId` is not
`accountId`; `attestorId` is not the attestor in the other slot. Stored in
`attestation_1` if empty, else `attestation_2` if empty, else refused. No
effect on acceptance beyond readiness.

### 5.3 assistedTransferCancel

```
payload: { type: "assistedTransferCancel", transactionId, accountId, signedAt }
```

Signer: `accountId`, the row's `account_id`, the sender. Own checks: the
wait, since 2026-11-11 (section 27.2); no cancellation present. The wait:
an `assistedAnosTransfer` cannot be cancelled while the validators would
still take the same signed transfer in again, that is while its
`createdAt` is no more than `LOCK_OFFSET_MINUTES` behind the validator's
clock. Such a cancel is refused with
`this transfer cannot be cancelled yet`. After the wait the cancel is
accepted until the transfer is written, even when both attestations are
approved; readiness excludes rows with a cancellation present. Stored in
`cancellation`. Effect on acceptance: the validator moves the row to
`logs`, outcome `userCancelled`. Accepted on a break-glass row (4.5) as on
an assisted one, without the wait, which is for an assisted transfer
alone, so an owner who still has their device stops a false move with the
account's own keys under any two pairs (section 22).

### 5.4 guardianVote

```
payload: { type: "guardianVote", transactionId, guardianId, vote, signedAt }
```

`transactionId` is a proposal's. Signer: `guardianId`, with at least one
vote: `weight = floor(guardian_stake / GUARDIAN_VOTE_ANOS) >= 1`. `vote` is
`for` or `against`. Own checks: now is before `vote_closes_at`; `guardianId`
is not the proposer, whose vote for is already counted; no row from this
guardian yet. Stored as a `guardian_votes` row with the weight at this
moment. No effect on acceptance; the tally happens in the round.

### 5.5 escrowSuccess, escrowCancel, escrowDispute

```
payload: { type, transactionId, accountId, signedAt }
```

For an `escrowTransfer`. Signer: `accountId`.

- `escrowSuccess`: the seller, `account_id`. Own checks: no dispute, cancel
  or success present. Stored in `success_signature`. Approved, it makes the
  escrow ready.
- `escrowCancel`: the buyer, `account_id_to`. Own checks: the wait, since
  2026-11-11 (section 27.2); no dispute, success or cancel present. The
  wait: the trade cannot be cancelled while the validators would still
  take the same signed `escrowTransfer` in again, that is while its
  `createdAt` is no more than `LOCK_OFFSET_MINUTES` behind the validator's
  clock. Such a cancel is refused with
  `this trade cannot be cancelled yet`. Stored in `cancel_signature`.
  Effect on acceptance: the row moves to `logs`, outcome
  `receiverCancelled`.
- `escrowDispute`: the seller or the buyer. Own checks: no success, cancel
  or dispute present. Stored in `dispute_signature`. From then on only
  verdicts move the escrow.

Between success and cancel the first stored wins, since each blocks the
other.

### 5.6 escrowVerdict

```
payload: { type: "escrowVerdict", transactionId, arbitratorId, verdict, signedAt }
```

Signer: `arbitratorId`, with `attestor_stake` at or above its minimum.
`verdict` is `success` or `cancel`. Own checks: the dispute signature is
approved; `arbitratorId` is neither `account_id` nor `account_id_to`; no row
from this arbitrator yet. Stored as an `escrow_arbitrations` row. Effect on
acceptance: when two approved rows say `cancel`, the row and its
arbitrations move to `archives`, outcome `arbitratedCancel`. When two
approved rows say `success`, the escrow is ready (section 6).

### 5.7 breakGlassCancel

```
payload: { type: "breakGlassCancel", transactionId, accountId, signedAt }
```

Added 2026-11-08 (section 22), at `POST /break-glass-cancel`. For a
`breakGlassTransfer` (4.5). Signer: `accountId`, the row's `account_id`,
the sender, under the rule **the break-glass pair alone** instead of any
two pairs: the kind names its rule and the common signature check uses it.
No stake. Own checks: the row's transaction is a `breakGlassTransfer`
(`not a break-glass transfer`); no cancellation present. Accepted until the
move is written, even when both attestations are approved. Stored in
`cancellation`, the slot 5.3 uses. Effect on acceptance: the validator
moves the row to `logs`, outcome `userCancelled`. No wallet page offers it
yet; the owner's dispute path is a later plan.

### 5.8 lockedTransferCancel

```
payload: { type: "lockedTransferCancel", transactionId, accountId, signedAt }
```

Added 2026-11-11 (section 28), at `POST /locked-transfer-cancel`. For a
`guardedAnosTransfer` or a `vaultAnosTransfer` waiting in
`locked_transactions`. Signer: `accountId`, the row's `account_id`, the
sender, under any two pairs. No stake. Own checks, in this order: the
signer is the sender (`payload.accountId is not the transfer's sender`);
the wait (section 27.2); no cancellation present
(`a cancellation is already present`). The wait: the transfer cannot be
cancelled while the validators would still take the same signed transfer
in again, that is while its `createdAt` is still at least its lock ahead
of the validator's clock. Such a cancel is refused with
`this transfer cannot be cancelled yet`. The wallet dates a transfer the
lock plus `LOCK_OFFSET_MINUTES` ahead, so the wait is the offset after
sending. After the wait the cancel is accepted until the transfer is
written: through its lock, and after it until a leader round writes the
transfer; readiness excludes rows with a cancellation present. Stored in
`cancellation`, a column of `locked_transactions` since this section, with
its flag `cancellation_approved`. Effect on acceptance: the validator
moves the row to `logs`, outcome `userCancelled`.

## 6. The leader round

Unchanged in shape: ready announcement, every validator's ready list, the
official list as the ids every list holds, the write, the final
declaration. What changes is the ready list and the write.

Each validator's ready list, in id order:

| Table                 | Ready when |
| --------------------- | ---------- |
| `pending`             | approved |
| `locked_transactions` | approved, `future_date <= now()`, `cancellation IS NULL` (since 2026-11-11, section 28) |
| `assisted_transfers`  | approved, `attestation_1_approved`, `attestation_2_approved`, `cancellation IS NULL`, and `future_date IS NULL OR future_date <= now()` (a break-glass move's moment, section 22) |
| `escrow_transfers`    | approved, `cancel_signature IS NULL`, and `success_signature_approved` or (`dispute_signature_approved` and at least two approved `success` verdicts) |
| `fund_proposals`      | approved, `vote_closes_at <= now()`, and the tally passes |

The tally: `for = proposer_weight + sum(weight)` over approved `for` votes;
`against = sum(weight)` over approved `against` votes; the proposal passes
when `for * 100 >= GUARDIAN_VOTE_PERCENT * (for + against)`. Guardians who
did not vote count for nothing. A closed proposal that fails is moved to
`archives`, outcome `voteFailed`, by the validator that finds it while
building its list.

The write, one database transaction per validator, rows in id order:

- `accountCreation`: as today.
- `anosTransfer`, `guardedAnosTransfer`, `vaultAnosTransfer`,
  `assistedAnosTransfer`, `escrowTransfer`: one link, the balance trigger.
- `breakGlassTransfer`: one link, the balance trigger, the sender's stakes
  row moved to the receiver (section 22).
- `transferToFund`: one link, the balance trigger, the stake added.
- `fundProposal`: the proposal link, then the payout links in index order,
  the balance trigger for each, the stakes reduced for payouts with
  `stakeFor`, rows at zero deleted.
- `record_hash` chains over every link written, as today.

After the batch: `pending` and `locked_transactions` rows are deleted as
today; `assisted_transfers` rows move to `logs`, outcome `written`;
`escrow_transfers` rows move to `logs`, outcome `written`, or to `archives`,
outcome `arbitratedSuccess`, when a dispute signature is present;
`fund_proposals` rows move to `archives`, outcome `written`, with their
votes.

No timer anywhere: a locked transfer, a closed vote or a completed escrow
waits for the next round, which the next transaction of any kind starts.

## 7. Logs and archives

| Table      | Source               | Outcome             | When |
| ---------- | -------------------- | ------------------- | ---- |
| `logs`     | `locked_transactions` | `userCancelled`    | the sender's cancellation approved (since 2026-11-11, section 28) |
| `logs`     | `assisted_transfers` | `written`           | after the round wrote it |
| `logs`     | `assisted_transfers` | `userCancelled`     | the sender's cancellation approved |
| `logs`     | `escrow_transfers`   | `written`           | written with no dispute |
| `logs`     | `escrow_transfers`   | `receiverCancelled` | the buyer's cancel approved |
| `archives` | `escrow_transfers`   | `arbitratedSuccess` | written after a dispute; `record` carries the arbitrations |
| `archives` | `escrow_transfers`   | `arbitratedCancel`  | two approved cancel verdicts; with the arbitrations |
| `archives` | `fund_proposals`     | `written`           | after the round wrote it; `record` carries the votes |
| `archives` | `fund_proposals`     | `voteFailed`        | the vote closed and failed; with the votes |

Each move is one database transaction: the insert into `logs` or `archives`
from the row and its children, then their deletion. A written row of
`pending` or `locked_transactions` is not logged: the chain holds
everything it had. A cancelled locked transfer is, since 2026-11-11: its
row moves to `logs` (section 28).

Purging logs is not built. The README gives the one-line delete for rows
older than a month; how it runs is decided later. Archives are never purged.

## 8. Endpoints

Public, called by wallets and by attestors, guardians and arbitrators
through their wallets:

| Method | Path                       | Takes |
| ------ | -------------------------- | ----- |
| POST   | `/create-account`          | `accountCreation` (unchanged) |
| POST   | `/anos-transfer`           | `anosTransfer`, `guardedAnosTransfer`, `vaultAnosTransfer`, `assistedAnosTransfer`, `escrowTransfer`, `breakGlassTransfer` (4.5) |
| POST   | `/transfer-to-fund`        | `transferToFund` |
| POST   | `/fund-proposal`           | `fundProposal` |
| POST   | `/attestation`             | `attestation` |
| POST   | `/assisted-transfer-cancel`| `assistedTransferCancel` |
| POST   | `/locked-transfer-cancel`  | `lockedTransferCancel` (5.8, since 2026-11-11) |
| POST   | `/break-glass-cancel`      | `breakGlassCancel` (5.7) |
| POST   | `/guardian-vote`           | `guardianVote` |
| POST   | `/escrow-signature`        | `escrowSuccess`, `escrowCancel`, `escrowDispute`, `escrowVerdict`, by `payload.type` |

Every one answers `202` + `{ transactionId }` once the object is stored on
the validator called and has been sent round, or `400` + `{ error }`. The
`202` is still the placeholder for the wallet's final answer.

Account level (added 2026-10-25 for the wallet; the wallet spec, section
5.3 and 5.4 of `~/Desktop/Z/web_app/docs/schemas.md`, is the spec): an
account signing with pair one, or since 2026-11-08 with its break-glass
pair, reads about itself. The envelope is
`{ payload: { accountId, path, timestamp, nonce, body }, signatures: { ecdsa,
mldsa } }`, checked by `src/auth/require-account.js`: the shape (`400 bad
request shape`), the path (`401 path mismatch`), the timestamp within
`TIMESTAMP_WINDOW_SECONDS` (`401 timestamp outside window`), the account
(`400 invalid accountId`, `401 unknown account`, `401 bad signature` against
`public_key1` and `public_key_pq1`, or failing that against `break_glass_pk`
and `break_glass_pk_pq`, so a recovered person reads an account whose user
keys are gone with the seed the bankers delivered, section 22), the nonce
(`400 invalid nonce`, `401 replay`; the new `nonces` table, the
keyholder's). Every held-transfer read below answers `type`, the payload's
`transactionType`, since 2026-11-08.

| Method | Path                 | Answers |
| ------ | -------------------- | ------- |
| POST   | `/get-account`       | `200 { accountId, type, balance: millionths as a decimal string, latestTransactionId: hex \| null, createdAt, stakes: { daoVote, moderator, attestor, guardian, validator, masterPod }, guardianVotes }`; `latestTransactionId` is the link with the highest `position` whose `account_id` is the signer; `stakes` the signer's six amounts in millionths as decimal strings, `"0"` each when it has no `stakes` row, and `guardianVotes` its votes on fund proposals, `floor(guardian / GUARDIAN_VOTE_ANOS)`, a number (added 2026-11-08, section 25) |
| POST   | `/list-transactions` | body `{ beforePosition?, limit? (default 50, at most 200), from?, to? (ISO 8601; added 2026-11-06, section 18.3) }`; `200 { transactions: [ { transactionId, position, type, accountId, accountIdTo, amount, createdAt } ], pending: [ { transactionId, type, accountId, accountIdTo, amount, createdAt, approved } ] }`, the links where the signer sent or received, `position` descending, with `createdAt` at or after `from` and before `to` when given, and its pending row (at most one) read from `og_transaction.payload`, not cut by the dates |
| POST   | `/list-escrows`      | body `{}`; `200 { escrows: [ { transactionId, type, accountId, accountIdTo, amount, createdAt, stage, disputedBy, verdicts: [ { verdict, approved } ] } ] }`, the signer's open escrow trades as seller or buyer, newest first, at most 200 (added 2026-11-05, section 16) |
| POST   | `/get-assisted-transfer` | body `{}`; `200 { transfer: { transactionId, type, accountId, accountIdTo, amount, createdAt, stage, attestations, unlocksAt } \| null }`, the signer's own held assisted transfer or break-glass move, the `assisted_transfers` row whose `account_id` is the signer (at most one), or `null` when there is none (added 2026-11-06, section 17; `type`, `unlocksAt` and the `locked` stage 2026-11-08, section 22) |
| POST   | `/get-locked-transfer` | body `{}`; `200 { transfer: { transactionId, type, accountId, accountIdTo, amount, createdAt, unlocksAt, stage } \| null }`, the signer's own locked transfer, the `locked_transactions` row whose `account_id` is the signer (at most one), a guarded or vault transfer waiting out its time lock, or `null` when there is none (added 2026-11-06, section 18) |

Public, unsigned (added 2026-11-08: one read for the DAO voting ledger on
the masterpod, section 23, the first route of the kind, and two more the
same day for the wallet's Guardians page, section 25): reads with no
envelope, no signature and no middleware. The body must be an object (`400
bad request shape`). Everything they answer is the fund's public business:
each `transferToFund` link names its purpose on the chain, a written
proposal's payouts are on the chain as `transferFromFund` links, and the
votes are the guardians' public act on the fund's money.

| Method | Path                 | Answers |
| ------ | -------------------- | ------- |
| POST   | `/list-dao-stakes`   | body `{}`; `200 { asOf, total, stakes: [ { accountId, daoVoteStake } ] }`: every `stakes` row with `dao_vote_stake > 0`, `accountId` hex, `daoVoteStake` millionths as a decimal string, account id ascending; `total` their sum as a decimal string (`"0"` with no rows); `asOf` the server clock at the read, ISO 8601. Read by the masterpod for its snapshot of DAO voting weights |
| POST   | `/list-fund-proposals` | body `{ status: 'open' \| 'decided', limit?, offset?, from?, to? }`; `200 { settings, proposals: [ item ] }`: for `open` the `fund_proposals` rows (at most one), for `decided` the `archives` rows that left `fund_proposals`, newest first, `limit` default 20 at most 200, after `offset` rows, with `created_at` at or after `from` and before `to` when given; `settings` the validator's `{ anosPerVote, minimumStake, percent, minutes }`; an `item` the proposal with its status, its tally and its votes (section 25.1). Bad values are `400 invalid status`, `invalid limit`, `invalid offset`, `invalid from` and `invalid to` |
| POST   | `/get-fund-proposal` | body `{ transactionId: hex }`; `200 { settings, proposal }`, the item plus `proposerWeight` and `payouts: [ { index, accountIdTo, amount, reason, stakeFor } ]`, looked for in `fund_proposals` first, then in `archives`; `400 invalid transactionId` unless 64 hex characters; `404 unknown proposal` |

`/create-account` gained a fifth check after uniqueness, on the receiving
validator only: the masterpod is asked `POST /get-anos-account { accountId }`
(`src/masterpod/masterpod.client.js`, 5-second timeout) and the submission
passes only on a `200` with a 32-byte `anopodId` and `vouched` true.
Anything else refuses it with `400 { error: "bad request" }` and no log
line.

Validator to validator: the five existing endpoints, plus
`/attachment-approval` and `/proof-of-attachment-acceptance` (section 9);
since 2026-11-07 also `/chain-links`, the chain chunk read, and, with step 2
of the catch-up build, `/ignore-vote`, `/proof-of-ignore-vote`,
`/no-answer-report`, `/join-request`, `/held-rows` and `/ready` (section 19).

## 9. Validator-to-validator messages

The transaction messages are unchanged: `transactionApproval` answered by
`transactionApproved`, `proofOfTransactionAcceptance` answered by
`transactionAccepted`, and the three leader calls. The receiver of a
transaction approval picks the checks by `payload.transaction.payload.
transactionType`, now one of nine kinds (the `breakGlassTransfer` since
2026-11-08, section 22), and stores the transaction in the
same holding table the originating validator used. The proof's receiver
looks for the transaction across the five holding tables.

Every follow-up goes round with one new pair of messages, whatever its
kind. The receiver picks the checks by `attachment.payload.type`.

`POST /attachment-approval`:

```
payload: {
  attachment:           the follow-up exactly as received ({ payload, signatures })
  type:                 "attachmentApproval"
  originatingValidator: the id of the validator the signer sent it to
  transactionId:        the held transaction's id, as the attachment names it
  attachmentId:         the SHA-256 of the attachment's canonical payload, hex
  sentAt:               ISO 8601
}
signature: { key }
```

The receiver checks the shape; that `originatingValidator` is an active
validator whose key verifies the signature; that `attachmentId` is the hash
of the embedded payload; runs the kind's checks (section 5) against its own
database; stores the follow-up with `approved = false`; and answers `200`
with:

```
payload: {
  transactionId, attachmentId
  type:          "attachmentApproved"
  validatorFrom: the id of the validator that was called
  validatorTo:   the id of the originating validator
  sentAt:        ISO 8601
}
signature: { key }
```

`POST /proof-of-attachment-acceptance`, sent once every peer answered and
the originating validator marked its own copy approved:

```
payload: {
  transactionId, attachmentId
  type:                 "proofOfAttachmentAcceptance"
  originatingValidator: the originating validator's id
  sentAt:               ISO 8601
  receipts:             [ { payload, signature }, ... ]  the approved receipts, untouched, by validator id
}
signature: { key }
```

The receiver checks the shape, the originating validator's signature, that
it holds this attachment for this transaction unapproved, each receipt (an
active validator other than the originating one, genuinely signed, addressed
to the originating validator, for this transaction and attachment, no
validator twice), and that no active validator is missing. Then it marks the
attachment approved, applies the kind's effect, and answers `200` with:

```
payload: {
  transactionId, attachmentId
  type:          "attachmentAccepted"
  validatorFrom, validatorTo, sentAt
}
signature: { key }
```

Both receipts are checked by the originating validator as the transaction
receipts are: a `200`, the shape, the signature against the peer's registry
key, `validatorFrom`, `validatorTo`, `transactionId` and `attachmentId`.

After a follow-up is accepted, the handlers call `runLeader()` as the
transaction handlers do: it may have completed a transfer.

Since the catch-up build (2026-11-07, section 19): every send goes to the
counted peers and every message above is accepted from a counted validator
only; no answer within the timeout is told apart from a refusal; the same
approval or proof twice answers the same receipt; and the chain chunk read,
`chainLinks` answered by `chainLinksList`, is a new pair (19.2), with six
more in step 2.

## 10. Environment variables

Added to every `.env-validatorN` and to `.env-validator.example`, checked
at boot by `src/config/env.js` as positive integers.

| Variable                    | Local | Production | Meaning |
| --------------------------- | ----: | ---------: | ------- |
| `STAKE_MIN_DAO_VOTE_ANOS`   |    10 |         10 | least `transferToFund` for `daoVote`, in anos |
| `STAKE_MIN_MODERATOR_ANOS`  | 1,000 |      1,000 | for `moderator` |
| `STAKE_MIN_ATTESTOR_ANOS`   | 1,000 |      1,000 | for `attestor`; also the stake an attestor or arbitrator must hold |
| `STAKE_MIN_GUARDIAN_ANOS`   | 1,000 |      1,000 | for `guardian` |
| `STAKE_MIN_VALIDATOR_ANOS`  | 50,000 |    50,000 | for `validator` |
| `STAKE_MIN_MASTER_POD_ANOS` | 500,000 |  500,000 | for `masterPod` |
| `GUARDIAN_VOTE_ANOS`        | 1,000 |      1,000 | guardian stake per vote, in anos |
| `GUARDIAN_VOTE_PERCENT`     |    70 |         70 | share of the votes cast a proposal needs |
| `GUARDIAN_VOTE_MINUTES`     |     1 |     10,080 | how long a proposal is open for votes |

The existing `GUARDED_LOCK_MINUTES`, `VAULT_LOCK_MINUTES` and
`LOCK_OFFSET_MINUTES` keep their meaning; `LOCK_OFFSET_MINUTES` also bounds
how far a proposal's `createdAt` may be from the validator's clock. Since
2026-11-11 (section 27) it also bounds the date of every transfer without
a lock: the `createdAt` of a plain, an assisted and an escrow transfer, of
a `transferToFund` and of a break-glass move out of a spending or assisted
account must be within `LOCK_OFFSET_MINUTES` of the validator's clock,
before or after. Through that it is also how long the sender's cancel of
an assisted transfer and the buyer's cancel of an escrow trade wait.

Added 2026-10-25 for the wallet, both optional, read through
`optionalInteger` and a default like the masterpod's, so the five env files
need no edit:

| Variable                   | Default                 | Meaning |
| -------------------------- | ----------------------- | ------- |
| `MASTERPOD_URL`            | `http://localhost:3100` | where `/get-anos-account` is asked: the binding check of create-account and, since 2026-11-08, the appointment check of a moderator or attestor stake (section 24), since 2026-11-10 also of a validator or masterPod stake (section 26) |
| `TIMESTAMP_WINDOW_SECONDS` | `120`                   | the window of a signed account-level request, each way; nonces live twice this long |

Since the testnet build (2026-10-27) these live in two files, the committed
`network/testnet.env` and the machine file `.env`, and `MASTERPOD_URL` is
required: section 14.

## 11. Notes from the build (2026-10-23)

What the build settled that the sections above leave open, and the one
wrinkle it found. Everything else was built as written.

- **Holding table names in code.** The registry
  (`src/held-transactions/held-transactions.js`) keys the five tables by
  their table names, and every verify function returns `heldIn` as one of
  them. `verifyAnosTransfer` also returns `accountIdTo`, which
  `escrow_transfers.account_id_to` needs; an account creation's `heldIn` is
  added by the validators' dispatch, since `verifyCreateAccount` is
  unchanged.
- **Rows leave the three new holding tables only by moving** (section 7).
  No plain delete exists for `assisted_transfers`, `escrow_transfers` or
  `fund_proposals`; `records.queries.js` deletes inside each move.
- **The `record` column** of `logs` and `archives` holds the rows as
  PostgreSQL's `to_jsonb` renders them: bytes in its hex text form
  (`\x` followed by hex), timestamps as ISO 8601, JSONB columns as they are.
  The timestamps differ between validators; everything else is identical.
- **Two verdicts each way** (section 5.6). When two approved `cancel`
  verdicts arrive after two approved `success` verdicts already made the
  escrow ready, nothing moves: the first verdict to reach two decides, and a
  success decision waits for the round. Verdicts keep being accepted until
  the row leaves the table.
- **Reasons.** A follow-up for a transaction the kind's table does not hold
  is refused with `no <table> transaction with this transactionId`; one for
  a transaction not yet approved here with `this transaction is not approved
  yet`. The holding tables' conflict reasons are `a transaction with this
  transactionId is already held in <table>` and `a transaction for this
  accountId is already held in <table>`; for the fund, `a proposal with this
  transactionId is already open` and `a fund proposal is already open`.
- **Settings in code.** `env.stakes.minimums` and
  `env.guardianVote.anosPerVote` are the anos from the env file converted to
  millionths once, as BigInt; `env.guardianVote.percent` and `minutes` are
  plain integers.
- **The web app** takes stake and payout amounts in whole anos and sends
  millionths; every other transfer keeps the hard-coded 1 anos.
- **The chain's tail after a proposal, and its fix.** `findTail` used to
  pick the newest link by `created_at`, then `transaction_id`. Links of one
  batch share a `created_at`, and a batch is written in id order, so the
  tail was always the last link written. A proposal's payout links take
  their own ids (the hash of the payout object) and are written right after
  the proposal link, out of id order, so after a batch holding a proposal
  the next batch could chain its `record_hash` on a payout link rather than
  on the last link written. Fixed the same day, outside the approved list
  with the user's go-ahead: `garlic_chain` gained `position`, a number that
  counts up with every insert, and both `findTail` and
  `findLatestTransactionId` order by it. The chain of record hashes now
  follows `position`, which is the write order on every validator.

## 12. Notes from the wallet build (2026-10-25)

Step 2 of `~/Desktop/Z/web_app/docs/build-plan.md`, built as its spec says
(sections 5.1 to 5.4 there). What it settled:

- **Where check 5 lives.** `verifyCreateAccount` is shared with the
  validator-to-validator approval path (`validators.service.js`
  `verifyTransaction`), and only the receiving validator may ask the
  masterpod, so the binding check runs in `receiveCreateAccount`, right
  after `verifyCreateAccount` and before the pending insert. It returns
  `{ ok: false, reason: 'bad request', dropped: true }`, and the
  `/create-account` handler answers a `dropped` result without logging.
- **The copied files' dependency.** `common-checks.js` and
  `require-account.js` answer through the keyholder's `ok / refuse / answer`
  shape, so `src/util/result.js` came along as a copy. The submission routes
  keep their own shape. `require-account.js` reads the account's pair one
  with `transfer.queries.js` `findAccount`, the lookup every transfer uses.
- **The nonces table** was applied to the live `anos1` to `anos5` with
  `psql` as the superuser under `SET ROLE anossoftware`, the same statements
  `db/schema.sql` now holds, so `npm run db:setup` finds it in place.
- **Positions** come back as JSON integers (`Number(position)`); every
  amount stays a decimal string.
- **Checked** by `test/rig.mjs` (34 checks): it boots a validator of its own
  on 3009 against `anos1` with its settings in the environment and a
  throwaway key, signs as the OG account with the keys file on the Desktop,
  and checks both reads, paging, every refusal of 5.3 with its reason, and
  the silent `400 bad request` of a creation the masterpod does not know,
  with the validator's output captured to show nothing was logged. The
  positive path of the binding check is step 8's.


## 13. The attestor reads (2026-10-26)

Design settled 2026-10-26 (`~/Desktop/Z/forclaude/attestor.md`). The
attestor edition of the wallet (wallet spec section 13) needs to know which
assisted transfers wait for attestations and which escrows are in dispute.
The two reads of section 8 answer only about the signer; these two answer
about other people's held transactions, to an account that holds attestor
stake. The masterpod stays off the anos database. Built by
`~/Desktop/Z/forclaude/attestor-build-1-validators-and-keyholders.md`.

### 13.1 The gate

Account level (section 8, `src/auth/require-account.js`), then the stake:
`stakes.attestor_stake` at or above `STAKE_MIN_ATTESTOR_ANOS` for the
signer (`stakes.service.js` `holdsRole(stake, ATTESTOR)`), else `403 not
an attestor`. The same rule the attestation and verdict follow-ups apply to
their signer (5.2, 5.6). `requireAttestor = [requireAccount,
mustHoldAttestorStake]` in a new `src/auth/require-attestor.js`; the two
routes join `src/reads/`.

### 13.2 The two routes

| Method | Path | Answers |
| ------ | ---- | ------- |
| POST | `/list-assisted-transfers` | body `{}`; `200 { transfers: [ { transactionId, type, accountId, accountIdTo, amount, createdAt, attestorIds } ] }` |
| POST | `/list-disputed-escrows` | body `{}`; `200 { escrows: [ { transactionId, type, accountId, accountIdTo, amount, createdAt, disputedBy, verdicts: [ { arbitratorId, verdict, approved } ] } ] }` |

`/list-assisted-transfers`: every `assisted_transfers` row on this
validator with `approved`, `cancellation IS NULL` and an empty attestation
slot (`attestation_1 IS NULL OR attestation_2 IS NULL`): the trades, and
since 2026-11-08 the break-glass moves (section 22), waiting for attestors.
`type` (`payload.transactionType`, `assistedAnosTransfer` or
`breakGlassTransfer`, which the attestor edition tells the two apart by),
`accountId`, `accountIdTo`, `amount` and `createdAt` are read from
`og_transaction.payload`; `attestorIds` lists
`payload.attestorId` of the attestations present, slot order, so a second
attestor sees who signed first.

`/list-disputed-escrows`: every `escrow_transfers` row with `approved` and
`dispute_signature_approved` that no verdict has decided: no value of
`verdict` has `DECIDING_VERDICTS` (2) approved `escrow_arbitrations` rows
(one `NOT EXISTS` with `GROUP BY verdict HAVING count(*) >= 2`). A
cancel-decided escrow is already in `archives` and a success-decided one
leaves after its round, so this is the list an attestor can still act on.
`disputedBy` is `dispute_signature.payload.accountId`; `verdicts` the
`escrow_arbitrations` rows of the escrow, `arbitrator_account_id` order,
`approved` as stored.

Both newest first by `created_at`, no paging (the holding tables are
small), ids hex, amounts decimal strings of millionths, `createdAt` the
payload's string. Refusals of the gate are logged `failed: <reason>` like
every other route. Nothing else about the rows is answered: the attestor
app reads people from the masterpod by account id (masterpod spec 13.4.3)
and never sees `og_transaction`.

### 13.3 Notes from the build

Built 2026-10-26 straight from this section and
`~/Desktop/Z/forclaude/attestor-build-1-validators-and-keyholders.md`, and
checked by `test/rig-attestor-reads.mjs` (22 checks): it builds a throwaway
`anosrig1` with a throwaway role from `db/schema.sql` and
`db/validators.sql`, boots a validator of its own on 3101 against it with
its settings in the environment, writes three accounts whose pair one it
holds (attestor stake at the minimum, one millionth below it, no stakes
row), five assisted transfers and five escrows straight into the tables,
checks every refusal and both lists from the outside, and drops the
database and the role afterwards. The live `anos1` to `anos5` were not
touched; the five validators reloaded under `--watch` and answer the two
routes. Where this section left a detail open, the simplest thing was
chosen and is recorded here; nothing above was changed.

- **The handlers** live in `reads.handlers.js` beside the two account
  reads. The file was not in the plan's list of approved changes, so the
  build first put them in a file of their own and folded them in once the
  user approved the change.
- **The gate** (`src/auth/require-attestor.js`) exports
  `mustHoldAttestorStake` and `requireAttestor = [requireAccount,
  mustHoldAttestorStake]`. The stake is read fresh on every request with
  `stakes.queries.js` `findStake` and judged with `stakes.service.js`
  `holdsRole(stake, ATTESTOR)`, exactly as the attestation and verdict
  follow-ups judge their signer. Because the stake comes after the six
  steps of the account level, as 13.1 orders them, a refused non-attestor
  has used its nonce up: the same envelope again is `401 replay`
  (rig-checked). The keyholder checks the stake before the nonce; here the
  order of section 8 was kept.
- **The queries** (`reads.queries.js`): `findAssistedWaitingForAttestors`
  and `findUndecidedDisputedEscrows`, both `ORDER BY created_at DESC`. The
  escrow query builds `verdicts` in SQL, one round trip: a correlated
  `json_agg(json_build_object(...) ORDER BY arbitrator_account_id)` with
  `encode(..., 'hex')` for the arbitrator, `COALESCE` to `[]`, beside the
  `NOT EXISTS` of 13.2 with `DECIDING_VERDICTS` imported from
  `escrow.queries.js`.
- **The wire shapes** (`reads.service.js`): a shared `heldTransferOf(row)`
  reads `accountId`, `accountIdTo`, `amount` and `createdAt` from
  `og_transaction.payload` the way `pendingOf` does; a field that is not a
  string comes out `null` (`amount` `'0'`, `createdAt` the row's
  `created_at`), which a row this validator wrote never is. `attestorIds`
  takes `payload.attestorId` of each slot holding an object with a payload,
  slot order; `disputedBy` likewise from `dispute_signature.payload`.
- **The signer parameter.** `listAssistedTransfers(accountId)` and
  `listDisputedEscrows(accountId)` take the verified signer, as the plan
  names them and as the other reads do, but the lists do not depend on it:
  13.2 answers the same rows to every attestor, so it is not used inside.
  Nothing is filtered by the signer: a trade the signer sent or already
  attested is listed too, and the app tells by `attestorIds`.
- **What the rig showed beyond 13.2's words:** an approved transfer with no
  attestation at all is listed with `attestorIds: []`; an escrow with one
  approved `cancel` and one unapproved `success` verdict is listed with both
  verdicts and their flags; an escrow whose dispute signature is present but
  not yet approved is not listed; `/get-account` and `/list-transactions`
  are unchanged, for attestors and non-attestors alike.
- **No schema change**: `stakes.attestor_stake` and the holding tables
  were in place. Nothing was applied live.

## 14. Testnet readiness (2026-10-27)

Built 2026-10-27 as the first half of testnet build 1, straight from
`~/Desktop/Z-TestNet/forclaude/testnet-build-1-code-ready.md` (FINAL,
decided in its planning chat); the keyholder is the second half, in its own
repo. `~/Desktop/Z-TestNet` is the testnet tree: fresh repos, one network,
no local development. Nothing about the protocol, the tables, the routes
that carry traffic or the wallet changed. No check ran but `node --check`
on each JavaScript file written or edited: the first boot on the validator
1 VM is the test.

### 14.1 The decisions, as they apply to this repo

- **Two env files per start.** `network/testnet.env`, committed, holds
  every value that is the same on every VM, each line with a comment;
  `.env`, git-ignored, holds what differs per machine: `VALIDATOR_ID`,
  `PGPASSWORD`, `KEY_FILE`. `npm start`, `npm run dev` and the unit run
  `node --env-file=network/testnet.env --env-file=.env src/server.js`; Node
  applies later files over earlier ones (Node 24.22.0, checked in the
  planning chat: two flags work, the later wins, a missing file aborts the
  start). No `VALIDATOR` start variable: the id is a line in `.env`.
- **Testnet dials.** `GUARDED_LOCK_MINUTES=10`, `VAULT_LOCK_MINUTES=20`,
  `LOCK_OFFSET_MINUTES=5`, `GUARDIAN_VOTE_MINUTES=60`; the stake minimums
  and the other vote settings at the production values of the README
  table. `PORT=3000`, `PGUSER=anossoftware`, `PGDATABASE=anos`.
- **`<fill in>`.** `MASTERPOD_URL` and `WEB_ORIGIN` ship as `<fill in>`;
  the user fills them once the Hetzner load balancers have DNS names (the
  masterpod's for the first, the wallet's for the second). `required()` in
  `env.js` refuses the literal with `X is still "<fill in>": fill it in
  network/testnet.env or .env`; every other required helper goes through
  it, so the check covers every required variable and ignores variables
  nobody reads. A server refuses to start until then, by design.
- **The key file.** `KEY_FILE` names it (default `./validator.key`), JSON
  `{ "privateKey": "<P-256 PKCS#8 DER hex>" }`, mode 0600, written once with
  the exclusive-create flag. `src/crypto/key-file.js` `readKeyFile` refuses
  a file that is missing, not a regular file, unreadable, or has any group
  or other bit set, naming the path and the mode; `derivePublicKey` is
  `createPublicKey` of the private key, exported as SPKI DER, the 26-byte
  prefix cut, the 65-byte point compressed with `ECDH.convertKey`.
  `PUBLIC_KEY` and `PRIVATE_KEY` left the env; `validators.signing.js`
  loads the key file once at import and exports `ownPublicKey` (33-byte
  Buffer) and `ownPublicKeyHex`.
- **make-keys and show-key.** `npm run make-keys -- --id <N>
  [--key-file <path>]`: both existence checks before any write, then the
  key file (`wx`, 0600) and `.env` (`wx`, 0644 so `sudo -u postgres` can
  read it; tightening it to 0600 is testnet-month work), exactly three
  lines. Prints `Validator <N>, public key <hex>` and the next commands.
  `npm run show-key [-- <path>]` prints the derived public key and starts
  nothing. A private key is never printed anywhere.
- **The registry file.** `network/testnet.registry.json`,
  `{ firstLeader, validators: [{ id, publicKey, url, active }] }`, starting
  with row 1 alone, filled by the user after make-keys has run on the VM.
  Applied at boot, after genesis and before listening, by
  `src/validators/registry.service.js` with its SQL in
  `registry.queries.js` (`validators.queries.js` untouched), by the five
  rules: upsert every row of the file (`is_leader` untouched); set every
  row not in the file inactive, the row staying; make `firstLeader` leader
  when no row is; this validator's own row must be in the file, active,
  with the derived key, checked against the file before the transaction;
  the hash, SHA-256 of the canonical JSON of all rows ordered by id as
  `{ id, publicKey, url, active }`, leader excluded. Shape checks name the
  row and the field, and the server exits 1. `db/validators.sql` is gone
  and `setup-db.sh` no longer applies a registry.
- **Leader rules unchanged.** `firstLeader` 1 from the first commit; every
  validator makes 1 leader when its table has no leader; nothing moves
  until the first transaction. Adding a validator after traffic and
  replacing a dead leader are testnet-month work.
- **Health.** `GET /health` answers `{ status, uptime, db, validator: { id,
  publicKey }, version: { commit, tag }, registry: { hash, active } }`.
  `src/util/version.js` runs `git rev-parse --short HEAD` and
  `git describe --tags --exact-match` once at boot, each `null` when git or
  the repo is absent or the command fails; no tag is the normal case until
  `testnet-1` exists.
- **CORS from env.** `WEB_ORIGIN` is a required comma-separated list,
  parsed as the masterpod's `optionalList` does but without a default;
  `src/app.js` passes the frozen array to `cors`. `MASTERPOD_URL` is
  required too, keeping the trailing-slash strip. The dev defaults
  `http://localhost:4200` and `http://localhost:3100` left the code.
- **Boot log.** `Validator <id>, public key <hex>` first (`src/server.js`
  imports `validators.signing.js` before anything else), the PostgreSQL
  and genesis lines, `Registry <16 hex>, <n> active`, then listening.
- **The unit.** `deploy/anos-validator.service`, identical on every VM:
  user `anos`, `/opt/anos/anossoftware`, `/usr/bin/node` (NodeSource on
  the VM), `Restart=on-failure` every 5 s, `NoNewPrivileges`,
  `ProtectSystem=strict` (the repo is read-only, and the server writes
  nothing), `PrivateTmp`.
- **The VM.** Debian 13 (unattended upgrades), PostgreSQL 17 from Debian's
  own packages, Node 24 from NodeSource, service user `anos` with both
  repos under `/opt/anos`, no external IP: a doorman holds the static IP
  and terminates TLS, so row 1's `url` is `https://<doorman static ip>:3000`.
  The doorman is a separate plan; the operator guide (since moved to
  `guides/operator-guide.md` beside the repos) covers the
  worker VM and defers the network section to it. Cloud KMS is the
  keyholder's and lives in each operator's own project and region; no
  region appears in code or config.

### 14.2 Files and variables

New: `src/crypto/key-file.js`, `src/validators/registry.service.js`,
`src/validators/registry.queries.js`, `src/util/version.js`,
`scripts/make-keys.js`, `scripts/show-key.js`, `network/testnet.env`,
`network/testnet.registry.json`, `deploy/anos-validator.service`,
`docs/operator-guide.md` (since moved to `guides/operator-guide.md` beside
the repos), `.example.env` (renamed from
`.env-validator.example` and reduced to the three machine lines).

Changed: `src/config/env.js`, `src/validators/validators.signing.js`,
`src/server.js`, `src/app.js`, `src/health/health.router.js`,
`src/health/health.service.js`, `scripts/setup-db.sh`,
`scripts/reset-db.sh`, `package.json`, `.gitignore` (`.env*` and `*.key`),
`README.md`, this file.

Deleted: `db/validators.sql`.

| Variable | Where | Value |
| -------- | ----- | ----- |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | shared | `127.0.0.1`, `5432`, `anossoftware`, `anos` |
| `PORT` | shared | `3000` |
| `GUARDED_LOCK_MINUTES`, `VAULT_LOCK_MINUTES`, `LOCK_OFFSET_MINUTES` | shared | `10`, `20`, `5` |
| the six `STAKE_MIN_*_ANOS` | shared | `10`, `1000`, `1000`, `1000`, `50000`, `500000` |
| `GUARDIAN_VOTE_ANOS`, `GUARDIAN_VOTE_PERCENT`, `GUARDIAN_VOTE_MINUTES` | shared | `1000`, `70`, `60` |
| `MASTERPOD_URL`, `WEB_ORIGIN` | shared | `<fill in>` |
| `TIMESTAMP_WINDOW_SECONDS` | shared | `120` |
| `VALIDATOR_ID`, `PGPASSWORD`, `KEY_FILE` | machine (`.env`, from make-keys) | the id, 32 hex characters, `./validator.key` |

Gone: `PUBLIC_KEY`, `PRIVATE_KEY`, the `VALIDATOR` start variable, the
`.env-validatorN` files.

### 14.3 Notes from the build

Where the plan was silent, the simplest thing was chosen and is recorded
here; nothing in 14.1 was changed.

- **`<fill in>` is double-quoted in the env files**
  (`MASTERPOD_URL="<fill in>"`). `scripts/setup-db.sh` and `reset-db.sh`
  source `network/testnet.env` and `.env` with `sh`, where a bare
  `<fill in>` is a redirection. Node's `--env-file` strips single, double
  or backtick quotes, so `env.js` still sees the literal `<fill in>` and
  refuses it. The values may be filled with or without quotes.
- **`requiredHex` left `env.js`**: its only uses were `PUBLIC_KEY` and
  `PRIVATE_KEY`. The hex check lives in `key-file.js` now.
- **Paths are resolved against the repo root**, not the working directory:
  `key-file.js`, `registry.service.js` and `version.js` locate the repo
  from `import.meta.url`, and `make-keys.js` writes `.env` and a relative
  `--key-file` there. `npm` and the unit run in the repo root anyway, so
  `KEY_FILE=./validator.key` reads the same either way.
- **`.env` is chmod-ed to 0644 after the write**, so an operator's umask
  cannot leave it unreadable to postgres. The key file is created 0600
  under `wx` and never chmod-ed: a umask can only narrow that, and anything
  narrower still passes the server's check.
- **`.example.env` carries comments** although make-keys writes `.env` as
  exactly three bare lines; the example explains, the real file does not.
- **`show-key` prints the bare hex**, one line and nothing else, so it can
  be copied or piped.
- **make-keys prints the unit install as its second next command** although
  the registry row (operator guide step 9) comes between the database and
  the unit; the printed text says so.
- **Registry messages** are prefixed `network/testnet.registry.json:` and
  name the row by position and id, for example `row 1 (id 1): publicKey is
  still "<fill in>": fill it in network/testnet.registry.json`; the own-row
  messages name the id and, for a key mismatch, both keys. `server.js`
  prints them as `Registry failed: <message>`. An unreadable or malformed
  file is `could not be read: <reason>`.
- **Rule 2 touches only active rows** (`UPDATE ... WHERE active AND NOT
  (id = ANY($1))`), so a row already inactive keeps its `updated_at`.
- **The hash** is `sha256(canonicalize(rows))` over the rows as
  `registry.queries.js` `findAllRows` returns them: `id` an integer,
  `publicKey` from `encode(public_key, 'hex')`, `url`, `active`; the keys
  sorted by `canonicalize`. The count beside it is the active rows of the
  table, which after the apply are exactly the file's active rows.
- **`version.js`** runs git with `cwd` the repo root and stderr ignored; a
  non-zero exit, a missing binary or empty output is `null`.
- **Health** composes the fixed facts in `health.service.js` `identity()`
  and the router spreads them into the answer, so the service stays the one
  place that knows the shape.
- **`validators.queries.js`** still says in its comment that the table is
  "seeded from db/validators.sql"; the plan says not to touch the file, so
  the comment stays stale until a later change there.
- **`node --check`** passed on the twelve JavaScript files written or
  edited. Nothing booted, no database was touched, no scratch file was
  written.

## 15. Bootstrap build 1 (2026-10-29)

Built 2026-10-29 straight from
`~/Desktop/Z-TestNet/forclaude/bootstrap-build-1-code-ready.md` (FINAL,
decided in its planning chat): one script per machine for onboarding a
validator, replacing the paste-by-paste walkthrough of the operator guide
with one pasted line per machine. This repo holds the worker's script;
doormansoftware holds the Cloud Shell and doorman scripts (its
`docs/schemas.md`, section 2) and the record of what the three share. The
operator guide, `guides/operator-guide.md` beside the repos, was rewritten
in two parts: Part A, the visit as it runs with the scripts, and Part B,
the same work by hand, the fallback. Nothing about the server, the
protocol, the registry, the unit, the env files, make-keys, show-key or
the database scripts changed. No check ran but `sh -n` on the script:
validator 5's onboarding visit is the first run and the test.

### 15.1 The decisions, as they apply to the worker script

- **One re-runnable script for the worker.** `scripts/bootstrap-worker.sh`,
  run as root over SSH after the doorman line (the worker's internet goes
  through the doorman), does the guide's steps 4, 6, 7 and 8 on the first
  run and stops after printing the validator's public key line, `done
  through step 8: waiting for registry row <N>`; once the row is merged,
  the same line again does steps 9 and 10; later runs do step 11. Each
  point does what is still missing and answers `already` for what is
  done. No separate update command; the same pasted line downloads the
  script from `main` with `curl -fsSLO` and runs it with `sudo sh`.
- **Arguments.** `--id` and the three keyholder GUI values,
  `--home-x25519` (64 lowercase hex), `--home-mlkem` (3136),
  `--signing-key` (66, starting `02` or `03`, the one value for both
  `KEYHOLDER_PUBLIC_KEY` lines), named flags parsed by a `while` and a
  `case`, each checked for shape before anything happens; lowercase only,
  since the keyholder's `env.js` accepts only lowercase hex. `--id` is
  required until `/opt/anos/anossoftware/.env` exists; given, it must equal
  `VALIDATOR_ID` there and `KEYHOLDER_ID` in the keyholder's `.env`; absent,
  it is read from `VALIDATOR_ID`. The GUI flags are optional on every run:
  given, each is written where its line is still `"<fill in>"` and must
  equal the line where it is filled; absent while a line is unfilled, the
  keyholder waits and the done line says so. So every later run is the
  line with nothing after the script name, and nobody keeps the
  3136-character value around.
- **What the script works out itself.** From the metadata server: the
  VM's name (must be `worker`), that it has no external IP, the project
  id, the zone (the region is the zone without its last `-x`) and the
  service account's scopes. `KMS_KEY_NAME` is assembled as
  `projects/<project id>/locations/<region>/keyRings/anos-testnet/cryptoKeys/keyholder-<N>`,
  so the key is always the one in the VM's own region, the one the Cloud
  Shell script made.
- **Log and screen.** `/var/log/anos-bootstrap.log`, mode 0600, every
  command's output, each run under `=== bootstrap-worker.sh <UTC time>
  <arguments> ===`; the screen gets one line per guide point and a final
  line, `done ...` or `failed at step <number> (<name>): see <log>` after
  the last five log lines; an argument failure is `failed at the argument
  check: <reason>`.
- **Service users.** `sudo -iu anos bash -c '...'` for the clones, `npm
  ci`, `make-keys` and the pulls, as the guide; `sudo -u anos` for
  show-key, the `sed` on the keyholder's `.env` and git's `rev-parse` and
  `diff`; `sudo -u postgres sh <script>` for the three database scripts.
- **Nothing private.** The script reads `VALIDATOR_ID`, `KEYHOLDER_ID` and
  the five fillable lines, each with `sed -n` on the one line, never by
  printing a file; `PGPASSWORD` lines are never read; the key files are
  read only by show-key, as `anos`, which prints the public key; make-keys
  prints public values only, into the log.

### 15.2 Files

New: `scripts/bootstrap-worker.sh`. Changed: `README.md` ("PostgreSQL on
the Compute Engine VM" gained the worker line; "Project layout" lists the
script), this file. Outside the repo: the guide, doormansoftware's two
scripts, README and record, keyholdersoftware's README (one sentence).

Step lines, in order: `4.1 look` (Debian 13 required; the clock, the
internet through the doorman, which must answer 200, and the
cloud-platform scope, which must be present), `4.2 packages` (node 24,
psql 17, postgresql active, git; NodeSource's setup script for node),
`6.2 install` (user `anos`, `/opt/anos` 755 on every run, each repo cloned
where missing, `npm ci` where `node_modules` is missing), `7.2 keys` (each
repo's make-keys when its key file and `.env` are both missing; then the
public key from show-key, printed on every run), `7.3 keyholder .env` (the
five lines, written where still `<fill in>` and the value is known,
compared where filled; the signing key on both `KEYHOLDER_PUBLIC_KEY`
lines), `8.2 databases` (the guide's three scripts when the look of 8.1
misses a database or a role), `9.1 pull` (for each repo that existed
before the run, `git pull --ff-only`, `npm ci` when the lock file changed),
`9.1 registry row <N>` (`present, <url>`, or `absent`, which ends the run
waiting), `10.2 validator` (both unit files placed when missing or
different, enabled and started when not active, restarted when its repo's
HEAD moved, printed as `11.3`; then up to thirty seconds for 3000 to
answer 200 and the boot lines), `10.3 keyholder` (the same when all five
lines are filled, up to ninety seconds for 3200; else `waiting for the
three GUI values`). Done lines: `done through step 8: waiting for registry
row <N>` after `Give us this line for the registry: Validator <N>, public
key <66 hex>` and `Once the row is on GitHub, run this same command again;
no arguments are needed.`; `done: validator <N> and keyholder <N> up;
registry <16 hex>, <n> active`; `done: validator <N> up, registry <16
hex>, <n> active; the keyholder waits for the three GUI values`; `done:
nothing to do; validator <N> on registry <16 hex>, <n> active; keyholder
active`.

### 15.3 Notes from the build

Where the plan was silent, the simplest thing was chosen and is recorded
here; nothing in 15.1 was changed.

- **Journal reads are scoped to the unit's current systemd invocation**
  (`journalctl _SYSTEMD_INVOCATION_ID=<id>`), so a boot line of an earlier
  run is never read as this one's. A validator up for weeks may have its
  boot lines rotated out of the journal: then `Validator <N>, public key`
  and `Registry <16 hex>, <n> active` are taken from its health answer,
  parsed by node from the JSON, and the line says so; a keyholder that
  answers 200 passed its KMS self-test, so a missing `KMS ok` line is
  reported as `KMS ok at boot (the line is no longer in the journal)`.
- **Boot errors are caught while waiting.** Each second of the wait for
  200, the unit's journal is read for `Registry failed`, `Genesis failed`,
  `Could not connect`, `KMS self-test failed` or `Error:` (an `env.js`
  refusal surfaces as Node's uncaught error, naming the `.env` line), and
  the first such line fails the step at once, so a keyholder with a wrong
  value does not wait the ninety seconds. The timeout message quotes the
  last such line of the unit's recent journal.
- **A `db/` change in the 9.1 pull runs the three database scripts
  again**, right after the pull, printed as a second `8.2 databases` line:
  the pull comes after 8.2 in the guide's order, so the scripts cannot
  know of it at 8.2. They are idempotent.
- **A registry row that is present but inactive fails at 9.1** (`registry
  row <N> is inactive`); the plan named only absent and another key.
- **The unit files are placed with `install -m 0644` when `cmp -s`
  differs** and `daemon-reload` runs only then; a changed unit alone
  restarts nothing, since a restart needs the repo's HEAD to have moved
  in this run, which a unit change always comes with.
- **4.2 fails when `postgresql` is not active after the install**, with
  `systemctl status postgresql` named; the database scripts at 8.2 would
  otherwise fail with a worse message. "Installed" for git is
  `dpkg-query`; node is `node -v` starting `v24`; psql is `psql --version`
  starting `17.`.
- **NodeSource's setup script is downloaded to a temporary file and then
  run** instead of piped into bash, as in the doorman script, and `node
  -v` is checked afterwards. The temporary directory, which also holds the
  health answers for parsing, is removed by the EXIT trap.
- **4.1 writes its four values to the log before the checks**, so a failed
  check still shows what was found; the scope is read from the metadata
  server's `instance/service-accounts/default/scopes`, one scope per line.
- **The key files are looked for at `validator.key` and `keyholder.key`**
  in each repo root, make-keys' defaults; `KEY_FILE` is not among the
  lines the script reads. make-keys runs whenever the two files of a repo
  do not both exist, so when only one exists its own refusal is the
  failure, as the plan says.
- **show-key's output is checked for the shape of a public key** before
  it is printed or compared with the registry row.
- **7.3 reports per line** (`KMS_KEY_NAME written; home x25519 written,
  home mlkem written, signing key 1 written, signing key 2 written`), with
  `all five lines already filled` when nothing was to do and `(give
  --home-x25519, --home-mlkem, --signing-key)` appended while a GUI line
  is unfilled. Both `"<fill in>"` (as make-keys writes it) and a bare
  `<fill in>` count as unfilled. The `sed -i` runs as `anos`, so the file
  keeps its owner and mode.
- **A GUI value that is given and differs from its filled line** is an
  argument failure that prints both values (public keys); a shape
  failure prints the length given rather than a 3136-character value.
- **`/opt/anos` is chmod-ed 755 on every run**, as the plan says, and
  `id anos` decides the user.
- **Which done line:** the keyholder-waits line when a GUI line is
  unfilled; nothing to do when no point of steps 4 to 8 did work, neither
  HEAD moved and both units were active; else the both-up line.
- **The worker script exports `DEBIAN_FRONTEND` only**; root's `HOME` does
  not matter here (acme.sh is the doorman's).

## 16. The escrow read (2026-11-05)

Decided 2026-11-05 in the wallet's escrow trades planning chat; the wallet
spec (`~/Desktop/Z-TestNet/web_app/docs/schemas.md`, section 5.4) carries
the same lines. The wallet showed nothing of an escrow while it waited: the
reads of section 8 list the chain and the pending row only, and every
follow-up needed the transaction id pasted from the one-time `202`. One
more read at the account level answers the signer's open escrow trades,
both sides, so the wallet can list them and act on each. Nothing about the
escrow rules, the follow-ups or the leader round changed.

### 16.1 The route

Account level (section 8, `src/auth/require-account.js`): the same
envelope and the same six checks as `/get-account`; no stake. It joins
`src/reads/` beside the other reads.

| Method | Path | Answers |
| ------ | ---- | ------- |
| POST | `/list-escrows` | body `{}`; `200 { escrows: [ { transactionId, accountId, accountIdTo, amount, createdAt, stage, disputedBy, verdicts: [ { verdict, approved } ] } ] }` |

Every `escrow_transfers` row where `account_id` (the seller) or
`account_id_to` (the buyer) is the signer, newest first by `created_at`,
at most 200 rows (`MAX_LIMIT`, the cap `/list-transactions` has). The cap
is a guard, not paging: a seller holds one open escrow at a time (one held
transaction per account) and a buyer one per seller trading with it. Open
trades only: nothing from `logs`, which may be purged (section 7), or
`archives`. A released escrow is on the chain under the same
`transaction_id`, so `/list-transactions` shows it to both sides for good;
a cancelled one leaves no trace a wallet reads.

`transactionId`, `accountId`, `accountIdTo`, `amount` and `createdAt` as
the attestor reads answer them (13.2, `heldTransferOf`). `disputedBy` is
`dispute_signature.payload.accountId`, or `null` while there is no
dispute. `verdicts` are the escrow's `escrow_arbitrations` rows in
`arbitrator_account_id` order, each `verdict` (`success` or `cancel`) and
`approved` as stored, without the arbitrator's id: a party learns how many
verdicts there are and what they say, never which attestor said what. The
body is not read. Refusals are the account level's, logged `failed:
<reason>` like every other route.

### 16.2 The stage

`stage` names where the trade is. The validator decides it from the row's
columns, so the word is made beside the rules that read the same columns
(5.5, 5.6 and 6), and a change to those rules has to change this table.
The first line that matches wins:

| `stage` | The row | What it means |
| ------- | ------- | ------------- |
| `waiting` | `approved` false | not every validator has accepted the trade yet; no follow-up is accepted on it (5.1) |
| `disputed` | `dispute_signature IS NOT NULL` | a dispute is on it; only verdicts move it now, and two approved verdicts that agree close it (5.6) |
| `cancelling` | `cancel_signature IS NOT NULL` | the buyer's cancel is on it; once approved, the row moves to `logs` (5.5) |
| `releasing` | `success_signature IS NOT NULL` | the seller's success is on it; the next leader round writes it (section 6) |
| `held` | none of the above | accepted and untouched: the seller may send `escrowSuccess`, the buyer `escrowCancel`, either `escrowDispute` |

A slot is only filled on an approved row (a follow-up on an unapproved
transaction is refused, 5.1), and each slot blocks the other two (5.5), so
at most one line past the first can match; the order is a definition, not
a race. "Being written after a dispute" is `disputed` with two approved
`success` verdicts; it lasts one round. A wallet that meets a `stage` it
does not know treats the trade as open and offers no action, so a sixth
stage added here cannot make it do the wrong thing.

### 16.3 Notes from the build

Built 2026-11-05 straight from 16.1 and 16.2. Files: `src/reads/
reads.queries.js` (`findOpenEscrowsFor(accountId, limit)`: the row, three
`IS NOT NULL` booleans for the slots, `dispute_signature` for who disputed,
and `verdicts` built in SQL as 13.3's query builds them, without the
`encode` of the arbitrator), `reads.service.js` (`ESCROW_STAGES`,
`listEscrows(accountId)` on `heldTransferOf`, `stageOf(row)` in the order
of 16.2's table), `reads.handlers.js`, `reads.router.js` (behind
`requireAccount`), `app.js` (the comment), the table of section 8, and
the README (the endpoints table, the account-level reads, the folder
list). No schema change: every column read was in place.

Checks run: `node --check` on the five source files, and the query's SQL
run by psql against the local `anos1` inside one transaction that inserted
two throwaway escrows (one in dispute with an approved `success` and an
unapproved `cancel` verdict, one held) and was rolled back: the buyer of
the first and seller of the second got both rows with the right booleans,
`disputedBy` and `verdicts`; a stranger got none; the live tables were
empty before and after. Not run: no validator was booted (this copy has no
rig, and the user runs the servers) and the live validators were not
touched; the wallet (its step 2) is the first caller.

Rollout: read only, so a validator with the route and one without agree on
everything else; the wallet reads from one validator (`DEFAULT_VALIDATOR`),
which pulls first, the rest at the next pull round (operator guide, the
`anos-validator` pull line). The doorman's validator door passes only the
paths in its table (doormansoftware `src/doors/validator.routes.js`,
`signedReadCheck` for the signed reads); `/list-escrows` has to be added
there, and that doorman restarted, before a wallet can reach the route.

## 17. The assisted transfer read (2026-11-06)

Decided 2026-11-06 in the wallet's assisted transfer planning chat; the
wallet spec (`~/Desktop/Z-TestNet/web_app/docs/schemas.md`, section 5.4)
carries the same lines. The wallet showed nothing of an assisted transfer
while it waited in `assisted_transfers`: the reads of section 8 list the
chain, the pending row and the open escrow trades, and the sender's cancel
needed the transaction id pasted from the one-time `202`. One more read at
the account level answers the signer's own held assisted transfer, so the
wallet can show it, follow its stage and cancel it from a page of its own.
Nothing about the assisted transfer rules, the follow-ups or the leader
round changed.

### 17.1 The route

Account level (section 8, `src/auth/require-account.js`): the same
envelope and the same six checks as `/get-account`; no stake. It joins
`src/reads/` beside the other reads.

| Method | Path | Answers |
| ------ | ---- | ------- |
| POST | `/get-assisted-transfer` | body `{}`; `200 { transfer: { transactionId, accountId, accountIdTo, amount, createdAt, stage, attestations } \| null }` |

`transfer` is the `assisted_transfers` row whose `account_id` is the
signer, or `null` when there is none. There is at most one: `account_id`
is UNIQUE there, and a transfer is refused while the account has anything
held (one held transaction per account). Sender only: the receiver can do
nothing with the transfer and sees it in the history when it lands. The
held transfer only: nothing from `logs`, which may be purged (section 7),
or `archives`. A written transfer is on the chain under the same
`transaction_id`, so `/list-transactions` shows it for good; a cancelled
one leaves no trace a wallet reads.

`transactionId`, `accountId`, `accountIdTo`, `amount` and `createdAt` as
the other held-transfer reads answer them (13.2 and 16.1,
`heldTransferOf`, from `og_transaction.payload`). `attestations` counts
the attestation slots holding an object, 0, 1 or 2; the attestations
reach the validator together, posted by the deciding attestor's app, so
the count is nearly always 0 or 2. The body is not read. Refusals are the
account level's, logged `failed: <reason>` like every other route.

### 17.2 The stage

`stage` names where the transfer is. The validator decides it from the
row's columns, so the word is made beside the rules that read the same
columns (5.2, 5.3 and section 6), and a change to those rules has to
change this table. Nothing new goes into the database: the rules below
are a table of words in this document only. The first line that matches
wins:

| `stage` | The row | What it means |
| ------- | ------- | ------------- |
| `waiting` | `approved` false | not every validator has accepted the transfer yet; no follow-up is accepted on it (5.1) |
| `cancelling` | `cancellation IS NOT NULL` | a cancel is on it, the sender's (5.3) or the break-glass pair's (5.7); once approved, the row moves to `logs` |
| `locked` | `attestation_1_approved` and `attestation_2_approved`, and `future_date > now()` | a break-glass move out of a guarded or vault account (4.5, section 22): both attestations accepted, waiting out the sender's lock until `unlocksAt`; a cancel is still accepted. Added 2026-11-08 |
| `writing` | `attestation_1_approved` and `attestation_2_approved` (and `future_date` NULL or passed) | both attestations accepted by every validator; the next leader round writes it (section 6); the sender may still cancel until then (5.3) |
| `attesting` | none of the above | accepted, waiting for two approved attestations; the sender may cancel |

A cancel is accepted until the transfer is written, even when both
attestations are approved (5.3), and a cancellation present keeps the row
off the ready list (section 6), so `cancelling` is decided before
`writing`: a row with both attestations approved and a cancellation on it
is being cancelled, not written. `locked` comes before `writing` for the
same reason: a row with both attestations approved and its moment ahead is
off the ready list until the moment passes, by the database's clock, the
one the ready list reads. A wallet that meets a `stage` it does not know
treats the transfer as held and offers no action, so the fifth stage,
`locked`, added 2026-11-08, and any later one cannot make it do the wrong
thing.

### 17.3 Notes from the build

Built 2026-11-06 straight from 17.1 and 17.2. Files: `src/reads/
reads.queries.js` (`findAssistedFor(accountId)`: the row, two `IS NOT
NULL` booleans for the attestation slots, the two approved flags as the
columns are, and one boolean for the cancellation slot; the row or null),
`reads.service.js` (`ASSISTED_STAGES`, `getAssistedTransfer(accountId)`
on `heldTransferOf` with `attestations` the two booleans counted,
`assistedStageOf(row)` in the order of 17.2's table, next to `stageOf`),
`reads.handlers.js`, `reads.router.js` (behind `requireAccount`, after
`/list-escrows`), `app.js` (the comment), the table of section 8, and
the README (the endpoints table, the account-level reads, the folder
list). No schema change: every column read was in place.

Checks run: `node --check` on the five source files, and the query's SQL
run by psql against the local `anos1` inside one transaction that
inserted one throwaway assisted transfer (approved, one attestation
present, no cancellation) and was rolled back: the sender got the row
with `has_attestation_1` true, `has_attestation_2` false, both approved
flags false and `has_cancellation` false; the receiver, a stranger to the
query, got none; the live table was empty before and after. Not run: no
validator was booted (this copy has no rig, and the user runs the
servers) and the live validators were not touched; the wallet (its step
2) is the first caller.

Readings where the plan left a detail open: `findAssistedFor` is appended
at the end of `reads.queries.js`, after `findOpenEscrowsFor`, as the
escrow read was; the README's sentence above the account-level list says
four routes now, since it counts the bullets under it; the router's
comment was rewrapped to fit the new path in.

Rollout: read only, so a validator with the route and one without agree
on everything else; the wallet reads from one validator
(`DEFAULT_VALIDATOR`), which pulls first, the rest at the next pull round
(operator guide, the `anos-validator` pull line). The doorman's validator
door passes only the paths in its table (doormansoftware
`src/doors/validator.routes.js`, `signedReadCheck` for the signed reads);
`/get-assisted-transfer` is added there in the same step, and that
doorman restarted, before a wallet can reach the route.

## 18. The locked transfer read and the date filter (2026-11-06)

Decided 2026-11-06 in the wallet's home page planning chat
(`~/Desktop/Z-TestNet/forclaude/wallet-home-plan-1.md`); the wallet spec
(`~/Desktop/Z-TestNet/web_app/docs/schemas.md`, section 5.4) carries the
same lines. The wallet is getting a balance card that says what is
available beside each balance, so it has to count what is spoken for:
the pending row, the open escrow trades and the held assisted transfer
have reads (sections 8, 16 and 17), but a guarded or vault account's
transfer waiting in `locked_transactions` had none, and those anos would
have gone uncounted for a week, or a month, in production. The wallet is
also getting a transaction history with a date range, and
`/list-transactions` could only page back from the newest row. Two
changes to the reads feature, nothing else: a fifth read at the account
level answers the signer's own locked transfer, and `/list-transactions`
takes an optional date range. No table changes, no follow-up, no round.

### 18.1 The route

Account level (section 8, `src/auth/require-account.js`): the same
envelope and the same six checks as `/get-account`; no stake. It joins
`src/reads/` beside the other reads.

| Method | Path | Answers |
| ------ | ---- | ------- |
| POST | `/get-locked-transfer` | body `{}`; `200 { transfer: { transactionId, accountId, accountIdTo, amount, createdAt, unlocksAt, stage } \| null }` |

`transfer` is the `locked_transactions` row whose `account_id` is the
signer, or `null` when there is none. There is at most one: `account_id`
is UNIQUE there, and a transfer is refused while the account has anything
held (one held transaction per account). A guarded or vault transfer sits
there from the moment the validator accepts it until the first leader
round after its unlock moment writes it; nothing can be done with it
meanwhile, since no follow-up exists for a locked transfer (so it was
until 2026-11-11: since then the sender can cancel it, section 28). Sender
only: the receiver sees it in the history when it lands. The held transfer
only: a written transfer is on the chain under the same `transaction_id`,
and the row is deleted when written (section 6), so nothing comes from
`logs` or `archives`.

`transactionId`, `accountId`, `accountIdTo`, `amount` and `createdAt` as
the other held-transfer reads answer them (13.2, 16.1 and 17.1,
`heldTransferOf`, from `og_transaction.payload`). `unlocksAt` is the
row's `future_date` as ISO 8601: the moment the transfer may be written.
`stage` from 18.2. The body is not read. Refusals are the account
level's, logged `failed: <reason>` like every other route.

### 18.2 The stage

`stage` names where the transfer is. The validator decides it from the
row, beside the rule that reads the same columns (`findDueIds`, section
6), and a change to that rule has to change this table. Nothing new goes
into the database: the rules below are a table of words in this document
only. The first line that matches wins:

| `stage` | The row | What it means |
| ------- | ------- | ------------- |
| `waiting` | `approved` false | not every validator has accepted the transfer yet |
| `cancelling` | `cancellation IS NOT NULL` | the sender's cancel is on it (5.8; since 2026-11-11, section 28); it is off the ready list, and once the cancel is approved the row moves to `logs` |
| `locked` | `approved`, `future_date > now()` | waiting out its lock; the first leader round after `unlocksAt` writes it |
| `due` | `approved`, `future_date <= now()` | unlocked; the next leader round writes it (a round starts with the next transaction of any kind) |

`now()` is the database's clock, the same one `findDueIds` reads, so the
wallet and the ready list agree. A wallet that meets a `stage` it does
not know treats the transfer as held.

### 18.3 The date filter

The body of `/list-transactions` (section 8) gains `from?` and `to?`,
each an ISO 8601 string. `transactions` then holds only the links with
`created_at >= from` and `created_at < to`; either alone works. `to` is
the first moment after the range: the wallet sends the start of the day
after the last day picked. `beforePosition` and `limit` work as before,
within the range. `pending` is not filtered. A value that is not a string
`Date.parse` accepts (a number, `NaN` after parsing): `400 invalid from`
or `400 invalid to`.

### 18.4 Notes from the build

Built 2026-11-06 straight from 18.1 to 18.3. Files: `src/reads/
reads.queries.js` (`findTransactions` takes `from` and `to`, Date objects
or null, as two more `IS NULL OR` lines before `ORDER BY`;
`findLockedFor(accountId)`, appended after `findAssistedFor`: the row
with `future_date <= now()` as `due`, or null), `reads.service.js`
(`from` and `to` checked after `limit` and passed as Dates;
`LOCKED_STAGES`; `getLockedTransfer(accountId)` on `heldTransferOf` plus
`unlocksAt` and `stage`; `lockedStageOf(row)` in the order of 18.2's
table, `row.due` for the clock, next to `assistedStageOf`),
`reads.handlers.js`, `reads.router.js` (behind `requireAccount`, after
`/get-assisted-transfer`), `app.js` (the comment), the table of section
8, and the README (the endpoints table, the account-level reads, the
folder list). No schema change: every column read was in place.

Checks run: `node --check` on the five source files, and the two
queries' SQL run by psql against the local `anos1` inside transactions
that were rolled back. The locked query, with one throwaway
`locked_transactions` row (approved, `future_date` an hour ahead, a
payload with the four fields): the sender got the row with `due` false;
the receiver, a stranger to the query, got none; the live table was
empty before and after. The transactions query, for the local account
with the most chain rows (seven): with a window from a day ago to now it
answered no rows, since the local chain's newest row is from 2026-10-26;
with nulls it answered all seven; with a window from the account's
oldest row up to its newest, every one of the six rows answered lay
inside the window and the newest, at the `to` moment, was left out;
`from` alone at that moment answered the one row, `to` alone the six.
The live tables were unchanged throughout. Not run: no validator was
booted (this copy has no rig, and the user runs the servers) and the
live validators were not touched; the wallet (its steps 2 and 4) is the
first caller.

Readings where the plan left a detail open: a `from` or `to` of `null`
is refused as `invalid from` or `invalid to`, since only an absent field
means not given (the plan's words), where `beforePosition` lets an
explicit `null` through as not given; the comment on `findTransactions`
says the two values are Date objects or null; the service's header
comment and the router's were rewrapped to fit the new words in; the
transactions query was run once more with a window drawn from the
account's own rows, so the filter was seen admitting rows and not only
answering none.

Rollout: read only, so a validator with the changes and one without
agree on everything else; the wallet reads from one validator
(`DEFAULT_VALIDATOR`), which pulls first, the rest at the next pull round
(operator guide, the `anos-validator` pull line). The doorman's validator
door passes only the paths in its table (doormansoftware
`src/doors/validator.routes.js`, `signedReadCheck` for the signed reads);
`/get-locked-transfer` is added there in the same step, and that doorman
restarted, before a wallet can reach the route. `/list-transactions`
needs nothing at the door: `from` and `to` travel inside the signed
envelope it already passes. A wallet against a validator without the
change gets every row, the dates ignored; against a doorman without the
line, the locked read is answered 404.

## 19. Catch-up, ignore votes and joining (2026-11-07)

Decided 2026-11-07 in a four-round planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/validator-catch-up-plan-1.md`. Why: a
validator that missed a transaction never got it again, nothing could add a
validator to a running network, and one silent validator stopped every
other one, since a proof of acceptance needed a receipt from every active
registry row, the leader round ended at the first validator that did not
answer, and the calls between validators had no timeout. Two build steps in
this repo, each with its doorman part (doormansoftware `docs/schemas.md`
section 3), built in one chat, checked on a throwaway rig on the Mac,
deployed once at the relaunch. Nothing here touches the masterpod, the
keyholder or the wallet.

Two steps, both built 2026-11-07. Step 1: the timeout, health's new
fields, the chain chunk read and the replay with the catch-up pass, the
ignored flag and the counted rule, the same message twice, the six
variables and the schema. Step 2: the votes, the report and the
originator's wait, the leader round with no answer, the join handshake,
the loop every boot runs, and one amendment the user approved in the build
chat: a joiner adopts the network's view of who is ignored (19.1).

Since 2026-11-12 a refusal starts the ignore vote as well, when the
refusing validator fails the health check: section 29.

### 19.1 The decisions, as they apply to the code

Step 1:

- **The timeout.** `VALIDATOR_CALL_TIMEOUT_SECONDS` (10, `env.network.
  callTimeoutSeconds`). `src/validators/validators.client.js`
  `postToValidators` gives every fetch `signal: AbortSignal.timeout`; a
  fetch that throws (refused, reset, timed out) or whose body cannot be
  read no longer rejects the call: that peer's entry is `{ id, url,
  noAnswer: true, reason }` and the others come back as before.
  `getFromValidator(validator, path)` does a GET with the same timeout,
  `{ status, body }` parsed as JSON or `{ noAnswer: true, reason }`;
  `getHealth(validator)` reads `/health` through it and unwraps a doorman's
  `worker`. The four answer checks of `validators.messages.js`
  (`checkTransactionApproved`, `checkTransactionAccepted`,
  `checkAttachmentAnswer`, `checkListAnswer`) answer `{ reason: "no answer:
  <reason>", noAnswer: true }` for such an entry, and the per-validator
  results of the six senders carry `noAnswer: true` through;
  `sendFinalDeclaration`'s raw answers carry the entry as it is. Since
  2026-11-19
  (`~/Desktop/Z-TestNet/forclaude/validator-redirects-plan-1.md`) both
  fetches set `redirect: 'manual'`: neither call follows a redirect, and a
  redirect comes back as an answer with its own status (the note at the
  end of 19.5).
- **Health.** `identity()` in `src/health/health.service.js` is async and
  gains `chain` (`{ position, recordHash }` of the newest link,
  `garlic-chain.queries.js findTailRow`, the position a number and the
  hash hex), `leader` (`validators.queries.js findLeaderId`, or null),
  `ignored` (`findIgnoredIds`, the active rows with the flag, ascending)
  and `counted` (the flag of `join.service.js`). Every reader of another
  validator's health takes `body.worker` when it is an object and `body`
  otherwise (`getHealth`), so the rig without a doorman and the network
  read the same way.
- **The chunk read.** `POST /chain-links`, `src/garlic-chain/
  chain-links.service.js` (both sides), `chain-links.handlers.js`,
  `chain-links.queries.js`, the router line in `validators.router.js`. The
  request names the asker, `afterPosition` and `limit`; the receiver
  checks the shape, `limit` at most `CHAIN_CHUNK_LINKS`, the asker an
  active row ignored or not, the signature, and answers the links above
  the position, ascending, at most `limit`, as 19.2 shapes them. The asker
  checks the answer as a receipt.
- **The replay.** `src/garlic-chain/replay.service.js` `replayLinks(links)`:
  one database transaction per chunk, each link checked (19.3) and written
  by `insertLink` with the chunk's `createdAt` (`insertLink` gains the
  optional field and returns the position the identity column gave, which
  must be the link's). The side effect of the type: `insertAccount` for an
  account creation, `addStake` for a transferToFund, `subtractStake` for a
  payout with `stakeFor`; the balance trigger does the rest. The clock
  checks, the masterpod check and the holding-table checks are skipped;
  nothing from the holding tables, logs or archives is touched. The
  signature and id checks of each type are lifted out of the verify
  functions into exported helpers the verify functions now call first:
  `checkCreateAccountSignaturesAndIds` (accounts.service.js),
  `checkTransferSignaturesAndIds` (transfer.service.js),
  `checkTransferToFundSignaturesAndIds` and
  `checkFundProposalSignaturesAndIds` (fund.service.js), each taking an
  optional `client` for its account read.
- **The catch-up pass.** `catchUp()` in the same file, on `sweepHealth()`:
  the health of every active row but this one (`validators.queries.js
  findMemberPeers`), the answers carrying `chain` grouped by tail, the
  largest group more than half of them or the pass waits the timeout and
  sweeps again; that group's tail is the network's, the leader most of the
  group names is the leader, the group's validators are the sources,
  lowest id first. Then the states of 19.3.
- **The ignored flag and the counted rule.** `validators.ignored BOOLEAN NOT
  NULL DEFAULT false`, the last column, with `ALTER TABLE validators ADD
  COLUMN IF NOT EXISTS` right after the table for a database that exists,
  the one alter of `db/schema.sql`, named in its header. `applyRegistry`
  reads whether the table has rows before the loop; `upsertValidator` sets
  `ignored` true on a row inserted into a table that had rows and on an
  update from inactive to active, false on a row inserted into an empty
  table, and leaves it alone otherwise. The registry hash is unchanged
  (`active` only). `validators.queries.js`: `findActivePeers` became
  `findCountedPeers` (active, not ignored, not own), `findActiveValidators`
  became `findCountedValidators` (the Map), `findActiveValidator` stays for
  membership (its row now carries `ignored`), new `findCountedValidator`,
  `findMemberPeers`, `findLeaderId`, `findIgnoredIds`,
  `findNextCounted(afterId)` (the lowest counted id above it, wrapping) and
  `setIgnored(client, ids, flag)`. Every use moved to the counted form:
  the sender checks of the two approvals and the two proofs, the receipts
  inside a proof and its "nobody missing", `checkLeaderCall`,
  `receiveFinalDeclaration`'s `nextLeader`, `leadRound`'s hand-over
  (`findNextCounted(own id)`), every send. A message from an ignored
  validator is refused with `validator N is ignored`
  (`validators.service.js findCountedSender`, which attachments.service.js
  uses too).
- **The same message twice.** `receiveTransactionApproval`: after the
  sender check, a holding table already holding the carried transaction
  with an equal `og_transaction` (canonical JSON of both) answers the
  approved receipt again; a conflict from another submission refuses as
  before. `receiveProofOfAcceptance` no longer refuses a row already
  approved, checks the receipts as before, and answers the accepted
  receipt whether `markApproved` changed a row or not.
  `receiveAttachmentApproval`: a follow-up with the same `attachmentId`
  already stored for the transaction answers the approved receipt.
  `receiveProofOfAttachmentAcceptance`: an attachment already approved
  passes the receipt checks and answers the accepted receipt without
  `markApproved` and without `onAccepted` again. The leader calls needed
  nothing.
- **Env and schema.** The six variables of 19.4 in `network/testnet.env`
  and `env.network`, all `requiredInteger`; the column and the alter above.

Step 2:

- **The votes.** The table `ignore_votes` (19.4) and the folder
  `src/votes/`: `votes.messages.js` (the three messages built, signed,
  sent and checked; `settleNoAnswers`, the originators' report and wait),
  `votes.service.js` (the voter, the proof's receiver, the report's
  receiver, `runVote` the starter's side, the report queue),
  `votes.queries.js`, `votes.handlers.js`; the router lines in
  `validators.router.js`. The request's checks and the voter's own health
  check of each named validator, the proof's checks and its apply in one
  transaction, the starter's rule (passed when every voter answered yes;
  failed stored with the receipts got; a silent voter fails an ignore vote
  and one new vote names it as well; the proof applied to the own table
  first, then sent to every counted validator, the named of an include
  vote among them) are 19.3, as the plan's 1.6 lists them. A proof already
  stored answers the accepted receipt again. The starter checks the floor
  itself before sending (decision 8), and drops from an ignore vote an id
  that is ignored already, not an active row, or reachable. The vote
  request's call waits twice `VALIDATOR_CALL_TIMEOUT_SECONDS`
  (`postToValidators` takes a `timeoutSeconds` for it): a voter's own check
  of a silent validator takes one timeout before the voter can answer, and
  with the plain timeout the starter gave up on every voter just as they
  voted, which the rig showed (19.5).
- **The report and the originator's wait.** `POST /no-answer-report`, to
  the leader or, when the leader is named or gives no answer, to
  `findNextCounted(leader)`; the receiver answers `200 {}` at once and
  then, if it may start a vote (the leader, or the next in the ring when
  the ids hold its leader), `startVote`: `runVote` in a busy section of its
  own, or the ids into the queue while a round, a vote or a join holds the
  flag; the queue is drained by whoever ends a busy section, then
  `runLeader`. The four originators (`receiveCreateAccount`,
  `receiveAnosTransfer`, the fund's `receiveTransaction`,
  `receiveAttachment`) pass their approvals through `settleNoAnswers`: the
  report, the poll of the own table once a second for at most
  `NO_ANSWER_WAIT_SECONDS` until every silent validator is ignored, the
  one re-send to the ones still counted (`sendTransactionApproval` and
  `sendAttachmentApproval` take an optional peer list), `validator N gave
  no answer twice` with `approved: false` as a refusal gives today.
- **The leader round and the busy flag.** `leading` became `busy` in
  `validators.service.js` (`takeBusy`, `releaseBusy`, `isBusy`), covering
  a round, a vote and a join; `runLeader` drains the report queue after
  its round. `leadRound` is a loop: a `noAnswer` entry from the ready
  announcement or the official list runs `runVote` for those ids inside
  the same busy section (`settleRoundAnswers`); a passed vote starts the
  round again from step 1; a failed vote sends that step's call once more
  to those peers (`sendReadyAnnouncement` and `sendOfficialList` take an
  optional peer list), and a second no answer ends the round with a line;
  the leader's own write of step 3 comes right after the send, before the
  vote, so it stands with the peers' writes. No answer to the final
  declaration is logged only.
- **Joining.** `src/validators/join.service.js`, both sides: the leader's
  hold (`joining`, the busy flag, the timer of `JOIN_HOLD_SECONDS`), the
  three messages and the seven states of 19.3; the joiner's loop
  (`startJoinLoop`, from `server.js` after listen) per the plan's 1.9, and
  the handshake per 1.8. The held rows: `src/held-transactions/
  held-rows.service.js`, `readHeldRows` on the leader (every column in
  camelCase, bytes as hex, JSONB as it is, timestamps ISO 8601; child rows
  under `arbitrations` and `votes`) and `storeHeldRows` on the joiner (the
  shape of every column; the transaction's signature and id checks by its
  type, the replay's helpers; every stored follow-up's signatures,
  `attachments.service.js checkAttachmentSignatures`, lifted out of
  `verifyAttachment` the way 1.3's helpers were; the insert with every
  column as received, children with it, plain inserts of its own; a row
  present with the same `og_transaction` skipped, with another one the
  pull stops and the joiner starts over). `counted` is the module flag of
  `join.service.js`; `app.js` answers 503 `{ error: "not counted yet" }`
  to every POST but `/proof-of-ignore-vote` and `/chain-links` while it is
  false; `GET /health` always answers. Every send goes through
  `validators.messages.js postToPeers`, which hands the answers to
  `join.service.js noticeIgnoredAnswers`: more than half of the peers
  answering `validator <own> is ignored` clears `counted` and runs the loop
  again.
- **The amendment: a joiner adopts the network's ignored list.** Decided
  by the user in the build chat on 2026-11-07, when the build found that
  the plan gives a joiner no way to learn who the network ignores (a wiped
  database applies the registry to an empty table, so every row starts
  counted there, and a validator that was away missed the proofs), which
  would have stopped the second joiner of the relaunch: its proof check
  "no counted validator missing" counts validators the network ignores.
  Health already carries `ignored`. The own table takes the list in two
  places (`replay.service.js adoptIgnoredList`, `validators.queries.js
  setIgnoredList`: the named rows ignored, every other active row counted,
  one line when something changed): after every majority sweep of the
  catch-up pass and of the loop's first step, the list most of the
  majority group's members name, counting only members that count
  themselves and run the same registry hash as this validator (a member on
  an older registry cannot know a row it lacks, and a mob of fresh joiners
  can form the majority with empty lists); and before the handshake, the
  leader's list from its health under the same two conditions. A
  validator named in an include vote applies the proof although its own
  row names it (the request checks "not this validator" and "every named
  is ignored" are relaxed for that one id), so a joiner whose own row the
  adoption did not reach still joins.

### 19.2 The messages

Step 1 adds the chunk read; step 2 the six below it.

`POST /chain-links`, from a validator catching up to any active validator:

```
payload: {
  type:          "chainLinks"
  validator:     the id of the validator asking
  afterPosition: integer >= 0
  limit:         integer 1..CHAIN_CHUNK_LINKS
  sentAt:        ISO 8601
}
signature: { key }
```

The answer, `200`:

```
payload: {
  type:          "chainLinksList"
  validatorFrom: the answering validator
  validatorTo:   the asker
  afterPosition
  links: [ { position, accountId: hex | null, accountIdTo: hex | null,
             transactionId: hex, amount: decimal string (millionths),
             transHash: hex, recordHash: hex, type, createdAt: ISO 8601,
             ogTransaction }, ... ]
  sentAt
}
signature: { key }
```

The receiver checks the shape; `limit` at most `CHAIN_CHUNK_LINKS`; that
`validator` is an active registry row, ignored or not, whose key verifies
the signature. The asker checks the answer as it checks a receipt: `200`,
the shape (every link's fields by type), the signature against the registry
key of the validator it asked, `validatorFrom`, `validatorTo` and
`afterPosition`. Any failure of the asker's check, no answer included, is
one failed source of the catch-up pass.

`POST /ignore-vote`, the request, from the starter to every counted
validator except itself and except the named:

```
payload: {
  type:         "ignoreVote"
  action:       "ignore" | "include"
  validatorIds: [ id, ... ]   distinct, ascending
  voteId:       hex, the SHA-256 of the canonical payload without voteId
  startedBy:    the starter's id
  sentAt:       ISO 8601
}
signature: { key }
```

The answer, `200`:

```
payload: {
  type:          "ignoreVoted"
  voteId
  vote:          "yes" | "no"
  results:       { "<id>": "ok" | "<reason>", ... }   one per named validator
  validatorFrom: the voter
  validatorTo:   startedBy
  sentAt
}
signature: { key }
```

`POST /proof-of-ignore-vote`, from the starter to every counted validator
except itself, and for an include vote to the named validators too:

```
payload: {
  type:      "proofOfIgnoreVote"
  voteId
  request:   { payload, signature }   the request as sent
  receipts:  [ { payload, signature }, ... ]   every yes receipt, by validator id
  startedBy
  sentAt
}
signature: { key }
```

The answer, `200`:

```
payload: {
  type:          "ignoreVoteAccepted"
  voteId
  validatorFrom: the receiver
  validatorTo:   startedBy
  sentAt
}
signature: { key }
```

`POST /no-answer-report`, from any counted validator to the leader, or,
when the leader is among the ids or gave no answer to the report, to
`findNextCounted(leader)`; answered `200 {}` at once:

```
payload: {
  type:         "noAnswerReport"
  validatorIds: [ id, ... ]   distinct, ascending
  reporter:     the reporting validator's id
  sentAt
}
signature: { key }
```

`POST /join-request`, from the joiner to the leader, repeated; a receiver
that is not the leader per its own table answers `400 { error: "not the
leader", leader }`:

```
payload: {
  type:           "joinRequest"
  validator:      the joiner's id
  tailPosition
  tailRecordHash: hex
  sentAt
}
signature: { key }
```

The answer, `200`:

```
payload: {
  type:           "joinAnswer"
  state:          counted | behind | busy | catchUp | voting | included | refused
  reason:         present with "refused"
  leader:         the receiver's id
  tailPosition
  tailRecordHash
  validatorFrom, validatorTo, sentAt
}
signature: { key }
```

`POST /held-rows`, from the joiner to the leader while `included`:

```
payload: {
  type:               "heldRows"
  validator:          the joiner's id
  table:              "pending" | "locked_transactions" | "assisted_transfers" |
                      "escrow_transfers" | "fund_proposals"
  afterTransactionId: hex | null
  limit:              integer 1..HELD_ROWS_PAGE
  sentAt
}
signature: { key }
```

The answer, `200`: `{ payload: { type: "heldRowsList", validatorFrom,
validatorTo, table, rows: [ ... ], sentAt }, signature }`: the table's rows
ordered by `transaction_id`, above `afterTransactionId`, at most `limit`,
each row every column of the table in camelCase (bytes as hex, JSONB as it
is, timestamps ISO 8601), plus `arbitrations` for an escrow row and `votes`
for a proposal row, each child row every column the same way.

`POST /ready`, from the joiner to the leader:

```
payload: { type: "ready", validator, tailPosition, tailRecordHash, sentAt }
signature: { key }
```

The answer, `200`: `{ payload: { type: "readyAccepted", validatorFrom,
validatorTo, sentAt }, signature }`; `400 behind` when the tail is not the
leader's. Every answer of this section is checked by its asker as a
receipt: `200`, the shape, the signature against the registry key of the
validator asked, `validatorFrom` and `validatorTo`.

### 19.3 The states and the checks

The replay, per link, in order, a failure rolling the chunk back with the
line `chain replay: <reason>`, the reason naming the position:

1. `position` is the own tail's position plus one (the tail read once at
   the start of the chunk on the chunk's connection, then the link just
   written): `expected position P, got Q`.
2. `transHash` is the SHA-256 of the canonical JSON of
   `ogTransaction.payload`, for every type.
3. `recordHash` is the SHA-256 of `transHash` followed by the previous
   link's `recordHash`, raw bytes, the `transHash` alone for the first link
   ever.
4. `type` equals `ogTransaction.payload.transactionType`.
5. The type's checks, which also give what its write puts in the row:
   `accountCreation`, checks 1 to 3 of `verifyCreateAccount`; the five
   transfer types, the shape, the signatures under the type's rule against
   the sender's account as the own table has it by then and the
   transactionId rule; `transferToFund` and `fundProposal`, the shape,
   signature and id parts of their verify functions; `transferFromFund`, no
   signatures, the link follows a `fundProposal` link or a
   `transferFromFund` link of the same proposal (at the start of a chunk
   that is the own tail link, its proposal found by id), and its payload is
   the `payoutObject` of the next index.
6. `transactionId`, `accountId`, `accountIdTo` and `amount` equal what the
   type's write function puts there (amount 0 for an account creation and a
   proposal; a payout link's `transactionId` is its `transHash`).
7. The side effect, then `insertLink` with the chunk's `createdAt`; the
   position the identity column gives equals the link's.

The catch-up pass, after each sweep:

| Own chain | Outcome |
| --- | --- |
| no majority tail (the largest group holds half or fewer of the answers that carry `chain`) | `no majority tail: <n> of <m> health answers carry a chain tail`; wait the timeout; sweep again |
| position above the network's | `own chain is ahead of the network`; the pass stops |
| position equal, hash equal | caught up |
| position equal, hash different | `own chain differs from the network at position P; wipe the database and start again`; the pass stops |
| position below | chunks from the first source, `afterPosition` the own position, `limit` the smaller of `CHAIN_CHUNK_LINKS` and what is missing, each replayed, until the own position is the network's; no answer, an empty chunk or a failed chunk moves to the next source; none left, wait and sweep again; at the tail, the hashes compared as above, then sweep again, since the tail may have moved |

The counted rule, per message: a transaction or attachment approval, a
proof, a leader call from a validator that is active and ignored:
`validator N is ignored`; from no active row: `<field> N is not an active
validator` as before. A receipt inside a proof from a validator that is not
counted: `receipts[i]: validatorFrom N is not a counted validator`; a
counted validator missing from a proof: `no receipt from validator N`. A
final declaration naming a validator that is not counted: `nextLeader N is
not a counted validator`. The chunk read needs membership only.

The vote request, on a voter, in order: the shape; `startedBy` is a
counted validator whose key verifies the signature; `voteId`; the starter
rule: `startedBy` is the leader per the voter's own table, or, when the
action is ignore and the named hold the voter's leader, `findNextCounted(
leader)`; every named id is an active row, not `startedBy`, not the voter
itself; for ignore none is ignored already, for include every one is
ignored; for ignore the floor: counted minus named, times 100, at least
`IGNORE_FLOOR_PERCENT` times the active rows, else `below the floor`. Then
the voter's own check of each named validator: health within the timeout,
`reachable` when it answered 200 with `chain.position`, `chain.recordHash`
and `leader` equal to the voter's own. Yes for ignore when no named
validator is reachable, yes for include when every one is, no otherwise.

The proof, on every validator that applies it: the shape; a `voteId`
already stored answers the accepted receipt again; `startedBy` as above;
the request inside is this vote's and passes every check above but the
health check (a receiver named in an include vote is allowed, its own
row's flag not required); every receipt: the shape, from a counted
validator other than `startedBy` and the named, genuinely signed, this
`voteId`, yes, `validatorTo` `startedBy`, no validator twice; no counted
validator missing (counted, minus `startedBy`, minus the named). Then one
transaction: ignore sets the flags and, when the named hold the leader,
`setLeader(startedBy)`; include clears the flags and `setLeader(startedBy)`;
the row stored, outcome passed.

The join, the leader's answer per the joiner's state:

| `state` | When | The joiner then |
| --- | --- | --- |
| `counted` | the joiner is counted in the leader's table and its tail equals the leader's | is done: counted |
| `behind` | counted, but its tail is not the leader's | runs the catch-up pass and asks again (the leader does not hold) |
| `busy` | a round, a vote or another join is in progress | asks again after `VALIDATOR_CALL_TIMEOUT_SECONDS` |
| `catchUp` | not counted; the leader now holds (busy on, `joining = { id, since }`); the joiner's tail differs from the leader's | fetches chunks from the leader only, up to the leader's tail, replays, asks again |
| `voting` | the tails are equal; the leader has started the include vote naming the joiner, once per hold | asks again after a second |
| `included` | the vote passed and the proof went round | pulls the held rows, then sends ready |
| `refused` | the vote failed, `reason` says why; the hold is over | waits `VALIDATOR_CALL_TIMEOUT_SECONDS` and starts over from the catch-up pass |

A second validator asking while one is joining gets `busy`. The hold ends
with ready, with refused, or when `JOIN_HOLD_SECONDS` have passed since
`since`: then `join of validator N timed out`, and, when the include vote
had passed, an ignore vote naming the joiner; busy off, the queue drained,
`runLeader`. The held rows and ready: the receiver must be the leader and
the sender `joining.id`; ready also needs the tail equal to the leader's,
else `400 behind`, and the joiner fetches from the leader (its tail from
the leader's health) and sends ready once more.

The loop every boot runs: the health sweep (no answer at all: `no
validator answers yet`; no majority: the no-majority line; both again
after the wait), the majority's leader and ignored list into the own
table; own id is the leader: counted, `leading at position P`; the
catch-up pass (a stop ends the loop, the validator serving but not
counted); the handshake until `counted at position P`. A refusal, no
answer from the leader, `not the leader` or a stopped pull goes back to
the sweep after the wait.

### 19.4 Files and variables

Step 1, new: `src/garlic-chain/chain-links.service.js`,
`chain-links.handlers.js`, `chain-links.queries.js`, `replay.service.js`;
`src/validators/join.service.js` (the counted flag in step 1; the join in
step 2).

Step 2, new: `src/votes/votes.messages.js`, `votes.service.js`,
`votes.queries.js`, `votes.handlers.js`;
`src/held-transactions/held-rows.service.js`. Step 2, changed:
`db/schema.sql` (the table), `src/app.js` (the 503 middleware),
`src/server.js` (`startJoinLoop`), `src/validators/join.service.js`,
`validators.service.js`, `validators.messages.js`, `validators.queries.js`
(`findCounts`, `setIgnoredList`), `validators.router.js` (six lines),
`validators.handlers.js` (the three join handlers),
`src/garlic-chain/replay.service.js` (`fetchChainFrom`, `ownTail` and
`adoptIgnoredList` exported; the sweep's `ignored`),
`src/attachments/attachments.service.js` (`checkAttachmentSignatures`,
`settleNoAnswers`), `src/accounts/accounts.service.js`,
`src/transfer/transfer.service.js`, `src/fund/fund.service.js`
(`settleNoAnswers`), `README.md`, this file.

Step 1, changed: `network/testnet.env`, `src/config/env.js`,
`db/schema.sql`, `src/validators/validators.client.js`,
`validators.queries.js`, `validators.messages.js`, `validators.service.js`,
`validators.router.js`, `registry.service.js`, `registry.queries.js`,
`src/attachments/attachments.service.js`, `src/health/health.service.js`,
`health.router.js`, `src/garlic-chain/garlic-chain.queries.js`,
`src/accounts/accounts.service.js`, `src/transfer/transfer.service.js`,
`transfer.queries.js`, `src/fund/fund.service.js`,
`src/pending/pending.queries.js`,
`src/locked-transactions/locked-transactions.queries.js`,
`src/held-transactions/held-transactions.js`, `README.md`, this file.

| Variable | Value | Field |
| --- | --- | --- |
| `VALIDATOR_CALL_TIMEOUT_SECONDS` | 10 | `env.network.callTimeoutSeconds` |
| `IGNORE_FLOOR_PERCENT` | 51 | `env.network.ignoreFloorPercent` |
| `JOIN_HOLD_SECONDS` | 120 | `env.network.joinHoldSeconds` |
| `NO_ANSWER_WAIT_SECONDS` | 60 | `env.network.noAnswerWaitSeconds` |
| `CHAIN_CHUNK_LINKS` | 100 | `env.network.chainChunkLinks` |
| `HELD_ROWS_PAGE` | 100 | `env.network.heldRowsPage` |

All six `requiredInteger`, in `network/testnet.env` with a comment block,
so a validator with an old env file stops at boot naming the variable.

### 19.5 Notes from the build

Where the plan was silent, or named something the code could not take
literally, the simplest thing was chosen and is recorded here; nothing in
19.1 was changed.

Step 1:

- **The repeat of an approval is found before the verification**, not when
  the insert conflicts as the plan says: the uniqueness checks of every
  verify function refuse "already pending" before any insert, so a hook on
  the insert's conflict would never see an exact repeat. After the sender
  check, `findHeld` reads the row and `og_transaction` is compared as
  canonical JSON; to that end `findPending`, `findLocked` and `findHeld`
  now return `ogTransaction` beside `approved`.
- **The lifted helpers read the sender's account on the replay's
  connection**: `findAccount(accountId, client)` takes an optional client
  (the pool when absent), passed by the replay, since an account created
  earlier in the same chunk is not committed yet and would be invisible to
  a read through the pool. The lifts change the order of a few checks in
  the verify functions: a transfer's lock window and account type now run
  after the signatures and the transactionId; a transfer to the fund's
  minimum and account type likewise; a proposal's date, proposer weight
  and recipient lookups after its signatures, ids and payout fields. The
  README's transfer section says the new order; sections 4.3 and 4.4 above
  describe the checks as designed and are left as they were.
- **`findMemberPeers(ownId)`** was added (active, ignored or not, not own)
  for the health sweep, since the plan renamed `findActivePeers` to the
  counted form and the sweep must ask every member.
- **`getHealth`** in `validators.client.js` is the one place a doorman's
  `worker` is unwrapped, for the three readers; a body that is not JSON
  counts as no answer (`answer is not JSON`), like a body that cannot be
  read.
- **Health reads the tables on every call**, so `identity()` is async and
  the router awaits it; when the database cannot be read the three fields
  are null and the status says `degraded` as before. `counted` is false on
  every validator until step 2's loop sets it; the flag lives in
  `join.service.js`, created in step 1 with the flag alone.
- **`findTailRow(client = pool)`** takes an optional client; the replay
  reads its tail with `findTailLink` and a payout tail's proposal with
  `findLinkPayload`, both in `chain-links.queries.js`.
- **The cap on `limit`** is checked after the shape, in the service, so the
  shape function the doorman copies has no env variable in it; the shape
  requires a positive integer, the service `at most CHAIN_CHUNK_LINKS`.
- **`insertLink`** writes `coalesce($9::timestamptz, now())` into
  `created_at`, so every existing caller gets now() as before, and returns
  `position` for every caller.
- **The sweep** keeps an answer whose body carries an object `chain` with
  an integer `position` and a string `recordHash`, whatever the status;
  the majority is of the kept answers; the leader is the id most of the
  group names, the lower id on a tie, null when most name none. An empty
  chunk from a source counts as a failed source. The log lines: `network
  tail: position P, k of n agree, leader L`, `replayed N links from
  validator V, now at position P`, `validator V sent no chain links:
  <reason>`.
- **A link of another type after an unfinished proposal** is not refused:
  the plan constrains a payout link only, and the record hashes are the
  network's agreement; the open proposal is simply dropped.
- **An attachment repeat** is recognised by `attachmentId`, the hash of the
  payload; the signatures of the repeat are not compared. A repeated proof
  of attachment acceptance whose row another request marked just before
  leaves the effect to that request.
- **A receipt inside a proof from an ignored validator** is refused as
  `is not a counted validator`; the sender itself as `validator N is
  ignored`.
- **`sendFinalDeclaration`'s answers** carry `noAnswer`; step 2's leader
  round logs those as `gave no answer to the final declaration`.

Step 2:

- **A silent voter in an include vote** fails it with no second vote: the
  plan's "one new vote naming that peer as well" is read for ignore votes,
  where the silent peer joins the named; naming it in an include vote
  would ask the voters to include a validator that is not ignored. The
  joiner gets `refused` and starts over after the wait.
- **The request checks on a validator named in an include vote** skip
  "not this validator" and "every named is ignored" for that one id (19.1,
  the amendment), since the plan's "it applies the proof as above" cannot
  hold otherwise.
- **The starter's pre-check of an ignore vote** also drops an id that is
  ignored already in its own table or not an active row, beside one that
  answers, with a line each; the voters would refuse those anyway.
- **The report's receiver drops a report it may not act on** with a line
  naming the leader; the plan says only when it may start a vote.
- **`startVote` is the busy-section wrapper around `runVote`**: the
  report handler and the drained queue go through it; the round and the
  join call `runVote` directly inside their own busy sections, as the plan
  says. `runLeader` ends its section by draining the queue only, since
  calling itself again would never end; a vote's and a join's end drain
  the queue and call `runLeader`.
- **The vote is started in the background by the join request** that
  finds the tails equal: a voter's health check of the joiner takes up to
  the timeout, longer than the joiner's own call timeout, so the request
  answers `voting` at once and the joiner asks again a second later.
- **The leader's `not the leader` answer is a plain 400 body**, unsigned
  like every refusal; the joiner goes back to the sweep rather than
  trusting it, which finds the leader again.
- **`behind` on ready**: the joiner reads the leader's tail from its
  health, fetches from the leader and sends ready once more; a second
  `behind` goes back to the sweep.
- **The held rows' column names on the wire** are camelCase of the column
  names as they are (`attestation1`, `attestation1Approved`,
  `voteClosesAt`, `proposerWeight`); the joiner's shape check wants every
  column of the table present with the right JavaScript type, and the
  insert names every column.
- **The lift of `checkAttachmentSignatures`** moves the held-row and stake
  checks of `verifyAttachment` after the signatures, as 1.3's lifts did
  for the transactions.
- **`findCounts`** (active rows, counted rows) in `validators.queries.js`
  serves the floor on both sides.
- **The 503 middleware** sits before the body parser and after cors, so a
  wallet's browser gets the CORS headers with the 503; `OPTIONS` and `GET`
  pass.
- **A repeat answers a receipt built afresh**: the same type and ids, a
  new `sentAt` and signature, not the bytes of the first answer, which are
  not stored.

The rig (the plan's section 3), 2026-11-07, on this Mac, everything in the
chat's scratchpad and nothing in either repo: six copies of the working
tree with `node_modules` linked; databases `anosrig1` to `anosrig6` on
Homebrew PostgreSQL 17 by `scripts/setup-db.sh`, under a role of the rig's
own, `anosrig`, so the Mac's `anossoftware` role kept its password; a key
per validator made by make-keys' own code into an owner-only file, the
six per-validator values given as environment variables instead of `.env`
files (Node lets the environment win over `--env-file`) and
`MASTERPOD_URL` the same way, pointed at a stub on port 3199; a registry
with `http://127.0.0.1:310N`, five rows then six; the genesis pair made by
a copy of `anossoftwarescripts/make-genesis-accounts.mjs` with its keys
path moved into the scratchpad (the Desktop keys file of the development
chain stayed as it was), into copy 1 and copied to the other five;
transfers by a copy of the OG signer with its keys path moved the same way;
a guarded account and its guarded transfer by two small tools of the rig.
No doorman: the validators called each other directly. Dropped after: the
six databases and the role.

What it showed, in the plan's order:

1. Five up on the five-row registry, validator 1 `leading at position 2`,
   the others `counted at position 2`. Ten transactions written, the tail
   at position 12 with one record hash on all five, the leadership round
   every validator. Row 6 into every copy and the five restarted one at a
   time, each counted again within two seconds, row 6 ignored on all five
   (the first restarted took no list from the others, whose registry hash
   differed; the next ones found it on the first). Validator 6 on an empty
   database, with `CHAIN_CHUNK_LINKS` 3 for that one boot: `ignored
   validators adopted from the network: 6`, four chunks of 3, 3, 3 and 1,
   the include vote with four yes votes, the proof applied on all six,
   `counted at position 12`. The next transaction landed on all six.
2. Validator 4 stopped; a transaction to validator 2: the report to the
   leader (itself), `ignore vote bd1375ab naming validator 4: 4 voters`,
   every voter yes with `no answer: fetch failed: connect ECONNREFUSED`,
   4 ignored and the vote's row on all five, the transaction written by
   five. A second transaction with 4 still down went through with no vote.
3. A guarded account made, funded by the OG account, and a guarded transfer
   dated twelve minutes ahead left approved in `locked_transactions` on the
   five. Validator 4 started again: `adopted from the network: 4`, four
   links replayed, the include vote, `join: included`, the five tables
   pulled (`held rows of locked_transactions: 1 received, 1 stored`),
   ready, `counted at position 17`; the next round wrote on all six and the
   locked row sat on 4 approved with its date.
4. The leader (3) stopped while idle; a transaction to validator 2: the
   report went to validator 4, the next in the ring; 4 started the vote
   naming 3, four yes votes, `validator 3 ignored; validator 4 is the
   leader` on every table, the transaction written by five, the leadership
   handed on. The old leader started again: `validator 5 is the leader`
   adopted, `adopted from the network: 3`, one link replayed, the include
   vote, the held rows (`1 received, 0 stored, 1 already here`), counted.
5. A transaction built by the signer, wrapped by hand in an approval signed
   by validator 2 and posted twice to validator 3: 200 and a
   `transactionApproved` receipt both times (validator 3 logged `correct`
   twice). The approval to the other five for their receipts, the proof
   signed by validator 2 posted twice to validator 3: 200 and a
   `transactionAccepted` receipt both times; the proof to the others, and
   the leader's round wrote the transaction.
6. Validator 6 stopped and ignored by a vote (five counted of six active);
   then 3, 4 and 5 stopped; a transaction to validator 2: the report named
   three, `no ignore vote naming validators 3, 4, 5: below the floor (5
   counted of 6 active)`, the originator waited its minute, re-sent once,
   `validator N gave no answer twice` three times, the submission failed
   as a refusal does. The three came back `counted` at once (never
   ignored), 6 by its include vote.
7. Validator 6 stopped, a TCP server on its port that accepts and never
   answers; a transaction to validator 2 at 16:53:51: the approval timed
   out at 16:54:01 (`The operation was aborted due to timeout`), the report,
   the starter's own check of 6 until 16:54:11, the voters' checks until
   16:54:21, four yes votes, 6 ignored, the transaction written at
   16:54:21. The black hole killed and 6 started again: it was voted in and
   counted at position 23.

Two things the rig found in the build, both fixed before the scenarios
that show them: the leader's join answer tested "counted here" before "the
joiner I hold rounds for", so once the include vote had passed the joiner
was told `counted`, never `included`, and the hold ran to its two-minute
timeout (which worked: `join of validator 6 timed out`, `validator 6
answers; no vote`, `rounds released`, the round); and the vote request's
plain timeout, above. Done by hand on the rig: after the failed
submissions of scenario 6 and of the first run of scenario 7 the stray
unapproved `pending` rows were deleted, since a refused submission leaves
them for good (the follow-up below).

What the rig could not show: the doorman (its seven entries went through
`node --check` and a shape check with no worker behind them); the held
rows of `assisted_transfers`, `escrow_transfers` and `fund_proposals`,
with their attachments and child rows (only `pending` and
`locked_transactions` rows were pulled); a chain that is ahead of or
differs from the network's (the two stops of the pass); the join states
`behind`, `busy`, `refused` and the answer `not the leader`; two joiners at
once; a joiner that stops answering during its hold (the timeout's ignore
vote on a reachable joiner was shown, on an unreachable one not); a
counted validator refused as ignored by its peers (`noticeIgnoredAnswers`);
a silent peer during the official-list step of a round (every silence hit
the approvals first); the relaunch's sixteen rows and ten joiners; the
masterpod, the keyholder and the wallet.

Follow-ups, from the plan's section 5 and the build:

- A validator that misses an official list it should have written (no
  answer twice, or a refusal, at step 3 of the round, which ends the
  round) keeps those transactions approved in its holding tables while the
  others wrote them; a later round would write them again on that
  validator alone. The round ends there today as a refusal did before this
  build; a cut of those rows against the chain belongs with the split-list
  follow-up below.
- A validator that wrote a batch the others did not (a split official
  list) needs a cut back to the last common link before it can catch up;
  today it logs `own chain is ahead of the network` and stops.
- A refused approval leaves unapproved rows on the other validators for
  good and blocks that account; a withdraw message or an age limit. Built
  as the age limit, 2026-11-07 (section 21).
- Logs and archives are not copied to a joiner.
- The held rows' approved flags come from the leader on trust.
- A validator that is up but cut off from everyone learns it is ignored
  only when its own sends are refused.
- The registry stays read at boot; adding a validator stays a pull and
  restart on every VM.
- The wallet's answer to 503 `not counted yet` from the validator it
  picked.

A call to another validator does not follow a redirect (2026-11-19).
Built from `~/Desktop/Z-TestNet/forclaude/validator-redirects-plan-1.md`
(FINAL, 2026-11-19), its step 2 of two, its section 2, one commit, on main
at b2dcc2d. Two lines of code in `src/validators/validators.client.js`: in
`postToValidators` the options of the `fetch` gain `redirect: 'manual'`,
after the `body` line, and in `getFromValidator` they become `{ redirect:
'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }`. The comment at the
top of that file gains one sentence, and the point "The timeout" of 19.1
one dated sentence. The README's paragraph "The timeout." gains one
sentence too: the plan does not name it, the build's first report listed
it as left, and the user said the same day to add it ("add that one
sentence to the two places"). No message, no route, no variable, no table
and no npm package; the doorman and the keyholder are not touched. A
validator with this change and one without it work together.

- Why. A redirect is an answer that says "ask this other address
  instead". Node's `fetch` follows one by itself, up to 20 in a row. Both
  calls go to another validator's doorman, a machine this validator's
  operator does not run. Whoever runs that doorman, or breaks into it,
  could so pick another address for the call, and this validator would
  make that call from inside its own network, where addresses answer that
  the outside cannot reach. After a 307 or a 308 Node sent the POST again
  to that address with the same body, which is this validator's signed
  message. The same word already stands in the doorman's relay to its
  worker (`doormansoftware/src/door/forward.js`) and in the monitor's
  sweep (`monitorsoftware/server/sweep/ask.js`), and step 1 of the plan
  puts it into the masterpod's read of the DAO stakes
  (`masterpodsoftware/src/dao/validators.client.js`).
- What a redirect is now, in `postToValidators`: an entry with its own
  status, `{ id, url, status: 302, body: '' }` (the body is the redirect's
  own, when it has one). Every check of an answer reads a status that is
  not 200 as `answered 302: `, a refusal, as it reads any answer that is
  not a yes. It is not "no answer". No new handling was needed.
- What a redirect is now, in `getFromValidator`: with an empty body `{
  noAnswer: true, reason }`, since an empty body is not JSON; with a JSON
  body `{ status: 302, body }`. The health check (`checkReachable` in
  `src/votes/votes.messages.js`) reads the second as `health answered
  302`: not reachable. The look before a round
  (`src/validators/chain-ends.js`), the join and the replay read the body
  that `getHealth` hands them and not the status, as they read any body
  that validator sends with a 200. So a redirect gives its sender nothing
  it could not send anyway, and its target's words are no longer read as
  the validator's.
- What a person sees: nothing. Honest validators send no redirect.
- Left as it is, on purpose (the plan's decision 5): the call to the
  masterpod (`src/masterpod/masterpod.client.js`), the only other `fetch`
  under `src/`. The masterpod is our own server.
- Checked. `git status --short` showed a clean tree at b2dcc2d at the
  start, and this step's three files and no others at the end:
  `src/validators/validators.client.js`, this file and `README.md`.
  `node --check src/validators/validators.client.js` passes. The plan's
  two code lines are in the file once each, and the built file equals
  the planning chat's own trial file but for the new sentence of the
  comment. No validator was started or stopped and no database was
  opened. Beyond the
  plan's two checks, one throwaway run on loopback, on the user's Mac,
  Node v24.22.0: the real `postToValidators`, `getFromValidator` and
  `getHealth` of the working tree, loaded with made-up settings, in front
  of three made-up validators and one more made-up server, "the other
  address", which stands in for an address inside the calling validator's
  own network and answers words of its own. The script is in the build
  chat's scratchpad and nothing of it is in the repo. 54 checks, all as
  expected. A signed message posted to three validators at once, of which
  one answers 307 and one 302 with the other address as the target: three
  entries in order, the two redirects with their own status and an empty
  body, the good validator's answer as before, each validator asked once,
  and no call to the other address. Each of 301, 302, 303, 307 and 308
  alone, a redirect that carries a body, and one to a path on the
  validator's own address: the same. The read of `/health`: each of the
  five with an empty body is no answer, one with a JSON body comes back
  under its own status, `getHealth` unwraps a doorman's `worker` from it
  as from any body, and the other address gets no call. As before: a 200
  and a 400 with their bodies as text, a body that is not JSON, an address
  where nothing listens and a validator that never answers (no answer,
  with the reason, after the timeout), the longer timeout of one call
  (`timeoutSeconds`), a message of 2 MB arriving whole, and `getHealth`
  with and without a doorman. The file of b2dcc2d went through the same
  script: 26 of the 54 checks were as expected, and the 28 others are what
  this step changes. There the other address got the signed message again
  after a 307 or a 308 and a GET after a 301, 302 or 303; its words came
  back as the validator's answer, and as the validator's health, under the
  status 200; and a redirect to the validator's own address was followed
  twenty times before the call gave up as no answer. Not run: a doorman,
  TLS, a validator, a rig, a database, the masterpod.
- The round of pulls. The change is plain new code: it reaches a
  validator with the pull and the restart of a round, and a banker's pull
  has no extra step for it. Nothing is installed, no database is changed,
  no setting changes. After this step's commit the build adds its entry to
  the short list of the round's `pull_steps.md`
  (`Z-TestNet/upcoming_validator_pulls`).

## 20. The assisted signing rule (2026-11-07)

Decided 2026-11-07 in a one-round planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/assisted-signing-plan-1.md`. Why: an
assisted transfer was signed under a rule of its own, **pair one and the
wallet pair**: the user's pair one and the wallet's pair, all four
signatures present. Nothing moved out of an assisted account without the
wallet's signature, so the wallet held a kind of custody over it. A
spending, guarded, vault or escrow transfer moves on **any two pairs**: the
user's two pairs alone are enough, or one user pair with the wallet pair.
That was the intent for assisted accounts too; the separate rule was a
mistake. The two attestations are not touched: an assisted transfer still
waits for two attestors. One build step in this repo, with its doorman
part (doormansoftware `docs/schemas.md` section 4), built 2026-11-07,
deployed at the relaunch. Nothing here touches the wallet, the masterpod,
the keyholder or the database.

### 20.1 The decisions, as they apply to the code

- **One rule.** The signing rule of `assistedAnosTransfer` is **any two
  pairs**, the rule the other four transfer types use: at least two of the
  three pairs (pair one, pair two, the wallet pair), both halves of each
  pair present, every signature present verifying against the account's
  stored keys. The assisted row of `TRANSFER_TYPES`
  (`src/transfer/transfer.service.js`) says `ANY_TWO_PAIRS`. The two
  attestations, from two different attestors with attestor stake, neither
  the sender, stay exactly as they were (4.1, 5.2). Readiness, the cancel,
  the write and the move to `logs`: unchanged.
- **The old rule's code is gone.** `PAIR_ONE_AND_WALLET`, its list of
  pairs and its branch in `verifyAccountSignatures`
  (`src/accounts/account-signatures.js`) are deleted. The `rule` parameter
  of the check and `ANY_TWO_PAIRS` stay as they were, so the four callers
  (transfers, follow-ups, transfers to the fund, fund proposals) do not
  change; one rule is left, and the throw for an unknown rule stays. The
  catch-up replay (`src/garlic-chain/replay.service.js`) goes through
  `checkTransferSignaturesAndIds`, which reads the rule from the table, so
  it follows the change with no edit.
- **The refusal** for too few pairs is the one the other types give,
  `signatures must come from at least 2 of the key pairs key1, key2 and
  walletKey`; the reason `signatures must include key1 and
  postQuantumKey1`, and its twin for the wallet pair, are gone with the
  branch.
- **The wallet is not touched.** It signs every transfer with pair one and
  the signing server adds the wallet pair, which passes the new rule. A way
  for the wallet to sign with the two user pairs and no wallet signature is
  a testnet-month follow-up.
- **No pull round of its own.** The change rides the relaunch, where every
  doorman and worker pulls anyway (20.2).
- **What is already there.** A held assisted transfer signed under the old
  rule carries pair one and the wallet pair, which passes the new rule, so
  held rows survive the update unchanged. Every assisted link on the chain
  so far passes the new rule for the same reason, so a replay on the new
  code reads the old chain as before. Every account stores its second user
  pair at creation (`src/accounts/accounts.service.js`, `publicKey2` and
  `publicKeyPq2`), assisted accounts included, so an existing assisted
  account can sign with its two user pairs the moment the validators run
  the new code. No database or schema change.

### 20.2 The rollout

- **A mixed network does no harm to what is sent today.** Each validator
  checks a transfer's signatures itself when another asks it to approve
  (`src/validators/validators.service.js` calls `verifyAnosTransfer`). What
  the wallet sends, pair one and the wallet pair, passes both rules, so
  validators on the old code and on the new agree on every transfer the
  wallet makes.
- **A transfer signed by two user pairs needs every counted validator on
  the new code.** One on the old code refuses it, and the transfer gets no
  proof of acceptance. A validator that joins later replays the chain
  through `checkTransferSignaturesAndIds`, so it too must be on the new
  code to pass such a link. Nothing signs that way today, so there is
  nothing to hold back; the relaunch puts every validator on the new code
  before anything could.

### 20.3 Files

Changed: `src/transfer/transfer.service.js` (the assisted row of
`TRANSFER_TYPES`, the import, the comment on check 3) and
`src/accounts/account-signatures.js` (the deletions and the comments). No
file under `deploy/`, no package file and no schema file changes. In the
docs: the README's "Account signing rules" and its transfer table,
sections 1 and 4.1 above, and this section.

### 20.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 20.1 was changed.

- **Main had moved on.** The plan names main at b93b8cb; the build was
  made on 385c6b5, the merge of the `updatevalidator18` branch. Every line
  the plan quotes was where it said, so the text was followed as it stood.
- **Nothing else named the old rule.** A search of the repo for
  `PAIR_ONE_AND_WALLET`, `pairOneAndWallet` and "pair one and the wallet"
  found only the spots the plan lists, plus `docs/build-plan.md`, which is
  history and stays.
- **Section 1's bullet** lost its closing sentence "Today's transfer
  rule.", which set one rule against the other; with one rule it said
  nothing.
- **Checks.** `node --check` passed on both files. No server was booted,
  no test script was written and no rig was run (the plan's 1.4): what the
  wallet sends passes both rules, so nothing on a running network changes
  until something signs an assisted transfer with two user pairs, which
  nothing does today.

## 21. The age limit on unapproved held rows (2026-11-07)

Decided 2026-11-07 in a planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/unapproved-age-limit-plan-1.md`. Why: a
transaction is stored in its holding table with `approved = false` before
the approval round, on the originating validator and on every peer that
approves it. When one validator refuses, the round ends there (section 19:
a refusal is a refusal, and no answer twice counts as one). The
originating validator never sends the proof of acceptance, and nothing
tells the others to drop their rows, so they stay for good, on the
originating validator too; the refusing validator holds nothing. Because
`account_id` is unique in every holding table, the account can then send
nothing through a validator that holds such a row, and a retry that
reaches the refusing validator gets stuck the same way on the rest. The
wallet is told `202` + `{ transactionId }` all the same
(`src/util/submission-response.js`), so the sender sees nothing but a
transfer that never arrives. On the rig of section 19 such rows were
deleted by hand. One build step in this repo; nothing touches the doorman,
the wallet, the masterpod, the keyholder, the registry or the database
schema.

### 21.1 The decisions, as they apply to the code

- **An age limit, nothing else.** Every validator drops, on its own, any
  held row that is still unapproved `UNAPPROVED_AGE_LIMIT_SECONDS` after
  it was stored: `300` in `network/testnet.env`, read as
  `env.unapprovedAgeLimitSeconds`, required at boot like the network
  variables of section 19. No withdraw message, no new
  validator-to-validator message and no round: an unapproved row is a
  reservation that only the proof of acceptance can turn into a
  transaction, and a round could itself be refused or go unanswered. The
  user, 2026-11-07: a refusal of this kind is rare, the timer is the easy
  fix, and in the rare case the sender waits.
- **Safe by the timing of section 19.** An approval round is over long
  before the limit: the sends with their `VALIDATOR_CALL_TIMEOUT_SECONDS`
  (10), the wait of at most `NO_ANSWER_WAIT_SECONDS` (60) for an ignore
  vote, the one re-send and the proof add up to well under two minutes,
  and in the normal case to seconds. A row unapproved past five minutes
  can no longer become approved, so dropping it changes nothing any
  validator writes.
- **A plain delete, in all five tables.** No move to `logs`, no trace but
  the log line `dropped unapproved <table> transaction <id hex>: older
  than 300 seconds`. An unapproved row has no follow-ups and no child rows
  (a follow-up is accepted on an approved row only, section 5), so the
  delete is one statement per table: `DELETE FROM <table> WHERE NOT
  approved AND created_at < now() - make_interval(secs => $1) RETURNING
  transaction_id`.
- **The sweep.** `src/held-transactions/unapproved-sweep.js`:
  `sweepUnapproved` runs the five deletes and logs each row dropped; a
  database error is logged (`unapproved sweep of <table> failed:
  <message>`) and the next sweep tries again. `startUnapprovedSweep`,
  called by `src/server.js` next to `startJoinLoop` once the server
  listens, runs it at once and then every minute (`SWEEP_EVERY_MS`), on
  every validator, counted or not, with the timer unref'd;
  `stopUnapprovedSweep` clears it at shutdown. Nothing waits on the sweep:
  a blocked account is free again within a minute of the limit passing.
- **The wallet's answer is unchanged.** `202` + `{ transactionId }`
  whatever the validators said, as before. A refusal answered to the
  wallet, and a withdraw message that frees the account at once, stay
  follow-ups.
- **What is already there.** Rows stuck on the live validators are dropped
  by the first sweep after the first boot on this code, so no hand deletes
  are needed at the relaunch. A validator on the old code keeps its stuck
  rows until it is updated; it harms nobody else.

### 21.2 Files

Changed: `network/testnet.env` (the variable and its comment),
`src/config/env.js` (`unapprovedAgeLimitSeconds`), `src/server.js` (the
import, the start after `startJoinLoop`, the stop in `shutdown`). New:
`src/held-transactions/unapproved-sweep.js`. In the docs: the README's
environment table and its holding tables paragraph, section 1 and the
follow-ups of section 19 above, and this section. No file under `deploy/`,
no package file and no schema file changes; the doorman is not touched.

### 21.3 Notes from the build

- **The parameter.** `make_interval(secs => $1)` was checked on PostgreSQL
  17 with a prepared statement and an untyped argument, the way pg sends
  one; the server infers double precision.
- **One level down.** The same thing can happen to a follow-up: an
  attestation, a cancellation, a vote, an escrow signature or a verdict
  that one validator refuses stays in its slot or row unapproved on the
  others, and a cancellation stuck that way keeps an assisted transfer off
  the ready list, and since 2026-11-11 a locked transfer too, a guarded or
  vault one (section 28): it is then never written and never removed. The
  slots are JSON columns with no time of their own, so an age limit there
  needs a time per slot. Not in this build; a testnet-month follow-up.

## 22. The break-glass transfer (2026-11-08)

Decided 2026-11-08 in a planning chat of five rounds, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/break-glass-plan-1.md`. Why: the two user
pairs of every account (pair one and pair two) were wrapped under the
anoPod encryption key, which the backup code also opens, so whoever rebuilt
a backup code held the original signing keys, and pair one with pair two
alone satisfies any two pairs. The recovery flow of 2026-10-26 handed a
recovered person exactly those keys back, and the break-glass seed
deposited with the keyholders for this very case was never used. From now
on the wallet wraps the signing keys under a key from the passkey's PRF
output alone: a lost passkey kills the old accounts' keys for good, and the
break-glass key is what moves the money, to new accounts of the same type,
through a new transaction type that two attestors sign like an assisted
transfer, so that a stolen break-glass key is pointless on its own. Four
repos in order, the validator (this step), the doorman (its spec, section
5), the masterpod (its section 14) and the wallet (its section 11), then
the architecture records; deployed after a reset of the testnet with a
fresh genesis, every validator and its doorman before the masterpod and
the wallet. This section is the validator's part, step 1 of the plan.

### 22.1 The decisions, as they apply to the code

- **A second signing rule.** `BREAK_GLASS_KEYS` and `BREAK_GLASS_PAIR` in
  `src/accounts/account-signatures.js`: the break-glass pair alone, both
  keys present and verifying against `break_glass_pk` and
  `break_glass_pk_pq`, and no signature from the three signing pairs beside
  them (`a breakGlassTransfer is signed by the break-glass pair alone`).
  The break-glass pair is not among `SIGNING_PAIRS` and never counts toward
  any two pairs; under any two pairs a stray break-glass signature is
  ignored, as any unknown field is. The per-key checks moved into
  `checkPair`, shared by the walk over the signing pairs and the
  break-glass branch, so every reason string exists once. `findAccount`
  (`src/transfer/transfer.queries.js`) returns the two break-glass keys as
  well, so every caller verifies with eight keys.
- **The sixth transfer type**, `breakGlassTransfer` (4.5), in
  `TRANSFER_TYPES` of `src/transfer/transfer.service.js` with `accountType`
  null (any of the four), `lockMinutes` null (the sender's type's, through
  `lockMinutesFor`: `GUARDED_LOCK_MINUTES`, `VAULT_LOCK_MINUTES`, else 0),
  held in `assisted_transfers`, rule `BREAK_GLASS_PAIR`.
  `checkTransferSignaturesAndIds` resolves the lock from the account row it
  reads in 2a and returns it; check 1b runs on it as for a guarded or vault
  transfer, check 2b is skipped when the type's account type is null, and
  a new check 6b, right after the receiver's existence, requires the
  receiver to be of the sender's type. For that, `findExisting`'s first
  `EXISTS` became a select of the receiver's type (`accountToType`), and
  `accountToExists` is that type being non-null. The shape check's reason
  names six types.
- **The stakes row moves with the money.** `moveStake` in
  `src/stakes/stakes.queries.js`: the whole row, all six purposes, added to
  the receiver's row (created when it has none), the sender's row deleted;
  a sender with no row moves nothing. `writeAnosTransfer` calls it after
  the link, inside the batch, as a transferToFund adds stake; the replay's
  `checkByType` (`src/garlic-chain/replay.service.js`) gives a break-glass
  link the same side effect. The roles move with it; guardians return
  stake to the new account with an ordinary proposal.
- **The unlock moment.** `assisted_transfers.future_date TIMESTAMPTZ`,
  NULL for an assisted transfer and for a move out of a spending or
  assisted account; `insertAssisted` stores the `futureDate`
  `verifyAnosTransfer` computes for a lock, which the registry's `insert`
  already passed on, and `findReadyAssistedIds` requires it NULL or passed,
  by the database's clock. The joiner's copy of a held row carries it
  (`src/held-transactions/held-rows.service.js`: the column in the table's
  spec, and a `nullable` list there so a null `TIME` passes the shape
  check; `locked_transactions`' `future_date` is never null). The trigger
  `garlic_chain_apply_anos_transfer` fires for the new type.
- **The cancel, either key.** `breakGlassCancel` (5.7),
  `src/assisted-transfers/break-glass-cancel.js`, in the shape of the
  assisted cancel with a `rule` member, `BREAK_GLASS_PAIR`;
  `checkAttachmentSignatures` (`src/attachments/attachments.service.js`)
  verifies under `kind.rule ?? ANY_TWO_PAIRS`, so the other seven kinds are
  untouched; `breakGlassCancel` is the eighth of `KINDS`.
  `assistedTransferCancel` and `attestation` check nothing about the row's
  type, so the owner's any-two-pairs cancel and the attestors' attestations
  attach to a break-glass row as to an assisted one. Route
  `POST /break-glass-cancel` on the assisted transfers router.
- **The reads.** `src/auth/require-account.js` accepts the break-glass
  pair as the signer when pair one does not verify, so the finish of a
  recovery reads the old account's balance and latest transaction id with
  the seed the bankers delivered; the nonce is recorded after, as before.
  Every held-transfer read answers `type` (`payload.transactionType`),
  `/list-assisted-transfers` included, which the attestor edition tells
  trades and moves apart by; `/get-assisted-transfer` answers `unlocksAt`
  and a fifth stage, `locked`, between `cancelling` and `writing` (17.2),
  decided by the same database clock as the ready list.
- **Not here.** No closed flag on an old account; no notification kinds;
  no wallet page for either cancel; no migration of old key blobs (a fresh
  genesis, decision 12 of the plan). The doorman's door, the masterpod's
  cases and routes, and the wallet's three steps are steps 2 to 6 of the
  plan.

### 22.2 The rollout

- **Every validator on the new code before the wallet is.** A validator on
  the old code refuses a `breakGlassTransfer` at the shape check and a
  `breakGlassCancel` as an unknown kind, so a counted validator left behind
  would refuse every move; and a joiner on the old code can neither replay
  such a link nor take a held row that carries `future_date`. The reset
  gives a network where every validator starts on this code; the wallet,
  deployed last, is the only thing that sends the new type.
- **The schema column** needs a fresh database (`db/schema.sql`, which the
  reset gives) or one `ALTER TABLE assisted_transfers ADD COLUMN IF NOT
  EXISTS future_date TIMESTAMPTZ` on a database kept from before. Nothing
  else in the schema changed but the trigger's `WHEN` list and the
  comments, which `npm run db:setup` replaces on an existing database.
- **No new npm package, no new environment variable**: the lock numbers of
  `network/testnet.env` are reused through `env.locks`.

### 22.3 Files

Changed: `src/accounts/account-signatures.js`,
`src/transfer/transfer.queries.js`, `src/transfer/transfer.service.js`,
`src/stakes/stakes.queries.js`, `db/schema.sql`,
`src/assisted-transfers/assisted-transfers.queries.js`,
`src/assisted-transfers/assisted-transfers.router.js`,
`src/attachments/attachments.service.js`,
`src/held-transactions/held-rows.service.js`,
`src/garlic-chain/replay.service.js`, `src/auth/require-account.js`,
`src/reads/reads.queries.js`, `src/reads/reads.service.js`; comments only
in `src/assisted-transfers/attestation.js`,
`src/assisted-transfers/assisted-transfer-cancel.js`,
`src/held-transactions/held-transactions.js`, `src/app.js`,
`src/accounts/accounts.service.js` and `src/validators/validators.service.js`
(a count each). New:
`src/assisted-transfers/break-glass-cancel.js`. In the docs: the README's
database list, endpoints, account-level reads, signing rules, transfer
table, follow-ups, assisted transfers and layout; sections 1, 3, 4 (4.5),
5 (5.1 to 5.3, 5.7), 6, 8, 9, 13.2 and 17.2 above, and this section. No
file under `deploy/`, no package file, no change to `network/`.

### 22.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 22.1 was changed.

- **The build was made on main at 234bbd6**, the age-limit commit of
  section 21. Every line the plan quotes was where it said.
- **`accounts.type` is nullable in the schema**, so `accountToExists`
  derived from the type select (1.2 of the plan) rests on every account
  row having a type. It does: genesis writes `fund` and `spending`, a
  creation is refused without one of the four, and the five local
  databases hold no untyped row. The comment on `findExisting` says so.
- **The nullable `TIME` column** is marked by a `nullable` list on the
  table's spec in `held-rows.service.js`, read by `checkColumns` for `TIME`
  columns only, as the plan's sentence says; a second column kind would
  have touched `toWire` and `fromWire`, which already pass null through.
- **`insertAssisted` writes `futureDate ?? null`**, so the undefined the
  registry's `insert` passes for an assisted transfer lands as NULL
  explicitly; the driver would have sent undefined as null anyway.
- **The reason for a user-pair signature under the break-glass rule**
  names the `breakGlassTransfer` even when the object is a
  `breakGlassCancel`, as the plan gave it; the doorman mirrors the string
  in step 2.
- **`breakGlassCancel.verify` reads `row.ogTransaction?.payload?.transactionType`**
  with optional chaining, defensive only: a held row's `og_transaction` is
  always an object with a payload.
- **Doc spots beyond the plan's list**, each a count or a field list the
  change had made false: section 4's "Four kinds are added"; 5.1's "one of
  the seven below" and its signatures line; `type` in the `/list-escrows`,
  `/get-locked-transfer` and `/list-disputed-escrows` rows of 8 and 13.2
  (every held-transfer read answers it, 1.8 of the plan); 17.2's closing
  sentence on "a fifth stage"; the schema's `COMMENT ON TABLE` for
  `assisted_transfers`; the README's database list, its follow-ups count
  and signatures line, the `type` field in its reads list, the layout
  lines for `transfer/` and `assisted-transfers.queries.js`, and the count
  of kinds in its validator-to-validator section; and the two source
  comments that said five transfer types (`accounts.service.js`
  `writeTransactions`, `validators.service.js` the approval's check).
- **Checks.** `node --check` passed on all seventeen source files. The SQL
  ran by psql as the superuser against a throwaway database
  `anos_bg_check` built from `db/schema.sql`, in one transaction rolled
  back, the database then dropped: `PREPARE` without parameter types
  inferred `{bytea, bytea}` for the stake move's statement, so the untyped
  `$2` in its `INSERT ... SELECT` resolves against the target column as
  the driver sends it; the move added to a receiver that had a row, moved
  nothing from a sender with none and created a row for a receiver with
  none, deleting the sender's each time it had one; `insertAssisted` took
  a date and a null; `findReadyAssistedIds` listed the row with no moment
  and the row whose moment had passed and left out the row whose moment
  was ahead; `findAssistedFor`'s `due` was false for the latter; the
  `findExisting` type select answered a type and null; and the trigger
  moved 1000 from sender to receiver for a `breakGlassTransfer` link.
  Beyond the plan, the whole app was imported once with dummy environment
  values and a throwaway key file in the scratchpad, to catch a wrong
  import name or an import cycle that a syntax check cannot: it imported.
  No validator was booted, no test script was written, no rig was run.

## 23. The DAO stake read (2026-11-08)

Decided 2026-11-08 in the DAO voting planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/dao-voting-plan-1.md`. Why: `daoVote` has
been one of the six stake purposes since 2026-10-23 (section 2), recorded
only: a `transferToFund` for it adds to `stakes.dao_vote_stake`, and
nothing read the column. The DAO voting ledger, plain-text proposals that
collect support like a petition and then take two weeks of votes for and
against, one staked anos one vote, lives on the masterpod (its spec,
section 15): the proposals, the support and the votes are its tables and
routes, and when a proposal is posted, and again when it goes to a vote,
it takes one snapshot of every account's DAO stake from a validator and
boils it down to one weight per anoPod through its `anos_accounts`
mapping. The validators keep no proposals and no votes; they gain this one
read, and nothing about the stakes, the fund proposals (sections 3 to 6, a
different system) or the leader round changed. Four repos in order: the
validator (this step), the doorman (its spec, section 6), the masterpod
(its section 15) and the wallet (its section 11), then the architecture
records; deployed validators and doormen first, then the masterpod, then
the wallet, no reset, everything additive.

### 23.1 The route

Public: no envelope, no signature, no middleware, the first route of the
kind. Everything it answers is already on the public chain (each
`transferToFund` link names its purpose), so nothing is given away; the
masterpod has no anos account and no validator key to sign with; the
doorman's rate limit covers abuse. It joins `src/reads/` beside the other
reads.

| Method | Path | Answers |
| ------ | ---- | ------- |
| POST | `/list-dao-stakes` | body `{}`; `200 { asOf, total, stakes: [ { accountId, daoVoteStake } ] }` |

`stakes` is every `stakes` row with `dao_vote_stake > 0`: `accountId` hex,
`daoVoteStake` millionths as a decimal string, account id ascending.
`total` is their sum in millionths as a decimal string (`"0"` with no
rows); `asOf` the server clock at the read, ISO 8601. The body must be an
object (`400 bad request shape`); nothing in it is read. The 503 "not
counted yet" of `src/app.js` applies as to every POST: a joiner answers
503 and the caller moves to the next validator. The masterpod asks the
validators of its `VALIDATOR_URLS` in order, five seconds each, and takes
the first `200` of the right shape. Refusals are logged `failed:
<reason>` like every other route.

### 23.2 The rollout

Read only and additive: a validator with the route and one without agree
on everything else; no table, no env variable and no npm package changed.
A doorman or a validator without the route answers 404 and the masterpod
moves to the next URL, so the masterpod's `VALIDATOR_URLS` should name
validators that have it; the rest follow at the next pull round (operator
guide, the doorman's and the validator's pull lines). The doorman's
validator door passes only the paths in its table (doormansoftware
`src/doors/validator.routes.js`); `/list-dao-stakes` is added there in
step 2 of the plan, with a body check of its own, and that doorman
restarted, before the masterpod can reach the route.

### 23.3 Files

Changed: `src/stakes/stakes.queries.js` (`listDaoVoteStakes`),
`src/reads/reads.service.js` (`listDaoStakes`),
`src/reads/reads.handlers.js` (`listDaoStakesHandler`),
`src/reads/reads.router.js` (the route after the attestor reads, no
middleware); comments only in `src/app.js` (the `readsRouter` line) and
`src/stakes/stake-purposes.js` (the header). In the docs: the README's
endpoints table, account-level reads paragraph, stake purposes table and
layout (two lines); sections 2 and 8 above, and this section. No schema
change, no file under `deploy/`, no package file, no change to
`network/`.

### 23.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 23.1 was changed.

- **The build was made on main at 1bf6d56**, the break-glass commit of
  section 22. Every line the plan quotes was where it said.
- **The query's SQL is the plan's**, the column written out as
  `dao_vote_stake` rather than taken from `stake-purposes.js`, as the plan
  gave it. `SUM(dao_vote_stake) OVER ()` is NUMERIC to PostgreSQL, which
  pg hands over as a decimal string like the BIGINTs; it is read off the
  first row and passed through `String()`, so a type parser set on the
  pool one day could not turn it into a number.
- **Where the new lines sit**: `listDaoVoteStakes` at the end of
  `stakes.queries.js`, after `moveStake`; `listDaoStakes` after
  `listDisputedEscrows` in `reads.service.js`, before the shared helpers;
  the handler and the route line last in their files, the route under a
  comment of its own after a blank line, as the attestor reads are set
  apart from the account level.
- **Section 8's paragraph is headed "Public, unsigned"**, since the
  submission table above it is already headed "Public": those routes are
  public too, but every object they take is signed.
- **Two spots outside the plan's file list** said daoVote was still
  recorded only and were fixed on the user's word, as 22.4 fixed the
  comments the break-glass build had made false: the header comment of
  `src/stakes/stake-purposes.js`, and the README's layout line for
  `stakes.queries.js`, which now names `listDaoVoteStakes`.
- **Checks.** `node --check` passed on the six source files. The SQL ran
  by psql against the local `anos1` in one transaction rolled back, the
  statement prepared with the query's exact text: the live table held six
  `stakes` rows, none with DAO stake; two throwaway rows went in, one with
  12 anos of DAO stake and one with guardian stake only; the query
  answered the one row with DAO stake, `dao_vote_stake` `12000000` and
  `total` `12000000`, and not the other; after the rollback the table held
  its six rows and a DAO total of 0 again. No validator was booted, no
  test script was written. The local PostgreSQL had to be brought back
  first: a `postmaster.pid` left by the server that ran before the day's
  reboot, its pid since reused by another process, was moved out of the
  data directory, and the Homebrew launchd job started the server by
  itself.

## 24. Appointed stakes (2026-11-08)

Decided 2026-11-08 in the appointments planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/appointments-plan-1.md`. Why: three
different checks decided who is a moderator or an attestor, and none of
them knew about the others. The masterpod admitted a pod whose username
started with `moderator` or `attestor` and that any super seed had vouched
for, and never looked at a stake; nothing reserved those usernames, so the
rule was really "any super seed vouched for you", and at the production
launch about a thousand pods will be super seeds. This validator knows
nothing about pods: it admits the account that signs, with attestor stake
of at least `STAKE_MIN_ATTESTOR_ANOS` for the two attestor reads, every
attestation and every escrow verdict, and anyone with a spending account
and 1,000 anos could stake for either purpose, since `verifyTransferToFund`
checks the minimum, the account type and the balance and nothing about the
person. The keyholders admit an account with 1,000 anos of moderator or
attestor stake to the bucket key routes, read from a validator's database.
So anyone with 1,000 anos could attest assisted transfers, decide escrow
disputes and pull bucket key shares, and the masterpod was never asked.
Moderator and attestor are positions of trust; the fix below is good
enough for the production launch and is grown later. The fix: one list of
appointed pods on the masterpod, an `appointments` table written only by
the operator's scripts (its spec, section 16); the masterpod's gates read
it instead of the username and the vouch; the validators ask the masterpod
before they accept a stake for `moderator` or `attestor`, the way they
already ask it at create-account whether a vouched pod made the account.
Then only an appointed pod can hold the stake, and the stake checks of the
validators and the keyholders stand unchanged. Three repos in order: the
masterpod (its section 16: the table, the two scripts, `role` in the
answers of `/get-anos-account` and `/check-anopod-status`), the validator
(this step), the wallet (its Stake for list reads `role`, and the two
refusals below are shown in words), then the architecture records.
Everything lands at the Test Net 2 relaunch, the masterpod first (24.2).
The keyholders, the doorman and the signing server are not touched.

### 24.1 The check

`receiveTransferToFund` (`src/fund/fund.service.js`) hands
`receiveTransaction` a check that runs `verifyTransferToFund` and then,
when `payload.stakeFor` is `moderator` or `attestor`
(`src/stakes/stake-purposes.js` `APPOINTED_PURPOSES` and
`isAppointedPurpose`), asks the masterpod for the sending account:
`POST MASTERPOD_URL/get-anos-account { accountId }`
(`src/masterpod/masterpod.client.js` `fetchAnosAccount`, 5-second
timeout), the one call this server makes to the masterpod, the same the
binding check of create-account makes. The masterpod answers
`200 { accountId, anopodId, vouched, role }` with `role` `"moderator"`,
`"attestor"` or `null`. The client returns `{ bound: true, anopodId, role }`
on a 200 whose `anopodId` decodes to 32 bytes and whose `vouched` is true,
`role` the answer's when it is one of the two names and `null` otherwise
(a masterpod from before this change sends no `role` field at all), and
`{ bound: false }` for anything else, as before; `receiveCreateAccount`
ignores `role`. `checkAppointment(body, verified)`, with `verified` the
verify result, then has three outcomes:

- no answer, or not bound: `{ ok: false, reason: "the masterpod could not
  confirm the sending account's anoPod" }`;
- bound, `role` not equal to `stakeFor`: `{ ok: false, reason: "the
  sending account's anoPod is not appointed as <stakeFor>" }`;
- otherwise the verify result, and the stake goes to `pending` and round
  the validators as before.

For the other four purposes the masterpod is not asked. The handler logs
`failed: <reason>` and answers `400 { error }` as for any refusal
(`src/util/submission-response.js`); nothing is dropped silently, since
the signer is the account's own holder and learns nothing they did not
know. Only the receiving validator asks: `validators.service.js`
`verifyTransaction` runs `verifyTransferToFund` alone and trusts the
check, as it trusts the binding check of create-account;
`replay.service.js` and `held-rows.service.js` run
`checkTransferToFundSignaturesAndIds` alone, as before. Nothing else
changed: the stake minimums and every other check of a `transferToFund`,
the stake checks of the attestor reads, the attestations and the escrow
verdicts, the fund proposals and the leader round. The appointment decides
who may stake; the stake still decides who holds the role. Out, by
decision: the peers asking the masterpod; a masterpod signature on
appointments carried in the transaction; an expiry on an appointment; the
validators returning a revoked pod's stake, which the guardians' fund
proposal payout with `stakeFor` does, so that until the payout is written
the stake still counts here and at the keyholders (a follow-up).

### 24.2 The rollout

The receiving validator alone asks, so a mixed set is not safe: an
unappointed moderator or attestor stake sent to a validator on the old
build goes to `pending` there, and the peers on this build approve it,
since the approval path runs `verifyTransferToFund` alone. At the Test Net
2 relaunch every validator is on this build, so the gap does not arise.
The masterpod goes first: a validator on this build against a masterpod
that sends no `role` reads it as `null` and refuses every moderator and
attestor stake as not appointed, while a validator on the old build
ignores `role`. No table, no env variable and no npm package changed;
`MASTERPOD_URL` is asked once more, at a moderator or attestor stake. The
wallet follows the validators (the plan's step 3); until it does, it
offers all six purposes, and the two refusals reach it as any other `400`
reason.

### 24.3 Files

Changed: `src/stakes/stake-purposes.js` (`APPOINTED_PURPOSES`,
`isAppointedPurpose`, the header), `src/masterpod/masterpod.client.js`
(`fetchAnosAccount` returns `role`; the header, one import),
`src/fund/fund.service.js` (`checkAppointment`, `receiveTransferToFund`,
the comments of `verifyTransferToFund` and `receiveTransferToFund`, two
imports). In the docs: the README's env table (`MASTERPOD_URL`), stake
purposes table (two rows), the `/transfer-to-fund` paragraph after it and
the layout line for `masterpod.client.js`; sections 2, 4.3 and 10 above,
and this section. No schema change, no file under `deploy/`, no package
file, no change to `network/`; nothing in `accounts.service.js`,
`validators.service.js`, `replay.service.js` or `held-rows.service.js`.

### 24.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 24.1 was changed.

- **The build was made on main at b8c8d32**, the DAO stake read commit of
  section 23, against the masterpod's step 1 at its 775d901. Every line
  the plan quotes was where it said.
- **`checkAppointment` sits right after `receiveTransferToFund`**, the one
  function that calls it, rather than among the shared helpers at the foot
  of the file, so the two read together.
- **The client decides what counts as a role with `isAppointedPurpose`**
  from `stake-purposes.js`, so the two strings live in one place: the
  masterpod spells its roles as the validator spells its two appointed
  purposes, and the check compares them with `===`.
- **`receiveCreateAccount` is untouched**: it reads `bound` and nothing
  else, so the new `role` passes it by.
- **One comment outside the plan's file list** still names
  `MASTERPOD_URL` as the binding check alone: the `masterpodUrl` line of
  `src/config/env.js`. Left for the user's word, as 22.4 and 23.4 handled
  such lines.
- **Checks.** `node --check` passed on the three source files; every
  imported name was confirmed exported where it comes from by grep. No
  validator was booted, no database touched, no rig run, as 2.4 says.

## 25. The fund proposal reads (2026-11-08)

Decided 2026-11-08 in the Guardians planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/wallet-guardians-plan-1.md`. Why: the
guardian features sat on the wallet's account page as two folded panels, a
vote on a proposal id pasted by hand and a payout form, and nothing in the
wallet could show a fund proposal, because the validators had no read for
one: a guardian learned a proposal's id from the one-time 202 or from
somebody else, and nobody saw the votes or the result. The wallet gets a
Guardians page under its DAO page (`/dao/guardians`), where everyone sees
the fund's proposals, their payouts, the votes and the decided list, and an
account with at least one guardian vote proposes and votes. The validators
keep the guts as they were (the `fundProposal` transaction of 4.4, the
`guardianVote` follow-up of 5.4, the tally of section 6, the tables of
section 3, the archives of section 7) and gain the reading side: two public
reads built like `/list-dao-stakes` (section 23), and two fields on
`/get-account`. Read only and additive: no table, no env variable, no npm
package; a validator with the routes and one without agree on everything
else. Three repos in order: the validator (this step), the doorman (its
spec, section 7: the two lines of its validator door), the wallet (its
sections 8 and 10: the pages), then the architecture records; deployed
validators and doormen first, then the wallet, no reset.

### 25.1 The routes

Public, like `/list-dao-stakes`: no envelope, no signature, no middleware;
the body must be an object (`400 bad request shape`); the 503 "not counted
yet" of a joiner applies as to every POST; refusals are logged `failed:
<reason>` like every route. Everything they answer is the fund's business:
a written proposal's payouts are on the public chain as `transferFromFund`
links, and the votes are the guardians' public act on the fund's money.

| Method | Path | Body | Answers |
| ------ | ---- | ---- | ------- |
| POST | `/list-fund-proposals` | `{ status: 'open' \| 'decided', limit?, offset?, from?, to? }` | `200 { settings, proposals: [ item ] }` |
| POST | `/get-fund-proposal` | `{ transactionId: hex }` | `200 { settings, proposal }`, the item plus the payouts and the proposer's weight, else `404 unknown proposal` |

`settings` is `{ anosPerVote, minimumStake, percent, minutes }`, the four
env values: `GUARDIAN_VOTE_ANOS` and `STAKE_MIN_GUARDIAN_ANOS` in millionths
as decimal strings like every amount, `GUARDIAN_VOTE_PERCENT` and
`GUARDIAN_VOTE_MINUTES` as numbers, so the wallet's notice, its rule and its
become-a-guardian sentence read the validator's own numbers.

An `item`:

```
{
  transactionId:  hex, the proposal's
  guardianId:     hex, the proposer's account, as the payload names it
  createdAt:      the payload's createdAt
  voteClosesAt:   ISO 8601
  status:         waiting | open | closing | written | failed (25.2)
  approved:       boolean, the row's
  payoutCount:    number
  total:          millionths as a decimal string, the payouts summed
  forWeight:      number, proposer_weight plus the approved votes for
  againstWeight:  number, the approved votes against
  passing:        boolean, the tally as it stands, by the round's own rule (fund.service.js votePasses)
  decidedAt:      ISO 8601 | null, the archives row's created_at
  votes:          [ { guardianId: hex, vote: for | against, weight, approved, votedAt } ], guardian id order
}
```

The `proposal` of `/get-fund-proposal` is the item plus `proposerWeight`
(the proposer's votes when the proposal was stored) and `payouts: [ {
index, accountIdTo: hex, amount, reason, stakeFor: purpose | null } ]` in
index order, the fields as the proposer sent them.

`status: 'open'` lists the `fund_proposals` rows, at most one (the fund's
`account_id` is unique there); `limit`, `offset`, `from` and `to` are not
read. `status: 'decided'` lists the `archives` rows with `source =
'fund_proposals'`, newest first by `created_at`, `limit` default 20 at most
200, after `offset` rows (default 0), with `created_at` at or after `from`
and before `to` when given (ISO 8601; either alone works; `to` is the first
moment after the range, as `/list-transactions` takes them). Anything else
in `status` is `400 invalid status`; a bad value is `400 invalid limit`,
`invalid offset`, `invalid from` or `invalid to`. `/get-fund-proposal`
looks in `fund_proposals` first, then in `archives` (the rows that left
`fund_proposals` only; an escrow's id there is `404 unknown proposal`); a
`transactionId` that is not 64 hex characters is `400 invalid
transactionId`.

The archive's `record` holds the row and its votes as PostgreSQL's JSON of
the rows (`records.queries.js`, `to_jsonb`): bytes come out as hex text
with a leading `\x`, timestamps as ISO 8601 with the server's offset. The
read strips the `\x`, re-reads the timestamps as UTC, takes the proposer
and the payouts from `record.row.og_transaction.payload` and the votes
from `record.votes`, and adds the tally up as the round did
(`proposer_weight` plus the approved votes for; the approved votes
against), so an archived item has the same shape as an open one.

`/get-account` (section 8) gains two fields after `createdAt`: `stakes`,
`{ daoVote, moderator, attestor, guardian, validator, masterPod }`, each
millionths as a decimal string, `"0"` each when the account has no `stakes`
row; and `guardianVotes`, `floor(guardian / GUARDIAN_VOTE_ANOS)` as a
number (`stakes.service.js guardianWeight`). One `findStake` per call. The
wallet's `AccountAnswer` gains two optional fields; nothing that reads the
answer today changes.

### 25.2 The statuses

The first line that matches:

| Status | When |
| ------ | ---- |
| `waiting` | the `fund_proposals` row is not approved: not every validator has accepted the proposal yet, and no vote is accepted on it (5.1) |
| `open` | approved, and `vote_closes_at` is ahead |
| `closing` | approved, `vote_closes_at` has passed, and the row is still in `fund_proposals`: the next ready list tallies it (section 6, "no timer anywhere") |
| `written` | an `archives` row with outcome `written`: the vote passed and the round wrote the payouts |
| `failed` | an `archives` row with outcome `voteFailed` |

The clock is the database's (`vote_closes_at <= now()` in the query), the
one the ready list reads, so the wallet and the ready list agree. A wallet
that meets a status it does not know shows the proposal and offers no
button.

### 25.3 Files

Changed: `src/fund/fund.queries.js` (`findOpenProposals`,
`findProposalVotes`, the header), `src/records/records.queries.js`
(`findArchivedProposals`, `findArchivedProposal`, the `query` import, the
header), `src/reads/reads.service.js` (`listFundProposals`,
`getFundProposal`, `FUND_PROPOSAL_STATUSES`, the helpers `settingsOf`,
`proposalItemOf`, `archivedItemOf` and what they share; `getAccount` and
`stakesOf`; the header), `src/reads/reads.handlers.js`
(`listFundProposalsHandler`, `getFundProposalHandler`, the header),
`src/reads/reads.router.js` (the two routes after `/list-dao-stakes`, no
middleware; the header); comments only in `src/app.js` (the `readsRouter`
line). In the docs: the README's endpoints table (two rows, the
`/get-account` row), its account-level reads paragraph, its `/get-account`
bullet and three layout lines; section 8 above and this section. No schema
change, no env variable, no npm package, no file under `deploy/`, no change
to `network/`.

### 25.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 25.1 was changed.

- **The build was made on main at b62ac29**, the appointed stakes commit of
  section 24. The plan called this section 24; that number was taken by the
  appointed stakes, committed after the plan was written, so the fund
  proposal reads are section 25 here and in every comment that names them.
- **A bad `limit` or `offset`** on the decided list is refused, `400
  invalid limit` and `400 invalid offset`, as `/list-transactions` refuses
  its `limit`; the plan named the four other words only.
- **The single read finds its open row through `findOpenProposals`** and
  picks the row with the id asked for: the table holds one row at most, so
  the one query with the sums serves both reads and nothing is tallied
  twice.
- **The tally of an archived proposal is added up in the code** from
  `record.votes`, the approved votes only, the proposer's weight first, as
  the round added it up in SQL while the proposal was open; the two agree
  because the archive holds the very rows the round read.
- **`closed` comes from the database's clock**, `vote_closes_at <= now()`
  in `findOpenProposals`, as `due` does in the locked and assisted reads.
  `guardian-vote.js` reads the process clock for its own check, as it did.
- **An archive outcome the read does not know passes through as the
  status**, so a wallet shows the row and offers no button, as 25.2 says
  of an unknown status. Only `written` and `voteFailed` reach `archives`
  from `fund_proposals` today.
- **`findProposalVotes` leaves the signature out**: the item carries the
  vote, the weight, the flag and the moment; the whole `guardianVote`
  object is nobody's business on a public read.
- **The timestamps of an archive record** come out of `to_jsonb` with
  microseconds and the server's offset (`2026-11-08T19:07:59.442641-08:00`
  on the build machine); `Date.parse` takes that form, and the read
  answers them as UTC with milliseconds, the form every other read answers.
- **Importing `votePasses` from `fund.service.js`** pulls the fund
  feature's imports into the reads module, the signing module among them,
  which reads the key file when it loads; the server loads them before the
  reads router in any case (`src/app.js` mounts `fundRouter` first), so
  nothing new happens at boot.
- **Checks.** `node --check` passed on the six source files. No validator
  runs on the build machine and none was booted, so the plan's curl step is
  the user's. Instead the three reads were run as functions, the real
  service, queries and pool, against a throwaway database made from
  `db/schema.sql` on the local PostgreSQL (`anos_scratch_guardians`,
  dropped afterwards) holding two accounts, one with 2,500 anos of guardian
  stake, one open proposal with an approved vote for and an unapproved vote
  against, two archived proposals moved with the exact statement of
  `records.queries.js` (one `voteFailed`, dated two days back; one
  `written`) and one archived escrow. The twenty calls answered as 25.1
  says: the open item `open`, `forWeight` 5 (2 plus 3; the unapproved
  against not counted), `total` `"6500000"`, `passing` true, its two
  payouts with `index` and `stakeFor` null on the second; the decided list
  newest first with `written` then `failed`, the failed one 5 for and 4
  against and `passing` false, `decidedAt` from the archive row, every
  timestamp in UTC; `from`, `to`, `limit` and `offset` cutting the list as
  given; the escrow's id `404 unknown proposal`; the five 400 words and the
  404; `/get-account` with `guardian` `"2500000000"` and `guardianVotes`
  2, and all `"0"` with 0 for the account without a stakes row.

## 26. Appointed stakes: validator and masterPod (2026-11-10)

Decided 2026-11-10 in a planning chat of one round, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/validator-masterpod-stake-plan-1.md`. It
grows section 24. Why: the wallet's Stake for list offered validator and
masterPod to everyone. The user, 2026-11-10: "Send stake should only be to
dao vote or guardian. Right now it also include validator and masterpod.
We'll actually need to build a list for those, like we did with moderator
and attestor. Unless the user is on that list, then those option should
not show." The list is the masterpod's `appointments` table: `validator`
and `masterPod` are two more roles on it, spelled as this validator spells
the two purposes. Hiding two options in the wallet would not be enough,
since a stake posted by hand would still pass. So this validator refuses a
validator or masterPod stake from an account whose anoPod is not appointed
for it: the check of section 24 with two more names, on the receiving
validator only. Such a stake is still recorded only: nothing here, on the
masterpod or on the keyholders reads it. One live role per anoPod stays on
the masterpod: a moderator or an attestor works from an anoPod made for
that work, a banker stakes for validator from the personal anoPod, and the
masterPod stake comes from one anoPod made for it. Three repos in order:
the masterpod (its section 16.7: the role check of `appointments` widened
to the four roles, the script's role list), the validator (this step), the
wallet (its Stake for list offers daoVote and guardian to everyone and
each other purpose only to the anoPod appointed for it), then the
architecture records. The keyholders, the doormen and the signing server
are not touched.

### 26.1 The check

`APPOINTED_PURPOSES` (`src/stakes/stake-purposes.js`) is `moderator`,
`attestor`, `validator` and `masterPod`. That one list is the whole change
in the code. The two places that decide go through `isAppointedPurpose`
and follow it:

- `checkAppointment` (`src/fund/fund.service.js`, 24.1) asks the masterpod
  when `payload.stakeFor` is one of the four. So a `transferToFund` for
  `validator` or `masterPod` now passes the check of 24.1 as well, after
  `verifyTransferToFund`, on the receiving validator.
- `fetchAnosAccount` (`src/masterpod/masterpod.client.js`) keeps the
  answer's `role` when it is one of the four names, and returns `null`
  for anything else, as before. So a `role` of `"validator"` or
  `"masterPod"` reaches the check.

The masterpod answers `200 { accountId, anopodId, vouched, role }` with
`role` `"moderator"`, `"attestor"`, `"validator"`, `"masterPod"` or `null`
(its spec, 16.7). The refusals are the two of 24.1:

- no answer, or not bound: `the masterpod could not confirm the sending
  account's anoPod`;
- bound, `role` not equal to `stakeFor`: `the sending account's anoPod is
  not appointed as validator`, or the same sentence ending `masterPod`.

The check compares with `===`, so an anoPod appointed as `validator` may
stake for `validator` and for none of the three other appointed purposes.
For `daoVote` and `guardian` the masterpod is not asked. Only the
receiving validator asks, as in 24.1: the peers (`validators.service.js`
`verifyTransaction`), the replay of a chain chunk (`replay.service.js`)
and the held-row checks (`held-rows.service.js`) do not. Nothing else
changed: the minimums (50,000 and 500,000 anos in `network/testnet.env`),
every other check of a `transferToFund`, the `stakes` table, and the fund
proposal's payout with `stakeFor`, which is how a stake comes back, a
revoked anoPod's too. Out, by decision: this validator doing anything
with a validator or masterPod stake; a link between a validator
appointment and the registry file (14.1); the peers asking the masterpod.

### 26.2 The rollout

As 24.2, with the two names. The receiving validator alone asks, so a
mixed set still lets such a stake in: a validator or masterPod stake from
an anoPod that is not appointed, sent to a validator on the old build,
goes to `pending` there, and the peers on this build approve it, since
the approval path runs `verifyTransferToFund` alone. The validators take
this build at their next pull, which the phase 3 list places at the
production launch. Until every validator runs it, a validator or
masterPod stake that somebody posts by hand is still accepted, as before
this section; the wallet no longer offers it (the plan's decision 9). The
masterpod goes first: a validator on this build against a masterpod from
before its step 1 never hears `validator` or `masterPod` as a role, since
that masterpod's table cannot hold them, and refuses every validator and
masterPod stake as not appointed. A validator on the old build ignores
the two new roles and accepts the two stakes from anyone. No table, no
env variable and no npm package changed; `MASTERPOD_URL` is asked at a
validator or masterPod stake too.

### 26.3 Files

Changed: `src/stakes/stake-purposes.js` (`APPOINTED_PURPOSES`; the header
and the comments of `APPOINTED_PURPOSES` and `isAppointedPurpose`).
Comments only: `src/fund/fund.service.js` (`checkAppointment`,
`receiveTransferToFund`) and `src/masterpod/masterpod.client.js` (the
header, `fetchAnosAccount`). In the docs: the README's env table
(`MASTERPOD_URL`), stake purposes table (the `validator` and `masterPod`
rows), the paragraph after it and the layout line for
`masterpod.client.js`; sections 2, 4.3 and 10 above, and this section. No
schema change, no file under `deploy/`, no package file, no change to
`network/`; nothing in `accounts.service.js`, `validators.service.js`,
`replay.service.js` or `held-rows.service.js`.

### 26.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 26.1 was changed.

- **The build was made on main at 0d9d26f**, the merge that brought
  validator 23 into the registry, against the masterpod's step 1 at its
  4472d39. Every line the plan quotes was where it said, and the last
  section was 25, so this is 26, as the plan expected.
- **The two names stand at the end of the list**, in the plan's order:
  `[MODERATOR, ATTESTOR, VALIDATOR, MASTER_POD]`.
- **The comments name both sections**, 24 for the check and 26 for the
  two new names, and say since when each pair needs the appointment. In
  the comment of `checkAppointment`, "the other four purposes" became
  "the other two purposes, daoVote and guardian" and "the other role"
  became "another role"; it also says now why a masterpod from before
  2026-11-10 refuses the two new stakes.
- **Section 2's two rows keep their words** and gain "the pod must be
  appointed to stake (section 26)", as the rows of `moderator` and
  `attestor` name section 24. In 4.3 the dated pointer is a clause in the
  paragraph's first sentence. The `MASTERPOD_URL` rows, here and in the
  README, name the four stakes.
- **In the README the paragraph after the stake purposes table was
  wrapped again** from its last changed sentence to its end; its words
  changed only in the purposes and the section numbers.
- **One comment the plan does not name** still says two purposes: the
  comment of `verifyTransferToFund` in `fund.service.js` ("the
  appointment check of a moderator or attestor stake"). Left for the
  user's word. The `masterpodUrl` line of `src/config/env.js` is as 24.4
  left it, and section 24 is as written on 2026-11-08.
- **Checks.** `node --check` passed on the three source files. No
  validator was booted and no database touched, as 2.3 says. Beyond the
  plan, a scratch script outside the repo loaded the real
  `stake-purposes.js` and `masterpod.client.js` with a stub in place of
  `src/config/env.js` and of `fetch`, so no env file was read and nothing
  went over the network. `isAppointedPurpose` is true for the four names
  and false for `daoVote`, `guardian` and a misspelled `masterpod`; the
  client keeps a `role` of `validator` or `masterPod` and answers `null`
  for any other role or none. `checkAppointment` is not exported and its
  code did not change, so it was not run: its two comparisons were
  written out in the script with the real list and the real client, and
  gave the outcomes of 26.1 (a validator stake passes with the role
  `validator` and is refused as not appointed with `null`, `masterPod`,
  `moderator` or no role; a 404 is the other refusal; `daoVote` and
  `guardian` are not asked). A real stake against a real masterpod is
  the user's run-through.

## 27. The time check on every transfer (2026-11-11)

Decided 2026-11-11 in a planning chat of three rounds, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/locked-transfer-cancel-plan-1.md`. This is
its step 1 of five, its section 0. Why: a plain, an assisted and an escrow
transfer, the stake transfer and a break-glass move out of a spending or
assisted account carried a date, `createdAt`, that the validators never
compared with their clock; it only had to be a string. So a signed
transfer stayed good for as long as nothing else was written for its
account. That is what let a cancelled transfer be sent in again. The
validators refuse a transfer whose id is in a holding table or on the
chain, but they do not look in `logs`, where a cancelled row goes. Whoever
kept a copy of the signed object, the wallet's proxy, a doorman or a
validator, could post it again, and the row was back. A second cancel was
then accepted, but its move to `logs` failed, because `logs` already had
that transaction id as its primary key. The row then stayed for good with
a cancellation on it, and the account could send nothing more. The user,
2026-11-11: "So you're saying with an assited transfer, there is no time
check when it comes in? There's no timestamp? That can't be right. Why
doesn't the rule just check the timestamp. Has it been 5 minutes or not?
That's the easieset thing in the world." The planning chat had begun with
a cancel for a guarded or vault transfer, which is the plan's step 2 and
builds on this step. The user on putting the two together: "While you're
digging in there, knock it all out." Two things are built here: every
transfer's date is checked when it comes in (27.1), and the two cancels
that exist today wait until their transfer can no longer be sent in
(27.2). No table, no route, no setting and no npm package. The doorman,
the wallet, the masterpod, the keyholders and the signing server are not
touched by this step.

### 27.1 The check

One rule for every transfer that had no date check: `createdAt` is within
`LOCK_OFFSET_MINUTES` of the validator's clock, before or after. It is the
check a fund proposal has (4.4), the same three lines, with its reason
word for word: `payload.createdAt must be within <n> minutes of now`, `<n>`
the offset, 5 on the testnet. A date that does not parse is refused with
the same reason. Nothing older than the offset is taken in any more.

- **The transfers of `/anos-transfer`.** Check 1b of `verifyAnosTransfer`
  (`src/transfer/transfer.service.js`) had one half, the block
  `if (lockMinutes > 0)`: the lock ahead, for a guarded or vault transfer
  and for a break-glass move out of a guarded or vault account. That half
  is untouched. It gained its other half, the `else`: the rule above,
  taken by a plain, an assisted and an escrow transfer and by a
  break-glass move out of a spending or assisted account, whose
  `lockMinutes` is 0. `futureDate` stays undefined in that branch, so
  `future_date` stays NULL for such a break-glass move.
- **The stake transfer.** `verifyTransferToFund`
  (`src/fund/fund.service.js`) runs the same check as its 1b, after
  `checkTransferToFundSignaturesAndIds` and before the purpose's minimum.
- **Where the check is, and where it is not.** It is in the two verify
  functions, which run on the receiving validator and on every peer asked
  to approve (`src/validators/validators.service.js` `verifyTransaction`),
  each by its own clock. It is not in `checkTransferSignaturesAndIds` or
  `checkTransferToFundSignaturesAndIds`, the shape, signature and id
  checks. Only those run when a chain chunk is replayed
  (`src/garlic-chain/replay.service.js`) and when a joiner stores the held
  rows it pulled (`src/held-transactions/held-rows.service.js`). So an old
  link and an old held row are never refused for their age.
- **No new setting.** The offset is `LOCK_OFFSET_MINUTES`
  (`env.locks.offsetMinutes`), as for a fund proposal.
- **What it asks of a sender**, as the plan read the senders on
  2026-11-11: nothing new. The wallet and the OG signer date a transfer at
  the moment they send it, a guarded or vault transfer the lock plus the
  offset ahead. A phone whose clock is more than
  `TIMESTAMP_WINDOW_SECONDS` (120) off cannot read its account, and the
  wallet reads the account before it sends.

### 27.2 The wait before a cancel

A cancelled transfer's row moves to `logs`, and the validators do not look
in `logs` when a transfer comes in. So a cancel must not be accepted while
the same signed transfer could still be taken in again. One function says
whether it could, `canBeSentInAgain(payload)`, exported from
`src/transfer/transfer.service.js`, beside check 1b:

- for a guarded or vault transfer: its date is still at least its lock
  ahead of the validator's clock;
- for a plain, an assisted or an escrow transfer: its date is not yet more
  than `LOCK_OFFSET_MINUTES` behind the validator's clock.

That is true exactly while check 1b accepts the transfer, now or at a
later clock, and time only moves it to false. Once it is false the check
refuses that transfer for good. The function reads the transfer's own date
and the lock of its type, and needs no setting. It is not for a
`breakGlassTransfer`, whose lock is its sender's type's.

A cancel waits until the function says false. The two cancels that exist
today got the wait. The third, of a guarded or vault transfer, is the
plan's step 2 and asks the same function, so the wait and the incoming
check cannot drift apart.

- **`assistedTransferCancel`**
  (`src/assisted-transfers/assisted-transfer-cancel.js`): `verify` gained
  one check between its two, after the sender and before the slot. When
  the row's transaction is an `assistedAnosTransfer` and
  `canBeSentInAgain` says true, the cancel is refused with
  `this transfer cannot be cancelled yet`. A break-glass move's row, which
  the same cancel may be attached to (5.3), is left as it was: no wait.
- **`escrowCancel`** (`src/escrow/escrow-cancel.js`): the builder of the
  three escrow signature kinds (`src/escrow/escrow-signature-kind.js`)
  takes one more member, which a kind may leave out, `check(row)`: a
  reason or null. `verify` runs it after `signerOf` and before it walks
  over the slots. `escrowCancel` passes one: refused with
  `this trade cannot be cancelled yet` while `canBeSentInAgain` says true
  for the row's escrow transfer. `escrowSuccess` and `escrowDispute` pass
  none and are checked as before.

Both reasons contain `cannot be cancelled yet`, which is what the wallet
looks for (the plan's step 4). With the wallet's dating the wait is the
offset: 5 minutes after sending on the testnet. The user, 2026-11-11: "An
easier rule would be that you have to wait at least 5 minutes before
cancelling it. What ever amount of time ensure that it can't be resent.
That's a simple 1 line rule."

Why a cancelled transfer cannot come back: a cancel is approved only when
every validator accepted it, and each accepts it, by its own clock, only
once check 1b would no longer take the transfer in. From then on each of
them refuses that same signed transfer for good, since time only moves its
date further out of the window. So a row that left for `logs` through a
cancel cannot be put back.

### 27.3 What is left as it is

- **A follow-up's `signedAt` gets no time check**, although the phase 3
  build list says "a time window on every transaction and follow-up". An
  attestation is signed by the first attestor, stored on the masterpod and
  sent to the validators only once the case is decided; a 5 minute rule
  would refuse it. `signedAt` stays recorded and not compared with the
  clock (5.1).
- **The two cancels of a break-glass move have no wait**: the
  `breakGlassCancel` (5.7), whose file is untouched, and the
  `assistedTransferCancel` on a break-glass row. No wallet page offers
  either. A break-glass move that is cancelled while check 1b would still
  take it in can be sent in again.
- **An escrow trade that two arbitrators' verdicts cancel** inside the
  offset after it was made is in the same place.
- **The moment the wait ends.** Every validator checks the wait by its own
  clock. A cancel that reaches them in the very moment the wait ends,
  while two of their clocks disagree, could be accepted by some and
  refused by one. It would then be stuck: a cancellation that one
  validator refuses stays unapproved on the others, and the transfer is
  never written and never removed (21.3, a follow-up there). That takes a
  press in that same moment and a validator whose clock is off, and is
  left as it is.

### 27.4 The rollout

- The validators take this build at their last pull, at the phase 3
  launch, which wipes every database. No schema change, no env variable,
  no npm package, nothing under `deploy/`.
- **Every validator has to be on the new code.** One left on the old code
  would still take in an old transfer that the others refuse, and its row
  there would only go when the age limit on unapproved rows drops it
  (section 21).
- **The validators' clocks now matter for every transfer**, as they
  already do for signed reads and fund proposals. A validator whose clock
  is more than `LOCK_OFFSET_MINUTES` off refuses every transfer it is
  asked to approve. Nothing new is asked of a phone: signed reads already
  allow it 2 minutes.
- **The wait needs no setting.** The validators work it out from the lock
  numbers they have.
- The doorman checks no time on a transfer or a follow-up and does not
  change for this step. The wallet's sentence for a cancel pressed too
  early is the plan's step 4.
- The run-through is the user's, on the launched network.

### 27.5 Files

Changed: `src/transfer/transfer.service.js` (the `else` half of check 1b;
`canBeSentInAgain`, new and exported; the comment above `TRANSFER_TYPES`
and item 1b in the comment of `verifyAnosTransfer`),
`src/fund/fund.service.js` (1b in `verifyTransferToFund`; its header
comment), `src/assisted-transfers/assisted-transfer-cancel.js` (the wait
in `verify`, `NOT_YET`, the import, the header comment),
`src/escrow/escrow-signature-kind.js` (`check`, in the builder and in
`verify`; the two comments) and `src/escrow/escrow-cancel.js` (`check`,
`NOT_YET`, the import, the header comment). Comment only:
`network/testnet.env`, above the three lock numbers, no value changed, and
`src/config/env.js`, above `locks`. In the docs: the README's row of
`LOCK_OFFSET_MINUTES`, its bullet on `createdAt` in "Transfer submission"
and the list of checks under it, its paragraph on the stake transfer and
its paragraphs of `/assisted-transfer-cancel` and of `escrowCancel`;
sections 4, 4.1, 4.2, 4.3, 4.5, 5.3, 5.5 and 10 above, and this section.
No schema change, no file under `deploy/` and no package file. Nothing in
`checkTransferSignaturesAndIds`, `checkTransferToFundSignaturesAndIds`,
`verifyFundProposal`, `break-glass-cancel.js`, `escrow-success.js`,
`escrow-dispute.js`, `replay.service.js` or `held-rows.service.js`.

### 27.6 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 27.1 or 27.2 was changed.

- **The build was made on main at d0cd95d**, the commit the plan names,
  with a clean working tree. Every line the plan quotes was where it
  said, and the last section was 26, so this is 27, as the plan expected.
- **The code is the plan's, word for word**: the `else` half,
  `canBeSentInAgain` with its comment, the three lines in
  `verifyTransferToFund`, the check in the assisted cancel's `verify` and
  `check(row)` in `escrow-cancel.js`. The comment of `canBeSentInAgain`
  names `locked-transfer-cancel.js`, a file the plan's step 2 adds.
- **In `escrow-signature-kind.js`** `verify` gained two lines:
  `const own = check ? check(row) : null;` and `if (own) return own;`.
  Both comments of the file name `check`: the builder's, and the header's
  sentence on what differs between the three kinds, which named
  `signerOf` and `onAccepted` only.
- **In `escrow-cancel.js`** `NOT_YET` stands above the header comment, so
  that the comment stays on the export.
- **Where a comment says more than the plan quotes.** The comment above
  `TRANSFER_TYPES` had a second sentence on the date, on a break-glass
  move out of a spending or assisted account ("is not checked"); it says
  the new rule too. The assisted cancel's header said of a break-glass
  row "nothing here reads the row's type"; the wait reads it, so the
  header says that such a row has no wait, and 5.3 above says the same.
  The header of `verifyTransferToFund` lists what follows the lifted-out
  checks and gained two words, "the date,". Item 1b in the comment of
  `verifyAnosTransfer` also says why the check is not in
  `checkTransferSignaturesAndIds`.
- **The README's paragraphs on the assisted and the escrow transfer** do
  not say that the date is not checked, so nothing changed there; 4.1 and
  4.2 above did say it. The README's bullet gives the reason with
  `<offset>` in the number's place. In 4.1 to 4.3 and 5.3 above and in
  the README's paragraphs on the stake transfer and on
  `/assisted-transfer-cancel` the lines were wrapped again from the
  changed sentence on; their other words are as they were.
- **Two places the plan does not name** were first left as they were and
  then changed on the user's word, given the same day when the build was
  reported: "Yes, fix both". The README's paragraph "The server checks,
  in order" said "for a locked transfer, the date" and says "the date",
  since the date is now checked for every transfer. The comment above
  `locks` in `src/config/env.js` told what the offset is for a guarded or
  vault transfer only. It also tells now what else the offset bounds, a
  fund proposal's date and the date of every transfer without a lock, and
  names the wait of the two cancels, in the words of the comment in
  `network/testnet.env`. Nothing but the comment changed in that file.
- **Checks.** `node --check` passed on the five source files, and on
  `src/config/env.js` once its comment had changed. No validator was
  booted and no database touched. The date arithmetic was read line by
  line, as the plan's 0.5 says. The `else` half and the 1b of
  `verifyTransferToFund` are the three lines of `verifyFundProposal`'s
  1b but for the indent, and `MS_PER_MINUTE` is `60_000` in both files; a
  date that does not parse is `NaN`, the comparison is false, and the
  transfer is refused. `canBeSentInAgain`, first line against the `if`
  half: the half accepts while the date is at least the lock and at most
  the lock plus the offset ahead, and time only brings the date nearer,
  so the transfer is accepted now or later exactly while it is at least
  the lock ahead, which is the line
  `createdAt - Date.now() >= lockMinutes * MS_PER_MINUTE`; a date exactly
  the lock ahead passes both. Second line against the `else` half: the
  half accepts while the date is within the offset either way, and time
  only takes the date further behind, so the transfer is accepted now or
  later exactly while it is no more than the offset behind, which is the
  line `Date.now() - createdAt <= env.locks.offsetMinutes * MS_PER_MINUTE`;
  a date exactly the offset behind passes both. A date that does not
  parse gives false in both lines.
- **Beyond the plan**, a throwaway script in the build chat's scratch
  folder, outside the repo, loaded the real modules with the values of
  `network/testnet.env`, a made-up database password, a key file made for
  the run and no `.env`. No server listened and nothing asked the
  database. The modules `src/server.js` imports loaded in its order with
  no error, `server.js` itself left out, so the two new imports of
  `transfer.service.js` link. With the clock held still,
  `canBeSentInAgain` gave the answer of the two halves of check 1b,
  written out and asked "now, or at any later clock?", for 1,881 dates
  over the five transfer types other than the break-glass move, every
  edge one millisecond either side: true at exactly the offset behind and
  at exactly the lock ahead, false one millisecond past, and false for
  good once false. On rows made by hand `assistedTransferCancel` and
  `escrowCancel` refused with their reasons inside the offset and passed
  one millisecond past it, in the order signer, wait, slots; a
  break-glass row, `breakGlassCancel`, `escrowSuccess` and
  `escrowDispute` had no wait. The script was run once more after the
  comment in `src/config/env.js` changed, with the same answers.
  `verifyAnosTransfer` and `verifyTransferToFund` themselves were not
  run: they need the database and real signatures. A real transfer and a
  real cancel on the launched network are the user's run-through.

## 28. The locked transfer cancel (2026-11-11)

Decided 2026-11-11 in the planning chat of section 27, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/locked-transfer-cancel-plan-1.md`. This is
its step 2 of five, its section 1, and it builds on step 1 (section 27).
Why: a guarded or vault transfer waits out its lock in
`locked_transactions`, a week or a month in production, and nothing could
be done with it meanwhile (18.1). A transfer sent by mistake went through
when the lock ended, and the account could send nothing else until then.
The cancel had never been built: this validator had no route for it, and
the wallet's home page plan of 2026-11-06 listed it as out of scope
(`~/Desktop/Z-TestNet/forclaude/wallet-home-plan-1.md`, 4.7). The user,
2026-11-11: "I believe at some point I wanted to add the feature where the
user could cancel a guarded or vault transfer. But I don't see any button
like that on the web app." And: "We need cancel before production. It
shouldn't be too hard to do." Built here: one new follow-up kind, the
ninth, `lockedTransferCancel` (5.8), with its route,
`POST /locked-transfer-cancel`; two columns on `locked_transactions`; and
the ready list, the logs, the held rows a joiner pulls and the read each
learn of it. Three repos change, in this order: the validator (this
step), the doorman, whose validator door has to let the new route through
(the plan's step 3), and the wallet, which gets a "Cancel transfer" button
on the "Locked transfer" row of its account page (step 4); then the
paperwork (step 5). The masterpod, the keyholders and the signing
server's code are not touched. No env variable and no npm package.

### 28.1 The cancel

- **Only the sender cancels.** The cancel is the follow-up of 5.8, signed
  with the account's own keys under the usual rule, any two pairs; no
  stake. A cancel by the break-glass key, for someone who lost their
  passkey, is not in this plan.
- **The kind**, `src/locked-transactions/locked-transfer-cancel.js`, is a
  copy of the assisted cancel
  (`src/assisted-transfers/assisted-transfer-cancel.js`, which is
  untouched) for the other table: `type` `lockedTransferCancel`, `table`
  `locked_transactions`, `signerField` `accountId`, no stake, no `rule`.
  The flow every kind shares runs first (5.1,
  `src/attachments/attachments.service.js`), so a cancel is accepted only
  on a transfer that is held
  (`no locked_transactions transaction with this transactionId`) and that
  every validator has accepted (`this transaction is not approved yet`).
  Then the kind's own three checks, in this order:
  1. the signer is the row's `account_id`, else
     `payload.accountId is not the transfer's sender`;
  2. the wait, else `this transfer cannot be cancelled yet`;
  3. the cancellation slot is empty, else
     `a cancellation is already present`: one cancel per transfer.

  Reasons 1 and 3 are the assisted cancel's, word for word; reason 2 is
  the one section 27 gave it.
- **The wait** (section 27.2) is one call,
  `canBeSentInAgain(row.ogTransaction.payload)`
  (`src/transfer/transfer.service.js`, untouched in this step). Only
  guarded and vault transfers are held in `locked_transactions`, so the
  function always decides by the lock of the transfer's type here: a
  cancel is refused while the transfer's `createdAt` is still at least its
  lock ahead of the validator's clock. That is the exact opposite of the
  lower bound of check 1b, the one condition under which the same signed
  transfer would still be taken in. So once any validator has accepted a
  cancel, that validator refuses the transfer for good, and a transfer
  needs every validator: a cancelled transfer cannot be sent in again,
  although its row has gone to `logs`, where the validators do not look
  when a transfer comes in. With the wallet's dating, the lock plus the
  offset ahead, the wait is the offset: 5 minutes after sending on the
  testnet. It needs no setting.
- **Until when.** After the wait the cancel is accepted until the transfer
  is written: through the lock, and after it until a leader round writes
  the transfer.
- **Where it is stored**: on the transfer's own row, in two new columns of
  `locked_transactions`, the same two `assisted_transfers` has:

  ```sql
  cancellation           JSONB,
  cancellation_approved  BOOLEAN NOT NULL DEFAULT false
  ```

  `cancellation` holds the whole signed object, `{ payload, signatures }`
  as received, NULL while there is none; `cancellation_approved` turns
  true once every validator accepted it. They are the last two columns,
  after `transaction_id`, so a database built from `db/schema.sql` matches
  one that was altered (28.2). The file has them in the table's definition
  and no `ALTER` line.
- **The queries**
  (`src/locked-transactions/locked-transactions.queries.js`). `findLocked`
  answers `{ accountId, approved, ogTransaction, slots: { cancellation:
  { object, approved } } }`: `approved` and `ogTransaction` as before,
  which is all `findHeld` and the transfer flows read, and `slots` in the
  shape `findAssisted` gives, which `findInSlots` reads. New:
  `setLockedCancellation(transactionId, object)`, which fills the slot
  only while it is empty, and
  `markLockedCancellationApproved(transactionId)`; each answers true when
  a row changed.
- **Present blocks.** `findDueIds` gained `AND cancellation IS NULL`: a
  row with a cancellation on it, approved or not, is off the ready list
  (section 6), as an assisted transfer's is. So a transfer cannot be
  written while its cancel is still going round.
- **The effect.** When a validator marks the cancel approved it moves the
  row to `logs`: source `locked_transactions`, outcome `userCancelled`,
  `record` `{ row }` with the cancellation in it (section 7). It is not
  just deleted. `SOURCES` in `src/records/records.queries.js` names
  `locked_transactions` for that. A locked transfer that is written is
  deleted as before.
- **The route.** `POST /locked-transfer-cancel`
  (`src/locked-transactions/locked-transactions.router.js`, mounted in
  `src/app.js` after the assisted transfers router), on the handler every
  follow-up route is built from. It answers `202` + `{ transactionId }` or
  `400` + `{ error }` as every follow-up does (5.1).
- **The peers.** `KINDS` in `attachments.service.js` has nine kinds, the
  new one after `breakGlassCancel`. So a peer accepts the cancel in an
  attachment approval, checks it against its own row by its own clock,
  and finds it stored when the proof comes.
- **A validator that joins** (section 19). The entry of
  `locked_transactions` in the table specs of
  `src/held-transactions/held-rows.service.js` (`TABLES`) has the two
  columns and names `cancellation` as a slot. So the leader sends a locked
  row with its cancellation, and the joiner checks the signatures of a
  filled slot and stores the row with every column.
- **The read** (18.2). `/get-locked-transfer` answers a fourth stage,
  `cancelling`, for a row with a cancellation on it. It is decided right
  after `waiting`, before `locked` and `due`, since a cancel is accepted
  in both and takes the row off the ready list. `findLockedFor`
  (`src/reads/reads.queries.js`) reads `has_cancellation`;
  `LOCKED_STAGES` and `lockedStageOf` (`src/reads/reads.service.js`) have
  the stage. The answer's fields are as they were. Once the row has moved
  to `logs` the read answers `null`.
- **Left as it is.** One known gap comes along from the assisted cancel: a
  cancel that one validator refuses stays unapproved on the others, and
  the transfer is then never written and never removed (21.3, a follow-up
  there). The moment the wait ends is the edge of 27.3. Out of this plan:
  a cancel by the break-glass key; an age limit on a follow-up that got
  stuck; a history line or a notification for a cancelled transfer; the
  receiver's view of a locked transfer.

### 28.2 The rollout

- The validators take this build at their last pull, at the phase 3
  launch, which wipes every database. A database built fresh from
  `db/schema.sql` has the two columns.
- **A database kept from before needs two lines** before the new code
  starts:

  ```sql
  ALTER TABLE locked_transactions ADD COLUMN IF NOT EXISTS cancellation JSONB;
  ALTER TABLE locked_transactions ADD COLUMN IF NOT EXISTS cancellation_approved BOOLEAN NOT NULL DEFAULT false;
  ```

  Without them `findDueIds` fails on the missing column, and that
  validator finishes no leader round. `findLocked` fails the same way, and
  `findHeld` asks it about every transaction that is not in `pending`, so
  that validator approves no transaction either. `npm run db:setup` does
  not add the columns, since `db/schema.sql` adds no column to a table
  that exists: on such a database it stops at the comment lines of the two
  columns until the two lines have run. `npm run db:reset` builds the
  table with them.
- **Every validator has to be on the new code.** One left on the old code
  refuses the cancel as a kind it does not know, so no cancel would be
  accepted; and a joiner and a leader on different code cannot pass the
  held rows of `locked_transactions`, whose columns then differ.
- A doorman on the old code answers `404 Not Found` for the route. The
  door's line is the plan's step 3.
- The wallet's button is the plan's step 4. Against validators or doormen
  without the route, a press ends in the refusal under the row.
- Today's signing server signs the cancel as it signs anything. The new
  one of `~/Desktop/Z-TestNet/forclaude/signing-server-plan-1.md` signs
  only the kinds on its list, so the kind goes on that list before it is
  built (this plan's 4.1).
- The wait needs no setting. The validators work it out from the lock
  numbers they have.
- The run-through is the user's, on the launched network: a guarded
  transfer sent from the wallet, a cancel pressed at once, which the wait
  refuses, and the cancel again after the wait.

### 28.3 Files

Changed: `db/schema.sql` (the two columns at the end of
`locked_transactions`, its header comment and two `COMMENT ON COLUMN`
lines; the header comment of `logs` and `archives`, and
`COMMENT ON TABLE logs`),
`src/locked-transactions/locked-transactions.queries.js` (`findLocked`;
`setLockedCancellation` and `markLockedCancellationApproved`, new;
`findDueIds`; the header comment), `src/app.js` (the import and the
mount), `src/attachments/attachments.service.js` (the import, `KINDS`,
three comments), `src/records/records.queries.js` (`SOURCES`; three
comments), `src/held-transactions/held-rows.service.js` (the entry of
`locked_transactions` in `TABLES`; the comment above it),
`src/reads/reads.queries.js` (`findLockedFor`) and
`src/reads/reads.service.js` (`LOCKED_STAGES`, `lockedStageOf`; the
comments of both and of `getLockedTransfer`). Comment only:
`src/validators/validators.service.js` (`findReadyIds`) and
`src/attachments/stored-attachments.js` (the header and `findInSlots`).
New: `src/locked-transactions/locked-transfer-cancel.js` and
`src/locked-transactions/locked-transactions.router.js`. In the docs: the
README's bullets of `locked_transactions` and of `logs` and `archives` in
the list of tables, its endpoints table (the new route; the row of
`/get-locked-transfer`), the bullet of `/get-locked-transfer`, a paragraph
on the cancel at the end of "Transfer submission", the count of kinds in
"Follow-ups", the ready table, the table of "Logs and archives" and the
sentence under it on what is logged, and the layout lines of
`locked-transactions/`; sections 1, 3 ("logs and archives"), 5.1, 5.8
(new), 6, 7, 8, 18.1, 18.2 and 21.3 above, and this section. No env
variable, no file under `deploy/`, no package file and nothing in
`network/`. Nothing in `assisted-transfer-cancel.js`,
`transfer.service.js`, `held-transactions.js` or `accounts.service.js`,
and nothing but that one comment in `validators.service.js`; in
`locked-transactions.queries.js`, `insertLocked`, `markLockedApproved`,
`findLockedApproved` and `deleteLocked` are as they were.

### 28.4 Notes from the build

Where the plan was silent the simplest thing was chosen and is recorded
here; nothing in 28.1 was changed.

- **The build was made on main at 0f80003**, the commit of step 1, with a
  clean working tree. Every line the plan quotes was where it said, and
  the last section was 27, so this is 28, as the plan expected. `KINDS`
  had eight kinds and `canBeSentInAgain` was exported, as step 1 left
  them.
- **The code is the plan's**: the two columns with their comments, word
  for word; the two new queries with the statements it gives;
  `AND cancellation IS NULL`; the three checks of `verify` in its order,
  the wait with its two comment lines and its one `if`; `store`,
  `findStored`, `markApproved` and `onAccepted` as it lists them; the line
  in `SOURCES`; the entry in `TABLES`; `has_cancellation`; `CANCELLING`
  and the one line in `lockedStageOf`.
- **Where the plan left the place open.** `SOURCES` has
  `locked_transactions` first, the order the holding tables are named in
  everywhere. The two new queries stand after `markLockedApproved`, where
  the assisted table's file has its slot functions. `LOCKED_STAGES` has
  `CANCELLING` second, the order `lockedStageOf` decides in. The entry in
  `TABLES` is written over five lines, like the assisted table's.
  `markApproved` of the kind takes the transaction id alone; the flow
  hands it the slot's name as well, which this table has no use for. In
  the table of section 7 the new row is the first. In the README the
  paragraph on the cancel is the last of "Transfer submission".
- **In `db/schema.sql`** the two new `COMMENT ON COLUMN` lines are lined
  up with each other, not with the seven above them, whose padding is
  narrower; those seven were not padded again. The header comment of
  `logs` and `archives` was wrapped again from its first sentence down to
  "Logs may be purged after a time:"; its other words are as they were.
  The new paragraph in the header comment of `locked_transactions` ends
  with one sentence the plan does not list, saying that the two columns
  stand after `transaction_id`, appended for the same reason.
- **Where a comment says more than the plan lists.** The comment of
  `getLockedTransfer` says that a cancelled transfer answers `null`. The
  comment of `lockedStageOf` says why `cancelling` is decided before
  `locked` and `due`, as the comment of `assistedStageOf` does. The header
  of `locked-transfer-cancel.js` says why the wait is needed: the row
  goes to `logs`, where the validators do not look.
- **Eight places the plan does not name** were first left as they were
  and then changed on the user's word, given the same day when the build
  was reported: "Yes, fix them". Each told the state before this step. In
  `db/schema.sql`: the header comment of `locked_transactions` said
  "transaction_id is the last column" and says that it comes after the
  columns the table began with; `COMMENT ON TABLE logs` named
  `assisted_transfers` and `escrow_transfers` and names
  `locked_transactions` too. In section 3 above, "logs and archives"
  named three tables a row may leave and names the cancelled locked
  transfer too. In the README: the bullet of `logs` and `archives` in the
  list of tables, the same way; "Follow-ups" said "one of the eight
  below" and says nine, the eight below and the one of "Transfer
  submission" above it; the table of "Logs and archives" has the row of
  `locked_transactions`, the first, as in section 7. In the code,
  comments only: the comment of `findReadyIds` in
  `src/validators/validators.service.js` gives the ready rule of a locked
  transaction with "no cancellation present", wrapped again from there
  on; and `src/attachments/stored-attachments.js` names
  `locked_transactions` among the tables whose rows have slots, in its
  header and in the comment of `findInSlots`. Every check below was run
  once more after these changes, with the same answers.
- **Checks.** `node --check` passed on the eleven source files, the nine
  changed and the two new. The psql check of the plan's 1.8 ran against
  the local `anos1`, as the superuser, in one transaction that was rolled
  back, each statement as the code has it, prepared with untyped
  parameters the way pg sends them. The two `ALTER` lines ran, and the
  table then had nine columns, the two new ones last. One row was
  inserted for a throwaway id, approved, its `future_date` a minute back.
  The query of `findDueIds` listed it. The UPDATE of
  `setLockedCancellation` changed one row, and a second run none. The
  query of `findDueIds` then listed nothing. The query of `findLockedFor`
  read `has_cancellation` true. The insert of `moveToLogs`, with the
  source `locked_transactions` and the outcome `userCancelled`, wrote one
  `logs` row whose `record` is `{ row }` and holds the cancellation, equal
  to the object stored. After the rollback `locked_transactions` had its
  seven columns and no row, and `logs` its one row, as before. No
  validator was booted.
- **Beyond the plan, the schema file.** Three more transactions on
  `anos1`, each rolled back, each building into a scratch schema. In the
  first, the edited `db/schema.sql` built its 15 tables from nothing with
  no error and ran a second time with no error; and `locked_transactions`
  built from the file was the same as the `locked_transactions` of `anos1`
  altered by the two lines, column by column: name, type, null, default
  and place. The other two took a scratch copy of a database built by the
  file of 0f80003. On it the edited file stopped at the comment line of
  `cancellation`; with the two lines run first, it ran. That is the
  sentence on `npm run db:setup` in 28.2.
- **Beyond the plan, the code.** A throwaway script outside the repo
  loaded the real modules with the values of `network/testnet.env`, a key
  file made for the run and no `.env`. `src/db/pool.js` was swapped for a
  stand-in that puts every query of the code on one connection, inside
  one transaction that was rolled back, against tables built from the
  edited `db/schema.sql` in a scratch schema of `anos1`. No server
  listened and `fetch` was cut off. 62 checks, all passed. The modules
  `src/server.js` imports loaded in its order, so the new imports link.
  `KINDS` has nine kinds, the new one after `breakGlassCancel`; the
  router has the one route, and `app.js` mounts it after the assisted
  transfers router. Then, with two accounts made for the run and a
  guarded transfer and its cancels signed for real, by pair one and the
  wallet pair, the steps of `verifyAttachment`, which is not exported,
  were run in its order. A cancel was refused with the reason of 28.1 on
  a transfer not yet approved; signed by another account; inside the
  wait, for a transfer dated its lock plus 4 minutes ahead; and a second
  time, with one already in the slot. One with a wrong signature was
  refused by the signature check every kind shares. The signer was
  checked before the wait, and the wait before the slot. The cancel
  passed for a transfer dated 6 seconds less than its lock ahead, and for
  one dated a minute back. Stored, it took the row off `findDueIds`.
  `findStored` found it by its attachment id. Marked approved,
  `onAccepted` moved the row to `logs`: `locked_transactions`,
  `userCancelled`, `{ row }` with the cancellation in it, approved.
  `getLockedTransfer`, which answers `/get-locked-transfer`, said
  `waiting`, `locked`, `due`, `cancelling` and `null` in their places,
  with the fields it had. `readHeldRows` carried the row with
  `cancellation` and `cancellationApproved`. `storeHeldRows` stored it,
  with the slot filled and with the slot empty, skipped it the second
  time, refused it with a wrong signature in the slot, naming the slot,
  and refused a row without `cancellationApproved`, as a leader on the
  old code would send it. Not run: `receiveAttachment` and the attachment
  messages between validators, which need the other validators. A real
  cancel on the launched network is the user's run-through.
- **The local databases are older than the two lines.** `anos1` to
  `anos5` also lack `future_date` on `assisted_transfers` (section 22),
  `ignored` on `validators` and the `ignore_votes` table (section 19). The
  two lines of 28.2 are for a database that is one step behind; alone
  they do not bring these five up to this code. Nothing was changed in
  them.

## 29. A refusal starts the ignore vote (2026-11-12)

Decided 2026-11-12 in a planning chat, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/validator-refusal-plan-1.md`, built in the
same chat. Why: a validator left the count only by an ignore vote, and only
silence started one (section 19: a refused connection, a dropped one, no
answer within the timeout). A validator that answered with a refusal stayed
counted, and its refusal failed every transaction at the validator that
took it and ended every leader round. Two cases showed it on 2026-11-12: a
validator that has not taken the new code and still runs the old network,
and a validator whose program has stopped while its doorman keeps answering
for it, `502 worker unavailable` or `504 worker timeout` (doormansoftware
`src/door/forward.js`). The vote itself would have passed in both: the
health check of section 19.3 fails on another chain tail and on a doorman's
`503`. The user weighed a quorum of 80 or 90 percent against one more
round, in which the others test the validator that refused, and took the
round, with the health check of the ignore vote as the test. One build step
in this repo; nothing touches the doorman, the wallet, the masterpod, the
keyholder, the registry, the database schema or a settings file, and there
is no new message, route or variable.

### 29.1 The decisions, as they apply to the code

- **A refusal is tested, and only a failed test counts.** A validator that
  refused and passes the health check keeps its refusal: the transaction is
  not approved, or the round ends, as before. One that fails the check is
  handled as a silent validator is. The check is the one of section 19.3,
  unchanged: `200`, the checker's `chain.position` and `chain.recordHash`,
  the checker's `leader`.
- **The originator.** `src/votes/votes.messages.js` `settleNoAnswers`, which
  the four originators already pass their approvals through: the peers that
  refused (`approved: false` without `noAnswer`) are checked by the
  originator itself, all at once (`findFailingRefusers`, one line each:
  `validator N refused and fails the health check: <reason>`); the ones
  that fail join the silent ones in the report, the wait of at most
  `NO_ANSWER_WAIT_SECONDS` and the one re-send, exactly as section 19.1
  has them. So a real refusal from a healthy validator costs one health
  read and no report. An originator that no longer counts itself
  (`join.service.js` `isCounted`: more than half of its peers have just
  answered that it is ignored) checks nobody, since the leader would refuse
  its report and the wait would run out for nothing.
- **The leader round.** `src/validators/validators.service.js`
  `settleRoundAnswers` names the peers that refused the ready announcement
  or the official list in the vote it already runs for the silent ones.
  `runVote` drops a peer that passes the leader's own check (`validator N
  answers; no vote`), as it always dropped a reachable id. A passed vote
  starts the round again; after a failed one the call goes once more to
  the silent peers only, and a refusal still among the answers ends the
  round with its line, as before.
- **A voter that refuses the vote.** `src/votes/votes.service.js`
  `runVote`: a voter that refused an ignore vote is named in the one new
  vote, as a voter that gave no answer is. The new vote's first step drops
  it again when it passes the starter's check. Without this, two validators
  that are out of step block the vote on each other: each is a voter in
  the vote on the other and refuses the request. The line of a second
  failure now reads `no vote twice from validator N; no further vote`, for
  both kinds.
- **`checkReachable` moved** from `votes.service.js` to `votes.messages.js`,
  word for word, because the originators cannot import the service: it
  imports `validators.service.js`, which imports them. `votes.service.js`
  imports it back and lost the three imports it used nowhere else
  (`findTailRow`, `isObject`, `getHealth`).
- **What stays.** The floor (`IGNORE_FLOOR_PERCENT`, 51: with 25 active
  rows at most 12 ignored), the starter rule, the proof and every message
  as section 19 has them. The report carries ids only, so its receiver and
  the door need no change, and its name, `noAnswerReport`, stays although
  it now also carries validators that refused. A refusal of the proof of
  acceptance or of the final declaration is not acted on, as silence there
  is not. `502` and `504` from a doorman stay answers: the fix does not
  read the status.

### 29.2 The rollout

- **With the last validator pull**, which starts on 2026-11-13: every
  worker pulls `main` and restarts on an empty database. No doorman pull is
  needed for it, no setting, no `npm ci`, no schema step. The messages are
  the ones of section 19, so a validator on older code answers a vote
  request or a report as it always did.
- **A validator that does not come to the pull** keeps running the old
  network and refuses the others. It is voted out at its first refusal and
  joins later by its visit, as long as at least 13 of the 25 stay counted.
  The wallet does not learn who was voted out, so such a validator is left
  out of the wallet's lists, or its two VMs are stopped
  (`~/Desktop/Z-TestNet/test_net_phase_3_launch/last-validator-pull.md`).
- **Not caught:** a validator that passes the health check and still
  refuses everything, for example one whose clock is more than
  `LOCK_OFFSET_MINUTES` off (section 27), or whose list of ignored
  validators differs from the others'. The quorum the user described is
  the follow-up for that, after production.

### 29.3 Files

Changed: `src/votes/votes.messages.js` (`checkReachable` moved in,
`settleNoAnswers`, the new `findFailingRefusers`, three import lines, the
header), `src/votes/votes.service.js` (`checkReachable` moved out, the
imports, the retry of `runVote`, two comments),
`src/validators/validators.service.js` (`settleRoundAnswers`, the comment
of `leadRound`); a comment only in `src/accounts/accounts.service.js`,
`src/transfer/transfer.service.js`, `src/fund/fund.service.js` and
`src/attachments/attachments.service.js`. In the docs: six places of the
README (the settings table, the routes table, "The leader round",
"Ignoring and joining", "The votes", "The report and the originator's
wait"), one paragraph in section 19 above, and this section. No file under
`deploy/`, `network/` or `db/` and no package file changes; the doorman is
not touched.

### 29.4 Notes from the build

- **The build was made on main at e3ed89e**, with a clean working tree. The
  code is the plan's, line for line.
- **One comment says more than the plan lists.** In the comment of
  `leadRound` the plan changes the first sentence of the last paragraph
  and says the rest stays. That rest said a failed vote sends the call once
  more "to that peer", which after the new first sentence would have
  included a refusing peer. It says "to a peer that gave no answer", and
  the paragraph is wrapped again.
- **Checks.** `node --check` passed on the seven source files, with Node
  24.22.0. The four names of the changed import lines were read against
  their modules' exports: `findTailRow` in
  `src/garlic-chain/garlic-chain.queries.js`, `isCounted` in
  `src/validators/join.service.js`, `getHealth` in
  `src/validators/validators.client.js`, `checkReachable` in
  `src/votes/votes.messages.js`. A search of `src/` shows `checkReachable`
  in `votes.messages.js` and `votes.service.js` only, and no
  `findTailRow`, `isObject` or `getHealth` left in `votes.service.js`.
  Nothing was run: no server, no rig, no script that loads the modules.
  `node --check` does not link imports, which is why the names were read
  by hand; the first boot on a worker is the first time these modules load
  together.
- **The import ring.** `votes.messages.js` now imports `join.service.js`
  (`isCounted`), which imports `votes.messages.js` (`IGNORE`, `INCLUDE`).
  The two were already in one ring through `validators.messages.js`, and
  no module in it uses an imported name while it loads, only inside
  functions.
- **A round in flight.** An originator's check compares the refusing
  validator's tail and leader with its own at that moment. While a round
  is being written the tails differ for a moment across healthy
  validators, so a healthy validator can fail that one check. It is then
  reported; the leader's own check, made in a busy section with no round
  in flight, drops it (`validator N answers; no vote`), and the sender of
  that transaction waits up to `NO_ANSWER_WAIT_SECONDS` for the refusal it
  would have got at once.
- **Never run live.** No ignore vote and no include vote is recorded on
  the live network before this build
  (`~/Desktop/Z-TestNet/forclaude/validators-record.md`); both ran on the
  rig of 2026-11-07 (19.5).

## 30. The worker script writes the keyholder's bucket line (2026-11-12)

One change to `scripts/bootstrap-worker.sh`, at point 10.3, from section
3.6 of `~/Desktop/Z-TestNet/forclaude/keyholder-share-copies-plan-1.md`
(FINAL, 2026-11-12). The keyholder now also writes every share it saves
to a bucket in the banker's own project (keyholdersoftware
`docs/schemas.md` section 16; the bucket is step 15 of the Cloud Shell
line, doormansoftware `docs/schemas.md` section 11), and it does not
start without the line `SHARE_COPIES_BUCKET` in its `.env`. The
keyholder's own script, `scripts/set-copies-bucket.sh`, writes that line.
The 25 workers that exist get it from the worker paste of the last
validator pull; this change is for a validator set up later, and for
every run of the worker line after it. Nothing else in the script
changed, and nothing in the validator: no route, no table, no setting, no
message.

### 30.1 The change

- **At point 10.3, before the keyholder is started or restarted**, and
  only once all five lines of 7.3 are filled, the script runs
  `sudo -u anos sh /opt/anos/keyholdersoftware/scripts/set-copies-bucket.sh`
  and keeps the one line it prints: `SHARE_COPIES_BUCKET: written
  <project id>-share-copies` or `SHARE_COPIES_BUCKET: already <project
  id>-share-copies`. The keyholder's script reads the project id from the
  metadata server itself; the worker script hands it nothing.
- **A keyholder that is running when the line is written is restarted**,
  as it is when its software changed: `10.3 keyholder: restarted
  (SHARE_COPIES_BUCKET written)`. A keyholder that is not active is
  started, and one whose repo moved in this run is restarted as `11.3`,
  both as before.
- **The 10.3 line shows what the script printed**, after the KMS line:
  `10.3 keyholder: started; KMS ok; SHARE_COPIES_BUCKET: written <project
  id>-share-copies; 3200: 200`.
- **A line that names another bucket**, a missing `.env` or a metadata
  server that does not answer ends the keyholder's script with its
  message, and this point with it: `failed at step 10.3 (keyholder)`,
  the message among the five log lines above it.
- **Point 7.3 and its five lines are not touched.** `fill` still only
  replaces a line that is already in `.env`.

### 30.2 Notes from the build

- **The build was made on main at 6118cb9**, with a clean working tree.
  `sh -n` passed on the script. Nothing was run.
- **The script runs as `sudo -u anos`, without the login shell**, like
  show-key at 7.2, so that only its one line is captured. The guide and
  the paste of the last pull run the same script through `sudo -iu anos`.
- **The keyholder's repository must hold the script** by the time the
  worker script reaches 10.3, so both repositories go to GitHub
  together. The worker script pulls the keyholder's repository at 9.1,
  before 10.3.
- **Left as it was: `boot_error`.** It reads a unit's journal for
  `Registry failed`, `Genesis failed`, `Could not connect`, `KMS self-test
  failed` and `Error:`. A keyholder without the line stops with Node's
  `Error: Missing required environment variable: SHARE_COPIES_BUCKET`,
  which it catches. The keyholder's other new stop line, `Share copies
  could not start: <message>`, for a database without the
  `waiting_copies` table, is not in that list: such a keyholder is
  reported after the ninety seconds, without that line. On this script's
  own path the table is there: the 9.1 pull runs the database scripts
  again when `db/` changed.
- **The keyholder's two new boot lines**, `Share copies: bucket <name>,
  <n> waiting` and `Share copies: test file ok` or the reason, are not
  shown by this script. They are in the keyholder's journal.

## 31. Seven small fixes for resilience (2026-11-19)

Decided 2026-11-19 in a planning chat of two rounds, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/validator-resilience-plan-1.md`, built the
same day in a chat of its own. The network is live since a soft launch a
few days earlier and holds real accounts. Why: it has had one ignore vote,
on 2026-11-16 at 15:47 UTC, naming validators 18 and 24. Neither was down.
The vote's record says what a voter saw, `tail at position 288, own 289`,
for both: the other 23 had written link 289 and these two had not. A
validator that missed a write was always voted out: the leader waited,
wrote, and only then started the vote, and by then every other validator
had written, so the one that missed it failed every health check. A
validator that was voted out was told nothing: validator 18 stayed out for
3 hours 56 minutes and validator 24 for 12 hours 51 minutes, each until a
wallet's transaction came in through it, and that transaction failed. And
a validator that came back kept its old waiting rows, which block the
account on that validator. Three more things were read in the code and
not seen live: a validator that is up and does not count itself answers
`503` to everything, passes the health check and cannot be voted out, and
its join loop ends for good on any thrown error; a batch that is rolled
back moves the counter behind `garlic_chain.position` on, after which that
validator can never catch up; and a stop did not wait for a round.

Seven fixes, lettered as in the planning chat: A, B, C, D, E, J and K. F,
the leader's look at every validator's chain end before a round, is not
among them: it has a plan of its own. This plan is about honest
validators, not a validator that is corrupt on purpose. One build step in
this repo, then a rig (31.5). Nothing touches the doorman, the wallet, the
masterpod, the keyholder, the database schema, the registry, the genesis
files or a settings file, and there is no new message between validators,
no new route, no new variable and no package. Each fix changes only what
the validator that runs it does, so a validator on this code and a
validator on `6b27427` work together, and the code goes onto the
validators one at a time.

### 31.1 The decisions, as they apply to the code

- **A. The health check asks "do you count yourself", where the question
  is whether to ignore a validator.** `src/votes/votes.messages.js`
  `checkReachable(validator, { mustCount = false } = {})`: after the
  checks of section 19.3 (`200`, the checker's `chain.position` and
  `chain.recordHash`, the checker's `leader`), with `mustCount` a health
  whose `counted` is not `true` answers `{ reachable: false, reason:
  'does not count itself' }`. It comes last, so every reason of before
  stays as it was. Three callers pass `mustCount: true`: the originator's
  check of a peer that refused (`findFailingRefusers`, same file), the
  voter in an ignore vote (`src/votes/votes.service.js`
  `receiveIgnoreVote`, `mustCount: payload.action === IGNORE`) and the
  starter's own check before an ignore vote (`runVote`). An include vote
  keeps the check of 19.3: a joiner does not count itself yet while the
  others vote on it.
- **B. A thrown error never ends the joining.**
  `src/validators/join.service.js`: `startJoinLoop` runs `joinLoop`
  through the new `keepJoining`, which catches whatever `joinLoop` throws,
  logs `join loop failed: <message>; trying again`, waits
  `VALIDATOR_CALL_TIMEOUT_SECONDS` as every other failed try does, and
  runs the loop again. The line `join loop stopped: <message>` of a thrown
  error is gone. The stop that needs a person stays a stop: `join loop
  stopped: the own chain cannot reach the network tail`.
- **A leader catches up before it counts itself, and then leads at once
  (decision 11 of the plan).** `joinLoop`, the step "own id is that
  leader": `catchUp()` first. A pass that stops ends the loop with the
  line above. A pass that ends with another leader goes back to the sweep
  at once. Otherwise `dropWrittenHeldRows()` (D), `setCounted(true)`,
  `leading at position P`, and `runLeader()` in the background, so what
  waited is written without waiting for the next transaction. Before, a
  validator that the others named as leader counted itself at once, also
  when it was one batch behind.
- **C. The self-check.** `src/validators/self-check.js`, new, built like
  `src/held-transactions/unapproved-sweep.js`: `startSelfCheck()` and
  `stopSelfCheck()`, a timer that is unref'ed, `SELF_CHECK_EVERY_MS =
  60_000`, the first check one interval after the start. One check,
  `selfCheck()`, which never throws:
  1. not counted (`isCounted`), or the busy flag held (`isBusy`): the last
     finding is forgotten, nothing else;
  2. the own table's leader is read (`findLeaderId`), then
     `sweepHealth()`; no majority: forgotten, nothing else;
  3. the finding, the first that holds: the majority's ignored list holds
     the own id, `ignored by the network`; the majority's position is
     above the own (`ownTail`), `behind the network (position P, the
     network's Q)`; the majority names a leader, and it is not the own
     table's, read again now and the same as before the sweep, `names
     leader X, the network names Y`. An own leader that moved during the
     sweep is no finding: the rig showed why (31.4). A validator whose own
     position is above the majority's has no finding of any kind (31.4);
  4. not counted or busy by now, since the sweep takes up to the call
     timeout: forgotten, nothing else;
  5. no finding: forgotten;
  6. a finding, and the check before had none: remembered, `self-check:
     <finding>`;
  7. a finding, and the check before had one too, of whatever kind:
     `self-check: <finding>, twice in a row; joining again`, forgotten,
     `setCounted(false)`, `startJoinLoop()`.

  An error is logged as `self-check failed: <message>` and changes
  nothing. `src/server.js` starts the check in the `listen` callback,
  after `startUnapprovedSweep()`, and stops it in `shutdown`.
- **D. The waiting rows of a validator that comes back.**
  `src/held-transactions/written-rows.js`, new. Two functions, each one
  database transaction that deletes from the two child tables
  (`escrow_arbitrations`, `guardian_votes`) and then from the five tables
  of `HELD_TABLE_NAMES`, logs after the commit and resolves with the
  number of rows the five tables lost; a database error is thrown.
  `dropWrittenHeldRows()`: every row whose transaction the own chain
  holds (`DELETE FROM <table> h WHERE EXISTS (SELECT 1 FROM garlic_chain g
  WHERE g.transaction_id = h.transaction_id)`), approved or not, one line
  a row: `dropped held <table> transaction <id as hex>: already on the
  chain`. `clearHeldRows()`: every row, one line a row: `cleared held
  <table> transaction <id as hex>: the join takes the leader's rows`.
  Both are called by the join loop only, before the validator counts
  itself, never while it is counted, so neither can cross a write:
  `dropWrittenHeldRows` in the leader's step of `joinLoop` and at `case
  COUNTED` of `joinThrough`, so at every start and after every catch-up;
  `clearHeldRows` at `case INCLUDED`, right before `pullHeldRows`. That is
  how a row the leader no longer holds goes, and how a row gets the
  follow-ups it missed. While the joiner clears and pulls it answers `503`
  to every POST but two, so nothing else writes those tables. Plain
  deletes, as the sweep of section 21 is: only the waiting tables, never
  the chain, the accounts, the logs or the archives.
- **E. The counter is set to the chain's end before every write of
  links.** `src/garlic-chain/garlic-chain.queries.js`
  `prepareChainWrite(client)`, two statements: `SELECT
  pg_advisory_xact_lock(hashtext('garlic_chain'))`, a lock that only
  another writer of links waits for, held to the end of the database
  transaction, so two writes never cross; then `SELECT
  setval(pg_get_serial_sequence('garlic_chain', 'position'),
  coalesce(max(position), 0) + 1, false) FROM garlic_chain`, so the next
  link gets the tail's position plus one, 1 on an empty chain. It is the
  first line after `BEGIN` in the three database transactions that insert
  links: `writeTransactions` (`src/accounts/accounts.service.js`, the
  batch), `replayLinks` (`src/garlic-chain/replay.service.js`, a catch-up
  chunk) and `runGenesis` (`src/genesis/genesis.service.js`). The check in
  `replayLink` that the counter gave the link's own position stays.
  `checkChainWrite()`, same file, tries the two statements once in a
  transaction that is rolled back; `src/server.js` calls it after the
  database check and before genesis, and a start whose database user may
  not run them stops with `Chain write check failed: <message>`. A banker
  then sees it at the pull, not at the first transaction.
- **J. The official list goes once more before any vote.**
  `src/validators/validators.service.js` `settleRoundAnswers(answers,
  resend, what, { secondSendFirst = false } = {})`. First every answer
  with a reason is logged, `validator N <what>: <reason>`, in both steps
  of the round and before any vote; before, a silence or a refusal was
  logged nowhere when the vote passed. With `secondSendFirst`, which
  `leadRound` passes at step 3 only, the call then goes once more to
  every peer that gave no answer or refused, after the line `the call
  goes once more to validator N` (`validators N, M` for several), and the
  second answers take the place of the first. Then the vote, the one
  further send to a silent peer after a failed vote, and the end of the
  round, as sections 19 and 29 have them. A validator that wrote at the
  first send answers the second with an empty list and writes nothing
  twice: `writeApproved` finds no approved row. A validator that answers
  `200` with fewer ids than the leader wrote is not sent to again: C
  finds it. The ready announcement keeps its order.
- **K. A stop waits for a round, a vote or a join.**
  `validators.service.js`: a flag `stopping`; `stopBusySections()` sets
  it, `isStopping()` reads it, and `takeBusy()` answers false once it is
  set, so no round, vote or join starts any more. `votes.service.js`
  `startVote` opens with `if (isStopping()) return;`, before it takes the
  flag or queues anything: `drainReports` calls `startVote` for each
  queued report and `startVote` queues a report it cannot run, so without
  that line the queue would never empty during a stop. `server.js`
  `shutdown`: `stopBusySections()`, then, while `isBusy()`, the line `a
  round, a vote or a join is under way; stopping when it ends` and a wait
  of at most `STOP_WAIT_MS` (30 seconds), looked at every 100
  milliseconds; then `server.close` and the pool, as before. The safety
  net is `STOP_WAIT_MS + 10_000`. The unit sets no stop timeout, so
  systemd's own applies.
- **No new setting.** The minute of the self-check and the 30 seconds of
  the stop are constants in their files, as `SWEEP_EVERY_MS` is in
  `unapproved-sweep.js`.
- **What stays.** Every message, route, table and setting, and the
  registry. "Every counted validator answers, or the network stops": no
  quorum. A proof of acceptance or a final declaration that gets no
  answer is logged only. A validator whose chain is ahead of the others',
  or differs from theirs, stops and waits for a person. The wallet is
  answered `202` whatever the validators said. The floor of 51 percent.

### 31.2 The rollout

- **One validator at a time, no shutdown.** The order is the user's:
  validator 1 first, watched, then the others one at a time, each counted
  again before the next one starts. Nothing but the validator's program
  restarts: no `npm ci`, no database step, no doorman pull, no setting.
- **The line for a worker**, as `banker@worker`. It is the line of
  `~/Desktop/Z-TestNet/guides/operator-guide.md` step 11, point 3, with a
  leader check between the pull and the restart. The user decided that
  check: the restart line asks first whether the validator is the leader,
  and does not restart a leader.

  ```text
  sudo -iu anos git -C /opt/anos/anossoftware pull --ff-only && node -e "fetch('http://127.0.0.1:3000/health').then((r) => r.json()).then((h) => { if (h.leader === h.validator.id) { console.log('This validator is the leader right now. Nothing was restarted. Wait for the next transaction, then paste the line again.'); process.exit(1); } }, () => {})" && sudo systemctl restart anos-validator && sleep 3 && sudo journalctl -u anos-validator -n 8 --no-pager -o cat
  ```

  The check asks the validator itself, on its worker, so it is exact to
  the second. When the validator leads, nothing is restarted: wait for
  the lead to move on, or send one transaction through, then paste the
  line again. The pull then answers `Already up to date.` and the check
  runs again. The check's three cases were tried on the Mac against a
  stand-in health page (leads: stops; another leads: goes on; nothing
  answers: goes on). The whole line was not, since a Mac has no systemd.
  The line goes into
  `~/Desktop/Z-TestNet/upcoming_validator_pulls/Nov_19/pull_steps.md` on
  the user's word.
- **What a restart costs the network**, while validators on `6b27427` are
  still about. While the program is down, a transaction that needs its
  yes waits up to `NO_ANSWER_WAIT_SECONDS`, then goes through. In the
  seconds between `listening` and `counted` the validator answers `503`.
  To an originator on `6b27427` that is a no that stands, and the
  transaction is not approved. To an originator on this code it is a
  validator that fails the health check: a wait, and then either the
  validator is counted again or it is voted out and joins.
- **An ignore vote on a validator that does not count itself** passes
  only once every voter runs this code. Until then a voter on `6b27427`
  finds such a validator reachable and answers no, and the vote fails as
  it does today.
- **Validators 18 and 24 delete nothing by hand.** Each should still hold
  the transaction of link 289 (`e38cc911…`) as an approved row in
  `pending`. The first start of this code should show `dropped held
  pending transaction e38cc911…: already on the chain` on each. If the
  line is not there, the row was not there.
- **Not known before the first days: the self-check's traffic.** One
  health answer through a doorman is 736 bytes (measured 2026-11-19).
  With 24 asked once a minute and the connection set up each time, the
  estimate is 2 to 8 GB a month for each validator, against the doorman's
  own counter of 100 GB a month. Not measured. `sudo nft list quota inet
  doorman egress-month` on a doorman shows it.

### 31.3 Files

Changed: `src/votes/votes.messages.js` (`checkReachable` and its comment,
the call in `findFailingRefusers`), `src/votes/votes.service.js` (the two
calls of `checkReachable`, the first line of `startVote`, one import),
`src/validators/validators.service.js` (`stopping`, `takeBusy`,
`stopBusySections`, `isStopping`, `settleRoundAnswers`, the call of step 3
in `leadRound`, the comments of both), `src/validators/join.service.js`
(`startJoinLoop`, the new `keepJoining`, the leader's step of `joinLoop`,
two cases of `joinThrough`, one import, the opening comment and the
comments of both functions), `src/garlic-chain/garlic-chain.queries.js`
(`prepareChainWrite`, `checkChainWrite`),
`src/accounts/accounts.service.js`, `src/garlic-chain/replay.service.js`
and `src/genesis/genesis.service.js` (one line and one import each),
`src/server.js` (the chain write check, `startSelfCheck`, `shutdown`,
three imports). In seven of these files also the comments that 31.4
lists.
New: `src/validators/self-check.js`,
`src/held-transactions/written-rows.js`. In the docs: the README
("Running", the `garlic_chain` bullet of "Database", "The leader round",
"Ignoring and joining", two lines of "Project layout") and this section.
No file under `deploy/`, `network/`, `db/` or `scripts/` and no package
file changes; the doorman is not touched.

### 31.4 Notes from the build

- **The build was made on main at `6b27427`**, with a clean working tree,
  equal to GitHub. All 25 live validators ran that commit at 19:31 UTC on
  2026-11-19. The code blocks of the plan's sections 1.1 to 1.9 are in
  the code as the plan has them. Where the plan gives steps and no code
  (its 1.6 and 1.8), the notes below say what was picked, and one of them
  what the rig then changed.
- **A validator that is ahead has no finding.** The plan's list of one
  self-check (its 1.8) has no step for a validator that is ahead of the
  others; its decision 12 says the check does nothing then. Built so:
  when the own position is above the majority's, the check has no finding
  of any kind, not `ignored by the network` and not another leader
  either, and it forgets the last one. The own tail is read after the
  sweep, as 1.8 orders its steps.
- **A fault the rig found, fixed: "another leader" compared two
  different moments.** As the plan has it, one check reads the others'
  health and then the own table's leader. The look at the others lasts as
  long as the slowest health answer, up to the call timeout. A round that
  ends meanwhile hands the lead on: the own table then names the new
  leader, the others' answers still name the old one, and a validator
  that is in step has a finding. Two such checks a minute apart took it
  out of the count. On the rig, with the proxy holding validator 5's
  health answer for 6 seconds and its answer to the official list for 5,
  and one transfer sent in 2.5 seconds before each of two checks of
  validator 4: `self-check: names leader 3, the network names 2`, a minute
  later `self-check: names leader 4, the network names 3, twice in a row;
  joining again`, and validator 4, which had missed nothing and was the
  leader by then, did not count itself for the 6 seconds its join took.
  The proxy made both windows seconds wide so that the timing was
  certain. On one computer they are a few milliseconds wide: 945
  transfers in 150 seconds with nothing slowed brought no finding on the
  code before the fix. On the live network they are as wide as the
  slowest health answer and the slowest answer to an official list, and
  with transfers coming in every few seconds, as a payout batch sends
  them, two hits a minute apart are a matter of time. The fix, in
  `src/validators/self-check.js`: the own leader is read before the sweep
  as well, and "another leader" is a finding only when it is the same
  before and after. An own leader that moved during the sweep means that
  a round ended in between, and nothing is concluded from it. A validator
  that really missed a hand-over keeps its old leader, so it is still
  found (31.5, the missed hand-over). The same two transfers at the same
  two checks after the fix: no line, and validator 4 stayed counted. The
  other two findings need no such care. "Ignored" does not move with a
  round. And the own tail is read after the sweep, which errs to the safe
  side: a validator that writes when the others do is then level with
  them or ahead of them, and ahead is no finding.
- **One helper serves both deletes** of `written-rows.js`
  (`deleteHeldRows`, private). On the two child tables
  `dropWrittenHeldRows` runs the same statement as on the five tables: a
  child row's `transaction_id` is its held row's. A child row gets no log
  line.
- **`checkChainWrite` leaves the counter at the chain's end.** A sequence
  is not part of a database transaction, so the `setval` stays although
  the check's transaction is rolled back. Nothing else writes at that
  point of the boot, so it only puts the counter where the next write
  would put it.
- **Three sends at the write step, at the most.** After the second send
  of J and a vote that failed, the call goes once more to a peer that
  gave no answer, as before this build. The line of a peer that is silent
  then still reads `gave no answer twice; the round ends`.
- **A reason can be in the log twice, and the second answers get no line
  of their own.** `settleRoundAnswers` logs every reason at once, and
  logs the reason that ends the round again at its end, as it did before.
  When the second send of J gets no answer either, the leader's log goes
  from `the call goes once more to validator N` straight to the vote, ten
  seconds later (31.5, point 4). The reason of the first send is in the
  log, which is what the plan asks for.
- **Seen on the rig and left as it is: the minute a transfer waits for a
  validator that is back at once.** An originator that has reported a
  validator looks at its own table once a second, for at most
  `NO_ANSWER_WAIT_SECONDS`, until that validator is ignored, and only
  then sends the approval once more. A validator that was only restarting
  is counted again within seconds and is not voted out, and the transfer
  still waits the whole minute: 60.2 seconds on the rig, twice (31.5, the
  restart while transfers come in, and point 9). Before this build such a
  transfer waited the same minute. A validator that is stopping still
  answers for about three seconds on the connections the others hold
  open, `counted: true` in its health, which is why the vote on it
  failed. To end the wait as soon as the reported validator passes the
  health check again, or to have a stopping validator say so in its
  health, would be a change of design. It is not in this plan.
- **One sentence of section 19.5 that the code does not bear out.** Its
  first follow-up says a validator that missed an official list keeps
  those transactions approved, and "a later round would write them again
  on that validator alone". It would not: the official list holds only
  the ids that every list holds, so no later list names those rows. They
  stay, approved, and the validator refuses the account's next
  transaction while it passes the health check. That is what
  `dropWrittenHeldRows` ends. Section 19.5 is the record of its build and
  is left as it was.
- **Comments the plan does not name** were first left as they were, where
  the build made them say less than the code does, and listed for the
  user, who said to bring them in line (2026-11-19, "Fix the comments and
  start the rig"). Brought in line: in
  `src/validators/validators.service.js` the comment of `takeBusy` (it
  also answers false during a stop); in `src/votes/votes.service.js` the
  comments of `startVote` (nothing starts during a stop), of
  `receiveIgnoreVote` and of `runVote` (an ignore vote also asks about
  `counted`); in `src/validators/join.service.js` the comment of
  `setCounted` and the last sentence of the opening comment (the
  self-check clears the flag too); in `src/server.js` the comment of
  `shutdown` (the wait comes first); the comments of the three writers,
  `writeTransactions`, `replayLinks` and `runGenesis` (each now names the
  two opening statements); and in the README's "Project layout" the line
  of `garlic-chain.queries.js` (it listed three functions; there are
  five). Comments only: no line of code changed with them.
- **Left as it was: `boot_error` of `scripts/bootstrap-worker.sh`.** It
  reads a unit's journal for `Registry failed`, `Genesis failed`, `Could
  not connect`, `KMS self-test failed` and `Error:`. The new stop line,
  `Chain write check failed: <message>`, is not in that list, so the
  worker script would report such a validator after its ninety seconds,
  without that line. On a worker the database user owns its tables
  (`scripts/setup-db.sh` applies the schema as that user), so the check is
  expected to pass there.
- **The import ring.** `self-check.js` is imported by `server.js` only
  and `written-rows.js` by `join.service.js` only, and neither uses an
  imported name while it loads, only inside functions. `votes.service.js`
  already imported `validators.service.js`.
- **Checks.** `node --check` passed on the eleven source files, the nine
  changed and the two new, with Node 24.22.0. The names of the changed
  and the new import lines were read against their modules' exports:
  `isStopping`, `isBusy` and `stopBusySections` in
  `src/validators/validators.service.js`; `prepareChainWrite` and
  `checkChainWrite` in `src/garlic-chain/garlic-chain.queries.js`;
  `clearHeldRows` and `dropWrittenHeldRows` in
  `src/held-transactions/written-rows.js`; `startSelfCheck` and
  `stopSelfCheck` in `src/validators/self-check.js`; `ownTail` and
  `sweepHealth` in `src/garlic-chain/replay.service.js`; `isCounted`,
  `setCounted` and `startJoinLoop` in `src/validators/join.service.js`;
  `findLeaderId` in `src/validators/validators.queries.js`; `pool` in
  `src/db/pool.js`; `HELD_TABLE_NAMES` in
  `src/held-transactions/held-transactions.js`; `env` in
  `src/config/env.js`. One check more than the plan lists: Node linked the
  whole module graph from `src/server.js` once, with an empty
  environment. The load stopped at the first settings read (`Missing
  required environment variable: PGDATABASE`), after every import of
  every module had been matched to an export. No key file was read, no
  database connection made, no server started. The same load with one
  wrong name put in front of it stopped with `does not provide an export
  named`, so the check does see a wrong name. No statement was run
  against a database in that step: the rig was the first run. After the
  rig, with its fix and the comments in: `node --check` on the eleven
  files again, the link check again, and the rig's copy of the code
  compared with the working tree, file by file: equal, but for the rig's
  own genesis pair. `git status` showed the thirteen files of 31.3 and no
  other, on `main` at `6b27427`.

### 31.5 The rig

The rig (the plan's section 2), 2026-11-19, on this Mac, everything in the
build chat's scratchpad and nothing in the repo. Built as the rig of 19.5
and the payout tool's
(`~/Desktop/Z-TestNet/og app signer/test/README.md`) were:

- **Two copies of the code**, without `.git`, `node_modules` linked: the
  working tree, and `6b27427` from `git archive`. Each validator is one
  process started from one of the two copies, so a validator changes its
  code by a stop and a start from the other copy.
- **Five databases**, `anosrig1` to `anosrig5`, on Homebrew PostgreSQL
  17.11 by `scripts/setup-db.sh`, under a role of the rig's own,
  `anosrig`, which owns the tables and the counter as the database user
  does on a worker. No other role or database of the Mac was touched.
- **A key per validator**, in the format `scripts/make-keys.js` writes, in
  owner-only files, the private halves never shown. The values that
  differ per validator in five machine files, given as the second
  `--env-file`. The network's own settings as they are: the call timeout
  of 10 seconds, the wait of 60, the self-check's minute.
- **A registry of five rows**, `http://127.0.0.1:3711` to `3714` for
  validators 1 to 4, and the proxy's address for validator 5.
- **A genesis pair and a signer of the rig's own**, built as
  `~/Desktop/Z-TestNet/anossoftwarescripts/make-genesis-accounts.mjs` and
  `~/Desktop/Z-TestNet/og app signer/transfer.mjs` build theirs, with the
  rig's OG keys in an owner-only file in the scratchpad. The keys file on
  the Desktop was never read. Every transfer paid the rig's fund account
  or the one extra account the rig made.
- **A stand-in for the masterpod**, asked once, for that one account.
- **No doorman**: the validators called each other directly.
- **One tool of the rig's own: a small proxy in front of validator 5**,
  which that validator's registry row points at, so the other four reach
  validator 5 through it. It can hold back the first or every `POST
  /official-list`, or one `POST /final-declaration` (not passed on, no
  answer); hold the answer to an official list or to `GET /health` for
  some seconds; and answer `counted: false` in `/health` with `503` to
  every POST.
- Every line a validator printed got the time of day in front, to the
  millisecond, by a filter on its output.

The rig found one fault, in the self-check (31.4). Points 1 to 4 ran
before the fix and again after it, with the same lines; points 5 to 9 ran
on the fixed code. The lines and numbers below are of the runs on the
fixed code, which is the code of this build.

What it showed, in the plan's order:

1. **Ground.** Five up on empty databases. No boot printed `Chain write
   check failed`. Genesis wrote links 1 and 2 behind the two new opening
   statements. Validator 1, the registry's first leader, logged `network
   tail: position 2, 2 of 2 agree, leader 1` and then `leading at
   position 2`: the catch-up pass before it counts itself. The other four
   `counted at position 2`. One account creation and six transfers, sent
   through all five validators, landed at positions 3 to 9 on all five
   with one record hash, and the lead went all the way round. Validator 3,
   stopped with SIGTERM while idle, had ended 0.1 seconds later and was
   `counted at position 8` 0.16 seconds after its start. Later, when the
   fix went onto the rig, all five were restarted one at a time, the lead
   moved on by one transfer before the leader's turn, and each was counted
   again before the next.
2. **A.** The proxy answered `503 not counted yet` to every POST for
   validator 5 and `counted: false` in its health. A transfer through
   validator 2: `validator 5 refused and fails the health check: does not
   count itself`, the report to the leader, `ignore vote e4b4c121 naming
   validator 5: 3 voters`, three times `voted yes (5: does not count
   itself)`, `validator 5 ignored`, and the transfer written by the other
   four at position 975. The wallet's call was answered after 1.1
   seconds. The vote's row on validator 1: action ignore, named `{5}`,
   outcome passed, the first voter's results `{"5": "does not count
   itself"}`. Validator 5 itself was up and counted itself all along, and
   was told nothing. With the proxy passing everything on again and
   nothing sent through validator 5: `self-check: ignored by the network`
   24 seconds after the vote, `self-check: ignored by the network, twice
   in a row; joining again` a minute later, one link replayed, the include
   vote, `counted at position 975`. It was out of the count for 85
   seconds.
3. **J.** The proxy held back the first official list to validator 5.
   The leader, validator 4, ten seconds later: `validator 5 did not write:
   no answer: The operation was aborted due to timeout`, `the call goes
   once more to validator 5`. Validator 5 logged `wrote: 1` at the second
   send, the leader `validator 5 wrote 1`, and the final declaration went
   round. Position 976 on all five. No vote ran: `ignore_votes` on
   validator 1 held six rows before and six after.
4. **C and D, the case of 2026-11-16.** The proxy held back both sends.
   The leader, validator 1: the reason, `the call goes once more to
   validator 5`, then `ignore vote 6aa7fa43 naming validator 5: 3 voters`,
   three times `voted yes (5: tail at position 977, own 978)`, the words
   of the live network's vote, and `the round starts again`. Validator 5
   then stood at position 977 with the others at 978, and its `pending`
   held the transfer `65d4968a…`, approved and not on its own chain. With
   nothing sent through it: `self-check: ignored by the network` 27
   seconds after the vote, `…twice in a row; joining again` a minute
   later, `replayed 1 links from validator 1, now at position 978`, the
   include vote, `cleared held pending transaction 65d4968a…: the join
   takes the leader's rows`, `counted at position 978`, 88 seconds after
   it was voted out. Its `pending` was empty. A second transfer from the
   same account, through validator 2, was written by all five at position
   979. In the run before the fix the first of the two findings came
   before the vote had passed and read `behind the network (position 12,
   the network's 13)`; the second, `ignored by the network`, still made
   it join: two findings of different kinds count as two in a row.
5. **D, at a start.** Validator 3 was stopped. By hand, five transactions
   its own chain already held went back into its five waiting tables,
   approved, one in each, with one row in `escrow_arbitrations` and one in
   `guardian_votes`; and one made-up row that was really waiting went into
   `pending`, not on the chain. At the start: `join: counted`, five lines
   `dropped held <table> transaction …: already on the chain`, one for
   each of `pending`, `locked_transactions`, `assisted_transfers`,
   `escrow_transfers` and `fund_proposals`, then `counted at position
   972`. The five rows and the two child rows were gone, and the made-up
   row was still there. It was taken out by hand again.
6. **E.** A trigger on validator 4's `garlic_chain` made one batch fail:
   `batch write failed: the rig makes this batch fail`, `wrote: 0`, and on
   the leader `validator 4 wrote 0`, with no second send. The trigger was
   removed at once. Validator 4 then had 972 links and top position 972,
   and its counter gave 974 next: the failed batch had used up 973. With
   nothing sent: `self-check: behind the network (position 972, the
   network's 973)`, a minute later `…twice in a row; joining again`,
   `replayed 1 links from validator 1, now at position 973`, `join:
   counted`, `dropped held pending transaction c2c6ea56…: already on the
   chain`, `counted at position 973`. On all five then: 973 links, top
   position 973, the counter at 974 next.
7. **K.** The proxy held validator 5's answer to the official list for 6
   seconds. SIGTERM reached the leader, validator 2, 39 milliseconds
   after `official list: 1`: `SIGTERM received, shutting down...`, `a
   round, a vote or a join is under way; stopping when it ends`, and 6
   seconds later `wrote 1`, four times `validator N wrote 1`, four times
   `answered the final declaration 200`, `validator 3 is the leader`. The
   process had ended 6.1 seconds after the signal. All five chains stood
   at position 974 with one record hash while it was down. Started again,
   it was `counted at position 974`.
8. **B.** Validator 3 was started with the proxy holding validator 5's
   health answer for 5 seconds, so that its first look at the others
   lasted that long. In that time the database's superuser closed its
   database to new connections and ended the open ones. `join loop failed:
   database "anosrig3" is not currently accepting connections; trying
   again`. The connections were allowed again, and after the wait:
   `network tail: position 974, 4 of 4 agree, leader 3`, `leading at
   position 974`. It was the leader at that moment, so the same run shows
   an idle leader that is restarted: the catch-up pass, then the lead.
9. **Old and new together.** Validators 1 and 2 on `6b27427`, validators
   3, 4 and 5 on this code. Five transfers, one through each validator,
   landed at positions 1072 to 1076 on all five, and each of the five led
   one round. Validator 2, on `6b27427`, restarted: `counted at position
   1076`. Validator 4, on this code and the leader at that moment,
   restarted while idle: `network tail: position 1076, 4 of 4 agree,
   leader 4`, `leading at position 1076`. Then the vote of point 2, with
   validator 3 (this code) leading and the transfer sent in through
   validator 4 (this code): `validator 5 refused and fails the health
   check: does not count itself`, the report, `ignore vote 8babaf20 naming
   validator 5: 3 voters`, `validator 1 voted no (5: ok)`, `validator 2
   voted no (5: ok)`, `validator 4 voted yes (5: does not count itself)`,
   `ignore vote 8babaf20 failed: validator 1 voted no (5: ok)`. Nobody was
   ignored. With the proxy passing everything on again, the originator
   waited out its `NO_ANSWER_WAIT_SECONDS`, sent the approval to validator
   5 once more, and the transfer was answered after 60.2 seconds and
   written by all five at position 1081. All five were in step after it.

Tried besides the nine points, all on the fixed code unless it says
otherwise:

- **The self-check's leader read**, the fault of 31.4: with a round under
  way at two checks in a row, before the fix and after it. And a control
  after the fix: a whole round, write and hand-over, begun and ended
  inside each of two checks in a row (the proxy holding validator 5's
  health answer for 6 seconds, a transfer sent in 2 seconds after each
  check began). No line: the own position was above the one the others
  had answered, and that is no finding.
- **A plain run of transfers**, nothing slowed or held: one after the
  other for 150 seconds, through each validator in turn. Before the fix,
  945 transfers, positions 17 to 961 on all five with no hole, the lead
  round and round, and not one self-check line. After the fix, as the
  last run of the rig, 935 transfers, positions 1910 to 2844, 2844 links
  and top position 2844 on all five, the counter at 2845 next, and again
  no self-check, join or vote line, with two self-checks of each
  validator inside the run.
- **The missed hand-over.** The proxy held back the final declaration
  that named validator 5 the next leader: `validator 5 gave no answer to
  the final declaration: The operation was aborted due to timeout`. The
  other four named validator 5 the leader, and validator 5 still named
  validator 4. A second transfer was approved by all five and stayed in
  `pending` on all five: nobody led a round. On `6b27427` nothing would
  have moved it, by the code; that was not tried. With nothing more sent,
  validator 5: `self-check: names leader 4, the network names 5`, a
  minute later `…twice in a row; joining again`, `validator 5 is the
  leader`, `leading at position 971`, `official list: 1`, and the
  transfer was written by all five at position 972, 98 seconds after it
  had been approved. So the fix of 31.4 still finds a validator whose own
  leader stands still, and a validator that finds itself the leader leads
  at once.
- **A restart while transfers come in.** Transfers one after the other
  through validators 1, 2 and 4, and SIGTERM to validator 3 in the middle
  of it. The write that was under way reached it: `wrote: 1` 3
  milliseconds after `SIGTERM received`. It took 3.2 seconds to end: the
  other validators' open connections to it stay up for about three
  seconds after their last use, and the stop waits for them, as it did
  before this build. A restart while idle took 0.1 seconds. The next
  transfer's approval got no answer from it, and the vote that followed
  failed: two voters found the connection refused, the third still
  reached it on its open connection and answered `voted no (3: ok)`. The
  validator was counted again 3.4 seconds after the signal, by a plain
  `join: counted`. The transfer waited out the originator's
  `NO_ANSWER_WAIT_SECONDS` and was answered after 60.2 seconds, approved
  by all five and written. That is the cost of a restart the rollout
  names (31.2), seen: one transfer that waits a minute, nothing lost. 92
  transfers in that run, one slow, all five chains equal at the end.
- **The first night of the rollout.** Validator 5 alone on this code,
  validators 1 to 4 on `6b27427`: 820 transfers in 130 seconds, through
  each validator in turn, written by all five (positions 1082 to 1901).
  Validator 5's self-check ran three times in that time and logged
  nothing. Restarted while idle, it was `counted at position 1901` 0.17
  seconds after its start.
- **What B changes, seen on `6b27427`.** Point 8's cut on a validator
  that ran `6b27427`: `join loop stopped: database "anosrig3" is not
  currently accepting connections`. Forty seconds later, the database
  long open again, it still answered `counted: false`, as validator 24
  did on the launch evening, until it was restarted.
- **What E prevents, seen on `6b27427`.** The trigger of point 6 on a
  validator that ran `6b27427`: `wrote: 0`, 1903 links, the counter at
  1905 next. Restarted on `6b27427`, as a banker would restart a
  validator that is behind: `chain replay: position 1904: the identity
  column gave position 1905`, then 1906, 1907, 1908, and after every wait
  four more. It answered `counted: false` and could never catch up, and
  every try moved its counter further on. The same validator, started on
  this code: `replayed 1 links from validator 1, now at position 1904`,
  `join: counted`, `dropped held pending transaction 37ec1f5f…: already
  on the chain`, `counted at position 1904`, and on all five 1904 links,
  top position 1904, the counter at 1905 next. So the first start of this
  code also heals a validator that `6b27427` had left in that state.
- **The start check without the permission.** A sixth throwaway database
  whose tables belonged to another role, the validator's database user
  allowed to read and write the rows and not to set the counter:
  `Connected to PostgreSQL …`, `Chain write check failed: permission
  denied for sequence garlic_chain_position_seq`, and the process ended
  with code 1, before genesis.
- **The leader check of the pull line** (31.2), against the rig's health
  pages in place of a stand-in. On the leader: the message `This
  validator is the leader right now. Nothing was restarted. …` and the
  line stops with code 1. On another validator, and on a port where
  nothing answers: nothing printed, and the line would go on.

What the rig could not show:

- The doorman: how it wraps the health answer, its `502`, `503` and
  `504`, its rate limit and its certificates. And the real network:
  twenty-five validators and the distances between them.
- How wide the two windows of 31.4's fault are on the real network. The
  proxy made them seconds wide; on one computer they are milliseconds.
- The self-check's traffic (31.2).
- The stop's limit of 30 seconds: the round of point 7 lasted 6. A stop
  during a vote or a join this validator leads: only a round was stopped.
- The clear at a join with rows of the other four waiting tables, and a
  pull that brings rows: every row cleared on the rig was a `pending`
  row, and the leader held no waiting row at any of those joins. Point 5
  put rows into all five tables and both child tables for the other
  delete.
- A validator that is ahead of the others while something else differs:
  the control case above is the only run in which the "ahead" rule
  decided.
- The whole pull line: a Mac has no systemd. `systemctl restart` sends
  the SIGTERM the rig sent; the unit's own time limits were not there.

The end of the rig: the five validators, the proxy and the stand-in
stopped, the five databases and the role `anosrig` dropped, the sixth
database dropped right after its one start. No other role or database of
the Mac was touched. The rig's folder, with its tools, keys and logs,
stayed in the build chat's scratchpad and is not kept.

## 32. The look before a round (2026-11-19)

Decided 2026-11-19 in a planning chat of its own, over two rounds of
questions, the plan FINAL at
`~/Desktop/Z-TestNet/forclaude/validator-resilience-plan-2.md`, built the
same day in a chat of its own. It is fix F of the resilience work, the
last piece, which section 31 left to a plan of its own. Why: a validator
that misses a write is one batch shorter than the others, and it can
still be counted. Two ways lead there. Its own batch failed and it
answered the official list with `200` and no ids: the leader logs
`validator N wrote 0` and goes on. Or the leader died while it handed out
the list, and only some validators got it. Such a validator keeps the
missed transactions as approved rows. Its next ready list still names
them, the next official list is the overlap of every ready list and
leaves them out, and so it writes the next batch onto its shorter chain.
From that moment it is on a chain of its own: its catch-up fails on
`recordHash does not chain on the previous link`, and only a wipe by hand
mends it. When a list reached only some validators, the same thing splits
the whole network in two. The self-check of section 31 finds a validator
that is behind and brings it back, after one to two minutes. Nothing
looked before the next write. This build closes that window: a leader
looks at every counted validator's chain end before it sends anything,
and nothing is written while they differ. The one ignore vote the live
network has had, on 2026-11-16, was validators 18 and 24 one link behind.
That case, one or a few validators behind, is what this build heals
without a person.

This plan is about honest validators, as section 31 is. One build step in
this repo, then a rig (32.5). Nothing touches the doorman, the wallet,
the masterpod, the keyholder, the database schema, the registry, the
genesis files or a settings file. There is no new message between
validators, no new field in a message, no new route, no new variable and
no package. The fix changes only what the validator that runs it does, so
a validator on this code and a validator on older code work together, and
the code goes onto the validators one at a time.

### 32.1 The decisions, as they apply to the code

- **The rule.** A leader writes only when every counted validator's chain
  end, the position and the record hash of its last link, is the same as
  its own. If not, nothing is written in that pass.
  `src/validators/validators.service.js` `leadRound` has a new step 0,
  right after `if (own.length === 0) return;` and before the ready
  announcement: `lookAtChainEnds()`. A finding other than `level` logs
  `chain ends differ: <the groups>` and goes to the new
  `settleChainEnds(look)`, which answers `RESTART` (the loop goes round:
  the leader check, the ready list and the look run again) or null (the
  round ends). A validator that is not the leader, or has nothing to
  write, returns before the look, as before: a leader with nothing to
  write does not look.
- **The look reads the health pages.** `src/validators/chain-ends.js`,
  new. `lookAtChainEnds()`: the counted peers (`findCountedPeers`), this
  validator's own chain end (`ownTail`), then `getHealth` on every peer
  at once. An answer whose `chain` is an object with an integer
  `position` and a string `recordHash` gives that peer's chain end. Every
  other answer puts the peer's id on the `unread` list: no answer within
  the call timeout, a body that is not an object, no `chain`, or a
  `chain` of another shape. It resolves with the judgement below and
  `own` added to it. Nothing new is sent between validators: `chain` has
  been in every validator's health since the catch-up build (section 19),
  so every validator on the network answers it, whatever code it runs.
- **Most win: the judgement.** `judgeChainEnds({ ownId, own, ends,
  unread })`, same file. It reads no table and makes no call. No chain
  end that was read differs from the own: `level`. Otherwise the chain
  ends are grouped by position and record hash, this validator's own
  among them, the largest group first and the higher position first on a
  tie. The counted validators are the ones read, the ones not read and
  this one. The largest group is the network's chain end when it holds
  more than half of them (`largest.ids.length * 2 > counted`). The five
  findings:

  | Finding        | When | It carries |
  | -------------- | ---- | ---------- |
  | `level`        | no chain end that was read differs from the own | nothing more |
  | `noMajority`   | no chain end is held by more than half of the counted validators | `line` |
  | `othersDiffer` | the own chain end is the network's, and others are not at it | `line`; `ids`, the validators that differ, ascending |
  | `leaderBehind` | the own chain end is not the network's, and the network's position is above the own | `line`; `network`, the network's chain end |
  | `leaderApart`  | the own chain end is not the network's, and the network's position is the own or below it: this validator is ahead, or on a chain that does not fit | `line`; `network` |

- **The line.** `describeChainEnds`, same file, private: the groups in
  words, for the log. A group of more than half is given as a count,
  every other group by its ids; then the own position; then, when some
  were not read, their ids. A record hash is cut to its first eight
  characters. As a leader logs them:

  ```text
  chain ends differ: 23 validators at position 971 (ab12cd34); validators 18, 24 at position 970 (ef567890); own position 971 (ab12cd34)
  chain ends differ: 24 validators at position 971 (ab12cd34); validator 7 at position 970 (ef567890); own position 970 (ef567890)
  chain ends differ: validators 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 at position 971 (ab12cd34); validators 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24 at position 970 (ef567890); own position 970 (ef567890)
  chain ends differ: 21 validators at position 971 (ab12cd34); validators 22, 23 at position 970 (ef567890); own position 971 (ab12cd34); no chain end read from validators 24, 25
  ```

- **What the leader then does.** `settleChainEnds(look)`, in
  `validators.service.js` right below `leadRound`. Nothing is written in
  any of the four cases.
  - `othersDiffer`, validators that are not at the network's chain end
    while the leader is. One ignore vote naming them, `runVote(look.ids,
    IGNORE)`, inside the round's busy section, as `settleRoundAnswers`
    runs its vote. The vote that exists is used as it is. Its starter
    drops a validator that passes the starter's own health check by then
    (`validator N answers; no vote`). Each voter compares the named
    validator's chain end with its own (section 19.3), so the vote passes
    with voters on older code too. Passed: `the round starts again`. Not
    passed: one more look, since a validator that caught up meanwhile is
    level by now. Level: `the round starts again`. Otherwise `nothing is
    written: the chain ends still differ`, and the round ends. A
    validator that was voted out because it is behind comes back by its
    own self-check (section 31). One that is ahead, or on a chain that
    does not fit, stops and waits for a person, as before. It does not
    rebuild itself.
  - `leaderBehind`. `behind the network (position P, the network's Q);
    joining again`, then `setCounted(false)` and `startJoinLoop()`
    (`src/validators/join.service.js`), which is what the self-check does
    after two findings, and the round ends. The join loop of section 31
    catches the validator up and, while the others still name it leader,
    has it lead at once (`leading at position Q`). No vote.
  - `leaderApart`, a leader that is ahead of the network or on a chain
    that does not fit. It cannot name most of the network in a vote. It
    hands the lead on with the message an empty round already sends:
    `findNextCounted`, `setLeader(nextLeader)`, `sendFinalDeclaration({
    transactionIds: [], nextLeader })`, one line for each answer as step
    4 of the round logs them, then `own chain end is not the network's:
    nothing is written, validator N is the leader`, and the round ends.
    The next leader's look finds this validator differing, and that
    leader's vote takes it out. Step 4 of `leadRound` is left as it is:
    the hand-on has its own copy of those lines.
  - `noMajority`. `nothing is written: no chain end is held by more than
    half of the counted validators`, and the round ends. After a list
    that reached half of the validators, the ones that are behind find it
    by their self-check and catch up. On two real chains a person
    decides.
- **Chain ends only.** A health page also carries `leader` and `counted`,
  and the health check of a vote compares them (`checkReachable`,
  sections 19.3 and 31.1). The look does not. A new leader starts its
  round the instant it gets the final declaration, and another validator
  may get its copy a moment later and still name the old leader. That is
  the fault of 31.4, two answers from two moments, in another place. A
  chain end has no such moment: every validator that answered the
  official list had committed its batch before it answered, and the final
  declaration goes out after those answers. Inside the leader's own round
  nothing else writes.
- **A health page that cannot be read is not held against a validator.**
  It is not compared, and it counts for nobody when "more than half" is
  worked out. With nothing else differing the look finds `level` and logs
  nothing. With something else differing the line ends in `no chain end
  read from validator N`. The round's own steps meet that validator next,
  as before: no answer to the ready announcement starts the vote. So a
  validator that is behind and whose health page cannot be read in that
  moment is missed for that round. Named here, not closed.
- **Where the look sits, and when it runs again.** After "am I the
  leader, and does something wait" and before the ready announcement. It
  runs again whenever the round starts again: after a passed vote of
  `settleRoundAnswers` as well as after `settleChainEnds`. After a vote
  of `settleChainEnds` that did not pass there is one more look inside
  it. That look tells the case where the round goes on, a validator that
  caught up in between, from the case where the chain ends still differ
  and the round ends.
- **One line of the join changes.** `join.service.js` `joinThrough`,
  `case BEHIND`: after a catch-up pass that brought nothing new (the own
  position is what it was when the request went out), the joiner waits
  `VALIDATOR_CALL_TIMEOUT_SECONDS` before it asks again. A joiner that
  the leader answers `behind` while it is already level with most used to
  ask again at once, with a read of every health page each time round,
  for as long as the leader itself was out of step. That had been so
  since the catch-up build. The `noMajority` case leans on this path for
  up to two minutes, with up to twelve validators in it. Nothing else in
  the file's code changes.
- **The cost.** One health read of every counted peer more in every round
  that a validator on this code leads: 24 on the network, each through a
  doorman, 736 bytes an answer (measured 2026-11-19 for section 31). The
  round is longer by the slowest of them, at most the call timeout of 10
  seconds. Not measured on the network.
- **No new setting, message, field, route, table or package.**
- **What stays.** Every message, route, table and setting, and the
  registry. "Every counted validator answers, or the network stops": no
  quorum. The ignore vote and its health check, the include vote, the
  join through the leader. The self-check: it still does nothing for a
  validator that is ahead. A validator whose chain is ahead of the
  others', or does not fit theirs, is now voted out before anything is
  written; it then stops and waits for a person, as before. A round that
  ended without writing is led again at the next transaction, as every
  round that ends early is: nothing makes a leader look while nothing
  waits. A proof of acceptance or a final declaration that gets no answer
  is logged only.
- **Known and accepted: a list that reached fewer than half** (the plan's
  decision 10). The few that got it are right, but they differ from most.
  They are voted out and wait for a person. It needs a leader that dies
  in the very moment it hands out a list.
- **Out of this build.** The follow-ups are the plan's section 5, written
  there and on no other list: sparing the few that are ahead the wipe; a
  round that ended without writing, led again as soon as the validators
  are level; a validator that is behind and whose health page cannot be
  read; a validator that is ahead and is restarted before the others have
  written; the minute an originator waits for a validator that was only
  restarting (31.4); what the look and the self-check send, measured on
  the network.

### 32.2 The rollout

- **One validator at a time, no shutdown**, as in 31.2. The order is the
  user's: validator 1 first, watched, then the others one at a time, each
  counted again before the next one starts. Nothing but the validator's
  program restarts: no `npm ci`, no database step, no doorman pull, no
  setting. A start prints the same lines as before this build.
- **The line for a worker**, as `banker@worker`, is the one of
  `~/Desktop/Z-TestNet/upcoming_validator_pulls/Nov_19/pull_steps.md`,
  step 3, which is the line of 31.2 with its leader check:

  ```text
  sudo -iu anos git -C /opt/anos/anossoftware pull --ff-only && node -e "fetch('http://127.0.0.1:3000/health').then((r) => r.json()).then((h) => { if (h.leader === h.validator.id) { console.log('This validator is the leader right now. Nothing was restarted. Wait for the next transaction, then paste the line again.'); process.exit(1); } }, () => {})" && sudo systemctl restart anos-validator && sleep 3 && sudo journalctl -u anos-validator -n 8 --no-pager -o cat
  ```

  The pull papers of this build go into a new folder of
  `~/Desktop/Z-TestNet/upcoming_validator_pulls`, on the user's word.
- **While validators on older code are about.** The look runs in every
  round that a validator on this code leads, and it looks at validators
  on any code: the health page, the ignore vote and the final declaration
  are in the code all 25 run today. A leader on older code does not look.
  It leads as today. A validator that is voted out comes back by itself
  only when it runs the self-check of section 31. One still on `6b27427`
  comes back at its pull, or when a wallet's transaction goes through it,
  as today.
- **What to look for on validator 1**, in its journal: `chain ends
  differ|nothing is written|joining again|own chain end is not`. None of
  these lines is expected on a network that is in step. What the look
  sends is seen on its doorman: `sudo nft list quota inet doorman
  egress-month`.
- **The way back** is the one of the Nov_19 papers: `git reset --hard` to
  the commit before this build and a restart. This build leaves nothing
  in the database.

### 32.3 Files

New: `src/validators/chain-ends.js` (`lookAtChainEnds`, `judgeChainEnds`,
the five findings, the private `describeChainEnds`).
Changed: `src/validators/validators.service.js` (two imports, step 0 in
`leadRound` and in its comment, the new `settleChainEnds`) and
`src/validators/join.service.js` (`case BEHIND` of `joinThrough`, and
three comments: the last sentences of the opening comment, `setCounted`,
`joinThrough`). In the docs: the README ("The leader round", one
paragraph; "Ignoring and joining", the paragraphs "Joining" and "The
self-check"; one line of "Project layout") and this section.
Not changed: `src/votes/` (the vote and its health check are used as they
are), `src/validators/self-check.js`,
`src/validators/validators.messages.js`,
`src/validators/validators.client.js`, `src/garlic-chain/`,
`src/server.js`, every file under `deploy/`, `network/`, `db/` and
`scripts/`, and no package file. The doorman is not touched.

### 32.4 Notes from the build

- **The build was made on main at `0108bc5`**, the build of section 31,
  with a clean working tree (`git status --short` and `git log` at about
  22:40 UTC on 2026-11-19, before the first edit). GitHub's `main` stood
  at `6b27427` then: the commit of section 31 was not pushed yet. The five
  code blocks of the plan's sections 1.1 to 1.3 are in the code as the
  plan has them, compared line for line by a throwaway script.
- **Where the plan gives words and no code.** The opening comment of
  `chain-ends.js` stands after the five import lines and above the
  constants, as the opening comments of `self-check.js` and
  `join.service.js` stand in their files. It says, in the plan's words:
  why the look exists, most win and the five findings, chain ends only, a
  health page that cannot be read, and that `settleChainEnds` is what the
  leader then does. Step 0 in the comment of `leadRound` says what the
  look is, that a difference is settled by `settleChainEnds` before step
  1, and that the look runs again whenever the round starts again. The
  three comments of `join.service.js` each got one or two sentences: a
  leader whose look finds it behind the network clears the flag too (the
  opening comment and `setCounted`), and the wait after `behind`
  (`joinThrough`).
- **Where the new lines stand.** The two import lines of
  `validators.service.js` stand after the import of `votes.service.js`
  and before the one of `validators.messages.js`, in the order of the
  paths, as the file's other imports are. `settleChainEnds` stands
  between `leadRound` and `settleRoundAnswers`.
- **The import ring.** `chain-ends.js` is imported by
  `validators.service.js` only. `validators.service.js` now imports
  `join.service.js` itself; before, it reached it through
  `validators.messages.js`, and `join.service.js` already imported
  `validators.service.js`. Neither file uses a newly imported name while
  it loads, only inside functions, and the five findings are plain
  strings.
- **Comments and doc lines the plan does not name** are left as they
  were, where this build makes them say less than the code does, and
  listed for the user (2026-11-19). In
  `src/validators/validators.service.js`: the comment of the constant
  `RESTART` (it names `settleRoundAnswers` alone; `settleChainEnds`
  answers it too), and in the comment of `leadRound` the sentence "A
  passed vote starts the round again from step 1" (the round now starts
  again with the look, step 0). In `src/votes/votes.service.js`: the
  opening comment (the leader starts an ignore vote for a validator that
  gave no answer or refused; now also for one whose chain end is not the
  network's). In `src/validators/validators.queries.js`: the comment of
  `findCountedPeers` ("who to send a message to"; the look reads their
  health as well). In the README: "The leader round", the paragraph "A
  round runs in a busy section" (the same "from step 1"); and in
  "Ignoring and joining" the opening paragraph and the paragraph "The
  votes" (when a validator is voted out) and the paragraph "Counted"
  (when a validator stops counting itself).
- **Checks.** `node --check` passed on the three source files, with Node
  24.22.0. The imported names were read against their modules' exports:
  `env` in `src/config/env.js`; `ownTail` in
  `src/garlic-chain/replay.service.js`; `isObject` in
  `src/util/is-object.js`; `getHealth` in
  `src/validators/validators.client.js`; `findCountedPeers` in
  `src/validators/validators.queries.js`; `LEADER_APART`,
  `LEADER_BEHIND`, `LEVEL`, `OTHERS_DIFFER` and `lookAtChainEnds` in
  `src/validators/chain-ends.js`; `setCounted` and `startJoinLoop` in
  `src/validators/join.service.js`. The link check of 31.4: Node linked
  the whole module graph from `src/server.js` with an empty environment
  and stopped at the first settings read (`Error: Missing required
  environment variable: PGDATABASE`), after every import of every module
  had been matched to an export. No key file was read, no database
  connection made, no server started. The same load behind one wrong name
  asked of `chain-ends.js` stopped with `does not provide an export
  named`, so the check does see a wrong name. Two checks more than the
  plan lists, both with throwaway scripts outside the repo. The plan's
  five code blocks were compared with the three files, line for line:
  equal, and between the imports and the constants of `chain-ends.js`
  stands one comment and nothing else. And the two judging functions, in
  a copy of the built file without its import lines, were given the four
  layouts whose lines the plan prints (32.1, "The line"): the four lines
  came out letter for letter, with the findings `othersDiffer`,
  `leaderBehind`, `noMajority` and `othersDiffer`. No statement was run
  against a database and no validator was started in that step: the rig
  was the first run. After the rig: `node --check` on the three files
  again, the link check again with the same answer, the plan's five code
  blocks compared with the three files again, and the rig's copy of the
  code compared with the working tree: equal in `src/`, `network/`,
  `db/`, `deploy/` and `scripts/`, but for the rig's own registry and
  genesis pair. `git status` showed the five files of 32.3 and no other,
  on `main` at `0108bc5`.
- **The rig found no fault in the code of this build**, and no line of
  the three source files changed after the first step. Every new branch
  ran at least once (32.5): the five findings, the four things a leader
  does, both ends of a vote that did not pass, a health page that cannot
  be read, and the wait after `behind`. The rig also showed four things
  that are not faults of this code. They are left as they are, they
  follow here, each with what it costs, and none of them is in the plan.
- **Seen on the rig and left as it is: a healthy validator voted out at
  a hand-over.** Older than this build: the first step of a round, the
  vote of section 29 and the hand-over are the same code in `6b27427`,
  which the live network runs, and in `0108bc5`. A leader ends its round
  with the final declaration, sent to every validator at once. The next
  leader starts its own round the instant it has taken its copy in, when
  something waits. A validator that is still taking its own copy in (the
  `UPDATE` that moves the lead is a commit to disk) answers the new
  leader's ready announcement `400 validator N is not the leader`. The
  new leader then does what section 29 says for a refusal: its own
  health check of that validator and the vote, and that health check
  compares `leader`. If the validator still names the old leader in
  those milliseconds, every voter says yes (`names leader X, own Y`), and
  a validator that missed nothing is out. If it names the new leader by
  then: `validator N answers; no vote`, the refusal ends the round with
  nothing written, and what waited is written at the next transaction.
  It is the fault of 31.4, two answers from two moments, in the health
  check of a vote. The look of this build logs nothing in that moment,
  because it compares chain ends only (the plan's decision 13 was right
  to leave `leader` out), and it makes the case rarer: it puts a read of
  every health page between the hand-over and the ready announcement.
  The rig's numbers (32.5): with three accounts sending side by side as
  fast as they could for 150 seconds, on `0108bc5` 37 refusals in 9,024
  rounds, one validator voted out; on this build 3 refusals in 6,652
  rounds and nobody voted out, and in an earlier run 2 in 6,511, both
  voted out. With one account, each transfer sent the instant the one
  before was written: 2 refusals in 4,718 rounds, both voted out, and
  none in 3,197. The validators that were voted out and then watched
  were found by their self-check and came back, 68 to 101 seconds
  later. A rig makes this far likelier than a network does: five
  validators share one computer and one disk, a call between them takes
  no time, and a commit that waits 20 to 40 milliseconds is then slower
  than the new leader's whole start. A
  timing line in the rig's proxy showed the wait inside the validator
  each time, not in the proxy, and often in several validators at the
  same moment. On the network the new leader's first message needs the
  way to the other validator, and with this build the slowest health
  answer before that. It can still happen there when a validator's disk
  stalls at a hand-over while a transaction waits. What it looks like in
  a journal: `failed: validator N is not the leader` on the validator
  that refused; on the leader `validator M sent no approved pending
  list: answered 400: {"error":"validator N is not the leader"}`. A fix
  would change the round's first step or the vote's health check.
- **Seen on the rig and left as it is: a transaction that is between
  its approvals and its proof when a vote passes is not written.** The
  validator a transaction comes in through collects an approval from
  every counted validator and then sends them the proof. If a vote
  changes who is counted in between, the others refuse the proof:
  `receipts[i]: validatorFrom N is not a counted validator` after an
  ignore vote, `no receipt from validator N` after an include vote.
  Nothing reacts to a refused proof (left so in 29.1, and on plan 1's
  list as a second try for the proof of acceptance). The transaction is
  never written, although the wallet was answered `202`. The validator
  it came in through has marked its own row approved by then. The others
  drop their rows after `UNAPPROVED_AGE_LIMIT_SECONDS`, and nothing
  removes the approved one: from then on that validator refuses every
  transaction of that account, and one no is enough. By the code, not
  tried on the rig, it heals when the same signed transaction is sent in
  again through another validator while its date still allows it: the
  approved row is then answered as the same approval twice and written
  with the rest. Otherwise the row is deleted by hand, as the rig did.
  Seen three times on the rig: at an include vote in a fast run, and in
  both runs of point 4. In point 4 it is this build's vote that falls
  into the gap, and it does so every time. The transaction that makes
  the others find the dead leader waits about a second for the vote on
  that leader. The new leader holds the missed transaction, so it looks
  the moment that vote has passed, and votes out the validator that is
  ahead while the first transaction's proof has not gone out yet. So the
  plan's "the transfer written by
  three" did not happen in point 4: the three wrote the missed transfer,
  and the transfer that had found the dead leader was left as described.
  In point 5 that transfer was written, because its proof went round
  before any vote on a living validator. Without this build the same
  case ends with two chains, so this is the smaller harm. It is still a
  harm, and the plan does not name it.
- **Seen on the rig and left as it is: a joiner that waits after
  `behind` is voted out when the leader comes back.** The wait of this
  build (32.1, "One line of the join changes") keeps a joiner that is
  level with most from asking at full speed. While it waits it does not
  count itself. When the leader has caught up by its self-check it leads
  at once (section 31), and its ready announcement meets the joiner,
  which answers `503 not counted yet`. The vote of section 31 then takes
  it out (`does not count itself`), and it comes back through an include
  vote at one of its next tries: 17.8 seconds on the rig (32.5, point 6,
  third run). Before this build the joiner asked again within
  milliseconds and would most likely have been answered `counted` first.
  It needs the no-majority case with the leader among the validators
  that are behind, and a transaction that waits, which that case has.
- **Seen in passing, older: the second of two validators that are voted
  back in one after the other.** A joiner takes the leader's list of
  ignored validators once, before its join requests begin. One that is
  then answered `busy`, because the leader holds for another joiner,
  still has that other joiner as ignored when its own include vote
  comes. The proof of its own vote carries a receipt from that
  validator, so it refuses the proof (`receipts[0]: validatorFrom N is
  not a counted validator`). The leader answers `included` all the same,
  and the joiner then counts itself with a table that says it is
  ignored, refuses what names the two, and names an old leader. Its
  self-check found it (`names leader 5, the network names 1`); it joined
  again and was right 109 seconds after it had counted itself. A
  transfer sent in that time was not written: the muddled validator
  refused its proof. Seen once, when the rig started two voted-out
  validators in the same second. It is in the join of section 19, not
  in this build.

### 32.5 The rig

The rig (the plan's section 2), 2026-11-19, 15:04 to 16:09 on this Mac's
clock, everything in the build chat's scratchpad and nothing in the repo.
Built as the rig of 31.5 was, with these differences:

- **Two copies of the code**, without `.git`, `node_modules` linked: the
  working tree, and `0108bc5` from `git archive`. They differed in the
  five files of 32.3 and nothing else.
- **Five databases**, `anosrig1` to `anosrig5`, under a role of the
  rig's own, `anosrig`, by `scripts/setup-db.sh`, on Homebrew PostgreSQL
  17.11. A key per validator in owner-only files, five machine files,
  the network's own settings as they are.
- **The proxy stood in front of all five validators.** Each registry row
  named the proxy's address for its validator (`http://127.0.0.1:3721`
  to `3725`); the validators listened on `3711` to `3715`. So every call
  between two validators passed through it. On a word from the rig it
  could, for one validator: hold back a call (not passed on, no answer),
  cut the connection at once, hold a call for some seconds before
  passing it on, and hold an answer for some seconds. Later it also
  logged, for a call that took 15 milliseconds or more, where the time
  went.
- **Three accounts that send**: the rig's OG account and two more,
  created through a validator with a stand-in for the masterpod (asked
  twice) and paid 1,000 anos each. They were needed: while chain ends
  differ, a transfer of the account whose transfer was missed cannot be
  approved (its previous id is not the same on every validator), so the
  transfer that had to start the next round came from another account.
  Every transfer paid the rig's fund account.
- **A batch that fails once**: a trigger on one validator's
  `garlic_chain` that fails the first insert and lets every later one
  through, taken off afterwards.
- **A leader killed in the middle of handing out a list**: the proxy
  held back the official list to the chosen validators, and the leader's
  process got SIGKILL while it waited for their answers, 44 to 68
  milliseconds after `official list: 1`.
- **The rig's own faults**, mended on the way. Its sender first sent an
  account's next transfer as soon as the one before was on the chain of
  the validator it sent to; another validator, a few milliseconds
  behind, refused it (`payload.previousTransactionId is not the
  account's latest transaction`). It then waited for every counted
  validator's chain. Its first trigger failed every insert, so it also
  failed the catch-up of point 3 (below). Once it started two voted-out
  validators in the same second (32.4, the last note).
- **By hand, between points**: waiting rows that a point had left behind
  were deleted on all five, and two validators that had been left on a
  chain of their own on purpose had their database dropped and set up
  again, the wipe by hand the live network would need.

What it showed, in the plan's order:

1. **Ground.** Five up on empty databases: validator 1 `leading at
   position 2`, the others `counted at position 2`. Two account
   creations and five transfers landed at positions 3 to 9 on all five.
   The long plain run, one account, each transfer sent as soon as the
   one before was written everywhere, through each validator in turn:
   in 150 seconds 4,718 transfers in as many rounds, positions 19,541 to
   24,258, and in a second run of 100 seconds 3,197 more, positions
   24,259 to 27,455. Neither run has a line `chain ends differ`. The
   second has no unusual line at all, and all five were equal at its
   end. Near the end of the first, two validators were voted out by the
   hand-over case of 32.4, with no line of the look. With three accounts
   side by side, so that round follows round with no pause: 150 seconds,
   9,912 transfers in 6,652 rounds, positions 27,456 to 37,367, no line
   of the look, three refusals of the hand-over case and no vote, all
   five equal at the end. In all, more than 21,000 rounds were led on
   this build with nothing held or slowed, and not one of them logged
   `chain ends differ`.
2. **One validator behind.** The batch failed on validator 5: `batch
   write failed: the rig makes this batch fail`, `wrote: 0`, and on the
   leader `validator 5 wrote 0`. Validator 5 stood at position 19,462
   with the transfer approved in `pending`, the others at 19,463. A
   transfer of another account through validator 3, a tenth of a second
   later. The leader, validator 2: `chain ends differ: 4 validators at
   position 19463 (3da15fad); validator 5 at position 19462 (320d4fca);
   own position 19463 (3da15fad)`, `ignore vote bb1c2229 naming
   validator 5: 3 voters`, three times `voted yes (5: tail at position
   19462, own 19463)`, `ignore vote bb1c2229 passed`, `the round starts
   again`, `official list: 1`, and the transfer written by the four at
   19,464, 44 milliseconds after the first line. Validator 5 wrote
   nothing. With nothing sent through it: `self-check: ignored by the
   network` 55 seconds after the vote, `…twice in a row; joining again`
   a minute later, `replayed 2 links from validator 1, now at position
   19464`, the include vote, two lines `cleared held pending transaction
   …: the join takes the leader's rows`, `counted at position 19464`,
   116 seconds after the vote. All five then held 19,464 links with top
   position 19,464, and a third transfer, through validator 5, was
   written by all five.
   **The same on `0108bc5`**, all five on that code. Validator 3 `wrote
   0`. At the next transfer its ready list held two ids (`approved
   pending list sent: 2`) and the others' one, the official list was
   that one transfer, and validator 3 wrote it at position 19,461, where
   the others hold the missed transfer: record hash `71911b04` against
   `320d4fca` one position higher. Its self-check: `behind the network
   (position 19461, the network's 19462)`, a minute later `…twice in a
   row; joining again`, and from then on every ten seconds `network
   tail: position 19462, 4 of 4 agree, leader 1` and four times `chain
   replay: position 19462: recordHash does not chain on the previous
   link`. It answered `counted: false` and could not catch up. That is
   what this build ends. Its database was wiped by hand; started on this
   build it replayed 19,460 links in 58 seconds and was `counted at
   position 19462`.
3. **The leader is behind.** The batch failed on validator 4, which led
   next: `wrote: 0`, then `validator 4 is the leader`. Four milliseconds
   later, with no transfer sent: `chain ends differ: 4 validators at
   position 19469 (1da7ecc5); validator 4 at position 19468 (2fc6129d);
   own position 19468 (2fc6129d)`, `behind the network (position 19468,
   the network's 19469); joining again`, `network tail: position 19469,
   4 of 4 agree, leader 4`, `replayed 1 links from validator 1, now at
   position 19469`, `dropped held pending transaction 7d100290…: already
   on the chain`, `leading at position 19469`, 19 milliseconds after it
   had got the lead. It looked at once because it still held the missed
   transfer as ready: a leader that missed a write needs no further
   transaction to find it. Two more transfers were written by all five.
   **The first try of this point** showed the longer way. The rig's
   trigger was still in place when the leader tried to catch up, so its
   replay failed (`chain replay: the rig makes this batch fail`, four
   times) and it waited its ten seconds, not counting itself. A transfer
   sent in that time: `validator 5 refused and fails the health check:
   tail at position 19465, own 19466`, the report to the next validator
   in the ring, `ignore vote db483751 naming validator 5: 3 voters`,
   passed, `validator 5 ignored; validator 1 is the leader`, and the
   transfer was answered after 1.05 seconds and written by the four.
   Validator 5 caught
   up at its next try, was voted in and `counted at position 19467`,
   11.1 seconds after it had stopped counting itself. So a leader that
   cannot catch up at once does not hold the network.
4. **A list that reached fewer than half, the next leader with most.**
   The list reached validator 4 (position 19,513) and was held back from
   validators 1, 3 and 5; the leader, validator 2, was killed. A
   transfer of another account through validator 5: `no answer report
   for validator 2 sent to validator 3`, `ignore vote 6a759b14 naming
   validator 2: 3 voters`, three yes (`2: no answer: …`), `validator 2
   ignored; validator 3 is the leader`. Validator 3 held the missed
   transfer and led at once: `chain ends differ: 3 validators at
   position 19512 (75d80064); validator 4 at position 19513 (8e2ffe65);
   own position 19512 (75d80064)`, `ignore vote 524b16e2 naming
   validator 4: 2 voters`, two times `voted yes (4: tail at position
   19513, own 19512)`, passed, `the round starts again`, `official list:
   1`, and the missed transfer written by validators 1, 3 and 5 at
   19,513 with the record hash validator 4 had, 37 milliseconds after
   the vote on the dead leader had passed. The transfer that had found
   the dead leader was not written: `validator 1 did not accept the
   proof: answered 400: {"error":"receipts[2]: validatorFrom 4 is not a
   counted validator"}` (32.4). Validator 4, level with the three and
   ignored: `self-check: ignored by the network` 51 seconds after its
   vote, `…twice in a row; joining again`, the include vote, `counted at
   position 19513`, 113 seconds after the vote. It came back by itself.
   A closing transfer was written by all four.
   **A second run, in which the three wrote another link first**: one
   more transfer was approved by all five while the leader still waited,
   its id below the missed one's. The list reached validator 5 (19,515).
   The new leader, validator 4: `chain ends differ: 3 validators at
   position 19514 (c01c7d99); validator 5 at position 19515 (4061d4c7);
   own position 19514 (c01c7d99)`, the vote, `official list: 2`: the
   three wrote the other transfer at 19,515 and the missed one at
   19,516. Validator 5: `self-check: ignored by the network`, `…twice in
   a row; joining again`, then every ten seconds three times `chain
   replay: position 19516: recordHash does not chain on the previous
   link`. Its health: `counted: false`, position 19,515, `4061d4c7`. It
   stands on another chain and waits for a person, as the plan's
   decision 10 says. The transfer that had found the dead leader was
   left again.
5. **The same, the next leader the one that is ahead.** The list reached
   validator 3 (19,517), which became the leader when validator 2 was
   voted out. It had nothing ready, so it did not look. A second later
   the transfer that had found the dead leader was approved by all four:
   `chain ends differ: 3 validators at position 19516 (7e583389);
   validator 3 at position 19517 (05133582); own position 19517
   (05133582)`, `own chain end is not the network's: nothing is written,
   validator 4 is the leader`. Validator 4, six milliseconds later:
   `chain ends differ: 3 validators at position 19516 (7e583389);
   validator 3 at position 19517 (05133582); own position 19516
   (7e583389)`, `ignore vote fe9a4dde naming validator 3: 2 voters`, two
   yes, passed, `the round starts again`, `official list: 2`: the missed
   transfer at 19,517, the link validator 3 had, and the new one at
   19,518, written by validators 1, 4 and 5. Validator 3 came back by
   its self-check, `counted at position 19518`, 104 seconds after its
   vote. A closing transfer was written by all four.
6. **No majority.** First run, the new leader among the two that wrote:
   the list reached validators 2 and 3 (19,520), validators 4 and 5
   stood at 19,519, validator 1 was killed and voted out. When the next
   transfer was approved, validator 2: `chain ends differ: validators 2,
   3 at position 19520 (b975ad9b); validators 4, 5 at position 19519
   (57ac3d5e); own position 19520 (b975ad9b)`, `nothing is written: no
   chain end is held by more than half of the counted validators`. With
   nothing sent, validators 4 and 5: `self-check: behind the network
   (position 19519, the network's 19520)`, a minute later `…twice in a
   row; joining again`, `replayed 1 links from validator 2, now at
   position 19520`, `join: counted`, `dropped held pending transaction
   bba19944…: already on the chain`, `counted at position 19520`. No
   vote. They were out of the count for 35 and 54 milliseconds, the
   later one 102 seconds after the kill. A closing transfer: `official
   list: 2`, the transfer that had waited and the closing one, written
   by all four.
   **Second run, the new leader among the two that did not write.**
   Validator 4 held the missed transfer and looked at once after the
   vote on the dead leader, and again a second later: both times the two
   lines above, with `validators 1, 5 at position 19523 (cb040515);
   validators 2, 4 at position 19522 (27d604dd)`. Its self-check a
   minute and a half later: `…twice in a row; joining again`, `replayed
   1 links`, `dropped held pending transaction …`, `leading at position
   19523`, and at once `chain ends differ: 3 validators at position
   19523 (cb040515); validator 2 at position 19522 (27d604dd); own
   position 19523 (cb040515)`, `ignore vote 89d2786b naming validator 2:
   2 voters`, passed, `the round starts again`, and the transfer that
   had waited was written by validators 1, 4 and 5. Validator 2, whose
   own second check was 23 seconds away, came back by it: `counted at
   position 19524`, 24.3 seconds after its vote. A closing transfer was
   written by all four.
   **Third run, timed so that the other validator's self-check came
   first.** Validator 4, behind and not the leader: `…twice in a row;
   joining again`, `replayed 1 links from validator 3, now at position
   19526`, then `join: behind` at 15:46:05.811, 15:46:15.821 and
   15:46:25.835, each after a catch-up pass that brought nothing new:
   every ten seconds, not at full speed. Validator 2, the leader, at
   15:46:29.097: `…twice in a row; joining again`, `leading at position
   19526`, and then `validator 4 sent no approved pending list: answered
   503: {"error":"not counted yet"}`, `ignore vote 1ea1b9a1 naming
   validator 4: 2 voters`, two times `voted yes (4: does not count
   itself)`, passed, `the round starts again`, and the transfer that had
   waited was written by validators 2, 3 and 5 (32.4). Validator 4:
   `join: validator 2 answered 400: not the leader` at its next try, and
   at the one after `replayed 1 links`, the include vote, `counted at
   position 19527`, 17.8 seconds after its vote. A closing transfer was
   written by all four. At the end of each of the three runs the four
   held everything that had waited, on one chain.
7. **Chain ends only.** A final declaration held: the proxy held one
   answer to an official list for three seconds, which kept leader 1's
   round open, and a second account's transfer was approved by all five
   in that time. Then validator 4's copy of the final declaration was
   held for four seconds. The new leader, validator 2, looked at once.
   Validator 4's health named leader 1 at that moment, at position
   19,472 like everyone: no line `chain ends differ`. The round's own
   first step then met validator 4: `validator 4 sent no approved
   pending list: answered 400: {"error":"validator 2 is not the
   leader"}`, `ignore vote 9f3a509a naming validator 4: 3 voters`, three
   times `voted yes (4: names leader 1, own 2)`, passed, `the round
   starts again`, and the transfer was written by the other four: the
   hand-over case of 32.4, made certain by the hold. Validator 4 took
   its copy in when the proxy passed it on and came back by its
   self-check 118 seconds after the vote.
   A health answer held: every answer of validator 1's health page was
   held for three seconds, for 40 seconds of transfers of three
   accounts. 30 transfers in 23 rounds; each look of the other four
   waited for that answer, so their rounds came three seconds apart; the
   proxy held 16 answers. No line `chain ends differ`, no vote, no
   self-check line, and all five equal at the end.
8. **A health page that cannot be read.** With the connection to
   validator 5's health page cut at once: three transfers, three rounds
   led by validators 1, 2 and 3, no line, written by all five. With
   validator 3's health page silent: the look waited out the call
   timeout, `official list: 1` came 10.0 seconds after the approval, and
   the transfer was written by all five 10.1 seconds after it was sent,
   with no line. With validator 3 behind and validator 4's health page
   cut: `chain ends differ: 3 validators at position 19511 (504539d9);
   validator 3 at position 19510 (7fe468c2); own position 19511
   (504539d9); no chain end read from validator 4`, `ignore vote
   6fd989aa naming validator 3: 3 voters`, validators 2, 4 and 5 voted
   yes (validator 4 votes although its health page cannot be read),
   passed, `the round starts again`, written by validators 1, 2, 4 and
   5. Validator 3 came back by its self-check 100 seconds after the
   vote.
9. **Old and new together.** Validators 1 and 2 on `0108bc5`, validators
   3, 4 and 5 on this build. Five transfers, one through each validator,
   each round led by another validator: written by all five, and no log
   has an unusual line, the two rounds led on `0108bc5` among them. Then
   point 2 with validator 2, on `0108bc5`, the one behind: `validator 2
   wrote 0`; at the next transfer the leader, validator 4, on this
   build: `chain ends differ: 4 validators at position 19538 (c5a7eef7);
   validator 2 at position 19537 (514bf52c); own position 19538
   (c5a7eef7)`, `ignore vote cf54f237 naming validator 2: 3 voters`,
   `validator 1 voted yes (2: tail at position 19537, own 19538)` from
   the voter on `0108bc5` and the same from validators 3 and 5, passed,
   `the round starts again`, written by validators 1, 3, 4 and 5.
   Validator 2 wrote nothing more. It came back by the self-check of
   `0108bc5`, `counted at position 19539`, 111 seconds after the vote,
   and a further transfer through it was written by all five.

Tried besides the nine points:

- **A vote of the look that does not pass, still differing.** Two
  validators were stopped and voted out, so three were counted, and
  validator 5 then missed a write. The leader: `chain ends differ: 2
  validators at position 40581 (1fd5508c); validator 5 at position 40580
  (bfdba5ef); own position 40581 (1fd5508c)`, `no ignore vote naming
  validator 5: below the floor (3 counted of 5 active)`, `nothing is
  written: the chain ends still differ`. Validator 5 came level by its
  self-check 104 seconds later (`join: counted`, no vote), and a closing
  transfer wrote what had waited on all three.
- **A vote of the look that does not pass, level by then.** Validator 4
  was behind. A transfer was sent 284 milliseconds before its second
  self-check, and the proxy held its health answer for a second and a
  half, so the look read "behind" and got that answer after validator 4
  had caught up (`…twice in a row; joining again`, `join: counted`,
  `counted at position 40584`; the leader answers a join request while
  it leads a round). The leader: `chain ends differ: 4 validators at
  position 40584 (f7f4131e); validator 4 at position 40583 (f2b8f263);
  own position 40584 (f7f4131e)`, `validator 4 answers; no vote`, `the
  round starts again`, `official list: 1`, written by all five. Nobody
  was voted out.
- **The hand-over case on `0108bc5`**, all five on that code, three
  accounts side by side for 150 seconds: 12,714 transfers in 9,024
  rounds, 37 times `failed: validator N is not the leader`, 29 times
  `validator N answers; no vote`, one ignore vote that failed and one
  that passed (`validator 1 voted yes (3: names leader 1, own 2)`); the
  validator it named was found by its self-check 101 seconds later. The
  numbers on this build are in 32.4.
- **Where a late answer loses its time.** For the calls that took 15
  milliseconds or more the proxy logged three spans. The call was read
  in 0.0 to 0.2 milliseconds, the connection to the validator stood 0.1
  to 0.6 milliseconds later, and the rest, 16 to 58 milliseconds in a
  quiet run, passed inside the validator. Several validators were often
  slow in the same moment, which points to the disk they share.
- **What the look costs on the rig.** In the two runs of three accounts
  a round took 16.6 milliseconds on `0108bc5` and 22.5 on this build: 60
  rounds a second against 44. The six milliseconds are four health reads
  on one computer.
- **A restart while transfers come in**, two accounts as fast as they
  could. Validator 3 got SIGTERM: `validator 3 sent no approved pending
  list: no answer: fetch failed: other side closed`, the vote, out; no
  line of the look. Started again it caught up and asked to join. Its
  include vote failed once (`join: refused: validator 1 voted no (3:
  names leader 4, own 2)`: the lead had moved on between the vote's
  start and that voter's check), then `join: busy`, then `not the
  leader`, and it was counted again 38 seconds after the vote, when the
  run ended. At 70 transfers a second the lead and the chain's end move
  faster than a join. A network's rounds are seconds apart.

What the rig could not show:

- The doorman and the real network: twenty-five validators, the
  distances between them, a health page read through a doorman. So it
  says nothing about how often the hand-over case of 32.4 happens there,
  and nothing about what the look costs there in seconds or in traffic.
- A list that reached twelve of twenty-four, and the eleven joiners that
  then wait at the same time: the rig had two and two.
- A write that is still under way on one validator when a new leader
  looks. The plan's decision 13 holds for a hand-over by final
  declaration. After a hand-over by vote, with the old leader named, one
  validator's write of that leader's list could still be under way and
  the look would read its old chain end. The rig held a list back; it
  did not slow a write.
- Point 5's other end, the three writing another link first. Point 4's
  second run shows what such a validator then does.
- A vote of the look that fails because a voter answers no. The two
  ends of a vote that did not pass were shown with a vote that could not
  start.
- The whole pull line and the stop: unchanged since 31.5, not run again.

The end of the rig: the five validators and the proxy stopped, the five
databases and the role `anosrig` dropped. The Mac's other roles and
databases were listed before the rig and after it, and the two lists are
the same. At its end the rig's chain had 40,585 links on all five. The
rig's folder, with its tools, keys and logs, stayed in the build chat's
scratchpad and is not kept.

## 33. The proof after a vote (2026-11-19)

Decided 2026-11-19 in a planning chat of its own, in one round of four
questions, the plan FINAL the same day at
`~/Desktop/Z-TestNet/forclaude/validator-proof-plan-1.md`. Its first step,
the code and its papers, was built the same day in a chat of its own, and
this section is the record of it. It is about one weakness, which the rig
of section 32 showed three times (32.4, "a transaction that is between
its approvals and its proof when a vote passes is not written").

The weakness, told with one transfer. Alice sends 5 anos to Bob, and her
wallet hands the transfer to validator 7. Validator 7 asks each of the
other 24 validators whether the transfer is good. Each one checks it,
keeps a copy and sends back a signed yes. When validator 7 has all 24, it
sends the whole bundle of signed yeses to everyone. Each validator checks
the bundle: it must hold one yes from every validator that is in the
network at that moment, no more and no fewer. If it does, that validator
marks the transfer as ready, and a transfer that is ready on every
validator gets written. Collecting the yeses and sending the bundle are
two moments. A validator that is voted out between them leaves a yes in
the bundle from someone who is no longer in the network. A validator that
is voted back in between them is missing from the bundle. Either way
every validator turned the bundle down, and validator 7 did nothing about
that. It had already marked the transfer as ready on its own side, and it
told the wallet "accepted". The transfer was never written. The other 24
threw their copy away after five minutes. Validator 7 kept its copy,
marked as ready, for good. An account may have only one transfer waiting
at a time, so from then on validator 7 said no to every new transfer from
Alice's account. Every validator has to say yes to a transfer, so that
one no blocked her account everywhere, until the row was deleted by hand
on validator 7.

The fix is three small changes, all inside the validator that took the
transfer, and one thing that is left alone. Validator 7 checks again
before it sends the bundle. It tries a second time. It unblocks the
account if that fails too. And the wallet keeps saying "accepted".

These words and the code's: a signed yes is a transaction approved
receipt; the bundle is the proof of acceptance; "in the network" is
counted, an active row that is not ignored; "marked as ready" is
`approved = true` on the row in its holding table; "thrown away after
five minutes" is the sweep of section 21; validator 7 is the originating
validator.

This plan is about honest validators, as sections 31 and 32 are. Nothing
touches the doorman, the wallet, the masterpod, the keyholder, the
database schema, the registry, the genesis files or a settings file.
There is no new message between validators, no new field in a message,
no new route, no new variable and no package. The fix changes only what
the validator that took a submission does, so a validator on this code
and a validator on older code work together, and the code goes onto the
validators one at a time. The plan has four steps: the code and its
papers, which this section records; a rig of five validators (33.5); the
pull papers; the records. The first two are done. The rig found no
fault in the code.

### 33.1 The decisions, as they apply to the code

- **One function, called from the four places a submission comes in.**
  `src/validators/acceptance.js`, new: `proveAcceptance({ transactionId,
  approvals, askApproval, markApproved, sendProof, takeMarkBack })`.
  `receiveCreateAccount` (`src/accounts/accounts.service.js`),
  `receiveAnosTransfer` (`src/transfer/transfer.service.js`),
  `receiveTransaction` (`src/fund/fund.service.js`, a stake and a fund
  proposal) and `receiveAttachment`
  (`src/attachments/attachments.service.js`, the nine kinds of
  follow-up) call it at their end, where each marked its own row and
  sent the proof before. What comes before it is as it was: the row
  stored unapproved, the approval sent to the counted peers,
  `settleNoAnswers` (sections 19.1 and 29), and the return with
  `approved: false` when not every answer is an approval. Each caller
  hands over what differs, as small functions: `askApproval(peers)`,
  the approval send it already has, to the peers named;
  `markApproved()`, the mark on its own row or copy;
  `sendProof(receipts)`, the proof with these receipts; and, for a
  transaction, `takeMarkBack()`.
- **Check again before sending the bundle** (the plan's decision 2).
  `bringInLine(approvals, askApproval)`, private, same file. Right
  before a proof is built it reads the counted peers again
  (`findCountedPeers`, the own table) and brings the approvals in line
  with them. The approval of a validator that is not counted any more
  is left out. A validator that is counted now and has given no
  approval is asked for it, with the message that exists, sent to that
  validator alone, and its result takes its place in id order. A
  validator that already holds the transaction answers its approved
  receipt again (check 2b of `receiveTransactionApproval`, 3b of
  `receiveAttachmentApproval`). One that does not hold it runs every
  check and stores the row.
- **A validator that was just voted back in is asked up to five times**
  (decision 7). After an include vote the others count it at once, but
  it answers `503 not counted yet` until it has taken in the leader's
  waiting rows and counts itself (`joinThrough`, section 19): a second
  or two. One ask in that moment would fail the transaction. So a
  validator that answers and does not approve is asked again after
  `ASK_AGAIN_AFTER_MS` (1000), the counted peers read again each time,
  `ASKS` (5) asks in all. One that gives no answer at all is not waited
  for. The cost of a real refusal is four seconds.
- **A validator that is counted now and still does not approve**
  (decision 11), after its five asks or by giving no answer: the
  transaction is not approved, as after any refusal. `proveAcceptance`
  resolves with `{ approvals, approved: false }`. No report, no
  minute's wait, nothing marked, no proof. The rows are swept
  (section 21).
- **The own mark first, then the proof**, as before (decision 12). The
  other order would leave approved rows on every other validator if
  the originating validator died in between.
- **Try a second time** (decisions 3 and 10). When not every validator
  accepted the proof: one line, a wait of `SECOND_TRY_AFTER_MS` (1000),
  `bringInLine` once more, and the proof again, to every counted peer,
  with a new `sentAt` and a new signature. One pass is not enough
  because the proof of a vote reaches the validators at slightly
  different moments, so in that moment no list of receipts is right
  for all of them. A validator that accepted the first proof holds its
  row approved whatever it answers the second, so it counts as
  accepted. A second proof is a message that exists: a receiver whose
  row is approved already passes the same checks, marks nothing and
  answers the accepted receipt. When the second `bringInLine` finds a
  validator that is counted now and does not approve, the second proof
  is not sent, one line says so, and the next decision looks at the
  answers to the first.
- **Unblock the account if it still fails** (decisions 4 and 8). When
  every answer to the proofs that went out was a plain refusal by a
  validator's own check, status `400`, the originating validator takes
  its own mark back: `takeMarkBack()`, which for a transaction is the
  new `takeApprovalBack(table, transactionId)` of
  `src/held-transactions/held-transactions.js`. Its statement is
  `UPDATE <table> SET approved = false WHERE transaction_id = $1 AND
  approved`, and the table must be one of `HELD_TABLE_NAMES` or it
  throws. One line is logged. The row is then unapproved here as it is
  on the others, the sweep of section 21 drops it by its age, and the
  account can send again, about five minutes after the submission. The
  transaction is not written. Why `400` and nothing else: a validator
  answers a proof it refuses with `400` (`proofOfAcceptance` in
  `src/validators/validators.handlers.js`), and it marks its row as its
  last step, after every check, so a `400` means it marked nothing. Any
  other answer, none at all, a `503`, or a `502` or `504` from a
  doorman, may come from a validator that did mark its row, and a mark
  taken back then would leave approved rows on others with no way to
  the write. So in that case, and when some validators accepted and
  some refused, the mark stays as it did before this build, and one
  line names who did not accept.
- **The status a validator answered.** `sendProofOfAcceptance`
  (`src/validators/validators.messages.js`): a result that is not
  accepted now carries `status`, the HTTP status that validator
  answered, undefined when it gave no answer. It is a field of a result
  in memory, not of a message. `sendProofOfAttachmentAcceptance` is not
  changed: nothing reads a status there.
- **Follow-ups get the first two changes and not the third**
  (decision 6). A follow-up travels the same way, an approval and then
  a proof, and has the same gap, with a larger harm: the others keep
  their copy for good, because no sweep drops a follow-up, and a slot
  that holds one refuses a second. `receiveAttachment` calls
  `proveAcceptance` with no `takeMarkBack`: nothing would drop a copy
  whose mark was taken back. The kind's effect (`kind.onAccepted`) is
  applied here after the proof, as before, and now only when
  `proved.approved`: not when a validator that is counted by then did
  not approve. What a follow-up whose proof stays refused leaves behind
  is as it was before this build.
- **What a handler sees** (decision 13). The result keeps its shape.
  `approvals` are the ones the last proof carried. `proof` has one
  entry per validator the last proof went to, an entry accepted when
  that validator accepted either proof. `approved` stays true when the
  mark was taken back. So `src/util/submission-response.js`,
  `src/transfer/transfer.handlers.js` and
  `src/accounts/accounts.handlers.js` log every `validator N accepted
  the proof` and `validator N did not accept the proof: <reason>` as
  before and answer `202`. They are not changed.
- **The wallet's answer stays `202`** (decision 5).
- **The lines**, word for word (decision 14). `<id>` is the
  transaction's id as the wallet sent it. For a follow-up it is the id
  of the transaction the follow-up attaches to.

  ```text
  validator N is not counted any more: its approval is left out of the proof
  validator N is counted now: it is asked for its approval
  validator N did not approve: <reason>; it is asked once more
  the proof of <id> was not accepted by every validator; it goes once more
  validator N did not approve: <reason>; the proof does not go again
  no validator accepted the proof of <id>: the approval here is taken back
  the proof of <id> is still not accepted by validator N: the approval here stays
  ```

  The last one reads `validators N, M` for more than one. None of the
  seven is logged while nobody is voted in or out.
- **Section 29 changes for the sending side** (decision 9). 29.1 says
  that a refusal of the proof of acceptance is not acted on (decision 7
  of `~/Desktop/Z-TestNet/forclaude/validator-refusal-plan-1.md`). The
  originating validator now acts on it, as above. The receiving side is
  as it was. A proof that gets no answer twice, and a refused final
  declaration, stay as that plan left them.
- **The cost** (decision 15). One more read of the own table for every
  submission, and nothing else while nobody is voted in or out. After a
  refused proof: one second and one more proof. By the planner's count
  the worst case adds about 30 seconds to a submission: twice four
  waits for a validator that was just voted back in, and two proofs
  that each run into the call timeout. The wallet's proxy ends a call
  after 120 seconds (`proxyTimeoutMs` in
  `~/Desktop/Z-TestNet/web_app/server/config.js`), and the worst case
  before this build, a silent validator and a silent leader, already
  came to about 110. A validator finishes its work whether or not the
  wallet still waits. Not measured on the network.
- **No new setting, message, field in a message, route, table or
  package** (decision 17). The new file has three numbers,
  `SECOND_TRY_AFTER_MS`, `ASKS` and `ASK_AGAIN_AFTER_MS`, and the
  status `REFUSED` (400). They are constants in the file, not settings.
- **What stays** (the plan's section 4). Every message, route, table
  and setting, and the registry. "Every counted validator answers, or
  the network stops": no quorum. The receiving side: a proof must still
  carry one receipt from every validator the receiver counts, no more
  and no fewer. A proof that some validators accepted and others still
  refuse or do not answer: the row stays approved where it was
  accepted, as before, and one line names who did not accept. That
  needs a validator whose own table differs from the others' for longer
  than a second, or one that is silent twice. A follow-up whose proof
  stays refused: its copy here stays approved and its kind's effect is
  applied here, as before. A submission that comes in through a
  validator on older code. The wallet: its answer is `202` whatever
  happened, it never sends the same signed submission twice, and the
  Resubmit button of an account creation shows only while the
  masterpod's mark is empty. The minute an originating validator waits
  for a validator that was only restarting (31.4). A transaction that
  is not approved because a validator that was just voted back in did
  not answer in its five asks: its rows are swept after five minutes,
  as after any refusal.
- **Out of this build.** The follow-ups are the plan's section 5. On
  the after-production list already
  (`~/Desktop/Z-TestNet/after_production_todos`), and not changed by
  this build: an answer to the wallet that says approved or not, in
  place of `202`; a follow-up that stays stuck, and an age limit for a
  slot; silence to the proof of acceptance, a second try for the final
  declaration, and the quorum. Written in the plan and on no other
  list: the receiving side taking a proof that carries a receipt from a
  validator that was voted out since; a message that tells the others
  to drop a row at once; a follow-up's effect applied on the
  originating validator although its proof was refused; a row that is
  left approved on one validator and is copied, with its mark, by a
  validator that joins through that one; a send to one peer and
  `noticeIgnoredAnswers`, where one validator that wrongly answers
  `validator N is ignored` is more than half; more than two tries, or a
  longer wait.

### 33.2 The rollout

- **One validator at a time, no shutdown**, as in 31.2 and 32.2. The
  order is the user's: validator 1 first, watched, then the others one
  at a time, each counted again before the next one starts. Nothing but
  the validator's program restarts: no `npm ci`, no database step, no
  doorman pull, no setting. A start prints the same lines as before
  this build.
- **The line for a worker** is the line of 31.2 and 32.2, with its
  question about the leader, as the round's `pull_steps.md` in
  `~/Desktop/Z-TestNet/upcoming_validator_pulls` gives it. The pull
  papers of this build are the plan's third step and are written on the
  user's word.
- **While validators on older code are about.** A submission that comes
  in through a validator on this code is covered, whatever code the
  others run: the approval, the proof and the answers to them are the
  messages all 25 know today. A submission that comes in through a
  validator on older code is as it was before this build. No mix is
  worse than before: a validator on older code checks a proof as it
  always did, and a second proof is to it a proof like any other.
- **What to look for on a validator**, in its journal:

  ```text
  its approval is left out|is asked for its approval|it goes once more|is taken back|still not accepted
  ```

  None of these lines is expected while nobody is voted in or out. `is
  taken back` and `still not accepted` are the two worth a look. The
  first means a transaction was not written and its account is free
  again after five minutes. The second means a row is left approved on
  some validators, as it could be before this build.
- **The way back** is the one of the round's papers: `git reset --hard`
  to the commit before this build and a restart. This build leaves
  nothing in the database.

### 33.3 Files

New: `src/validators/acceptance.js` (`proveAcceptance`; the private
`bringInLine` and `sleep`; the four constants).
Changed: `src/validators/validators.messages.js` (`status` on a result
of `sendProofOfAcceptance` that is not accepted, the comment of that
function, and one sentence at the end of the opening comment),
`src/held-transactions/held-transactions.js` (one import and the new
`takeApprovalBack`), `src/transfer/transfer.service.js`,
`src/accounts/accounts.service.js` and `src/fund/fund.service.js` (two
imports each, the end of `receiveAnosTransfer`, `receiveCreateAccount`
and `receiveTransaction`, and one sentence in the comment of each),
`src/attachments/attachments.service.js` (one import, the end of
`receiveAttachment`, and its comment), and
`src/held-transactions/unapproved-sweep.js` (one sentence in the opening
comment, no code). On the user's word also the comments that 33.4 lists,
which touch one file more, by a comment only:
`src/validators/validators.service.js`. In the docs: the README
("Create-account submission"; "Follow-ups"; "Ignoring and joining", the
new paragraph "The proof after a vote" and three words in "The report
and the originator's wait"; "Validator-to-validator messages", at the
two proofs; two lines of "Project layout"; one clause in "Database") and
this section.
Not changed: the code of `src/validators/validators.service.js` (a proof
is checked as before), `src/votes/` (`settleNoAnswers` and the votes are
used as they are), the handlers and `src/util/submission-response.js`,
the code of `src/held-transactions/unapproved-sweep.js` and
`written-rows.js`,
`src/validators/join.service.js`, `src/server.js`, the nine kinds of
follow-up, every file under `deploy/`, `network/`, `db/` and `scripts/`,
and no package file. The doorman is not touched.

### 33.4 Notes from the build

- **The build was made on main at `0712b16`**, the build of section 32,
  which is the commit the plan was written against, with a clean
  working tree (`git status --short` and `git log --oneline -3` at
  about 18:20 on this Mac's clock on 2026-11-19, which is 02:20 UTC on
  2026-11-20, before the first edit). GitHub's `main` stood at
  `6b27427` then: the commits of sections 31 and 32 were not pushed.
  Before the first edit every **Old** block of the plan's sections 1.2
  to 1.5 was in its file exactly once, fifteen places in all, and
  `src/validators/acceptance.js` was not there.
- **The code is the plan's text, not a retyping of it.** A throwaway
  script outside the repo read the plan's 21 code blocks, wrote the
  first as `src/validators/acceptance.js`, and put each New block in
  the place of its Old block. A second script then compared the plan
  with the files (below, "Checks").
- **Eight source files, where the plan counts seven.** Seven is the
  number of files whose code changes. The plan's section 1.6 also names
  the opening comment of `src/held-transactions/unapproved-sweep.js`,
  and that file got its one sentence. Its code is unchanged, as the
  plan's 1.9 says.
- **Where the plan gives words and no code** (its 1.6 and 1.7). Each
  comment carries the day, 2026-11-19, and the plan's words. The
  comments above `receiveAnosTransfer`, `receiveCreateAccount` and
  `receiveTransaction` got one sentence, the same in all three, right
  after "…the proof of acceptance bundling those receipts": that last
  step is now `proveAcceptance`, and the three things it does. The
  comment above `receiveAttachment` got its sentences after "…and the
  kind's effect is applied here", which is the end of the sentence the
  plan quotes from: the first two things, and that the mark of a
  follow-up is not taken back. The opening comment of
  `validators.messages.js` got one sentence after its last: the
  approval sends take the list of peers also for the approval asked of
  a validator that is counted by the time of the proof. The comment
  above `sendProofOfAcceptance` got one sentence in front of the lines
  the plan's 1.2 changes: `receipts` are the approvals of the
  validators counted when the proof is built, and the proof of one
  transaction may go a second time. The opening comment of
  `unapproved-sweep.js` got one sentence at the end of its first
  paragraph. In the README: "Create-account submission" has the three
  things in three sentences and the seven lines after the sentence that
  ends "…and logs `validator N accepted the proof`"; "Follow-ups" has
  one sentence after "…each peer marks its copy approved"; the new
  paragraph "The proof after a vote" stands right after "The report and
  the originator's wait"; each of the two proofs in
  "Validator-to-validator messages" has one short paragraph under its
  payload; and in "Project layout" the line of `acceptance.js` stands
  after the one of `chain-ends.js`.
- **The import ring.** `acceptance.js` imports `src/config/env.js` and
  `src/validators/validators.queries.js`, and neither imports it back.
  It is imported by the four service files and by nothing else.
  `held-transactions.js` now imports `src/db/pool.js`, which imports
  `pg` and `env.js` and nothing of this repo besides. No newly imported
  name is used while a module loads, only inside functions.
- **Comments and doc lines the plan does not name** were first left as
  they were, where this build makes them say less than the code does,
  and listed for the user, who said to bring them in line (2026-11-19,
  "Go ahead and change the comments and start the rig"). Brought in
  line, each with the day. In `src/validators/validators.messages.js`:
  the comments of `sendTransactionApproval` and `sendAttachmentApproval`
  (the list of peers was "the one re-send after no answer"; it also
  serves the approval asked of a validator that is counted by the time
  of the proof), and the comment of `sendProofOfAttachmentAcceptance`
  (`receipts` were "those answers"; they are the approvals of the
  validators counted when the proof is built, and that proof may go a
  second time too). In `src/transfer/transfer.service.js`,
  `src/accounts/accounts.service.js` and
  `src/attachments/attachments.service.js`: the sentence of the receive
  comment that says what is returned (`approvals` are in line with the
  validators counted by the time of the proof, as the last proof
  carried them; `proof` has one entry per validator the last proof went
  to; for a transaction `approved` stays true when the mark was taken
  back). In the first two of these that sentence also named an entry of
  `proof` as `{ id, status, body }`, which was wrong before this build;
  it now reads `{ id, accepted, reason? }`. The comment of
  `receiveTransaction` in `src/fund/fund.service.js` says "exactly as
  those two do" and needed no change. In
  `src/held-transactions/unapproved-sweep.js`: the second paragraph of
  the opening comment (the steps of an approval round "add up to well
  under two minutes"; by the plan's count this build adds about half a
  minute to the worst case, which stays far under the five minutes). In
  `src/validators/validators.service.js` and
  `src/attachments/attachments.service.js`: the comments of the two
  proof receivers (a row that is approved already was "the same proof
  twice"; it is also met by the second proof, which carries other
  receipts). In the README, "Database": "a refused approval leaves such
  rows behind" (a proof that every validator refused leaves one too).
  Comments and doc words only: no line of code changed with them.
  `src/validators/validators.service.js`, which the plan's 1.9 lists as
  not changed, has that one comment changed and no code.
- **Read in the code, not tried: a follow-up that reaches the
  originating validator in the second before a mark is taken back.**
  Between its own mark and the take-back, a second at the least, the
  row is approved on the originating validator alone. A follow-up for
  that transaction that reaches this validator in that time passes
  "approved on this validator", is stored here unapproved, and is
  refused by every other validator (`attachment: this transaction is
  not approved yet`). The sweep then drops the row, and a follow-up
  that is kept in the row goes with it. A guardian's vote is a row of
  `guardian_votes`,
  which the sweep does not touch (section 21 counts on an unapproved
  row having no child rows), so that one row would stay behind without
  its proposal, on that one validator. It needs a guardian's vote in
  the very second in which every validator refused a new proposal
  twice. Before this build the row stayed approved for good, with such
  a follow-up stuck in it. Named here, not closed.
- **Checks.** `node --check` passed on the eight source files, the
  seven of the plan and `unapproved-sweep.js`, with Node 24.22.0. The
  imported names were read against their modules' exports:
  `proveAcceptance` in `src/validators/acceptance.js`;
  `takeApprovalBack` in `src/held-transactions/held-transactions.js`;
  `query` in `src/db/pool.js`; `env` in `src/config/env.js`;
  `findCountedPeers` in `src/validators/validators.queries.js`. The
  link check of 31.4, run from a folder outside the repo: Node linked
  the whole module graph from `src/server.js` with an empty environment
  and stopped at the first settings read (`Error: Missing required
  environment variable: PGDATABASE`), after every import of every
  module had been matched to an export. No key file was read, no
  database connection made, no server started. The same kind of load
  behind one wrong name asked of `acceptance.js` stopped with
  `SyntaxError: … does not provide an export named`, so the check does
  see a wrong name. The plan's blocks against the built files, by a
  throwaway script: 21 blocks between a line of three backticks plus
  `js` and the next three backticks; the first is the whole of
  `acceptance.js`, byte for byte; each of the ten blocks under **New**
  is in its file exactly once, fifteen places in all. One check more
  than the plan lists, also with a throwaway script outside the repo: a
  byte-for-byte copy of the built `acceptance.js` was run on 24 made-up
  layouts, with stand-ins for its two imports, for the sends and for
  the two waits, and with receivers that judge a proof by checks 2, 4
  and 5 of `receiveProofOfAcceptance`. What was expected of each layout
  was written down from the plan's decisions before the run, and all 24
  came out so: nothing changed; a validator voted out before the proof;
  one voted back in that approves at once, says no five times, gives no
  answer, answers `not counted yet` twice and then approves, answers it
  five times, or is voted out again while it is asked; one voted out
  and another voted back in; two voted back in, one of them silent; a
  vote that lands while the first proof travels, in both directions; a
  validator that took the first proof and refuses the second; every
  validator refusing both proofs; the same with one answer missing,
  with one `200` among them, with a `504` from all, and for a
  follow-up; one validator that keeps refusing; a validator silent to
  the first proof that takes the second; a network of one; a validator
  voted back in between the two proofs that then says no, so that the
  second proof does not go; the originating validator itself voted out;
  a validator voted out between the two proofs after it took the first.
  In every layout the own row was marked once at the most and before
  any proof, and the mark was never taken back while any validator had
  marked its row. The planning chat had run the same text on 22 layouts
  of its own, and the statement of `takeApprovalBack` in a scratch
  schema that was rolled back (the plan, "What the plan stands on").
  `git status` showed the ten files of the first step and no other, on
  `main` at `0712b16`. After the comments were brought in line:
  `node --check` on nine source files, `validators.service.js` now
  among them, the link check with the same answer, the plan's blocks
  against the files with the same result, and `git status` with eleven
  files. After the rig: `node --check` on the nine files again, the
  link check again with the same answer, the plan's blocks against the
  files again, the 24 layouts again, and the rig's copy of the code
  compared with the working tree: equal in `src/`, `db/`, `network/`,
  `deploy/` and `scripts/`, but for the rig's own registry and genesis
  pair. `git status` showed the eleven files of 33.3 and no other, on
  `main` at `0712b16`, with nothing staged.
- **Before the rig** nothing of this build had run between two
  validators, and no statement of it against a database in the build
  chat. The rig was the first run.
- **The rig found no fault in the code of this build**, and no line of
  code changed after the first step: the source files the rig ran are
  the ones the plan's blocks describe, with the comments in line. Every
  one of the seven lines was logged between running validators, and
  every branch of `acceptance.js` ran there at least once (33.5), but
  for one: a validator that accepted the first proof and refuses the
  second, which only the layouts above have. `takeApprovalBack` ran
  through all three callers, on `pending`.
- **Seen on the rig, known and left as it is.** Three things stopped or
  disturbed the rig's long runs, and none of them is in this plan. The
  hand-over case of 32.4, a healthy validator voted out when the lead
  changes hands: it is on the after-production list
  (`~/Desktop/Z-TestNet/after_production_todos`), and the rig met it in
  every run at full speed. A round that ended without writing is led
  again only at the next transaction that is accepted (32.1; among the
  follow-ups of
  `~/Desktop/Z-TestNet/forclaude/validator-resilience-plan-2.md`): on
  the rig, with every account that could send holding a transfer that
  waited, there was none, and nothing more was written until the leader
  was restarted. And on a network of five, two validators voted out are
  the floor: a third that then stops cannot be voted out, and when it
  comes back one link short it cannot catch up while the other four
  stand at three different chain ends. Each is told in 33.5.

### 33.5 The rig

The rig (the plan's section 2), 2026-11-19, 18:50 to 19:25 on this Mac's
clock, everything in the build chat's scratchpad and nothing in the repo.
It started on the user's word ("Go ahead and change the comments and
start the rig"), after the comments of 33.4 were in line. Built as the
rig of 32.5 was, from the tools that rig had left in its build chat's
scratchpad, with these differences:

- **Two copies of the code**, without `.git`, `node_modules` linked: the
  working tree (every tracked file and the new one, 117 files), and
  `0712b16` from `git archive`. They differed in the eleven files of
  33.3 and nothing else. The rig's own registry and genesis pair went
  into both.
- **Five databases**, `anosrig1` to `anosrig5`, under a role of the
  rig's own, `anosrig`, by `scripts/setup-db.sh`, on Homebrew PostgreSQL
  17.11. A key per validator in owner-only files, five machine files,
  the network's own settings as they are.
- **The proxy** stood in front of all five, as in 32.5, with three
  things more. A rule can name the validator a call comes from and the
  transaction it is about. And a call can wait at a gate until the rig
  lets it go. So the rig could hold one validator's answer to the
  approval call of one originating validator, hold an originating
  validator's proof on its way to chosen validators, and keep a
  joiner's join request at the leader's door until the moment it wanted
  the include vote.
- **Four accounts**: the rig's OG account, two more (x and y) created
  through a validator with a stand-in for the masterpod and paid 1,000
  anos each, and later a fourth (z) for one of the extra checks. Every
  plain transfer paid the rig's fund account.
- **How a vote was put between the approvals and the proof.** A
  validator V was made one link short: a trigger failed one batch on
  it, as in 32.5. The transfer under test, T, went in through validator
  A while the proxy held one answer to A's approval call for six
  seconds. Three tenths of a second later a transfer of another account
  went in through a third validator, the leader's look (section 32)
  found V behind, and V was voted out. So A stood between its approvals
  and its proof when the vote passed, for certain. For a return, V's
  process was stopped after its vote and started again with its join
  request held at the gate.
- **By hand.** A validator that had been voted out was brought back by
  a restart where its return was not the point. In point 7 and in the
  run on `0712b16` it came back by its own self-check. A wrong flag was
  set and reset by hand in points 5, 6 and 8 and in three of the extra
  checks. Waiting rows that a refused proof had left were deleted by
  hand after points 6, 8 and 9, in the run on `0712b16` and after the
  extra checks, each time with a line in the rig's output.

What it showed, in the plan's order. "A" is the validator the transfer
comes in through, "V" the validator that is voted out or back in.

1. **Ground.** Five up on empty databases: validator 1 `leading at
   position 2`, the others `counted at position 2`. Two account
   creations and five transfers landed at positions 3 to 9 on all five.
   Then 60 transfers of the three accounts, 12 through each validator,
   each on all five chains before the next was sent, in 12.4 seconds:
   positions 10 to 69, every validator led 12 rounds, all five equal at
   the end (69 links, one digest over every record hash), no unusual
   line, and none of the seven lines of 33.1 in any log.
2. **A validator voted out between the approvals and the proof.** The
   batch failed on validator 2 (`wrote: 0`), which stood at position 69
   with the others at 70. T, `6c606cad…` of account y, went in through
   validator 1, and validator 3's answer to its approval call was held.
   The other transfer went in through validator 5. The leader,
   validator 4: `chain ends differ: 4 validators at position 70
   (5d4e029e); validator 2 at position 69 (90745e82); own position 70
   (5d4e029e)`, `ignore vote 40257098 naming validator 2: 3 voters`,
   three times `voted yes (2: tail at position 69, own 70)`, passed,
   `the round starts again`, and the other transfer written by the four
   at 71, all within 0.4 seconds of T's send. Six seconds after the
   send the held answer went back. Validator 1: `validator 2 is not
   counted any more: its approval is left out of the proof`, `validator
   3 approved`, `validator 4 approved`, `validator 5 approved`, `all
   validators approve`, three times `accepted the proof`. T was written
   by the four at position 72, 44 milliseconds after the held answer
   had gone back. The wallet was answered `202` after 6.0 seconds,
   which is the hold. The point ran five times on this build, with
   another validator in each part (A was validator 1, 4, 1, 4 and 2):
   the same line, and the transfer written by the four, each time.
   **The same on `0712b16`**, all five on that code. The batch failed
   on validator 1; T, `6753d82f…`, went in through validator 4;
   validator 1 was voted out (`ignore vote 7f54ba0d`). Validator 4 sent
   its proof with validator 1's receipt in it. Validators 2, 3 and 5:
   `failed: receipts[0]: validatorFrom 1 is not a counted validator`.
   Validator 4: three times `did not accept the proof: answered 400:
   {"error":"receipts[0]: validatorFrom 1 is not a counted
   validator"}`, and `202` to the wallet. T was never written.
   Validator 1 came back by its self-check, `counted at position 110`,
   61 seconds after its vote. The others dropped their copies of T 300
   to 360 seconds after the send (`dropped unapproved pending
   transaction 6753d82f…: older than 300 seconds`). Validator 4's row
   was still there and approved 362 seconds after the send. The
   account's next transfer, through validator 2: `validator 4 failed:
   answered 400: {"error":"transaction: a transaction for this
   accountId is already pending"}`, not approved. That is what this
   build ends.
3. **A validator voted back in between the approvals and the proof.**
   Validator 2 was out and stopped. Started again, it caught up
   (`replayed 3 links`), and its join request waited at the gate. T,
   `02ec51d1…` of account x, went in through validator 3 with validator
   4's answer held for five seconds, and 153 milliseconds later the
   gate opened. The leader, validator 1: `join of validator 2 started;
   rounds held`, `include vote b7ee7ba0 naming validator 2: 3 voters`,
   three yes, passed. Validator 2: `join: included`, three lines
   `cleared held pending transaction …`, `held rows of pending: 1
   received, 1 stored`, which is T, and `counted at position 72`, 1.0
   second after the vote. When the held answer went back, validator 3:
   `validator 2 is counted now: it is asked for its approval`,
   `validator 2 approved` with the other three, `accepted the proof`
   from all four, and T written by all five at position 73.
   **A second run, with V not ready yet.** Validator 1 was out; the
   answer to A's approval call was held for 1.3 seconds and validator
   1's `ready` for 2.5 seconds, so that it counted itself 3.5 seconds
   after its include vote. A, validator 2: `validator 1 is counted now:
   it is asked for its approval`, then three times, a second apart,
   `validator 1 did not approve: answered 503: {"error":"not counted
   yet"}; it is asked once more`. The fourth ask was approved, the
   proof accepted by all four, and T, `35307552…`, written by all five
   at position 77. The wallet was answered `202` after 4.4 seconds.
4. **A vote while the proof travels.** The batch failed on validator 5.
   T, `fe75126a…`, went in through validator 3: four approvals at once,
   its own row marked, and the proof, which the proxy held for five
   seconds on its way to validators 1, 2, 4 and 5. In that time the
   other transfer went in and validator 5 was voted out (`ignore vote
   ba71ab8c`). When the proof arrived, validators 1, 2 and 4: `failed:
   receipts[3]: validatorFrom 5 is not a counted validator`. Validator
   5, which is told nothing of its vote, accepted it. Validator 3: `the
   proof of fe75126a… was not accepted by every validator; it goes
   once more`, a second later `validator 5 is not counted any more: its
   approval is left out of the proof`, then `accepted the proof` from
   validators 1, 2 and 4, and T written by the four at position 80.
   **A second run, the proof held on its way to two validators only.**
   Validators 4 and 5 took the first proof at once (`approved:
   d3eca945…`), before the vote. Validators 1 and 2 got it five seconds
   later, after the vote, and refused it with the line above. `…it goes
   once more`, `validator 5 is not counted any more…`, and the second
   proof was accepted by validators 1 and 2 and by validator 4, whose
   row was approved already. T was written by the four at position 83.
   So some took the first proof and some the second.
5. **Every validator refuses.** On validator 1 alone, by hand,
   validator 3's row got `ignored = true`. T, `86d0e13f…` of account x,
   through validator 1: approvals from validators 2, 4 and 5, and both
   proofs refused by all three, `failed: no receipt from validator 3`,
   a second apart. Validator 1: `the proof of 86d0e13f… was not
   accepted by every validator; it goes once more`, then `no validator
   accepted the proof of 86d0e13f…: the approval here is taken back`,
   three times `did not accept the proof: answered 400: {"error":"no
   receipt from validator 3"}`, and `202` to the wallet after 1.0
   second. Its row was unapproved, like the rows of the three. With
   nothing sent: validator 1 `dropped unapproved pending transaction
   86d0e13f…: older than 300 seconds` 319 seconds after the send, and
   validators 4, 2 and 5 the same line 335, 349 and 355 seconds after
   it. Validator 1's table was put right by hand, and a new transfer of
   account x, through validator 2, was written by all five at position
   84, with no line of the plan.
6. **One validator keeps refusing.** On validator 4 alone, by hand,
   validator 2's row got `ignored = true`. T, `baeb3368…` of account y,
   through validator 1: four approvals, then validator 4 refused both
   proofs (`failed: receipts[0]: validatorFrom 2 is not a counted
   validator`) and validators 2, 3 and 5 accepted. Validator 1: `…it
   goes once more`, then `the proof of baeb3368… is still not accepted
   by validator 4: the approval here stays`. Its row stayed approved,
   as the rows of validators 2, 3 and 5 did; validator 4's was not; and
   nothing was taken back. T was written nowhere: the leader's round
   came to `official list: 0`. This is the case that stays (33.1, "What
   stays"). The rig put validator 4's table right and deleted the five
   rows by hand, and a closing transfer was written by all five.
7. **The dying leader**, point 4 of 32.5, first run. The list of the
   leader, validator 5, reached validator 2 (position 86) and was held
   back from validators 1, 3 and 4, and validator 5 got SIGKILL. A
   transfer of another account, `a4626153…`, through validator 3: `no
   answer report for validator 5 sent to validator 1: answered 200`.
   Validator 1: `ignore vote 60e9029b naming validator 5: 3 voters`,
   three yes, `validator 5 ignored; validator 1 is the leader`; then
   `chain ends differ: 3 validators at position 85 (5a7aea2f);
   validator 2 at position 86 (45e85a07); own position 85 (5a7aea2f)`,
   `ignore vote b3d7ddc6 naming validator 2: 2 voters`, two yes,
   passed 20 milliseconds after the first vote, `the round starts
   again`, and the missed transfer written by validators 1, 3 and 4 at
   86. Validator 3, a second after its send: `validator 2 is not
   counted any more: its approval is left out of the proof`, `validator
   1 approved`, `validator 4 approved`, two times `accepted the proof`,
   and the transfer that had found the dead leader was written by
   validators 1, 3 and 4 at position 87. The wallet was answered `202`
   after 1.0 second. In 32.5 that transfer was left unwritten, both
   times. Validator 2 came back by its self-check (`self-check: ignored
   by the network`, a minute later `…twice in a row; joining again`,
   `replayed 1 links`, the include vote, `counted at position 87`), 93
   seconds after its vote. A closing transfer was written by the four.
8. **A follow-up.** An escrow transfer E, `504ae520…`, 5 anos from
   account x to account y, was approved by all five and waited in
   `escrow_transfers`. The batch failed on validator 5. The success
   signature for E, signed by x, went in through validator 3, and
   validator 1's answer to its attachment approval was held for six
   seconds; the other transfer went in, and validator 5 was voted out
   (`ignore vote f65e11e9`). Validator 3: `validator 5 is not counted
   any more: its approval is left out of the proof`, three times
   `accepted the proof`; validators 1, 2 and 4: `approved attachment:
   28a17f61…`. E was written by the four at position 91 and left
   `escrow_transfers` for `logs`, outcome `written`.
   **Once with every validator refusing.** A second escrow transfer,
   `e9676e41…`, approved by all five. On validator 1 alone, by hand,
   validator 3's row got `ignored = true`, and the success signature
   went in through validator 1. Validators 2, 4 and 5 refused both
   proofs: `failed: no receipt from validator 3`. Validator 1: `…it
   goes once more`, then `the proof of e9676e41… is still not accepted
   by validators 2, 4, 5: the approval here stays`. No line `taken
   back`. On validator 1 the success signature was approved; on
   validators 2, 4 and 5 it was there and not approved; validator 3 had
   none; the escrow was written nowhere. That is what a follow-up whose
   proof stays refused leaves behind, as before this build. The rig
   deleted the escrow's rows by hand.
9. **Old and new together.** Validators 1 and 2 on `0712b16`,
   validators 3, 4 and 5 on this build. Ten transfers, two through each
   validator, the rounds led by validators on both codes: written by
   all five at positions 93 to 102, and no log has a line of the plan
   or an unusual line. Point 2 with A on this build (validator 3), the
   vote's round led by validator 2 on `0712b16`: `validator 5 is not
   counted any more: its approval is left out of the proof`, `accepted
   the proof` from validators 1 and 2, on `0712b16`, and from validator
   4, and T written by the four at position 106. Point 2 with A on
   `0712b16` (validator 1): validators 2, 4 and 5 refused the proof,
   `receipts[1]: validatorFrom 3 is not a counted validator`, T was not
   written, validator 1's row stayed approved, and no log has a line of
   the plan. That is the limit during a round of pulls: a submission is
   covered when the validator it comes in through runs this build.

Tried besides the nine points:

- **The cure that was read in the code and never tried.** After point 2
  on `0712b16`, with validator 4's row still approved, the account's
  next transfer had left unapproved rows on the other four, and the rig
  deleted those by hand: they would have blocked the account for five
  more minutes, past the ten minutes a transfer is taken in for. Then
  the same signed T went in again, through validator 2, 363 seconds
  after its first send. Validator 4 answered it as the same approval
  twice (`correct`), every validator approved, `accepted the proof`
  came from all four, validator 4's row being approved already, and T
  was written by all five at position 111. So the cure holds, for a
  sender that keeps the signed transfer and sends it again between the
  sixth and the tenth minute. The wallet does neither.
- **A stake**, which goes through `receiveTransaction`
  (`fund.service.js`): 10 anos of account y for `daoVote`, plain,
  written by all five, the `stakes` row on all five, no line of the
  plan. And once with every validator refusing, as in point 5: `…it
  goes once more`, `no validator accepted the proof of 4a809fca…: the
  approval here is taken back`, the row unapproved.
- **An account creation**, which goes through `receiveCreateAccount`:
  a new account z, through a validator whose table was wrong by hand as
  in point 5. Both proofs refused, `no validator accepted the proof of
  f933177a…: the approval here is taken back`, the row unapproved. The
  rig deleted the rows by hand in place of the five minutes, and the
  same signed submission, sent in again through another validator, was
  written by all five; account z is in `accounts` on all five.
- **Five asks that run out.** As point 3, with V's `ready` given no
  answer once, so that V counted itself only 21 seconds after its
  include vote. A: `validator 3 is counted now: it is asked for its
  approval`, four times `…; it is asked once more`, and after the
  fifth ask `validator 3 failed: answered 503: {"error":"not counted
  yet"}` from the handler. The transfer was not approved, nothing was
  marked, no proof went out, and the wallet was answered `202` after
  5.4 seconds. The five rows were unapproved, V's among them, which it
  had pulled from the leader.
- **The include vote while the first proof travels, and five asks that
  run out.** A's proof, with three receipts, was held for four seconds;
  the include vote on validator 1 passed in that time; validators 3, 4
  and 5 then refused it, `failed: no receipt from validator 1`.
  Validator 2: `…it goes once more`, `validator 1 is counted now: it
  is asked for its approval`, four times `…; it is asked once more`,
  then `validator 1 did not approve: answered 503: {"error":"not
  counted yet"}; the proof does not go again` and `no validator
  accepted the proof of 8dc02112…: the approval here is taken back`.
  The wallet was answered `202` after 9.1 seconds. With this run every
  one of the seven lines has been logged between running validators.
- **A validator that gives no answer to the ask.** As point 3, with the
  connection for A's ask to V cut by the proxy. `validator 4 is counted
  now: it is asked for its approval`, and at once, with no second ask,
  `validator 4 failed: no answer: fetch failed: other side closed`. Not
  approved, nothing marked.
- **A missing answer among the refusals.** As point 5, with the proxy
  cutting both proofs on their way to one of the three validators. Two
  refused with `400`, twice, and one gave no answer, twice. `the proof
  of 8cd7f6f5… is still not accepted by validators 3, 4, 5: the
  approval here stays`, and validator 1's row stayed approved. An
  answer that is missing may come from a validator that did mark its
  row, so the mark is not taken back (33.1).
- **A long plain run on this build.** Three accounts side by side, as
  fast as they could, for 100 seconds, nothing held: 9,738 transfers in
  6,749 rounds, positions 4,422 to 14,159, the slowest answer 44
  milliseconds, none refused. Every one of the 9,738 is on the chain of
  every counted validator, no waiting row was left, and no log has one
  of the seven lines. The hand-over case of 32.4 voted one healthy
  validator out 49 seconds into the run (`validator 4 sent no approved
  pending list: answered 400: {"error":"validator 3 is not the
  leader"}`), and it came back by its self-check 78 seconds later. No
  transfer stood between its approvals and its proof at that vote.
- **A second long run on this build, 180 seconds, and what stopped
  it.** Thirteen seconds in, the hand-over case again: `validator 2
  sent no approved pending list: answered 400: {"error":"validator 1 is
  not the leader"}`, then `ignore vote f922b9ef failed: validator 3
  voted no (2: ok)`, and the round ended with nothing written. A
  transfer of each of the three accounts was approved on all five and
  waited. A round that ended early is led again at the next transaction
  (32.1, "What stays"), and the rig had no other account to send one:
  each account's own next transfer was refused at the door, `a
  transaction for this accountId is already pending`, 1,011 times, and
  nothing more was written for the rest of the run. It is no fault of
  this build: the three proofs had been accepted by every validator,
  and no log has one of the seven lines. The rig restarted the leader,
  which led at once (`official list: 3`), and the three were written
  by all five. Every one of the 1,146 transfers answered `202` in that
  run is on all five chains.
- **A long run with restarts on `0712b16`**, all five on that code:
  three accounts side by side for 100 seconds, and two validators
  restarted in that time, as a round of pulls does. It says nothing
  about this build and is told because it stopped the rig. Within ten
  seconds of the first restart the hand-over case voted two healthy
  validators out (`ignore vote ae5325e6 naming validator 4`, `ignore
  vote 8a70e644 naming validator 3`). Three were counted when the
  second restart took validator 5 down: `no ignore vote naming
  validator 5: below the floor (3 counted of 5 active)`, `validator 5
  gave no answer twice; the round ends`, and nothing more was written.
  Validator 5 came up one link short and could not catch up, `no
  majority tail: 4 of 4 health answers carry a chain tail`, since the
  other four stood at three different chain ends; the two that were
  voted out could not come back for the same reason. 4,300 transfers
  had been answered `202`, and four of them were not on every chain
  when the run ended. No proof was refused in that run: no log has `is
  not a counted validator` or `no receipt from`. The rig stopped the
  two validators that were far behind, validator 5 then found most at
  one chain end and was counted again, and the two were started one
  after the other and voted back in. Three of the four transfers were
  then on every chain; the fourth had not been approved, and the rig
  deleted its rows by hand. A rig of five on one disk makes this far
  likelier than a network of twenty-five: two validators out are
  already the floor here.

What the rig could not show:

- The doorman and the real network: twenty-five validators, the
  distances between them, and a `502` or `504` from a doorman as the
  answer to a proof. The rig's missing answer was a cut connection.
- A vote that lands between the approvals and the proof by itself.
  Every vote that did was put there by a hold of 1.3 to 6 seconds. On
  one computer the gap is a few milliseconds wide, and in the long
  plain runs the one vote that passed met no transfer in it.
- A validator that accepted the first proof and refuses the second.
  The layouts of 33.4 have it; on the rig a validator that had taken
  the first proof accepted the second as well (point 4, second run).
- `takeApprovalBack` on the four holding tables other than `pending`.
  The planning chat ran its statement on all five in a scratch schema.
- A follow-up of another kind than the escrow's success signature, and
  a fund proposal.
- A restart while transfers come in, on this build. 31.5 and 32.5 have
  it for theirs; the run above, on `0712b16`, shows why the rig did not
  repeat it.
- The whole pull line and the stop: unchanged since 31.5, not run
  again.

The end of the rig: the five validators and the proxy stopped, the five
databases and the role `anosrig` dropped. The Mac's other roles and
databases were listed before the rig and after it, and the two lists are
the same (19 databases, 5 roles). At its end the rig's chain had 15,310
links on all five, with one digest over every record hash, no waiting
row and no child row. Over the whole rig the five logs hold the seven
lines 43 times: `its approval is left out of the proof` 10 times, `it
is asked for its approval` 5, `it is asked once more` 11, `it goes once
more` 9, `the proof does not go again` once, `the approval here is
taken back` 4 times and `the approval here stays` 3. No log has a
thrown error. The rig's folder, with its tools, keys and logs, stayed
in the build chat's scratchpad and is not kept.
