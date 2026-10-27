# anossoftware

An Express 5 server backed by PostgreSQL. One running process is one
validator. Built to run on a Google Compute Engine VM alongside a local
PostgreSQL instance on the same machine; locally, five validators run on one
machine against five databases in one PostgreSQL.

## Requirements

- Node.js 22 or newer
- PostgreSQL 17 or newer, running locally

## Getting started

```bash
npm install
cp .env-validator.example .env-validator1   # fill it in; repeat for 2 to 5
npm run db:setup                            # role, databases, tables, validator registry
VALIDATOR=1 npm start                       # one terminal per validator
```

Then open <http://localhost:3001>.

## Scripts

| Command                   | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `VALIDATOR=N npm start`   | Run validator N (loads `.env-validatorN`)                                   |
| `VALIDATOR=N npm run dev` | Same, restarting on file changes                                            |
| `npm run db:setup`        | Create the role, every validator's database, its tables and the validator registry (idempotent). Pass an env file to do just one. |
| `npm run db:reset`        | Drop those databases and run setup again. Local data is lost; use after a schema change. |

## Configuration

Each validator has one env file, `.env-validatorN`, holding everything that
process needs. `npm start` loads it with `node --env-file`, and
`src/config/env.js` reads the variables once at boot.

| Variable                   | Default     | Description                                                   |
| -------------------------- | ----------- | ------------------------------------------------------------- |
| `PORT`                     | `3000`      | Port the server listens on (3001 to 3005 locally)             |
| `PGHOST`                   | `127.0.0.1` | PostgreSQL host                                               |
| `PGPORT`                   | `5432`      | PostgreSQL port                                               |
| `PGDATABASE`               | required    | Database name (`anos1` to `anos5` locally, `anos` on a VM)    |
| `PGUSER`                   | required    | Application role                                              |
| `PGPASSWORD`               | required    | Application role's password                                   |
| `VALIDATOR_ID`             | required    | 1 to 5; this validator's row in the `validators` table        |
| `PUBLIC_KEY`               | required    | P-256 public key, 33-byte compressed point, lowercase hex     |
| `PRIVATE_KEY`              | required    | P-256 private key, PKCS#8 DER, lowercase hex                  |
| `GUARDED_LOCK_MINUTES`     | required    | Time lock on a guarded account, in minutes: a week (10080) in production, 1 locally |
| `VAULT_LOCK_MINUTES`       | required    | Time lock on a vault account, in minutes: a month (43200) in production, 2 locally |
| `LOCK_OFFSET_MINUTES`      | required    | How much more than its lock a guarded or vault transfer may be dated ahead, and how far a fund proposal's `createdAt` may be from the validator's clock: 10 in production, 1 locally |
| `STAKE_MIN_DAO_VOTE_ANOS`  | required    | Least `transferToFund` for `daoVote`, in whole anos: 10       |
| `STAKE_MIN_MODERATOR_ANOS` | required    | For `moderator`: 1000                                         |
| `STAKE_MIN_ATTESTOR_ANOS`  | required    | For `attestor`: 1000; also the stake an attestor or arbitrator must hold |
| `STAKE_MIN_GUARDIAN_ANOS`  | required    | For `guardian`: 1000                                          |
| `STAKE_MIN_VALIDATOR_ANOS` | required    | For `validator`: 50000                                        |
| `STAKE_MIN_MASTER_POD_ANOS`| required    | For `masterPod`: 500000                                       |
| `GUARDIAN_VOTE_ANOS`       | required    | Guardian stake behind one vote on a fund proposal, in whole anos: 1000 |
| `GUARDIAN_VOTE_PERCENT`    | required    | Share of the votes cast a proposal needs to pass: 70          |
| `GUARDIAN_VOTE_MINUTES`    | required    | How long a proposal is open for votes: a week (10080) in production, 1 locally |
| `MASTERPOD_URL`            | `http://localhost:3100` | The masterpod, asked `/get-anos-account` for every create-account submission (the binding check) |
| `TIMESTAMP_WINDOW_SECONDS` | `120`       | Allowed clock difference on a signed account-level request, each way; nonces are kept twice this long |

`env.js` checks all of them at boot: the `PG*` and `PORT` values as before,
`VALIDATOR_ID`, the three lock settings and the nine stake and vote settings
as positive integers, and each key as lowercase hex of the right length. The
last two are optional: the env files need no edit for the local setup. The
amounts in anos are converted to millionths once, as BigInt, under
`env.stakes.minimums` and `env.guardianVote.anosPerVote`. A bad value stops
the process with a message naming the variable. The keys are kept as hex
strings under `env.validator`.

Because the names follow libpq, `psql` connects to a validator's database
with no arguments once its file is loaded:

```bash
set -a && source .env-validator1 && set +a && psql
```

## Running five validators

Each validator is one process with its own file, `.env-validator1` to
`.env-validator5` (git-ignored). They listen on 3001 to 3005 and use
databases `anos1` to `anos5`, all in the one local PostgreSQL under the same
role. Start each in its own terminal:

```bash
VALIDATOR=1 npm start
```

Public keys use the same formats as the web app's account keys, so the same
verification code serves both. Every validator knows every other one through
the `validators` table in its own database, not through its env file: the
same rows are seeded into all five databases from `db/validators.sql`.

## Database

The whole schema is one file, `db/schema.sql`: the tables, the
`set_updated_at()` trigger function, the triggers and the column comments.
`db/validators.sql` seeds the validator registry. `npm run db:setup` applies
both to every validator's database and is safe to re-run: it adds the tables
that are missing and replaces the functions and triggers, but it never
alters a table that already exists. After changing an existing table
locally, run `npm run db:reset` to drop the databases and build them again.

