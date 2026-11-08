import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { HELD_TABLE_NAMES } from './held-transactions.js';

/**
 * The age limit on unapproved held rows (docs/schemas.md section 21).
 *
 * A transaction is stored in its holding table with approved = false before
 * the approval round, on the originating validator and on every peer that
 * approves it. When one validator refuses, the round ends there: the
 * originating validator never sends the proof of acceptance, and nothing
 * tells the others to drop their rows. Those rows would stay for good, and
 * since account_id is unique in every holding table, the account could send
 * nothing more through a validator that holds one.
 *
 * So every validator drops, on its own, any held row that is still
 * unapproved UNAPPROVED_AGE_LIMIT_SECONDS after it was stored
 * (env.unapprovedAgeLimitSeconds). A plain delete, in all five tables, with
 * no trace but a log line. Safe because an approval round is over long
 * before the limit: the send with its timeout, the wait for an ignore vote
 * and the one re-send, then the proof, add up to well under two minutes
 * against the five minutes set in network/testnet.env. A row unapproved
 * past the limit can no longer become approved, so no two validators can
 * disagree about a transaction that counts. An unapproved row has no
 * follow-ups and no child rows (a follow-up is only accepted on an approved
 * row), so the delete is one statement per table.
 *
 * The sweep runs once at boot and then every SWEEP_EVERY_MS, on every
 * validator, counted or not. Nothing waits on it: an account blocked by a
 * dead row is free again within a minute of the limit passing.
 */

/** How often the sweep runs, in milliseconds. */
const SWEEP_EVERY_MS = 60_000;

let timer = null;

/**
 * One sweep: deletes from each holding table every row older than the
 * limit and still unapproved, and logs one line per row dropped. Resolves
 * with the number dropped. A database error is logged, not thrown: the
 * next sweep tries again.
 */
export async function sweepUnapproved() {
  const limit = env.unapprovedAgeLimitSeconds;
  let dropped = 0;
  for (const table of HELD_TABLE_NAMES) {
    try {
      const { rows } = await query(
        `DELETE FROM ${table}
         WHERE NOT approved AND created_at < now() - make_interval(secs => $1)
         RETURNING transaction_id`,
        [limit],
      );
      for (const row of rows) {
        console.log(`dropped unapproved ${table} transaction ${row.transaction_id.toString('hex')}: older than ${limit} seconds`);
      }
      dropped += rows.length;
    } catch (err) {
      console.error(`unapproved sweep of ${table} failed: ${err.message}`);
    }
  }
  return dropped;
}

/** Starts the sweep: once now, then every SWEEP_EVERY_MS. Starting it twice does nothing. */
export function startUnapprovedSweep() {
  if (timer !== null) return;
  timer = setInterval(sweepUnapproved, SWEEP_EVERY_MS);
  timer.unref();
  void sweepUnapproved();
}

/** Stops the sweep; a sweep already running finishes on its own. */
export function stopUnapprovedSweep() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
