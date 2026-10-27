import { query } from '../db/pool.js';

/**
 * SQL for the escrow feature's two tables (db/schema.sql): escrow_transfers,
 * pending's twin for escrow transfers, with three slots for the signed
 * objects that move an escrow (success_signature, cancel_signature,
 * dispute_signature, each with its own approved flag), and
 * escrow_arbitrations, one row per arbitrator's verdict on a disputed
 * escrow. Mirrors locked-transactions.queries.js.
 *
 * Ids are Buffers of 32 raw bytes, matching the BYTEA columns; pg sends a
 * Buffer parameter as bytea. Slot names come from ESCROW_SLOTS, a fixed
 * list, never from a request, so they are safe to put into the SQL text.
 */

/** The three slot columns, each with a `<slot>_approved` flag next to it. */
export const ESCROW_SLOTS = Object.freeze(['success_signature', 'cancel_signature', 'dispute_signature']);

/** The two verdicts an arbitrator may give, as escrow_arbitrations.verdict holds them. */
export const VERDICTS = Object.freeze(['success', 'cancel']);

/** How many approved verdicts saying the same thing decide a disputed escrow. */
export const DECIDING_VERDICTS = 2;

/**
 * The reason to give a caller for each kind of conflict, keyed by what
 * insertEscrow reports. Shared by the manual uniqueness check that runs
 * before an insert and the insert's own backstop, so both say the same.
 */
export const ESCROW_CONFLICT_REASONS = Object.freeze({
  transaction_id: 'a transaction with this transactionId is already held in escrow_transfers',
  account_id: 'a transaction for this accountId is already held in escrow_transfers',
});

/** PostgreSQL's SQLSTATE for a primary key or UNIQUE violation. */
const UNIQUE_VIOLATION = '23505';

const COLUMNS = `transaction_id, account_id, account_id_to, og_transaction, approved,
  success_signature, success_signature_approved, cancel_signature, cancel_signature_approved,
  dispute_signature, dispute_signature_approved`;

/**
 * A row as { transactionId, accountId, accountIdTo, ogTransaction, approved,
 * slots }, where slots maps each slot name to { object, approved }: the
 * signed object stored there (null while the slot is empty) and its approved
 * flag. accountId is the seller, accountIdTo the buyer.
 */
function toRow(row) {
  const slots = {};
  for (const slot of ESCROW_SLOTS) {
    slots[slot] = { object: row[slot], approved: row[`${slot}_approved`] };
  }
  return {
    transactionId: row.transaction_id,
    accountId: row.account_id,
    accountIdTo: row.account_id_to,
    ogTransaction: row.og_transaction,
    approved: row.approved,
    slots,
  };
}

function checkSlot(slot) {
  if (!ESCROW_SLOTS.includes(slot)) throw new TypeError(`Unknown escrow_transfers slot: ${slot}`);
}

/**
 * Inserts one escrow transfer, `accountIdTo` the buyer. `approved` and the
 * slots take their defaults. `ogTransaction` is the submission exactly as
 * received, stored as JSONB like pending.og_transaction.
 *
 * Returns { inserted: true }, or { inserted: false, conflict } when a row
 * with this transaction_id (conflict 'transaction_id') or for this account_id
 * (conflict 'account_id') already exists: the backstop for two requests
 * racing past the check that runs first. Any other database error is thrown.
 */