Tables:

- `accounts`: one row per wallet account.
- `garlic_chain`: one row per transaction on the chain, holding the signed
  transaction object whole in `og_transaction`. `position` numbers the rows
  in the order they were written; the highest is the chain's tail, and the
  highest for an account is that account's newest transaction.
- `pending`: transactions received but not yet on the chain, one per account.
- `locked_transactions`: guarded and vault transfers waiting out their time
  lock, one per account, with `future_date`, the moment each may be written.
- `assisted_transfers`: transfers out of assisted accounts waiting for two
  attestations, one per account, with slots for the two attestations and the
  sender's cancellation.
- `escrow_transfers`: escrow transfers waiting for the seller's success
  signature, the buyer's cancel or an arbitrated verdict, one per seller,
  with `account_id_to` the buyer and slots for the three signatures.
- `escrow_arbitrations`: one row per arbitrator's verdict on a disputed
  escrow.
- `fund_proposals`: fund proposals open for guardian votes, one at a time,
  with `vote_closes_at` and the proposer's weight.
- `guardian_votes`: one row per guardian's vote on a proposal.
- `stakes`: per account, the amount staked with the fund for each of the six
  purposes.
- `logs` and `archives`: where rows go when they leave `assisted_transfers`,
  `escrow_transfers` or `fund_proposals`, with the whole row and its child
  rows as one JSON record.
- `validators`: the registry of validators, this one included: `id`,
  `public_key`, `url` and `active`. Rows are never deleted; a validator that
  leaves is set `active = false` so its old signatures can still be verified.
- `nonces`: the replay cache of signed account-level requests (the reads),
  the keyholder's table as it is: `nonce` and `expires_at`, swept by the
  next insert. Added after the others were in use, so `npm run db:setup`
  adds it to an existing database without a reset.

The five tables `pending`, `locked_transactions`, `assisted_transfers`,
`escrow_transfers` and `fund_proposals` are the **holding tables**: a
transaction waits in one of them until a leader round writes it. They share
a shape: `transaction_id` is the primary key, `account_id` is unique (one
outstanding transaction per account), `og_transaction` holds the submission
as received, and `approved` turns true once every validator accepted it. A
submission whose transaction id or account id is found in any holding table
or on the chain is refused. `src/held-transactions/held-transactions.js` is
the registry of the five, so one code path stores, finds and approves in all
of them.

Conventions used in the schema:

- Lowercase `snake_case` for every identifier. PostgreSQL folds unquoted
  names to lowercase, so anything else would need quoting forever.
- Plural table names (`accounts`).
- Hashes and public keys are stored as `BYTEA` (raw bytes), with `CHECK`
  constraints on fixed-length values. Encode to hex or base64 at the API edge.
- Money is `BIGINT` in millionths of a unit (6 implied decimals), never floats.
- Every table has `created_at` and `updated_at` (`TIMESTAMPTZ`), except
  `logs` and `archives`, whose rows never change and have `created_at` only.
  A shared `set_updated_at()` trigger keeps `updated_at` current on real
  changes.
- No foreign keys anywhere.

## Endpoints

Paths are lowercase kebab-case (`/create-account`), the usual convention for
multi-word URL segments.

| Method | Path              | Response                                                 |
| ------ | ----------------- | -------------------------------------------------------- |
| GET    | `/`               | `Hello, World!`                                          |
| GET    | `/health`         | `200` with `db.status: "ok"`, or `503` if the DB is down |
| POST   | `/create-account` | `202` + `{ transactionId }` once verified, stored in `pending` and sent round, else `400` + reason |
| POST   | `/anos-transfer`  | `202` + `{ transactionId }` once verified, stored in its holding table (`pending` for a plain transfer, `locked_transactions` for a guarded or vault one, `assisted_transfers` for an assisted one, `escrow_transfers` for an escrow) and sent round, else `400` + reason |
| POST   | `/transfer-to-fund` | A stake: `202` + `{ transactionId }` once verified, stored in `pending` and sent round, else `400` + reason |
| POST   | `/fund-proposal`  | `202` + `{ transactionId }` once verified, stored in `fund_proposals` and sent round, else `400` + reason |
| POST   | `/attestation`    | An attestor's attestation to an assisted transfer: `202` + `{ transactionId }` (the transfer's) once stored and sent round, else `400` + reason |
| POST   | `/assisted-transfer-cancel` | The sender's cancellation of an assisted transfer, answered the same way |
| POST   | `/guardian-vote`  | A guardian's vote on a fund proposal, answered the same way |
| POST   | `/escrow-signature` | The seller's success, the buyer's cancel, either side's dispute or an arbitrator's verdict on an escrow, by `payload.type`, answered the same way |
| POST   | `/get-account`    | Account level (next section). The signer's `type`, `balance` (millionths, a decimal string), `latestTransactionId` and `createdAt`: `200`, else `400` or `401` + reason |
| POST   | `/list-transactions` | Account level. The signer's garlic chain links, newest first, paged with `beforePosition` and `limit`, and its pending transaction: `200`, else `400` or `401` + reason |
| POST   | `/list-assisted-transfers` | Attestor level (account level plus attestor stake). The assisted transfers waiting for attestors on this validator, newest first: `200 { transfers }`, else `400`, `401` or `403 not an attestor` + reason |
| POST   | `/list-disputed-escrows` | Attestor level. The escrows in dispute that no verdict has decided on this validator, newest first: `200 { escrows }`, else `400`, `401` or `403 not an attestor` + reason |
| POST   | `/transaction-approval` | Validator to validator. `200` + a transaction approved receipt once the transaction checks out and is stored, else `400` + reason |
| POST   | `/proof-of-acceptance` | Validator to validator. `200` + a transaction accepted receipt once the proof checks out and the transaction is marked approved here, else `400` + reason |
| POST   | `/attachment-approval` | Validator to validator. `200` + an attachment approved receipt once the follow-up checks out and is stored, else `400` + reason |
| POST   | `/proof-of-attachment-acceptance` | Validator to validator. `200` + an attachment accepted receipt once the proof checks out and the follow-up is marked approved here, else `400` + reason |
| POST   | `/ready-announcement`, `/official-list`, `/final-declaration` | Validator to validator: the leader round |

