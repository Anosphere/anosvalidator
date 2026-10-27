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
- Two account signing rules, shared by transactions and follow-ups:
  - **any two pairs**: at least two of the three pairs key1/postQuantumKey1,
    key2/postQuantumKey2 and walletKey/walletPostQuantumKey, both halves of
    each pair present, every signature present verifying against the
    account's stored key. Today's transfer rule.
  - **pair one and the wallet pair**: key1, postQuantumKey1, walletKey and
    walletPostQuantumKey all present and verifying. A key2 pair also present
    is checked like any other and accepted. Used by assisted transfers only.
- A transaction waits in a **holding table** until a leader round writes it.
  There are five: `pending`, `locked_transactions`, `assisted_transfers`,
  `escrow_transfers` and `fund_proposals`. All five share: `transaction_id`
  is the primary key; `account_id` is unique, so an account has one
  outstanding transaction at a time; `og_transaction` holds the submission
  exactly as received; `approved` starts false and turns true once every
  validator accepted the transaction. A submission whose transaction id or
  account id is found in any holding table or on the chain is refused.
- A **follow-up** is a signed object attached to a transaction that is
  waiting in a holding table: an attestation, a cancellation, a vote, an
  escrow signature or verdict. Each is stored in or next to the row with its
  own approved flag and goes round the validators the way a transaction does
  (section 9).
- A row that leaves a holding table is deleted (`pending`,
  `locked_transactions`) or moved whole to `logs` or `archives` (the other
  three; section 7).
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
| `daoVote`   | `dao_vote_stake`   | `STAKE_MIN_DAO_VOTE_ANOS`   |      10 | recorded only |
| `moderator` | `moderator_stake`  | `STAKE_MIN_MODERATOR_ANOS`  |   1,000 | recorded only |
| `attestor`  | `attestor_stake`   | `STAKE_MIN_ATTESTOR_ANOS`   |   1,000 | attests assisted transfers, arbitrates escrow disputes |
| `guardian`  | `guardian_stake`   | `STAKE_MIN_GUARDIAN_ANOS`   |   1,000 | proposes and votes on fund proposals |
| `validator` | `validator_stake`  | `STAKE_MIN_VALIDATOR_ANOS`  |  50,000 | recorded only; the `validators` table is unchanged |
| `masterPod` | `master_pod_stake` | `STAKE_MIN_MASTER_POD_ANOS` | 500,000 | recorded only |

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
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Pending's twin for assisted transfers. `attestation_1` and `attestation_2`
hold whole attestation objects, `{ payload, signatures }` as received, the
first to arrive in slot 1. `cancellation` holds the sender's signed
`assistedTransferCancel` while its round runs; once approved on a validator,
that validator moves the row to `logs`.

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
`fund_proposals`. `source` is the table the row left, `outcome` why
(section 7), `record` the whole row as JSON plus its child rows:
`{ row }`, `{ row, arbitrations }` or `{ row, votes }`. Logs may be purged
after a time; archives are kept.

### Changes to existing tables

- `garlic_chain_apply_anos_transfer` fires for seven link types:
  `anosTransfer`, `guardedAnosTransfer`, `vaultAnosTransfer`,
  `assistedAnosTransfer`, `escrowTransfer`, `transferToFund` and
  `transferFromFund`. Its error messages name `NEW.type` instead of
  `anosTransfer`.
- The comments on `locked_transactions` no longer say assisted accounts
  have a time lock. They do not.
- `pending`, `garlic_chain`, `accounts` and `validators` are unchanged.

## 4. Transactions

A transaction is `{ payload, signatures }` with `payload.transactionType`
naming its kind. The four existing kinds, `accountCreation`,
`anosTransfer`, `guardedAnosTransfer` and `vaultAnosTransfer`, are
unchanged and documented in the README. Four kinds are added.

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

### 4.1 assistedAnosTransfer

Sent from an **assisted** account at `POST /anos-transfer`. Signing rule
**pair one and the wallet pair**. No time lock: `createdAt` is not checked.
Held in `assisted_transfers`. Ready for a leader round when approved, both
attestations approved, and no cancellation present. After the write the row
moves to `logs` with outcome `written`, attestations included; the
attestations are not written to the chain.

### 4.2 escrowTransfer

