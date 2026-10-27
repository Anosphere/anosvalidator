import { pool } from '../db/pool.js';
import { ESCROW_TRANSFERS } from '../held-transactions/held-transactions.js';
import { RECEIVER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { escrowSignatureKind } from './escrow-signature-kind.js';

/**
 * The escrowCancel follow-up: the buyer calling the deal off, which drops
 * the escrow unwritten.
 *
 *   payload: { type: 'escrowCancel', transactionId, accountId, signedAt }
 *
 * The signer is the buyer, the row's account_id_to. Own checks: no dispute,
 * success or cancel signature present. Stored in cancel_signature. Effect
 * on acceptance: the row moves to logs, outcome receiverCancelled.
 */
export const escrowCancel = escrowSignatureKind({
  type: 'escrowCancel',
  slot: 'cancel_signature',

  signerOf(row, signerId) {
    return signerId.equals(row.accountIdTo) ? null : 'payload.accountId is not the buyer';
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