Every public `202` is still the placeholder for the wallet's final answer,
whatever the validators said.

## The account level and the reads

A fourth kind of caller, beside wallets submitting transactions, the other
validators and nobody: an account signing with pair one, for reads about
itself (`src/auth/require-account.js`, `src/reads/`). The envelope is the
masterpod's and the keyholder's, with `accountId` as the signer field:

```json
{
  "payload": {
    "accountId": "<hex 32 bytes>",
    "path":      "/get-account",
    "timestamp": "2026-10-25T18:00:00.000Z",
    "nonce":     "<hex 16 to 32 bytes>",
    "body":      {}
  },
  "signatures": { "ecdsa": "<hex 64>", "mldsa": "<hex 4627>" }
}
```

Both signatures are over the RFC 8785 canonical bytes of `payload`: `ecdsa`
by `key1` (64 bytes r||s over the SHA-256), `mldsa` by `postQuantumKey1`
(pure ML-DSA-87). The checks, in order, stopping at the first failure:

1. the shape, every field a string and `body` an object: `400 bad request
   shape`;
2. `payload.path` is the route: `401 path mismatch`;
3. the timestamp within `TIMESTAMP_WINDOW_SECONDS` of now, either way: `401
   timestamp outside window`;
4. `accountId` decodes to 32 bytes (`400 invalid accountId`), has an
   `accounts` row (`401 unknown account`), and both signatures verify
   against its `public_key1` and `public_key_pq1` (`401 bad signature`);
5. the nonce is 16 to 32 bytes (`400 invalid nonce`) and new in `nonces`
   (`401 replay`); it is kept twice the window;
6. the handler gets the account id as `req.account` and `payload.body` as
   `req.body`.

The two routes answer the signer's own account only:

- `POST /get-account`, body `{}`: `200 { accountId, type, balance,
  latestTransactionId, createdAt }`. `balance` is millionths as a decimal
  string; `latestTransactionId` is the `transaction_id` of the garlic chain
  link with the highest `position` whose `account_id` is the signer, what the
  next transfer names as `previousTransactionId`, or `null`.
- `POST /list-transactions`, body `{ beforePosition?, limit? }` (`limit` 1
  to 200, default 50): `200 { transactions, pending }`. `transactions` are
  the links where `account_id` or `account_id_to` is the signer, `position`
  descending, below `beforePosition` when given, each `{ transactionId,
  position, type, accountId, accountIdTo, amount, createdAt }`. `pending` is
  the signer's pending row, at most one, read from `og_transaction.payload`:
  `{ transactionId, type, accountId, accountIdTo, amount, createdAt,
  approved }`. The other holding tables are not listed; a guarded or vault
  transfer shows up when it lands. Bad values are `400 invalid
  beforePosition` and `400 invalid limit`.

Refusals are logged `failed: <reason>` like every other route.

The attestor reads (added 2026-10-26, `docs/schemas.md` section 13) use the
same envelope, signed with pair one, through the same six checks, then a
seventh: the signer's `stakes.attestor_stake` is at or above
`STAKE_MIN_ATTESTOR_ANOS`, else `403 not an attestor`
(`src/auth/require-attestor.js`: `requireAttestor = [requireAccount,
mustHoldAttestorStake]`, the rule the attestation and verdict follow-ups
apply to their signer). Unlike the two reads above they answer about other
people's held transactions, the same list to every attestor:

- `POST /list-assisted-transfers`, body `{}`: `200 { transfers }`, every
  `assisted_transfers` row on this validator that is approved, has no
  cancellation and has an attestation slot still empty, newest first, each
  `{ transactionId, accountId, accountIdTo, amount, createdAt, attestorIds }`.
  The four transfer fields are read from `og_transaction.payload`;
  `attestorIds` lists the `attestorId` of each attestation present, slot
  order, so a second attestor sees who signed first.
- `POST /list-disputed-escrows`, body `{}`: `200 { escrows }`, every
  `escrow_transfers` row that is approved, whose dispute signature is
  approved and that no verdict has decided (no value of `verdict` with two
  approved `escrow_arbitrations` rows), newest first, each `{ transactionId,
  accountId, accountIdTo, amount, createdAt, disputedBy, verdicts: [ {
  arbitratorId, verdict, approved } ] }`. `disputedBy` is the signer of the
  dispute; `verdicts` are the escrow's arbitrations in arbitrator order,
  `approved` as stored.

No paging: the holding tables are small. Nothing else about a row is
answered; the attestor's app turns account ids into people through the
masterpod.

## Create-account submission

`POST /create-account` takes `{ payload, signatures }`:

- `payload` is the signed part: `accountId`, `accountType`, `createdAt` (ISO 8601
  string), `transactionId`, and `publicKeys`, an object holding the eight keys
  listed in `src/accounts/account-keys.js`, in that order.
- `signatures` has the same eight names. Each is that key's signature over the
  RFC 8785 canonical bytes of `payload` (next section).
- `accountId` is the SHA-256 of `key1` + `postQuantumKey1`: the two lowercase
  hex key strings exactly as sent, joined with nothing between them, hashed as
  UTF-8 bytes, written as lowercase hex.
