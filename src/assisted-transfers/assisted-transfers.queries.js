import { query } from '../db/pool.js';

/**
 * SQL for the assisted_transfers table: transfers out of assisted accounts
 * waiting for two attestations before a leader round writes them
 * (db/schema.sql). Pending's twin, with three slots for the follow-ups
 * attached to the transfer: attestation_1, attestation_2 and cancellation,
 * each a whole signed object with its own approved flag. Mirrors
 * locked-transactions.queries.js.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns; pg sends a
 * Buffer parameter as bytea. Slot names come from ASSISTED_SLOTS, a fixed
 * list, never from a request, so they are safe to put into the SQL text.
 */

/** The three slot columns, each with a `<slot>_approved` flag next to it. */
export const ASSISTED_SLOTS = Object.freeze(['attestation_1', 'attestation_2', 'cancellation']);

/**
 * The reason to give a caller for each kind of conflict, keyed by what
 * insertAssisted reports. Shared by the manual uniqueness check that runs
 * before an insert and the insert's own backstop, so both say the same.
 */
export const ASSISTED_CONFLICT_REASONS = Object.freeze({
  transaction_id: 'a transaction with this transactionId is already held in assisted_transfers',
  account_id: 'a transaction for this accountId is already held in assisted_transfers',
});

/** PostgreSQL's SQLSTATE for a primary key or UNIQUE violation. */
const UNIQUE_VIOLATION = '23505';

const COLUMNS = `transaction_id, account_id, og_transaction, approved,
  attestation_1, attestation_1_approved, attestation_2, attestation_2_approved,
  cancellation, cancellation_approved`;

/**
 * A row as { transactionId, accountId, ogTransaction, approved, slots },
 * where slots maps each slot name to { object, approved }: the signed object
 * stored there (null while the slot is empty) and its approved flag.
 */
function toRow(row) {
  const slots = {};
  for (const slot of ASSISTED_SLOTS) {
    slots[slot] = { object: row[slot], approved: row[`${slot}_approved`] };
  }
  return {
    transactionId: row.transaction_id,
    accountId: row.account_id,
    ogTransaction: row.og_transaction,
    approved: row.approved,
    slots,
  };
}

function checkSlot(slot) {
  if (!ASSISTED_SLOTS.includes(slot)) throw new TypeError(`Unknown assisted_transfers slot: ${slot}`);
}

/**
 * Inserts one transaction. `approved` and the slots take their defaults.
 * `ogTransaction` is the submission exactly as received, stored as JSONB
 * like pending.og_transaction.
 *
 * Returns { inserted: true }, or { inserted: false, conflict } when a row
 * with this transaction_id (conflict 'transaction_id') or for this account_id
 * (conflict 'account_id') already exists: the backstop for two requests
 * racing past the check that runs first. Any other database error is thrown.
 */
export async function insertAssisted({ transactionId, accountId, ogTransaction }) {
  try {
    await query(
      `INSERT INTO assisted_transfers (transaction_id, account_id, og_transaction)
       VALUES ($1, $2, $3::jsonb)`,
      [transactionId, accountId, JSON.stringify(ogTransaction)],
    );
    return { inserted: true };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return {
      inserted: false,
      conflict: err.constraint === 'assisted_transfers_account_id_key' ? 'account_id' : 'transaction_id',
    };
  }
}

/** The whole row for this transaction id (toRow), or null when there is none. */
export async function findAssisted(transactionId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM assisted_transfers WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

/**
 * Marks the transaction approved. Returns true when a row changed, false
 * when there is no such row or it was approved already, so two proofs
 * arriving at once cannot both claim to have done it.
 */
export async function markAssistedApproved(transactionId) {
  const { rowCount } = await query(
    'UPDATE assisted_transfers SET approved = true WHERE transaction_id = $1 AND approved = false',
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * Stores `object` (a whole signed follow-up, { payload, signatures }) in
 * `slot`, if the slot is still empty. Returns true when it was stored, false
 * when the slot was taken in the meantime: the backstop for two follow-ups
 * racing past the check that runs first.
 */
export async function setAssistedSlot(transactionId, slot, object) {
  checkSlot(slot);
  const { rowCount } = await query(
    `UPDATE assisted_transfers SET ${slot} = $2::jsonb
     WHERE transaction_id = $1 AND ${slot} IS NULL`,
    [transactionId, JSON.stringify(object)],
  );
  return rowCount === 1;
}

/**
 * Marks the follow-up in `slot` approved. Returns true when a row changed,
 * false when the slot is empty, there is no such row, or it was approved
 * already.
 */
export async function markAssistedSlotApproved(transactionId, slot) {
  checkSlot(slot);
  const { rowCount } = await query(
    `UPDATE assisted_transfers SET ${slot}_approved = true
     WHERE transaction_id = $1 AND ${slot} IS NOT NULL AND ${slot}_approved = false`,
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * The ids of every assisted transfer a leader round may write, in id order,
 * as hex strings: approved, both attestations approved, and no cancellation
 * present (approved or not; present blocks).
 */
export async function findReadyAssistedIds() {
  const { rows } = await query(
    `SELECT transaction_id FROM assisted_transfers
     WHERE approved AND attestation_1_approved AND attestation_2_approved AND cancellation IS NULL
     ORDER BY transaction_id`,
  );
  return rows.map((row) => row.transaction_id.toString('hex'));
}

/**
 * The approved assisted transfers among these ids (Buffers), in id order,
 * as { transactionId, accountId, ogTransaction }, the shape pending's
 * findApproved gives. Readiness is not checked again here: the leader's
 * official list only names ready transactions, and every validator writes
 * the same list.
 */
export async function findAssistedApproved(transactionIds) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction FROM assisted_transfers
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