Sent from a **spending** account, the seller, to the buyer at
`POST /anos-transfer`. `createdAt` is not checked. Held in
`escrow_transfers` with `account_id_to` filled from the payload. Ready when
approved, no cancel signature present, and either the seller's success
signature is approved, or the dispute signature is approved and two approved
verdicts say `success`. After the write the row moves to `logs`, outcome
`written`, when there was no dispute, or to `archives`, outcome
`arbitratedSuccess`, with its arbitrations, when there was.

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
`amount` is at least the minimum for that purpose. `createdAt` is not
checked. Held in `pending` like a plain transfer and written at the next
round as a link of type `transferToFund`. In the same database transaction
the sender's `stakes` row gets the amount added to the purpose's column,
the row created if the account has none. Nothing else happens: the role
follows from the amount.

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

## 5. Follow-ups

### 5.1 Common rules

Every follow-up is `{ payload, signatures }`:

```
payload: {
  type:          the kind, one of the seven below
  transactionId: the held transaction it attaches to
  <signer>:      the signer's account id, under the field the kind names
  signedAt:      ISO 8601, recorded, not compared with the clock
  ...the kind's own fields
}
signatures: the signer's account keys, any two pairs
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

For an `assistedAnosTransfer`. `accountId` is the transfer's sender and must
equal the row's `account_id`. Signer: `attestorId`, with
`attestor_stake` at or above its minimum. Own checks: `attestorId` is not
`accountId`; `attestorId` is not the attestor in the other slot. Stored in
`attestation_1` if empty, else `attestation_2` if empty, else refused. No
effect on acceptance beyond readiness.

### 5.3 assistedTransferCancel

```
payload: { type: "assistedTransferCancel", transactionId, accountId, signedAt }
```

Signer: `accountId`, the row's `account_id`, the sender. Own checks: no
cancellation present. Accepted until the transfer is written, even when both
attestations are approved; readiness excludes rows with a cancellation
present. Stored in `cancellation`. Effect on acceptance: the validator moves
the row to `logs`, outcome `userCancelled`.

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
- `escrowCancel`: the buyer, `account_id_to`. Own checks: no dispute,
  success or cancel present. Stored in `cancel_signature`. Effect on
  acceptance: the row moves to `logs`, outcome `receiverCancelled`.
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

## 6. The leader round

Unchanged in shape: ready announcement, every validator's ready list, the
official list as the ids every list holds, the write, the final
declaration. What changes is the ready list and the write.

Each validator's ready list, in id order:

| Table                 | Ready when |
| --------------------- | ---------- |
| `pending`             | approved |
| `locked_transactions` | approved, `future_date <= now()` |
| `assisted_transfers`  | approved, `attestation_1_approved`, `attestation_2_approved`, `cancellation IS NULL` |
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
| `logs`     | `assisted_transfers` | `written`           | after the round wrote it |
| `logs`     | `assisted_transfers` | `userCancelled`     | the sender's cancellation approved |
| `logs`     | `escrow_transfers`   | `written`           | written with no dispute |
| `logs`     | `escrow_transfers`   | `receiverCancelled` | the buyer's cancel approved |
| `archives` | `escrow_transfers`   | `arbitratedSuccess` | written after a dispute; `record` carries the arbitrations |
| `archives` | `escrow_transfers`   | `arbitratedCancel`  | two approved cancel verdicts; with the arbitrations |
| `archives` | `fund_proposals`     | `written`           | after the round wrote it; `record` carries the votes |
| `archives` | `fund_proposals`     | `voteFailed`        | the vote closed and failed; with the votes |

Each move is one database transaction: the insert into `logs` or `archives`
from the row and its children, then their deletion. Nothing from `pending`
or `locked_transactions` is logged: the chain holds everything they had.

Purging logs is not built. The README gives the one-line delete for rows
older than a month; how it runs is decided later. Archives are never purged.

## 8. Endpoints

Public, called by wallets and by attestors, guardians and arbitrators
through their wallets:

| Method | Path                       | Takes |
| ------ | -------------------------- | ----- |
| POST   | `/create-account`          | `accountCreation` (unchanged) |
| POST   | `/anos-transfer`           | `anosTransfer`, `guardedAnosTransfer`, `vaultAnosTransfer`, `assistedAnosTransfer`, `escrowTransfer` |
| POST   | `/transfer-to-fund`        | `transferToFund` |
| POST   | `/fund-proposal`           | `fundProposal` |
| POST   | `/attestation`             | `attestation` |
| POST   | `/assisted-transfer-cancel`| `assistedTransferCancel` |
| POST   | `/guardian-vote`           | `guardianVote` |
| POST   | `/escrow-signature`        | `escrowSuccess`, `escrowCancel`, `escrowDispute`, `escrowVerdict`, by `payload.type` |

Every one answers `202` + `{ transactionId }` once the object is stored on
the validator called and has been sent round, or `400` + `{ error }`. The
`202` is still the placeholder for the wallet's final answer.

Account level (added 2026-10-25 for the wallet; the wallet spec, section
5.3 and 5.4 of `~/Desktop/Z/web_app/docs/schemas.md`, is the spec): an
account signing with pair one reads about itself. The envelope is
`{ payload: { accountId, path, timestamp, nonce, body }, signatures: { ecdsa,
mldsa } }`, checked by `src/auth/require-account.js`: the shape (`400 bad
request shape`), the path (`401 path mismatch`), the timestamp within
`TIMESTAMP_WINDOW_SECONDS` (`401 timestamp outside window`), the account
(`400 invalid accountId`, `401 unknown account`, `401 bad signature` against
`public_key1` and `public_key_pq1`), the nonce (`400 invalid nonce`, `401
replay`; the new `nonces` table, the keyholder's).

| Method | Path                 | Answers |
| ------ | -------------------- | ------- |
| POST   | `/get-account`       | `200 { accountId, type, balance: millionths as a decimal string, latestTransactionId: hex \| null, createdAt }`; `latestTransactionId` is the link with the highest `position` whose `account_id` is the signer |
| POST   | `/list-transactions` | body `{ beforePosition?, limit? (default 50, at most 200) }`; `200 { transactions: [ { transactionId, position, type, accountId, accountIdTo, amount, createdAt } ], pending: [ { transactionId, type, accountId, accountIdTo, amount, createdAt, approved } ] }`, the links where the signer sent or received, `position` descending, and its pending row (at most one) read from `og_transaction.payload` |

`/create-account` gained a fifth check after uniqueness, on the receiving
validator only: the masterpod is asked `POST /get-anos-account { accountId }`
(`src/masterpod/masterpod.client.js`, 5-second timeout) and the submission
passes only on a `200` with a 32-byte `anopodId` and `vouched` true.
Anything else refuses it with `400 { error: "bad request" }` and no log
line.

Validator to validator: the five existing endpoints, plus
`/attachment-approval` and `/proof-of-attachment-acceptance` (section 9).

## 9. Validator-to-validator messages

The transaction messages are unchanged: `transactionApproval` answered by
`transactionApproved`, `proofOfTransactionAcceptance` answered by
`transactionAccepted`, and the three leader calls. The receiver of a
transaction approval picks the checks by `payload.transaction.payload.
transactionType`, now one of eight kinds, and stores the transaction in the
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
how far a proposal's `createdAt` may be from the validator's clock.

Added 2026-10-25 for the wallet, both optional, read through
`optionalInteger` and a default like the masterpod's, so the five env files
need no edit:

| Variable                   | Default                 | Meaning |
| -------------------------- | ----------------------- | ------- |
| `MASTERPOD_URL`            | `http://localhost:3100` | where `/get-anos-account` is asked (the binding check) |
| `TIMESTAMP_WINDOW_SECONDS` | `120`                   | the window of a signed account-level request, each way; nonces live twice this long |

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
| POST | `/list-assisted-transfers` | body `{}`; `200 { transfers: [ { transactionId, accountId, accountIdTo, amount, createdAt, attestorIds } ] }` |
| POST | `/list-disputed-escrows` | body `{}`; `200 { escrows: [ { transactionId, accountId, accountIdTo, amount, createdAt, disputedBy, verdicts: [ { arbitratorId, verdict, approved } ] } ] }` |

`/list-assisted-transfers`: every `assisted_transfers` row on this
validator with `approved`, `cancellation IS NULL` and an empty attestation
slot (`attestation_1 IS NULL OR attestation_2 IS NULL`): the trades waiting
for attestors. `accountId`, `accountIdTo`, `amount` and `createdAt` are
read from `og_transaction.payload`; `attestorIds` lists
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
