import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { signPayload } from '../validators/validators.signing.js';
import { reportWaitingTransfers } from './masterpod.client.js';

/**
 * The report of waiting transfers to the masterpod (docs/schemas.md
 * section 34), so that the owner of an account hears of a transfer that
 * has started to wait and can cancel one that is not theirs.
 *
 * A guarded or a vault transfer waits in locked_transactions; an assisted
 * transfer and a break-glass move wait in assisted_transfers. The code that
 * stores and approves them is not touched. This job reads the two tables
 * instead: every row that is approved, that was stored more than
 * UNAPPROVED_AGE_LIMIT_SECONDS ago and that has no row in masterpod_reports
 * yet. The age is the sweep's (unapproved-sweep.js): an approval round is
 * over long before it, so the approved mark of an older row is no longer
 * taken back (src/validators/acceptance.js). The rows go to the masterpod
 * in one message, { payload, signature }, signed with this validator's key
 * like a message to another validator. When the masterpod answers 200 the
 * ids are written to masterpod_reports, and those transfers are not sent
 * again. Any other answer, or none, writes nothing, and the next run sends
 * the same rows again. A transfer that is written or cancelled before the
 * masterpod could be told is never reported: nothing is left to cancel.
 *
 * Every validator runs it, counted or not, once at boot and then every
 * REPORT_EVERY_MS. The masterpod acts on the first report of a transfer
 * and ignores the rest. Nothing here can stop a transfer: a failure is
 * one log line, and only when it differs from the failure before it.
 */

/** How often the job runs, in milliseconds. */
const REPORT_EVERY_MS = 60_000;

/** How many transfers one message carries at most; the rest go with the next run. */
const REPORT_LIMIT = 100;

let timer = null;
let running = false;
let lastFailure = null;

/** One failure: a log line unless it is the same as the one before. */
function failed(reason) {
  if (reason !== lastFailure) console.error(`report to the masterpod failed: ${reason}`);
  lastFailure = reason;
  return 0;
}

/**
 * One run. Resolves with the number of transfers the masterpod took.
 * Never throws: the next run tries again. A run that is still under way
 * when the next one is due makes the next one do nothing.
 */
export async function reportWaiting() {
  if (running) return 0;
  running = true;
  try {
    const { rows } = await query(
      `SELECT t.transaction_id, t.account_id, t.og_transaction, t.future_date
       FROM (
         SELECT transaction_id, account_id, og_transaction, future_date, created_at FROM locked_transactions WHERE approved
         UNION ALL
         SELECT transaction_id, account_id, og_transaction, future_date, created_at FROM assisted_transfers WHERE approved
       ) t
       WHERE t.created_at < now() - make_interval(secs => $1)
         AND NOT EXISTS (SELECT 1 FROM masterpod_reports r WHERE r.transaction_id = t.transaction_id)
       ORDER BY t.created_at, t.transaction_id
       LIMIT $2`,
      [env.unapprovedAgeLimitSeconds, REPORT_LIMIT],
    );
    if (rows.length === 0) return 0;

    const payload = {
      validatorId: env.validator.id,
      transfers: rows.map((row) => ({
        transactionId: row.transaction_id.toString('hex'),
        accountId: row.account_id.toString('hex'),
        transactionType: row.og_transaction.payload.transactionType,
        amount: row.og_transaction.payload.amount,
        writesAt: row.future_date === null ? null : row.future_date.toISOString(),
      })),
    };
    const failure = await reportWaitingTransfers({ payload, signature: signPayload(payload) });
    if (failure !== null) return failed(failure);

    await query(
      `INSERT INTO masterpod_reports (transaction_id)
       SELECT unnest($1::bytea[])
       ON CONFLICT (transaction_id) DO NOTHING`,
      [rows.map((row) => row.transaction_id)],
    );
    if (lastFailure !== null) console.log('the masterpod takes reports again');
    lastFailure = null;
    console.log(`reported ${rows.length} waiting transfer${rows.length === 1 ? '' : 's'} to the masterpod`);
    return rows.length;
  } catch (err) {
    return failed(err.message);
  } finally {
    running = false;
  }
}

/** Starts the job: once now, then every REPORT_EVERY_MS. Starting it twice does nothing. */
export function startMasterpodReports() {
  if (timer !== null) return;
  timer = setInterval(reportWaiting, REPORT_EVERY_MS);
  timer.unref();
  void reportWaiting();
}

/** Stops the job; a run already under way finishes on its own. */
export function stopMasterpodReports() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
