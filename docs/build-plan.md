# Build plan: assisted accounts, stakes, the fund and escrow

For a fresh chat. The specification is `docs/schemas.md`; this file says in
what order to build it, which files each step touches, and how to verify it.
The design was settled with the user on 2026-10-23 over about fifty
questions; the answers are all folded into `schemas.md`, so nothing here
needs the old conversation.

## Before starting

Read, in this order: `CLAUDE.md`, `README.md`, `docs/schemas.md`, this
file, then the code under `src/` (it is small; `transfer.service.js`,
`validators.service.js`, `validators.messages.js` and
`accounts.service.js` carry the patterns everything below copies).

House rules, from the user:

- The user commits. Never commit. End the work with the list of changed and
  new files, what changed in each, and a suggested commit message per step
  below, so the user can commit step by step.
- No test suites, fixtures or smoke scripts in the repo. Verify on a
  throwaway rig (step 10) with scripts kept in the scratchpad, then the user
  tests by hand through the web app.
- The spec is the spec. The changes to existing code are listed under
  "Approved changes" below; anything else in existing code gets a one-line
  question first. New files are free.
- Node comes from nvm: `source ~/.nvm/nvm.sh` before `node` or `npm` in a
  shell. PostgreSQL is Homebrew's `postgresql@17`; `scripts/find-psql.sh`
  locates `psql`.
- The five local env files `.env-validator1` to `5` are git-ignored; new
  variables go into all five and into `.env-validator.example`, with the
  example carrying production values.
- `npm run db:setup` adds new tables and replaces functions and triggers on
  the live databases `anos1` to `anos5` without a reset. Nothing here alters
  an existing table, so no reset and no ALTER is needed.
- The user's own five validators run on ports 3001 to 3005 from the
  committed code; do not start or stop them. The rig uses its own ports and
  databases.
- Build straight through, all steps, then report. Keep the step boundaries
  visible in the report so the diff reads step by step.

## Approved changes to existing code

Everything else in `src/` stays as it is.

1. `db/schema.sql`: the eight new tables; the balance trigger's `WHEN` list
   and its `RAISE` messages; the `locked_transactions` comments.
2. `src/config/env.js`: the nine new variables.
3. `src/transfer/transfer.service.js`: the signature-pairs loop moves out
   into the shared helper and is called from there; `TRANSFER_TYPES` gains
   `assistedAnosTransfer` and `escrowTransfer`, each entry now also naming
   its holding table and its signing rule; `verifyAnosTransfer` returns
   `heldIn` (the table) alongside the existing fields; `receiveAnosTransfer`
   stores by `heldIn` through the holding-tables registry instead of the
   `locked` boolean; the shape message names five types.
4. `src/transfer/transfer.queries.js`: `findExisting` also looks in
   `assisted_transfers`, `escrow_transfers` and `fund_proposals`.
5. `src/validators/validators.service.js`: `verifyTransaction` dispatches
   the four new kinds; `receiveTransactionApproval` stores by `heldIn`;
   `receiveProofOfAcceptance` finds and marks the transaction through the
   registry; `findReadyIds` covers the five tables and runs the tally and
   the `voteFailed` sweep; the two new receive functions for the attachment
   round, or their import from the attachments feature.
6. `src/validators/validators.messages.js`: the four attachment message
   builders and checkers (copies of the transaction ones, with
   `attachmentId`). `validators.router.js` and `validators.handlers.js`:
   the two new endpoints, the proof handler calling `runLeader()`.
7. `src/accounts/accounts.service.js`: `writeTransactions` dispatches the
   new kinds; `writeApproved` reads approved rows from all five tables and,
   after the batch, deletes or moves each table's rows as section 6 of the
   spec says.
8. `src/accounts/account-types.js`: the comment saying assisted is unbuilt.
9. `src/app.js`: mounts the new routers.
10. `README.md`, `.env-validator.example` and the five env files.

## Steps

### 1. Schema

`db/schema.sql`, after `locked_transactions` and before `validators`, in
this order: `stakes`, `assisted_transfers`, `escrow_transfers`,
`escrow_arbitrations`, `fund_proposals`, `guardian_votes`, `logs`,
`archives`. Each with its header comment, `set_updated_at` trigger (not on
`logs` and `archives`) and `COMMENT ON` lines, in the style of the existing
tables. The balance trigger's `WHEN` list and messages. The two
`locked_transactions` comments. Then `npm run db:setup` and check `\d` in
`anos1`.

Suggested commit: `assisted, stakes, fund, escrow: schema`.

### 2. Configuration