- `transactionId` is the same over all eight public key strings, joined in the
  order above.
- `accountType` is one of `spending`, `guarded`, `vault` or `assisted`. It is
  stored as the account's type and decides how the account may spend (next
  section).

Formats the web app must match:

| Keys                                         | Algorithm                      | Public key                                | Signature                                   |
| -------------------------------------------- | ------------------------------ | ----------------------------------------- | ------------------------------------------- |
| `key1`, `key2`, `breakGlassKey`, `walletKey` | ECDSA P-256 over SHA-256       | 33 raw bytes, compressed SEC1 (65 uncompressed also accepted) | 64 bytes r\|\|s (DER also accepted) |
| the four `...PostQuantum...` keys            | ML-DSA-87, pure, empty context | 2592 raw bytes                            | 4627 bytes                                  |

The web app sends every byte string as lowercase hex. The server also accepts
base64 (either alphabet, padding optional): the expected byte length tells the
two apart, so nothing has to say which. Both algorithms are handed the raw
canonical bytes; ECDSA hashes them with SHA-256 internally, ML-DSA-87 absorbs
them directly. Nothing is pre-hashed on either side.

What the server checks today, in order: the shape, `accountType` included;
that all eight signatures
verify; that `accountId` and `transactionId` are the hashes described above
(hash and id strings may be hex in either case or base64, compared as bytes);
and that nothing with these ids exists yet: no account with this `accountId`,
no pending transaction with this `transactionId` or for this `accountId`, and
no garlic chain transaction with this `transactionId`. The four lookups run as
one query. Then the binding check, on the receiving validator only: it asks
the masterpod `POST MASTERPOD_URL/get-anos-account { accountId }`
(`src/masterpod/masterpod.client.js`, 5-second timeout) and goes on only on a
`200` whose `anopodId` decodes to 32 bytes and whose `vouched` is true.
Anything else, a `404`, a timeout, a `5xx`, a bad body, `vouched` false,
refuses the submission with `400 { error: "bad request" }` and writes no log
line: the request is dropped like garbage. The validator-to-validator
approval path trusts the binding, as it does for everything else. The
submission is then stored whole in `pending` with
`approved = false`; the table's primary key and the UNIQUE on `account_id`
are the backstop if two requests race past the checks. The handler logs
`pending: <transactionId>` or `failed: <reason>` and answers `202` or `400`.
Before answering it sends a transaction approval receipt (next section) to
every other active validator, waits for all of them, and checks each answer
as a transaction approved receipt, logging `validator N approved` or
`validator N failed: <reason>` and, when every one approved, `all validators
approve`. In that case it marks its own pending row approved, sends everyone
the proof of acceptance and logs `validator N accepted the proof`. Written as
if nothing can fail: a validator that is down makes the request fail with a
`500`, the pending row already in place, and nothing yet happens when a
validator refuses.

## Account signing rules

Two rules, shared by every transfer kind and every follow-up
(`src/accounts/account-signatures.js`). The keys to verify with come from the
`accounts` table, never from the object itself; a follow-up carries no
public keys at all.

- **any two pairs**: at least two of the three pairs `key1`/`postQuantumKey1`,
  `key2`/`postQuantumKey2` and `walletKey`/`walletPostQuantumKey`, both
  halves of each pair present, every signature present verifying against the
  account's stored key.
- **pair one and the wallet pair**: `key1`, `postQuantumKey1`, `walletKey`
  and `walletPostQuantumKey` all present and verifying. A `key2` pair also
  present is checked like any other and accepted. Used by assisted
  transfers only.

## Transfer submission

`POST /anos-transfer` takes `{ payload, signatures }` for a transfer out of
an account, of one of five types:

| `transactionType`      | Sent from          | Waits in              | Signing rule | Until |
| ---------------------- | ------------------ | --------------------- | ------------ | ----- |
| `anosTransfer`         | a spending account | `pending`             | any two pairs | the next leader round |
| `guardedAnosTransfer`  | a guarded account  | `locked_transactions` | any two pairs | `GUARDED_LOCK_MINUTES` (a week) have passed |
| `vaultAnosTransfer`    | a vault account    | `locked_transactions` | any two pairs | `VAULT_LOCK_MINUTES` (a month) have passed |
| `assistedAnosTransfer` | an assisted account | `assisted_transfers` | pair one and the wallet pair | two attestors have attested |
| `escrowTransfer`       | a spending account, the seller | `escrow_transfers` | any two pairs | the seller signs for success, or arbitrators decide |

- `payload` is the signed part: `accountId` (the sender), `transactionId`,
  `previousTransactionId`, `transactionType`, `amount` (millionths of a unit
  as a decimal string), `accountIdTo` and `createdAt` (ISO 8601 string).
- `transactionId` is the SHA-256 of the RFC 8785 canonical JSON of `payload`
  without `transactionId`.
- `previousTransactionId` is the sender's newest transaction on the garlic
  chain: its creation, or its last transfer.
- `signatures` are by the sender's keys as the `accounts` table holds them,
  under the type's signing rule (previous section), each over the canonical
  bytes of `payload`.
- `createdAt` of a guarded or vault transfer is the lock ahead: the validator
  requires it to be at least the lock and at most the lock plus
  `LOCK_OFFSET_MINUTES` ahead of its own clock. The web app dates it the lock
  plus the offset ahead, so a transfer that takes a while to reach a
  validator still passes. The other types' `createdAt` is not checked.

