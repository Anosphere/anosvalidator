import { query } from '../db/pool.js';

/**
 * SQL for the fund feature's two tables (db/schema.sql): fund_proposals,
 * pending's twin for fund proposals, open for votes until vote_closes_at,
 * and guardian_votes, one row per guardian's vote on a proposal. Plus the
 * lookups a proposal's checks need. Mirrors locked-transactions.queries.js.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns; pg sends a
 * Buffer parameter as bytea.
 */

/** The two ways a guardian may vote, as guardian_votes.vote holds them. */
export const VOTES = Object.freeze(['for', 'against']);

/**
 * The reason to give a caller for each kind of conflict, keyed by what
 * insertProposal reports. account_id is always the fund's, so a conflict on
 * it means another proposal is open. Shared by the manual uniqueness check
 * that runs before an insert and the insert's own backstop.
 */
export const PROPOSAL_CONFLICT_REASONS = Object.freeze({
  transaction_id: 'a proposal with this transactionId is already open',
  account_id: 'a fund proposal is already open',
});

/** PostgreSQL's SQLSTATE for a primary key or UNIQUE violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * A row as { transactionId, accountId, ogTransaction, approved,
 * voteClosesAt (a Date), proposerWeight }.
 */
function toRow(row) {
  return {
    transactionId: row.transaction_id,
    accountId: row.account_id,
    ogTransaction: row.og_transaction,
    approved: row.approved,
    voteClosesAt: row.vote_closes_at,
    proposerWeight: row.proposer_weight,
  };
}

/**
 * Inserts one proposal: `accountId` the fund's id, `voteClosesAt` a Date,
 * `proposerWeight` the proposer's votes now. `approved` takes its default.
 * `ogTransaction` is the submission exactly as received, stored as JSONB
 * like pending.og_transaction.
 *
 * Returns { inserted: true }, or { inserted: false, conflict } when a row
 * with this transaction_id (conflict 'transaction_id') or for this account_id
 * (conflict 'account_id': another proposal is open) already exists: the
 * backstop for two requests racing past the check that runs first. Any
 * other database error is thrown.
 */
export async function insertProposal({ transactionId, accountId, ogTransaction, voteClosesAt, proposerWeight }) {
  try {
    await query(
      `INSERT INTO fund_proposals (transaction_id, account_id, og_transaction, vote_closes_at, proposer_weight)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [transactionId, accountId, JSON.stringify(ogTransaction), voteClosesAt, proposerWeight],
    );
    return { inserted: true };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return {
      inserted: false,
      conflict: err.constraint === 'fund_proposals_account_id_key' ? 'account_id' : 'transaction_id',
    };
  }
}

/** The whole row for this proposal id (toRow), or null when there is none. */
export async function findProposal(transactionId) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction, approved, vote_closes_at, proposer_weight
     FROM fund_proposals WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

/**
 * Marks the proposal approved. Returns true when a row changed, false when
 * there is no such row or it was approved already, so two proofs arriving at
 * once cannot both claim to have done it.
 */
export async function markProposalApproved(transactionId) {
  const { rowCount } = await query(
    'UPDATE fund_proposals SET approved = true WHERE transaction_id = $1 AND approved = false',
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * The tally: every approved proposal whose vote has closed, in id order, as
 * { transactionId (Buffer), forWeight, againstWeight }, both Numbers.
 * forWeight is proposer_weight plus the weight of the approved votes for;
 * againstWeight the weight of the approved votes against. Guardians who did
 * not vote count for nothing. Whether that passes is the service's call
 * (fund.service.js), with GUARDIAN_VOTE_PERCENT.
 */
export async function findClosedProposals() {
  const { rows } = await query(
    `SELECT p.transaction_id,
            p.proposer_weight
              + coalesce((SELECT sum(v.weight) FROM guardian_votes v
                          WHERE v.transaction_id = p.transaction_id AND v.approved AND v.vote = 'for'), 0)
              AS for_weight,
            coalesce((SELECT sum(v.weight) FROM guardian_votes v
                      WHERE v.transaction_id = p.transaction_id AND v.approved AND v.vote = 'against'), 0)
              AS against_weight
     FROM fund_proposals p
     WHERE p.approved AND p.vote_closes_at <= now()
     ORDER BY p.transaction_id`,
  );
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    forWeight: Number(row.for_weight),
    againstWeight: Number(row.against_weight),
  }));
}

/**
 * The approved proposals among these ids (Buffers), in id order, as
 * { transactionId, accountId, ogTransaction }, the shape pending's
 * findApproved gives. The vote is not tallied again here: the leader's
 * official list only names proposals that passed, and every validator
 * writes the same list.
 */
export async function findProposalApproved(transactionIds) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction FROM fund_proposals
     WHERE approved AND transaction_id = ANY($1)
     ORDER BY transaction_id`,
    [transactionIds],
  );
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    accountId: row.account_id,
    ogTransaction: row.og_transaction,
  }));
}

