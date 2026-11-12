import { pool } from '../db/pool.js';
import { ESCROW_TRANSFERS } from '../held-transactions/held-transactions.js';
import { RECEIVER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { canBeSentInAgain } from '../transfer/transfer.service.js';
import { escrowSignatureKind } from './escrow-signature-kind.js';

const NOT_YET = 'this trade cannot be cancelled yet';

/**
 * The escrowCancel follow-up: the buyer calling the deal off, which drops
 * the escrow unwritten.
 *
 *   payload: { type: 'escrowCancel', transactionId, accountId, signedAt }
 *
 * The signer is the buyer, the row's account_id_to. Own checks: the wait,
 * and no dispute, success or cancel signature present. The wait
 * (2026-11-11, docs/schemas.md section 27): an escrow is not cancelled
 * while the validators would still take the same signed escrow transfer in
 * again (transfer.service.js canBeSentInAgain: its date no more than
 * LOCK_OFFSET_MINUTES behind), refused with "this trade cannot be
 * cancelled yet". So a cancelled trade can never be sent in again. Stored
 * in cancel_signature. Effect on acceptance: the row moves to logs,
 * outcome receiverCancelled.
 */
export const escrowCancel = escrowSignatureKind({
  type: 'escrowCancel',
  slot: 'cancel_signature',

  signerOf(row, signerId) {
    return signerId.equals(row.accountIdTo) ? null : 'payload.accountId is not the buyer';
  },

  /** The wait: an escrow transfer that could still be sent in again is not cancelled yet. */
  check(row) {
    return canBeSentInAgain(row.ogTransaction.payload) ? NOT_YET : null;
  },

  /** The escrow leaves for logs, cancelled by its buyer. */
  async onAccepted(transactionId) {
    const client = await pool.connect();
    try {
      await moveToLogs(client, ESCROW_TRANSFERS, RECEIVER_CANCELLED, transactionId);
    } finally {
      client.release();
    }
  },
});
