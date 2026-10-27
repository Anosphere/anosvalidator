import { query } from '../db/pool.js';

/**
 * SQL for the locked_transactions table: guarded and vault transfers
 * received and waiting out their time lock before they go onto the garlic
 * chain (db/schema.sql). It is pending's twin for those transfers: the same
 * one transaction per account, the same approved flag, plus future_date,
 * the moment the transaction may be written. Written to by the transfer and
 * validators features, so it has its own feature folder like pending.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns; pg sends a
 * Buffer parameter as bytea.
 */

/**
 * The reason to give a caller for each kind of conflict, keyed by what
 * insertLocked reports. Shared by the manual uniqueness check that runs
 * before an insert and the insert's own backstop, so both say the same.
 */
export const LOCKED_CONFLICT_REASONS = Object.freeze({
  transaction_id: 'a transaction with this transactionId is already locked',
  account_id: 'a transaction for this accountId is already locked',
});

/** PostgreSQL's SQLSTATE for a primary key or UNIQUE violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Inserts one transaction into locked_transactions. `futureDate` is the
 * moment it may be written, a Date; `approved` takes its default, false.
 * `ogTransaction` is the submission object exactly as received, stored as
 * JSONB like pending.og_transaction.
 *
 * Returns { inserted: true }, or { inserted: false, conflict } when a row
 * with this transaction_id (conflict 'transaction_id') or for this account_id
 * (conflict 'account_id') already exists: the backstop for two requests
 * racing past the check that runs first. Any other database error is thrown.
 */
export async function insertLocked({ transactionId, accountId, futureDate, ogTransaction }) {
  try {
    await query(
      `INSERT INTO locked_transactions (transaction_id, account_id, future_date, og_transaction)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [transactionId, accountId, futureDate, JSON.stringify(ogTransaction)],
    );
    return { inserted: true };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return {
      inserted: false,
      conflict: err.constraint === 'locked_transactions_account_id_key' ? 'account_id' : 'transaction_id',
    };
  }
}

/**
 * The approved flag of the locked transaction with this id, as { approved },
 * or null when there is no such transaction.
 */
export async function findLocked(transactionId) {
  const { rows } = await query(
    'SELECT approved FROM locked_transactions WHERE transaction_id = $1',
    [transactionId],
  );
  return rows.length === 0 ? null : { approved: rows[0].approved };
}

/**
 * Marks the locked transaction with this id approved. Returns true when a
 * row changed, false when there is no such row or it was approved already,
 * so two proofs arriving at once cannot both claim to have done it.
 */
export async function markLockedApproved(transactionId) {
  const { rowCount } = await query(
    'UPDATE locked_transactions SET approved = true WHERE transaction_id = $1 AND approved = false',
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * The ids of every approved locked transaction whose future_date has
 * passed, in id order, as hex strings: the ones a leader round may write.
 */
export async function findDueIds() {
  const { rows } = await query(
    `SELECT transaction_id FROM locked_transactions
     WHERE approved AND future_date <= now()
     ORDER BY transaction_id`,
  );
  return rows.map((row) => row.transaction_id.toString('hex'));
}

/**
 * The approved locked transactions among these ids (Buffers), in id order,
 * as { transactionId, accountId, ogTransaction }, the shape pending's
 * findApproved gives. future_date is not checked again here: the leader's
 * official list only names due transactions, and every validator writes the
 * same list whatever its own clock says.
 */
export async function findLockedApproved(transactionIds) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction FROM locked_transactions
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

/** Deletes the locked transactions with these ids (Buffers). */
export async function deleteLocked(transactionIds) {
  await query('DELETE FROM locked_transactions WHERE transaction_id = ANY($1)', [transactionIds]);
}