/**
 * Which of these account ids (Buffers) have an accounts row, as an array of
 * Buffers: a proposal's payouts are checked against it in one round trip.
 */
export async function findExistingAccounts(accountIds) {
  const { rows } = await query(
    'SELECT account_id FROM accounts WHERE account_id = ANY($1)',
    [accountIds],
  );
  return rows.map((row) => row.account_id);
}

/**
 * What a proposal must not find, in one round trip: nothing with its
 * transactionId in any of the five holding tables or on the chain, and
 * nothing for the fund's account id in any holding table, which for the
 * fund means no other proposal is open. Each EXISTS is a primary-key or
 * unique-index lookup. Returns { held, chainTransaction }: `held` is null or
 * { table, conflict } for the first holding table that has a row, with
 * conflict 'transaction_id' or 'account_id', the keys of that table's
 * conflict reasons (held-transactions.js).
 */
export async function findProposalConflicts({ transactionId, accountId }) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM pending             WHERE transaction_id = $1) AS pending_transaction,
       EXISTS (SELECT 1 FROM pending             WHERE account_id     = $2) AS pending_for_account,
       EXISTS (SELECT 1 FROM locked_transactions WHERE transaction_id = $1) AS locked_transaction,
       EXISTS (SELECT 1 FROM locked_transactions WHERE account_id     = $2) AS locked_for_account,
       EXISTS (SELECT 1 FROM assisted_transfers  WHERE transaction_id = $1) AS assisted_transaction,
       EXISTS (SELECT 1 FROM assisted_transfers  WHERE account_id     = $2) AS assisted_for_account,
       EXISTS (SELECT 1 FROM escrow_transfers    WHERE transaction_id = $1) AS escrow_transaction,
       EXISTS (SELECT 1 FROM escrow_transfers    WHERE account_id     = $2) AS escrow_for_account,
       EXISTS (SELECT 1 FROM fund_proposals      WHERE transaction_id = $1) AS proposal_transaction,
       EXISTS (SELECT 1 FROM fund_proposals      WHERE account_id     = $2) AS proposal_for_account,
       EXISTS (SELECT 1 FROM garlic_chain        WHERE transaction_id = $1) AS chain_transaction`,
    [transactionId, accountId],
  );
  const row = rows[0];
  const checks = [
    ['pending', 'transaction_id', row.pending_transaction],
    ['pending', 'account_id', row.pending_for_account],
    ['locked_transactions', 'transaction_id', row.locked_transaction],
    ['locked_transactions', 'account_id', row.locked_for_account],
    ['assisted_transfers', 'transaction_id', row.assisted_transaction],
    ['assisted_transfers', 'account_id', row.assisted_for_account],
    ['escrow_transfers', 'transaction_id', row.escrow_transaction],
    ['escrow_transfers', 'account_id', row.escrow_for_account],
    ['fund_proposals', 'transaction_id', row.proposal_transaction],
    ['fund_proposals', 'account_id', row.proposal_for_account],
  ];
  const found = checks.find(([, , exists]) => exists);
  return {
    held: found ? { table: found[0], conflict: found[1] } : null,
    chainTransaction: row.chain_transaction,
  };
}

/**
 * Inserts one guardian's vote on a proposal: `signature` is the whole
 * guardianVote object as received, `vote` one of VOTES, `weight` the
 * guardian's votes now. `approved` takes its default. Returns true when it
 * was stored, false when this guardian already has a row for this proposal:
 * the backstop for two votes racing past the check that runs first.
 */
export async function insertVote({ transactionId, guardianAccountId, vote, weight, signature }) {
  const { rowCount } = await query(
    `INSERT INTO guardian_votes (transaction_id, guardian_account_id, vote, weight, signature)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (transaction_id, guardian_account_id) DO NOTHING`,
    [transactionId, guardianAccountId, vote, weight, JSON.stringify(signature)],
  );
  return rowCount === 1;
}

/**
 * Every vote on this proposal, in guardian order, as
 * { guardianAccountId, vote, weight, signature, approved }.
 */
export async function findVotes(transactionId) {
  const { rows } = await query(
    `SELECT guardian_account_id, vote, weight, signature, approved FROM guardian_votes
     WHERE transaction_id = $1
     ORDER BY guardian_account_id`,
    [transactionId],
  );
  return rows.map((row) => ({
    guardianAccountId: row.guardian_account_id,
    vote: row.vote,
    weight: row.weight,
    signature: row.signature,
    approved: row.approved,
  }));
}

/**
 * Marks one guardian's vote approved. Returns true when a row changed, false
 * when there is no such row or it was approved already.
 */
export async function markVoteApproved(transactionId, guardianAccountId) {
  const { rowCount } = await query(
    `UPDATE guardian_votes SET approved = true
     WHERE transaction_id = $1 AND guardian_account_id = $2 AND approved = false`,
    [transactionId, guardianAccountId],
  );
  return rowCount === 1;
}