`src/config/env.js`: `env.stakes.minimums` (the six, converted from anos to
millionths once, as BigInt), `env.guardianVote.{anosPerVote, percent,
minutes}`. The nine variables in `.env-validator.example` with production
values and in `.env-validator1` to `5` with the local values of spec
section 10. README: the Configuration table.

Suggested commit: `stake and guardian vote settings`.

### 3. Shared building blocks

All new files.

- `src/accounts/account-signatures.js`: `verifyAccountSignatures(account,
  signatures, message, rule)` lifted from `verifyAnosTransfer`, returning
  `null` or a reason; the two rules `ANY_TWO_PAIRS` and
  `PAIR_ONE_AND_WALLET`; the `SIGNING_PAIRS` table moves here. The account
  row shape is the one `transfer.queries.js` `findAccount` returns.
- `src/stakes/stake-purposes.js`: the six purposes, each with its column
  and its minimum from `env`; `isPurpose`, `columnFor`. `stakes.queries.js`:
  `findStake(accountId)`, `addStake(client, accountId, purpose, amount)`
  (insert or add), `subtractStake(client, accountId, purpose, amount)`
  (subtract, then delete the row when all six are zero). `stakes.service.js`:
  `holdsRole(stake, purpose)`, `guardianWeight(stake)`.
- `src/fund/fund-account.js`: the fund's account id, read from
  `src/genesis/fund-account.json`.
- `src/held-transactions/held-transactions.js`: the registry of the five
  holding tables, each entry with `insert`, `find`, `markApproved`,
  `findApproved`, `conflictReasons`, built from the existing
  `pending.queries.js` and `locked-transactions.queries.js` and the three new
  query modules below; `findHeld(transactionId)` across all five, returning
  the table key and the row's `approved`.
- `src/assisted-transfers/assisted-transfers.queries.js`,
  `src/escrow/escrow.queries.js` (both tables), `src/fund/fund.queries.js`
  (both tables, the tally query, the closed-and-failed list): inserts,
  lookups, approve, the slot and row writes for follow-ups, ready-id
  queries, approved-row queries, deletes, conflict reasons. Mirror
  `locked-transactions.queries.js`.
- `src/records/records.queries.js`: `moveToLogs(client, source, outcome,
  transactionId)` and `moveToArchives(...)`, each one database transaction:
  `INSERT ... SELECT` with `row_to_json` of the row and its child rows into
  `record`, then the deletes.

Suggested commit: `shared helpers for signatures, stakes, holding tables and records`.

### 4. Transaction kinds

- `transfer.service.js`: `assistedAnosTransfer` (held in
  `assisted_transfers`, rule pair one and wallet, sender type assisted) and
  `escrowTransfer` (held in `escrow_transfers`, sender type spending,
  `account_id_to` stored). Approved change 3.
- `src/fund/fund.service.js`: `verifyTransferToFund`,
  `receiveTransferToFund` (held in `pending`), `writeTransferToFund(client,
  row, previousRecordHash)` (the link, then `addStake`);
  `verifyFundProposal`, `receiveFundProposal`, `writeFundProposal(client,
  row, previousRecordHash)` (the proposal link, the payout links,
  `subtractStake` for payouts with `stakeFor`), the payout object and its
  id. `fund.router.js` and `fund.handlers.js`: `/transfer-to-fund`,
  `/fund-proposal`, logging and `202` exactly like `transfer.handlers.js`,
  `runLeader()` after answering.
- Approved changes 4, 5 (the dispatch and storage parts), 7 (the write
  dispatch), 9.

Suggested commit: `assisted, escrow, transfer to fund and fund proposal transactions`.

### 5. Follow-ups

- `src/attachments/attachments.service.js`: the shared flow.
  `receiveAttachment(body, kinds)`: pick the kind by `payload.type` from the
  kinds the endpoint allows; the common checks of spec 5.1 in order (the
  kind supplies its table, signer field, required stake and own checks);
  store; `sendAttachmentApproval`; mark approved; `sendProofOfAttachment
  Acceptance`; the kind's `onAccepted`; the same result shape the transfer
  flow returns so handlers log alike. `receiveAttachmentApproval(body)` and
  `receiveProofOfAttachmentAcceptance(body)`, the peers' side, mirroring
  `receiveTransactionApproval` and `receiveProofOfAcceptance`.
- One module per kind, each exporting the same interface (`type`, `table`,
  `signerField`, `requiredStake`, `checkShape`, `verify`, `store`,
  `findStored`, `markApproved`, `onAccepted`):
  `src/assisted-transfers/attestation.js` and
  `assisted-transfer-cancel.js`; `src/fund/guardian-vote.js`;
  `src/escrow/escrow-success.js`, `escrow-cancel.js`, `escrow-dispute.js`,
  `escrow-verdict.js`.
