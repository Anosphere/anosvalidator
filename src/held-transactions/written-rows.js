import { pool } from '../db/pool.js';
import { HELD_TABLE_NAMES } from './held-transactions.js';

/**
 * The waiting rows of a validator that comes back, brought in line
 * (docs/schemas.md section 31).
 *
 * Why: a validator that misses a write keeps the transaction as an
 * approved row in its holding table. The catch-up pass writes the missed
 * link and does not touch the holding tables
 * (src/garlic-chain/replay.service.js), and the pull of a join adds rows
 * and removes none. The official list holds only ids that every list
 * holds, so no later round names that row again. Left alone it would stay,
 * and since account_id is unique in every holding table, the validator
 * would refuse the account's next transaction while it passes the health
 * check. One no is enough, so the account could send nothing.
 *
 * Two deletes end that, both run by the join loop
 * (src/validators/join.service.js) before the validator counts itself,
 * never while it is counted, so neither can cross a write:
 *
 *   dropWrittenHeldRows  every row whose transaction the own chain already
 *                        holds, approved or not; at every start and after
 *                        every catch-up;
 *   clearHeldRows        every row, at a join through the leader, right
 *                        before the leader's rows are pulled: that is how a
 *                        row the leader no longer holds goes, and how a row
 *                        gets the follow-ups it missed.
 *
 * A plain delete, as the sweep of unapproved rows is (unapproved-sweep.js),
 * with one log line per row. Only the five holding tables and their two
 * child tables; never the chain, the accounts, the logs or the archives.
 */

/** The child tables, both keyed by transaction_id: an escrow's arbitrations and a proposal's votes. Their rows go first. */
const CHILD_TABLES = Object.freeze(['escrow_arbitrations', 'guardian_votes']);

/**
 * Deletes every held row whose transaction the own chain already holds,
 * with its child rows, in one database transaction. One line per row of
 * the five holding tables, after the commit. Resolves with the number of
 * rows deleted from the five tables. A database error is thrown.
 */
export function dropWrittenHeldRows() {
  return deleteHeldRows(
    (table) => `DELETE FROM ${table} h
       WHERE EXISTS (SELECT 1 FROM garlic_chain g WHERE g.transaction_id = h.transaction_id)
       RETURNING h.transaction_id`,
    (table, id) => `dropped held ${table} transaction ${id}: already on the chain`,
  );
}

/**
 * Deletes every held row, with every child row, in one database
 * transaction. One line per row of the five holding tables, after the
 * commit. Resolves with the number of rows deleted from the five tables. A
 * database error is thrown.
 */
export function clearHeldRows() {
  return deleteHeldRows(
    (table) => `DELETE FROM ${table} RETURNING transaction_id`,
    (table, id) => `cleared held ${table} transaction ${id}: the join takes the leader's rows`,
  );
}

/**
 * One database transaction: `statement(table)` on the two child tables,
 * then on the five holding tables (held-transactions.js HELD_TABLE_NAMES).
 * After the commit, `line(table, id)` is logged for every row the five
 * tables lost, the id as hex. Resolves with their number.
 */
async function deleteHeldRows(statement, line) {
  const deleted = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of CHILD_TABLES) {
      await client.query(statement(table));
    }
    for (const table of HELD_TABLE_NAMES) {
      const { rows } = await client.query(statement(table));
      for (const row of rows) {
        deleted.push({ table, id: row.transaction_id.toString('hex') });
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const { table, id } of deleted) {
    console.log(line(table, id));
  }
  return deleted.length;
}
