import { findInSlots } from '../attachments/stored-attachments.js';
import { pool } from '../db/pool.js';
import { LOCKED_TRANSACTIONS } from '../held-transactions/held-transactions.js';
import { USER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { canBeSentInAgain } from '../transfer/transfer.service.js';
import { findLocked, markLockedCancellationApproved, setLockedCancellation } from './locked-transactions.queries.js';

/**
 * The lockedTransferCancel follow-up: the sender taking a guarded or vault
 * transfer back while it waits out its lock (2026-11-11, docs/schemas.md
 * section 28).
 *
 *   payload: { type: 'lockedTransferCancel', transactionId, accountId, signedAt }
 *
 * The signer is `accountId`, the row's account_id, the sender, under any
 * two pairs; no stake is needed. Own checks: the signer is the sender, the
 * wait, and no cancellation present. The wait (docs/schemas.md section
 * 27.2): a transfer is not cancelled while the validators would still take
 * the same signed transfer in again (transfer.service.js canBeSentInAgain:
 * its date still at least its lock ahead), refused with "this transfer
 * cannot be cancelled yet". A cancelled row moves to logs, where the
 * validators do not look when a transfer comes in, so without the wait the
 * same signed transfer could be posted again and the row would be back.
 * With it a cancelled transfer can never be sent in again. Only guarded
 * and vault transfers are held in locked_transactions, so the function
 * always decides by the lock of the transfer's type here. After the wait
 * the cancel is accepted until the transfer is written, through its lock
 * and after it until a leader round writes it; readiness excludes rows
 * with a cancellation present (findDueIds). Stored in the cancellation
 * slot. Effect on acceptance: the row moves to logs, outcome
 * userCancelled.
 *
 * The interface is described in assisted-transfers/attestation.js.
 */

const SLOT = 'cancellation';

const PRESENT = 'a cancellation is already present';

const NOT_YET = 'this transfer cannot be cancelled yet';

export const lockedTransferCancel = Object.freeze({
  type: 'lockedTransferCancel',
  table: LOCKED_TRANSACTIONS,
  signerField: 'accountId',
  requiredStake: null,

  checkShape() {
    return null;
  },

  verify(payload, { row, signerId }) {
    if (!signerId.equals(row.accountId)) return "payload.accountId is not the transfer's sender";
    // The wait: a transfer that could still be sent in again is not
    // cancelled yet.
    if (canBeSentInAgain(row.ogTransaction.payload)) return NOT_YET;
    if (row.slots[SLOT].object !== null) return PRESENT;
    return null;
  },

  async store(transactionId, attachment) {
    const stored = await setLockedCancellation(transactionId, attachment);
    return stored ? { stored: true, ref: SLOT } : { stored: false, reason: PRESENT };
  },

  async findStored(transactionId, attachmentId) {
    return findInSlots(await findLocked(transactionId), [SLOT], attachmentId);
  },

  markApproved(transactionId) {
    return markLockedCancellationApproved(transactionId);
  },

  /** The transfer leaves for logs, cancelled by its sender. */
  async onAccepted(transactionId) {
    const client = await pool.connect();
    try {
      await moveToLogs(client, LOCKED_TRANSACTIONS, USER_CANCELLED, transactionId);
    } finally {
      client.release();
    }
  },
});