- Routers and handlers: `src/assisted-transfers/assisted-transfers.router.js`
  (`/attestation`, `/assisted-transfer-cancel`), `/guardian-vote` in
  `fund.router.js`, `src/escrow/escrow.router.js` (`/escrow-signature`),
  each handler logging and answering as the others do and calling
  `runLeader()` after.
- Approved change 6, and the two receive functions wired into
  `validators.router.js` (approved change 5).

Suggested commit: `attestations, cancellations, guardian votes and escrow signatures`.

### 6. The leader round

`findReadyIds` over the five tables with the readiness rules of spec
section 6, the tally and the `voteFailed` sweep. `writeApproved` reading
approved rows from all five, the batch, then the deletes and the moves to
logs and archives per table. Approved changes 5 and 7.

Suggested commit: `leader round over every holding table`.

### 7. README and the spec

README: the Database tables list, the Endpoints table, a section each for
assisted transfers and attestations, stakes and transfer to fund, fund
proposals and votes, escrow, logs and archives (with the purge line), the
attachment messages under validator-to-validator messages, the
Configuration table, the layout tree. Anything that changed during the
build goes into `docs/schemas.md` too, so it stays the paperwork.

Suggested commit: `document assisted accounts, stakes, the fund and escrow`.

### 8. The web app

Repository `~/Desktop/Z/test/test-web-app` (Angular, standalone components,
signals; the user commits there too; one browser tab is one account, keys in
memory only). Plain forms in the existing page's style, nothing fancy.

- `crypto.service.ts`: `'assisted'` in `ACCOUNT_TYPES`; the new transfer
  types; builders `buildTransferToFund`, `buildFundProposal` and one
  `buildFollowUp(keys, payload)` that signs any follow-up payload with pair 1
  and the wallet pair; the payload interfaces of spec sections 4 and 5. The
  fund's account id as a constant.
- `app.ts` / `app.html`: assisted in `TRANSFERS` with zero minutes ahead; a
  kind selector for spending accounts (plain, escrow, stake with purpose
  and amount); the tab remembers its latest transaction id (the creation,
  then each transfer it sent) so a second transfer is accepted; forms for
  attest (transaction id, sender account id), cancel (transaction id), vote
  (transaction id, for or against), fund proposal (rows of recipient,
  amount, reason, optional purpose) and escrow (transaction id, which
  signature, verdict). Each posts to the matching endpoint and logs the
  answer as the existing forms do.
- `account-api.service.ts`: one method per endpoint.

Suggested commit, in that repo: `assisted, stake, fund proposal and escrow forms`.

### 9. Report

The changed and new files per step, what changed, the suggested commit
messages, what was verified on the rig and what was not, and anything left
open.

### 10. Verification rig

Before the report. In the scratchpad, never in the repo:

- Five env files `anosrig1` to `5` on ports 3101 to 3105, databases
  `anosrig1` to `5`, the local values of spec section 10, lock minutes 1 and
  2, offset 1. `sh scripts/setup-db.sh <the five files>`. Five validators
  started in the background with `--env-file` on those files; the registry
  rows need their urls on 3101 to 3105, so update `validators.url` in the
  rig databases after setup.
- A scratch script with `node:crypto` (P-256 and ML-DSA-87 are built in)
  and the project's `canonicalize` that creates accounts, funds them by SQL
  in all five databases, and runs: a stake as attestor and as guardian from
  two accounts; an assisted transfer with two attestations through to the
  write, and a second one cancelled; an escrow written on the seller's
  success, one cancelled by the buyer, one disputed and decided each way by
  two attestors; a fund proposal with two payouts, one returning stake, voted
  through the one-minute window, written; a proposal voted down. After each
  flow compare the five databases: the chain, balances, stakes, logs and
  archives identical everywhere. Earlier rigs from this project: dbs
  `anosrig1..5` on 3101-3105, scratch `submit.mjs`, all dropped afterwards.
- Drop the rig databases and stop the rig validators at the end.

## Out of scope, by decision

- Failure handling: a validator that is down, two conflicting follow-ups
  stored first on different validators, a batch that fails. Everything is
  still written as if nothing can fail.
- Purging logs: documented, not run.
- Roles beyond attestor and guardian do nothing yet.
- The wallet's final answer stays `202` + `{ transactionId }`.
- Expiry of transfers that never complete, other than the sender's
  cancellation of an assisted transfer and the buyer's of an escrow.
