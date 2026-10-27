import { query } from '../db/pool.js';

/**
 * SQL for the pending table: transactions received but not yet on the garlic
 * chain. Every transaction type lands here, so it has its own feature folder
 * rather than living under accounts.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns; pg sends a
 * Buffer parameter as bytea.
 */

/**
 * The reason to give a caller for each kind of conflict, keyed by what
 * insertPending reports. Shared by the manual uniqueness check that runs
 * before an insert and the insert's own backstop, so both say the same.
 */
export const PENDING_CONFLICT_REASONS = Object.freeze({
  transaction_id: 'a transaction with this transactionId is already pending',
  account_id: 'a transaction for this accountId is already pending',
});

/** PostgreSQL's SQLSTATE for a primary key or UNIQUE violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Inserts one transaction into pending. `approved` takes its default, false.
 *
 * `ogTransaction` is the submission object exactly as received. It is sent
 * as JSON text and stored in the JSONB column; JSONB keeps the value, not the
 * key order or whitespace, which is fine because canonical JSON fixes both
 * whenever the bytes are needed again.
 *
 * Returns { inserted: true }, or { inserted: false, conflict } when a row
 * with this transaction_id (conflict 'transaction_id') or for this account_id
 * (conflict 'account_id') already exists. The caller normally checked both
 * before calling; this is the backstop for two requests racing past that
 * check. Any other database error is thrown.
 */
export async function insertPending({ transactionId, accountId, ogTransaction }) {
  try {
    await query(
      `INSERT INTO pending (transaction_id, account_id, og_transaction)
       VALUES ($1, $2, $3::jsonb)`,
      [transactionId, accountId, JSON.stringify(ogTransaction)],
    );
    return { inserted: true };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return {
      inserted: false,
      conflict: err.constraint === 'pending_account_id_key' ? 'account_id' : 'transaction_id',
    };
  }
}

/**
 * The approved flag of the pending transaction with this id, as
 * { approved }, or null when there is no such transaction.
 */
export async function findPending(transactionId) {
  const { rows } = await query(
    'SELECT approved FROM pending WHERE transaction_id = $1',
    [transactionId],
  );
  return rows.length === 0 ? null : { approved: rows[0].approved };
}

/**
 * Marks the pending transaction with this id approved. Returns true when a
 * row changed, false when there is no such row or it was approved already,
 * so two proofs arriving at once cannot both claim to have done it.
 */
export async function markApproved(transactionId) {
  const { rowCount } = await query(
    'UPDATE pending SET approved = true WHERE transaction_id = $1 AND approved = false',
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * The ids of every approved pending transaction, in id order, as hex
 * strings.
 */
export async function findApprovedIds() {
  const { rows } = await query(
    'SELECT transaction_id FROM pending WHERE approved ORDER BY transaction_id',
  );
  return rows.map((row) => row.transaction_id.toString('hex'));
}

/**
 * The approved pending transactions among these ids (Buffers), in id order,
 * as { transactionId, accountId, ogTransaction }. pg sends an array of
 * Buffers as bytea[].
 */
export async function findApproved(transactionIds) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction FROM pending
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

/** Deletes the pending transactions with these ids (Buffers). */
export async function deletePending(transactionIds) {
  await query('DELETE FROM pending WHERE transaction_id = ANY($1)', [transactionIds]);
}