The server checks, in order: the shape and, for a locked transfer, the date;
that the sender exists and is of the type the transfer type is for; the
signatures; `transactionId`; `previousTransactionId`; that `accountIdTo` is a
different account that exists; that nothing with these ids exists yet (no
transaction with this `transactionId` or for this `accountId` in any of the
five holding tables, no garlic chain transaction with this `transactionId`,
one query); and that the balance covers the amount. Then the transfer is
stored whole, with `approved = false`, in its holding table (an escrow
transfer with `account_id_to` the buyer, a locked one with its `createdAt`
as `future_date`), and goes round the other validators exactly as a
create-account submission does: the transaction approval receipt and the
proof of acceptance are the same messages, and each validator stores and
approves it in the same holding table as the originating one.

A held transfer stays in its table until a leader round finds it ready
(section "The leader round"): to the leader round, every holding table is
another pending table. The official list is written as one batch, each
transfer as a garlic chain link with its `transactionType` as the link's
type, and the balance trigger moves the amount for all of them. A transfer
that becomes ready between rounds waits for the next round, which the next
transaction of any kind starts.

## Stakes and transfer to fund

An account takes a role by staking anos with the fund, the genesis account
whose id is the SHA-256 of `anosFund` (`src/genesis/fund-account.json`,
`src/fund/fund-account.js`). `POST /transfer-to-fund` takes a
`transferToFund`: the transfer payload above with `accountIdTo` the fund's id,
`transactionType` `transferToFund` and one more field, `stakeFor`, the
purpose:

| `stakeFor`  | `stakes` column    | Minimum                     | Role today |
| ----------- | ------------------ | --------------------------- | ---------- |
| `daoVote`   | `dao_vote_stake`   | `STAKE_MIN_DAO_VOTE_ANOS`   | recorded only |
| `moderator` | `moderator_stake`  | `STAKE_MIN_MODERATOR_ANOS`  | recorded only |
| `attestor`  | `attestor_stake`   | `STAKE_MIN_ATTESTOR_ANOS`   | attests assisted transfers, arbitrates escrow disputes |
| `guardian`  | `guardian_stake`   | `STAKE_MIN_GUARDIAN_ANOS`   | proposes and votes on fund proposals |
| `validator` | `validator_stake`  | `STAKE_MIN_VALIDATOR_ANOS`  | recorded only; the `validators` table is unchanged |
| `masterPod` | `master_pod_stake` | `STAKE_MIN_MASTER_POD_ANOS` | recorded only |

The sender must be a spending account; the signing rule is any two pairs;
`createdAt` is not checked. On top of the transfer checks: `accountIdTo` is
the fund, `stakeFor` is one of the six, and `amount` is at least the
purpose's minimum. The stake is held in `pending` like a plain transfer and
written at the next round as a link of type `transferToFund`; in the same
database transaction the sender's `stakes` row gets the amount added to the
purpose's column, the row created if the account has none
(`src/stakes/`). Nothing else happens: a role is held while the column is at
or above the minimum, and a fund proposal that returns stake reduces it. The
row is deleted when every amount in it is zero.

Guardian votes: one vote per `GUARDIAN_VOTE_ANOS` of guardian stake, rounded
down. An account with at least one vote may propose and vote.

## Follow-ups

A follow-up is a signed object attached to a transaction that is waiting in
a holding table: an attestation, a cancellation, a vote, an escrow signature
or a verdict. Every one is `{ payload, signatures }`:

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

The checks every kind runs, in order (`src/attachments/attachments.service.js`):
the shape; the held row exists in the kind's table and is approved on this
validator; the signer's account exists and holds the stake the kind
requires, if any; the signatures verify against that account's keys; the
kind's own checks; a place to store it. Then the object is stored whole,
`approved = false`, and goes round the validators with the attachment
messages (section "Validator-to-validator messages"): the originating
validator marks it approved once every peer answered, sends the proof, and
each peer marks its copy approved. When a validator marks a follow-up
approved it applies the kind's effect, if the kind has one, and the handler
starts a leader round, since the follow-up may have completed a transfer.
The signer's answer is `202` + `{ transactionId }` once stored on the
validator called, or `400` + `{ error }`.

A slot or row is **present** once stored, approved or not, and present
blocks. Outcomes need **approved**. Surplus and late follow-ups are refused
with `400` and nothing is stored: a third attestation, a second dispute, a
vote after the window, a second vote or verdict from the same account, a
verdict without a dispute, anything for a transaction no longer held.

Validators identify a follow-up by its `attachmentId`, the SHA-256 of its
canonical payload, which they compute; the signer does not send it.

## Assisted transfers and attestations

An `assistedAnosTransfer` (section "Transfer submission") waits in
`assisted_transfers` until two attestors have attested to it. Two follow-ups
attach to it (`src/assisted-transfers/`):

`POST /attestation`, `payload: { type: "attestation", transactionId,
accountId, attestorId, signedAt }`. `accountId` is the transfer's sender and
must equal the row's `account_id`. The signer is `attestorId`, an account
with `attestor_stake` at or above its minimum. Own checks: the attestor is
not the sender, and not the attestor in the other slot. Stored in
`attestation_1` if empty, else `attestation_2` if empty, else refused. No
effect beyond readiness.

`POST /assisted-transfer-cancel`, `payload: { type: "assistedTransferCancel",
transactionId, accountId, signedAt }`. The signer is `accountId`, the
sender. Own check: no cancellation present. Accepted until the transfer is
written, even when both attestations are approved. Stored in
`cancellation`. Effect on acceptance: the row moves to `logs`, outcome
`userCancelled`.

The transfer is ready for a leader round when approved, both attestations
approved, and no cancellation present. After the write the row moves to
`logs` with outcome `written`, attestations included; the attestations are
not written to the chain.

## Escrow

An `escrowTransfer` (section "Transfer submission") is sent by the seller
(`account_id`) to the buyer (`account_id_to`), who pays off-chain. It waits
in `escrow_transfers` until one of four follow-ups at
`POST /escrow-signature`, told apart by `payload.type` (`src/escrow/`):

