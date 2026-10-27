import {
  ASSISTED_CONFLICT_REASONS,
  findAssisted,
  findAssistedApproved,
  insertAssisted,
  markAssistedApproved,
} from '../assisted-transfers/assisted-transfers.queries.js';
import {
  ESCROW_CONFLICT_REASONS,
  findEscrow,
  findEscrowApproved,
  insertEscrow,
  markEscrowApproved,
} from '../escrow/escrow.queries.js';
import {
  PROPOSAL_CONFLICT_REASONS,
  findProposal,
  findProposalApproved,
  insertProposal,
  markProposalApproved,
} from '../fund/fund.queries.js';
import {
  LOCKED_CONFLICT_REASONS,
  findLocked,
  findLockedApproved,
  insertLocked,
  markLockedApproved,
} from '../locked-transactions/locked-transactions.queries.js';
import {
  PENDING_CONFLICT_REASONS,
  findApproved,
  findPending,
  insertPending,
  markApproved,
} from '../pending/pending.queries.js';

/**
 * The holding tables: where a transaction waits until a leader round writes
 * it. There are five, and they share a shape (db/schema.sql): transaction_id
 * is the primary key, account_id is unique (one outstanding transaction per
 * account), og_transaction holds the submission as received, and approved
 * starts false and turns true once every validator accepted the transaction.
 * Which table holds a transaction follows from its kind: the verify
 * functions say so in their `heldIn`, and everything that stores, finds or
 * approves a held transaction goes through this registry so one code path
 * serves all five.
 *
 * The keys are the table names, which is what `heldIn` carries.
 */
export const PENDING = 'pending';
export const LOCKED_TRANSACTIONS = 'locked_transactions';
export const ASSISTED_TRANSFERS = 'assisted_transfers';
export const ESCROW_TRANSFERS = 'escrow_transfers';
export const FUND_PROPOSALS = 'fund_proposals';

/**
 * One entry per table, each with the same five members, built from that
 * table's query module:
 *   insert(row):           stores { transactionId, accountId, ogTransaction }
 *                          plus whatever the table needs (futureDate,
 *                          accountIdTo, voteClosesAt and proposerWeight);
 *                          extra fields are ignored. Returns { inserted } or
 *                          { inserted: false, conflict }.
 *   find(transactionId):   the row, with at least `approved`, or null.
 *   markApproved(id):      marks the row approved; true when a row changed.
 *   findApproved(ids):     the approved rows among `ids`, in id order, as
 *                          { transactionId, accountId, ogTransaction, ... }.
 *   conflictReasons:       the reason to answer with for each insert
 *                          conflict, keyed by 'transaction_id' / 'account_id'.
 */
export const HELD_TABLES = Object.freeze({
  [PENDING]: Object.freeze({
    insert: insertPending,
    find: findPending,
    markApproved,
    findApproved,
    conflictReasons: PENDING_CONFLICT_REASONS,
  }),
  [LOCKED_TRANSACTIONS]: Object.freeze({
    insert: insertLocked,
    find: findLocked,
    markApproved: markLockedApproved,
    findApproved: findLockedApproved,
    conflictReasons: LOCKED_CONFLICT_REASONS,
  }),
  [ASSISTED_TRANSFERS]: Object.freeze({
    insert: insertAssisted,
    find: findAssisted,
    markApproved: markAssistedApproved,
    findApproved: findAssistedApproved,
    conflictReasons: ASSISTED_CONFLICT_REASONS,
  }),
  [ESCROW_TRANSFERS]: Object.freeze({
    insert: insertEscrow,
    find: findEscrow,
    markApproved: markEscrowApproved,
    findApproved: findEscrowApproved,
    conflictReasons: ESCROW_CONFLICT_REASONS,
  }),
  [FUND_PROPOSALS]: Object.freeze({
    insert: insertProposal,
    find: findProposal,
    markApproved: markProposalApproved,
    findApproved: findProposalApproved,
    conflictReasons: PROPOSAL_CONFLICT_REASONS,
  }),
});

/** The five table names, in the order above. */
export const HELD_TABLE_NAMES = Object.freeze(Object.keys(HELD_TABLES));

/**
 * Looks for a transaction (its id as 32 raw bytes) across the five holding
 * tables. Returns { table, approved } naming the table that holds it and the
 * row's approved flag, or null when no table does.
 */
export async function findHeld(transactionId) {
  for (const table of HELD_TABLE_NAMES) {
    const row = await HELD_TABLES[table].find(transactionId);
    if (row) return { table, approved: row.approved };
  }
  return null;
}
