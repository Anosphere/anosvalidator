/**
 * SQL for logs and archives: where a row goes when it leaves
 * assisted_transfers, escrow_transfers or fund_proposals (db/schema.sql).
 * The two tables have the same columns; a move is one database transaction
 * on `client`, a connection checked out of the pool: the insert of the row
 * and its child rows as one JSON record, then the deletes. Every validator
 * does every move for itself, so the copies stay identical.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns. Table names
 * come from SOURCES below, a fixed table, never from a request, so they are
 * safe to put into the SQL text.
 */

/** Where moved rows go. */
export const LOGS = 'logs';
export const ARCHIVES = 'archives';

/**
 * Why a row left, as logs.outcome and archives.outcome hold it. Logs take
 * WRITTEN (an assisted or undisputed escrow transfer the round wrote),
 * USER_CANCELLED (the sender cancelled an assisted transfer) and
 * RECEIVER_CANCELLED (the buyer cancelled an escrow). Archives take WRITTEN
 * (a fund proposal the round wrote), ARBITRATED_SUCCESS (a disputed escrow
 * the round wrote), ARBITRATED_CANCEL (two verdicts cancelled a disputed
 * escrow) and VOTE_FAILED (a proposal whose vote closed and failed).
 */
export const WRITTEN = 'written';
export const USER_CANCELLED = 'userCancelled';
export const RECEIVER_CANCELLED = 'receiverCancelled';
export const ARBITRATED_SUCCESS = 'arbitratedSuccess';
export const ARBITRATED_CANCEL = 'arbitratedCancel';
export const VOTE_FAILED = 'voteFailed';

/**
 * The tables a row may leave, each with its child table, whose rows go into
 * the record under `key` and are deleted with the row. `record` is
 * { row } for an assisted transfer, { row, arbitrations } for an escrow and
 * { row, votes } for a proposal; every value is the database row as JSON
 * (to_jsonb), so bytes come out in PostgreSQL's hex text form and
 * timestamps as ISO 8601.
 */
const SOURCES = Object.freeze({
  assisted_transfers: Object.freeze({ children: null }),
  escrow_transfers: Object.freeze({
    children: Object.freeze({ table: 'escrow_arbitrations', key: 'arbitrations', orderBy: 'arbitrator_account_id' }),
  }),
  fund_proposals: Object.freeze({
    children: Object.freeze({ table: 'guardian_votes', key: 'votes', orderBy: 'guardian_account_id' }),
  }),
});

/**
 * Moves the row with this transaction id out of `source` into logs, with
 * `outcome` saying why (WRITTEN, USER_CANCELLED or RECEIVER_CANCELLED). One
 * database transaction on `client`: the insert, then the deletes of the
 * child rows and the row. Throws when there is no such row, or on any
 * database error, after rolling back.
 */
export function moveToLogs(client, source, outcome, transactionId) {
  return move(client, LOGS, source, outcome, transactionId);
}

/**
 * Moves the row with this transaction id out of `source` into archives,
 * with `outcome` saying why (WRITTEN, ARBITRATED_SUCCESS, ARBITRATED_CANCEL
 * or VOTE_FAILED). Otherwise as moveToLogs.
 */
export function moveToArchives(client, source, outcome, transactionId) {
  return move(client, ARCHIVES, source, outcome, transactionId);
}

async function move(client, target, source, outcome, transactionId) {
  const spec = SOURCES[source];
  if (!spec) throw new TypeError(`Rows do not leave ${source} for ${target}`);

  const children = spec.children
    ? `, '${spec.children.key}',
         (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.${spec.children.orderBy}), '[]'::jsonb)
          FROM ${spec.children.table} c WHERE c.transaction_id = t.transaction_id)`
    : '';

  await client.query('BEGIN');
  try {
    const { rowCount } = await client.query(
      `INSERT INTO ${target} (transaction_id, source, outcome, account_id, record)
       SELECT t.transaction_id, $2, $3, t.account_id, jsonb_build_object('row', to_jsonb(t)${children})
       FROM ${source} t
       WHERE t.transaction_id = $1`,
      [transactionId, source, outcome],
    );
    if (rowCount !== 1) {
      throw new Error(`no ${source} row ${transactionId.toString('hex')} to move to ${target}`);
    }
    if (spec.children) {
      await client.query(`DELETE FROM ${spec.children.table} WHERE transaction_id = $1`, [transactionId]);
    }
    await client.query(`DELETE FROM ${source} WHERE transaction_id = $1`, [transactionId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