- `escrowSuccess`, `payload: { type, transactionId, accountId, signedAt }`,
  signed by the seller. Own checks: no dispute, cancel or success signature
  present. Stored in `success_signature`. Approved, it makes the escrow
  ready.
- `escrowCancel`, the same payload signed by the buyer. Own checks: no
  dispute, success or cancel present. Stored in `cancel_signature`. Effect
  on acceptance: the row moves to `logs`, outcome `receiverCancelled`.
- `escrowDispute`, the same payload signed by the seller or the buyer. Own
  checks: no success, cancel or dispute present. Stored in
  `dispute_signature`. From then on only verdicts move the escrow.
- `escrowVerdict`, `payload: { type, transactionId, arbitratorId, verdict,
  signedAt }`, `verdict` `success` or `cancel`, signed by `arbitratorId`, an
  account with `attestor_stake` at or above its minimum. Own checks: the
  dispute signature is approved; the arbitrator is neither party; no row
  from this arbitrator yet. Stored as an `escrow_arbitrations` row. The
  first verdict to have two approved rows decides the escrow: two approved
  `cancel` verdicts move the row and its arbitrations to `archives`,
  outcome `arbitratedCancel`; two approved `success` verdicts make the
  escrow ready.

Between success and cancel the first stored wins, since each blocks the
other. The escrow is ready for a leader round when approved, no cancel
signature present, and either the success signature is approved or the
dispute signature is approved with two approved `success` verdicts. After
the write the row moves to `logs`, outcome `written`, when there was no
dispute, or to `archives`, outcome `arbitratedSuccess`, with its
arbitrations, when there was.

## Fund proposals and votes

A `fundProposal` is a guardian's list of payments from the fund, submitted
at `POST /fund-proposal`, voted on by the guardians for
`GUARDIAN_VOTE_MINUTES`, then written or dropped (`src/fund/`). It is a
transaction like any other: its id is its `transactionId`, so every receipt
and table treats it as one.

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
sent round like every transaction.

`POST /guardian-vote`, `payload: { type: "guardianVote", transactionId,
guardianId, vote, signedAt }`, `vote` `for` or `against`, signed by
`guardianId`, an account with at least one vote. Own checks: now is before
`vote_closes_at`; the guardian is not the proposer, whose vote for is
already counted; no row from this guardian yet. Stored as a `guardian_votes`
row with the guardian's weight at this moment. No effect on acceptance; the
tally happens in the round.

The tally, when a round finds the vote closed: `for = proposer_weight +
sum(weight)` over approved `for` votes; `against = sum(weight)` over
approved `against` votes; the proposal passes when
`for * 100 >= GUARDIAN_VOTE_PERCENT * (for + against)`. Guardians who did
not vote count for nothing. A closed proposal that fails is moved to
`archives`, outcome `voteFailed`, with its votes, by the validator that
finds it while building its ready list, and nothing is written.

A proposal that passes is written as one proposal link followed by one
payout link per payout, in index order, in the round's batch:

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
`archives`, outcome `written`.

## The leader round

Unchanged in shape: ready announcement, every validator's ready list, the
official list as the ids every list holds, the write, the final
declaration. Each validator's ready list, in id order:

| Table                 | Ready when |
| --------------------- | ---------- |
| `pending`             | approved |
| `locked_transactions` | approved, `future_date <= now()` |
| `assisted_transfers`  | approved, `attestation_1_approved`, `attestation_2_approved`, `cancellation IS NULL` |
| `escrow_transfers`    | approved, `cancel_signature IS NULL`, and `success_signature_approved` or (`dispute_signature_approved` and at least two approved `success` verdicts) |
| `fund_proposals`      | approved, `vote_closes_at <= now()`, and the tally passes |

The write, one database transaction per validator, rows in id order
(`src/accounts/accounts.service.js` `writeTransactions`): an
`accountCreation` as before; a transfer of any of the five types as one link
with the balance trigger; a `transferToFund` as one link, the balance
trigger and the stake added; a `fundProposal` as the proposal link, then the
payout links in index order, the balance trigger for each and the stakes
reduced for payouts with `stakeFor`. `record_hash` chains over every link
written, in `position` order: each link hashes its `trans_hash` with the
`record_hash` of the link written just before it, and the next batch starts
from the link with the highest `position`.

After the batch: `pending` and `locked_transactions` rows are deleted;
`assisted_transfers` rows move to `logs`, outcome `written`;
`escrow_transfers` rows move to `logs`, outcome `written`, or to `archives`,
outcome `arbitratedSuccess`, when a dispute signature is present;
`fund_proposals` rows move to `archives`, outcome `written`, with their
votes.

No timer anywhere: a locked transfer, a closed vote or a completed escrow
waits for the next round, which the next transaction or follow-up of any
kind starts.

## Logs and archives

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

Each move is one database transaction (`src/records/records.queries.js`):
the insert into `logs` or `archives` of the row and its children as one JSON
record (`{ row }`, `{ row, arbitrations }` or `{ row, votes }`, every value
the database row as `to_jsonb` gives it), then their deletion. Every
validator does every move for itself, at the same logical moment, so the
copies stay identical. Nothing from `pending` or `locked_transactions` is
logged: the chain holds everything they had.

Logs may be purged after a time; how that runs is not decided yet. The
statement is:

```sql
DELETE FROM logs WHERE created_at < now() - interval '1 month';
```

Archives are never purged.

## Validator-to-validator messages