export async function insertEscrow({ transactionId, accountId, accountIdTo, ogTransaction }) {
  try {
    await query(
      `INSERT INTO escrow_transfers (transaction_id, account_id, account_id_to, og_transaction)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [transactionId, accountId, accountIdTo, JSON.stringify(ogTransaction)],
    );
    return { inserted: true };
  } catch (err) {
    if (err.code !== UNIQUE_VIOLATION) throw err;
    return {
      inserted: false,
      conflict: err.constraint === 'escrow_transfers_account_id_key' ? 'account_id' : 'transaction_id',
    };
  }
}

/** The whole row for this transaction id (toRow), or null when there is none. */
export async function findEscrow(transactionId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM escrow_transfers WHERE transaction_id = $1`,
    [transactionId],
  );
  return rows.length === 0 ? null : toRow(rows[0]);
}

/**
 * Marks the escrow transfer approved. Returns true when a row changed, false
 * when there is no such row or it was approved already, so two proofs
 * arriving at once cannot both claim to have done it.
 */
export async function markEscrowApproved(transactionId) {
  const { rowCount } = await query(
    'UPDATE escrow_transfers SET approved = true WHERE transaction_id = $1 AND approved = false',
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
export async function setEscrowSlot(transactionId, slot, object) {
  checkSlot(slot);
  const { rowCount } = await query(
    `UPDATE escrow_transfers SET ${slot} = $2::jsonb
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
export async function markEscrowSlotApproved(transactionId, slot) {
  checkSlot(slot);
  const { rowCount } = await query(
    `UPDATE escrow_transfers SET ${slot}_approved = true
     WHERE transaction_id = $1 AND ${slot} IS NOT NULL AND ${slot}_approved = false`,
    [transactionId],
  );
  return rowCount === 1;
}

/**
 * The ids of every escrow transfer a leader round may write, in id order, as
 * hex strings: approved, no cancel signature present, and either the
 * seller's success signature approved or the dispute signature approved
 * with at least DECIDING_VERDICTS approved verdicts saying success.
 */
export async function findReadyEscrowIds() {
  const { rows } = await query(
    `SELECT e.transaction_id FROM escrow_transfers e
     WHERE e.approved
       AND e.cancel_signature IS NULL
       AND (e.success_signature_approved
            OR (e.dispute_signature_approved
                AND (SELECT count(*) FROM escrow_arbitrations a
                     WHERE a.transaction_id = e.transaction_id AND a.approved AND a.verdict = 'success')
                    >= $1))
     ORDER BY e.transaction_id`,
    [DECIDING_VERDICTS],
  );
  return rows.map((row) => row.transaction_id.toString('hex'));
}

/**
 * The approved escrow transfers among these ids (Buffers), in id order, as
 * { transactionId, accountId, ogTransaction, disputed }: the shape pending's
 * findApproved gives, plus whether a dispute signature is present, which
 * decides whether a written escrow goes to logs or to archives. Readiness
 * is not checked again here: the leader's official list only names ready
 * transactions, and every validator writes the same list.
 */
export async function findEscrowApproved(transactionIds) {
  const { rows } = await query(
    `SELECT transaction_id, account_id, og_transaction, dispute_signature IS NOT NULL AS disputed
     FROM escrow_transfers
     WHERE approved AND transaction_id = ANY($1)
     ORDER BY transaction_id`,
    [transactionIds],
  );
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    accountId: row.account_id,
    ogTransaction: row.og_transaction,
    disputed: row.disputed,
  }));
}

/**
 * Inserts one arbitrator's verdict on a disputed escrow: `signature` is the
 * whole escrowVerdict object as received, `verdict` one of VERDICTS.
 * `approved` takes its default. Returns true when it was stored, false when
 * this arbitrator already has a row for this escrow: the backstop for two
 * verdicts racing past the check that runs first.
 */
export async function insertArbitration({ transactionId, arbitratorAccountId, verdict, signature }) {
  const { rowCount } = await query(
    `INSERT INTO escrow_arbitrations (transaction_id, arbitrator_account_id, verdict, signature)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (transaction_id, arbitrator_account_id) DO NOTHING`,
    [transactionId, arbitratorAccountId, verdict, JSON.stringify(signature)],
  );
  return rowCount === 1;
}

/**
 * Every verdict on this escrow, in arbitrator order, as
 * { arbitratorAccountId, verdict, signature, approved }.
 */
export async function findArbitrations(transactionId) {
  const { rows } = await query(
    `SELECT arbitrator_account_id, verdict, signature, approved FROM escrow_arbitrations
     WHERE transaction_id = $1
     ORDER BY arbitrator_account_id`,
    [transactionId],
  );
  return rows.map((row) => ({
    arbitratorAccountId: row.arbitrator_account_id,
    verdict: row.verdict,
    signature: row.signature,
    approved: row.approved,
  }));
}

/**
 * Marks one arbitrator's verdict approved. Returns true when a row changed,
 * false when there is no such row or it was approved already.
 */
export async function markArbitrationApproved(transactionId, arbitratorAccountId) {
  const { rowCount } = await query(
    `UPDATE escrow_arbitrations SET approved = true
     WHERE transaction_id = $1 AND arbitrator_account_id = $2 AND approved = false`,
    [transactionId, arbitratorAccountId],
  );
  return rowCount === 1;
}

/** How many approved verdicts on this escrow say `verdict` (one of VERDICTS). */
export async function countApprovedVerdicts(transactionId, verdict) {
  const { rows } = await query(
    `SELECT count(*) AS n FROM escrow_arbitrations
     WHERE transaction_id = $1 AND approved AND verdict = $2`,
    [transactionId, verdict],
  );
  return Number(rows[0].n);
}
