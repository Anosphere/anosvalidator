import { query } from '../db/pool.js';
import { DECIDING_VERDICTS } from '../escrow/escrow.queries.js';

/**
 * SQL for the reads feature: what an account may read about itself (wallet
 * spec 5.4). Ids are Buffers of 32 raw bytes, matching the BYTEA columns;
 * pg sends a Buffer parameter as bytea and hands BIGINT columns over as
 * decimal strings, so no amount is ever a JavaScript number.
 */

/** The account's type, balance (a decimal string of millionths) and created_at, or null when there is no such account. */
export async function findAccountSummary(accountId) {
  const { rows } = await query(
    'SELECT type, current_balance, created_at FROM accounts WHERE account_id = $1',
    [accountId],
  );
  if (rows.length === 0) return null;
  return { type: rows[0].type, balance: rows[0].current_balance, createdAt: rows[0].created_at };
}

/**
 * The transaction_id of the garlic chain link with the highest position whose
 * account_id is this account (its creation, then each transfer it sent), or
 * null when it has none: what the account's next transfer names as
 * previousTransactionId.
 */
export async function findLatestTransactionId(accountId) {
  const { rows } = await query(
    `SELECT transaction_id FROM garlic_chain
     WHERE account_id = $1
     ORDER BY position DESC
     LIMIT 1`,
    [accountId],
  );
  return rows.length === 0 ? null : rows[0].transaction_id;
}

/**
 * The garlic chain links where account_id or account_id_to is this account,
 * position descending, below `beforePosition` when it is not null, at most
 * `limit` rows. Each row: transaction_id, position, type, account_id,
 * account_id_to, amount, created_at, as the columns are.
 */
export async function findTransactions(accountId, beforePosition, limit) {
  const { rows } = await query(
    `SELECT transaction_id, position, type, account_id, account_id_to, amount, created_at
     FROM garlic_chain
     WHERE (account_id = $1 OR account_id_to = $1)
       AND ($2::bigint IS NULL OR position < $2::bigint)
     ORDER BY position DESC
     LIMIT $3`,
    [accountId, beforePosition, limit],
  );
  return rows;
}

/** The account's pending row (there is at most one): transaction_id, og_transaction, approved, created_at; or null. */
export async function findPendingFor(accountId) {
  const { rows } = await query(
    'SELECT transaction_id, og_transaction, approved, created_at FROM pending WHERE account_id = $1',
    [accountId],
  );
  return rows.length === 0 ? null : rows[0];
}

/**
 * The assisted transfers waiting for attestors (spec 13.2): approved on
 * this validator, no cancellation present, and an attestation slot still
 * empty; newest first by created_at. Each row: transaction_id,
 * og_transaction, attestation_1, attestation_2, created_at, as the columns
 * are (a slot holds a whole attestation object, or null while empty).
 */
export async function findAssistedWaitingForAttestors() {
  const { rows } = await query(
    `SELECT transaction_id, og_transaction, attestation_1, attestation_2, created_at
     FROM assisted_transfers
     WHERE approved AND cancellation IS NULL AND (attestation_1 IS NULL OR attestation_2 IS NULL)
     ORDER BY created_at DESC`,
  );
  return rows;
}

/**
 * The disputed escrows no verdict has decided (spec 13.2): approved on this
 * validator, the dispute signature approved, and no value of verdict with
 * DECIDING_VERDICTS approved escrow_arbitrations rows; newest first by
 * created_at. Each row: transaction_id, og_transaction, dispute_signature,
 * created_at, and verdicts, the escrow's escrow_arbitrations rows in
 * arbitrator_account_id order as a JSON array of { arbitratorId (hex),
 * verdict, approved }, empty when it has none.
 */
export async function findUndecidedDisputedEscrows() {
  const { rows } = await query(
    `SELECT e.transaction_id, e.og_transaction, e.dispute_signature, e.created_at,
            COALESCE((SELECT json_agg(json_build_object('arbitratorId', encode(a.arbitrator_account_id, 'hex'),
                                                        'verdict', a.verdict,
                                                        'approved', a.approved)
                                      ORDER BY a.arbitrator_account_id)
                      FROM escrow_arbitrations a
                      WHERE a.transaction_id = e.transaction_id), '[]'::json) AS verdicts
     FROM escrow_transfers e
     WHERE e.approved
       AND e.dispute_signature_approved
       AND NOT EXISTS (SELECT 1 FROM escrow_arbitrations a
                       WHERE a.transaction_id = e.transaction_id AND a.approved
                       GROUP BY a.verdict
                       HAVING count(*) >= $1)
     ORDER BY e.created_at DESC`,
    [DECIDING_VERDICTS],
  );
  return rows;
}