Validators talk to each other over the same HTTP server, one endpoint per
message type. Every message is `{ payload, signature }`: the payload is
signed as its RFC 8785 canonical bytes, exactly like an account payload, by
the sending validator's P-256 key, `signature.key` (64-byte r||s, hex).
Validators have no post-quantum key; only accounts do. The receiver looks
the sender up by id in its own `validators` table and checks the signature
against that row's key; keys inside a message are never used. The reply to
a call carries the answering message, so answers are not endpoints of their
own.

`POST /transaction-approval`, the transaction approval receipt:

```
payload: {
  transaction:          the whole submission, as received
  type:                 "transactionApproval"
  originatingValidator: the sender's validator id (integer)
  transactionId:        the transaction's id, as the submitter sent it
  sentAt:               ISO 8601 timestamp
}
signature: { key }
```

The receiver checks the shape; that `originatingValidator` is an active
validator and the signature verifies against its key; that the embedded
transaction passes every check the originating validator ran, against the
receiver's own database, picked by `payload.transaction.payload.
transactionType`, now one of eight kinds (`accountCreation`, the five
transfer types, `transferToFund`, `fundProposal`); and that `transactionId`
is the transaction's own. Then it stores the transaction in its own copy of
the same holding table the originating validator used, `approved = false`,
logs `correct`, and answers `200` with a transaction approved receipt. On
any failure it logs `failed: <reason>` and answers `400`.

The transaction approved receipt, the body of that `200`:

```
payload: {
  transactionId: the id of the transaction being approved
  type:          "transactionApproved"
  validatorFrom: the id of the validator that was called
  validatorTo:   the id of the originating validator
  sentAt:        ISO 8601 timestamp
}
signature: { key }
```

The originating validator checks each answer: a `200` with a body of this
shape, the signature valid for the validator it called, `validatorFrom`
that validator, `validatorTo` itself, and `transactionId` the transaction it
is working on.

`POST /proof-of-acceptance`, the proof of transaction acceptance, sent once
every validator approved and the originating validator has marked its own
row approved:

```
payload: {
  transactionId:        the transaction being accepted
  type:                 "proofOfTransactionAcceptance"
  originatingValidator: the originating validator's id
  sentAt:               ISO 8601 timestamp
  receipts:             [ { payload, signature }, ... ]  the approved receipts, untouched, by validator id
}
signature: { key }
```

The receiver checks the shape; the originating validator's signature; that
it holds the transaction in one of the five holding tables and has not
approved it yet; each receipt (an active validator other than the
originating one, genuinely signed, addressed to the originating validator,
for this transaction, no validator twice); and that no active validator is
missing, per its own registry. Then it marks its row approved, in whichever
table holds it, logs `approved: <id>` and answers `200` with a transaction
accepted receipt.

The transaction accepted receipt, the body of that `200`, has the schema of
the transaction approved receipt with its own `type`:

```
payload: {
  transactionId: the id of the transaction accepted
  type:          "transactionAccepted"
  validatorFrom: the id of the validator the proof was sent to
  validatorTo:   the id of the originating validator
  sentAt:        ISO 8601 timestamp
}
signature: { key }
```

The originating validator checks each answer as it does an approved receipt:
a `200` with a body of this shape, the signature valid for the validator it
called, `validatorFrom` that validator, `validatorTo` itself, and
`transactionId` the transaction it is working on.

Every follow-up goes round with one more pair of messages, whatever its
kind; the receiver picks the checks by `attachment.payload.type`. Each
carries the held transaction's id and the follow-up's `attachmentId`.

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
of the embedded payload; runs the kind's checks against its own database;
stores the follow-up with `approved = false`; logs `correct` and answers
`200` with:

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
it holds this attachment for this transaction unapproved (the holding table
that has the transaction says which kinds to ask, and each kind hashes what
it stored), each receipt (an active validator other than the originating
one, genuinely signed, addressed to the originating validator, for this
transaction and attachment, no validator twice), and that no active
validator is missing. Then it marks the attachment approved, applies the
kind's effect, logs `approved attachment: <id>`, answers `200` with the
attachment accepted receipt (the schema above with `type`
`"attachmentAccepted"`), and starts a leader round.

Both receipts are checked by the originating validator as the transaction
receipts are: a `200`, the shape, the signature against the peer's registry
key, `validatorFrom`, `validatorTo`, `transactionId` and `attachmentId`.

## Canonical JSON and hashing

Objects that arrive hashed and signed were serialised canonically on the
sender's side before hashing. `src/crypto/canonical.js` rebuilds those exact
bytes with the same `canonicalize` npm package the web app uses, an
implementation of RFC 8785 (JSON Canonicalization Scheme): keys sorted by
UTF-16 code unit, no whitespace, ES6 number formatting. Hashes are SHA-256, 32 raw bytes,
matching every hash column in the schema. `verifyCanonicalHash(value, expected)`
takes the expected digest as raw bytes, hex or base64 and compares in constant
time. The same package on both ends means the bytes cannot differ.

## Project layout

Organised by feature. Each feature folder owns its router, handlers, service
and anything else specific to it. Shared infrastructure lives at the top level.

Within a feature, `*.router.js` maps paths to handlers, `*.handlers.js` holds
the handlers (the functions Express calls with `req` and `res`; HTTP in and
out only), and `*.service.js` holds the logic the handlers call. A tiny
feature like `health` may keep its handler inline in the router.

```
src/
  app.js                 builds the app: middleware, feature routers, 404, errors
  server.js              verifies the DB, runs genesis, starts HTTP, handles graceful shutdown
  config/env.js          reads and validates environment variables once
  db/pool.js             shared pg connection pool
  middleware/            cross-cutting middleware, one per file
  util/is-object.js      the one helper the shape checks share
  util/submission-response.js  how a handler logs and answers a submission (202 / 400)
  util/result.js         ok / refuse / answer, the shape the account level and the reads use (the keyholder's)
  auth/                  the account level: require-account.js, signed-request.js, common-checks.js, nonces.queries.js;
                         the attestor gate on top of it: require-attestor.js
  masterpod/masterpod.client.js  the one call to the masterpod: /get-anos-account, the binding check
  reads/                 feature: the two signed reads (get-account, list-transactions) and the two attestor reads
                         (list-assisted-transfers, list-disputed-escrows)
    reads.router.js, reads.handlers.js, reads.service.js, reads.queries.js
  crypto/hash.js         SHA-256, digest decoding and constant-time comparison
  crypto/canonical.js    canonical JSON (canonicalize package) and its hash
  crypto/bytes.js        hex / base64 decoding with byte-length checks
  crypto/signatures.js   ECDSA P-256 signing and verification, ML-DSA-87 verification
  accounts/              feature: accounts (create-account)
    account-keys.js      the eight account keys, in order, with algorithms
    account-types.js     the four account types a submission may ask for
    account-signatures.js  the signing pairs and the two signing rules every transfer and follow-up uses
    accounts.router.js   maps paths to handlers
    accounts.handlers.js one function per route; HTTP in and out only
    accounts.service.js  validates a create-account submission; writes the official list (writeApproved)
    accounts.queries.js  the feature's SQL
  genesis/               the first two accounts, written once per database at boot
    genesis.service.js, genesis.queries.js, fund-account.json, og-account.json
  pending/               feature: the pending table
    pending.queries.js   insert, look up and approve pending rows
  locked-transactions/   feature: the locked_transactions table, pending's twin for guarded and vault transfers
    locked-transactions.queries.js  insert, look up, approve, list due and delete locked rows
  held-transactions/     the registry of the five holding tables
    held-transactions.js one entry per table (insert, find, markApproved, findApproved, conflictReasons); findHeld
  transfer/              feature: transfers (anos-transfer), all five types
    transfer.router.js   maps paths to handlers
    transfer.handlers.js one function per route; HTTP in and out only
    transfer.service.js  validates a transfer, holds it in its holding table, writes its link
    transfer.queries.js  the feature's SQL
  stakes/                feature: the stakes table and the roles it gives
    stake-purposes.js    the six purposes, each with its column and minimum
    stakes.queries.js    findStake, addStake, subtractStake
    stakes.service.js    holdsRole, guardianWeight
  fund/                  feature: the fund (transfer-to-fund, fund-proposal, guardian-vote)
    fund-account.js      the fund's account id
    fund.router.js, fund.handlers.js
    fund.service.js      verifies, receives and writes transfers to the fund and fund proposals; the tally
    fund.queries.js      the fund_proposals and guardian_votes SQL
    guardian-vote.js     the guardianVote follow-up kind
  assisted-transfers/    feature: the assisted_transfers table and its follow-ups
    assisted-transfers.router.js  /attestation, /assisted-transfer-cancel
    assisted-transfers.queries.js the table's SQL, slots included
    attestation.js, assisted-transfer-cancel.js  the two follow-up kinds
  escrow/                feature: the escrow_transfers and escrow_arbitrations tables and their follow-ups
    escrow.router.js     /escrow-signature
    escrow.queries.js    both tables' SQL
    escrow-signature-kind.js  what the three escrow signatures share
    escrow-success.js, escrow-cancel.js, escrow-dispute.js, escrow-verdict.js  the four follow-up kinds
  attachments/           the flow every follow-up shares
    attachments.service.js  receiveAttachment; the peers' side of the attachment messages
    attachments.handlers.js the handler every follow-up endpoint is built from
    stored-attachments.js   finding a stored follow-up by its attachmentId
  records/               logs and archives
    records.queries.js   moveToLogs, moveToArchives
  validators/            feature: the validator registry and validator-to-validator messages
    validators.queries.js  active peers; one validator with its keys; the leader
    validators.client.js   POST one message to each peer, in parallel
    validators.signing.js  sign a payload with own key; verify one with a peer's
    validators.messages.js build and sign each message type; send calls, check answers
    validators.service.js  receive and check each message type; the leader round
    validators.handlers.js HTTP in and out
    validators.router.js   the validator-to-validator endpoints
  health/                feature: liveness + database check
    health.router.js
    health.service.js
db/
  schema.sql             the whole schema, built from nothing
  validators.sql         the validator registry rows
docs/
  schemas.md             the specification of assisted accounts, stakes, the fund and escrow
  build-plan.md          how it was built, step by step
scripts/
  setup-db.sh            role, databases, schema and registry for each env file
  reset-db.sh            drop those databases and set them up again
  find-psql.sh           locates psql for the other two scripts
```

## PostgreSQL on the Compute Engine VM

The VM runs PostgreSQL from the Debian/Ubuntu packages (or the official PGDG
repository for the newest major version). Its defaults already match what this
app expects: it listens on `127.0.0.1:5432`, the `postgres` OS user is a
superuser over the unix socket, and TCP connections require a password
(`scram-sha-256`).

One VM is one validator, so it has one env file, named after its id:

```bash
sudo apt install postgresql
cp .env-validator.example .env-validator1   # PGDATABASE=anos, a strong PGPASSWORD, this VM's keys
sudo -u postgres sh scripts/setup-db.sh .env-validator1
VALIDATOR=1 npm start
```

`db/validators.sql` ships with the local development keys and `127.0.0.1`
urls. A testnet needs its own copy of that file with the real validators'
public keys and hosts before `db:setup` runs there.

Locally, Homebrew's PostgreSQL uses `trust` auth on localhost, so the password
is not checked there. The connection settings are otherwise identical.
