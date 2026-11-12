import { findInSlots } from '../attachments/stored-attachments.js';
import { pool } from '../db/pool.js';
import { ASSISTED_TRANSFERS } from '../held-transactions/held-transactions.js';
import { USER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { ASSISTED_ANOS_TRANSFER, canBeSentInAgain } from '../transfer/transfer.service.js';
import { findAssisted, markAssistedSlotApproved, setAssistedSlot } from './assisted-transfers.queries.js';

/**
 * The assistedTransferCancel follow-up: the sender taking an assisted
 * transfer back.
 *
 *   payload: { type: 'assistedTransferCancel', transactionId, accountId, signedAt }
 *
 * The signer is `accountId`, the row's account_id, the sender; no stake is
 * needed. Own checks: the wait, and no cancellation present. The wait
 * (2026-11-11, docs/schemas.md section 27): an assisted transfer is not
 * cancelled while the validators would still take the same signed transfer
 * in again (transfer.service.js canBeSentInAgain: its date no more than
 * LOCK_OFFSET_MINUTES behind), refused with "this transfer cannot be
 * cancelled yet". So a cancelled transfer can never be sent in again.
 * After the wait it is accepted until the transfer is written, even when
 * both attestations are approved; readiness excludes rows with a
 * cancellation present. Stored in the cancellation slot. Effect on
 * acceptance: the row moves to logs, outcome userCancelled. Accepted on a
 * break-glass move's row (breakGlassTransfer, docs/schemas.md section 22)
 * as on an assisted transfer's, without the wait, which is for an assisted
 * transfer alone, so an owner who still has their device stops a false
 * move with the account's own keys under any two pairs.
 *
 * The interface is described in attestation.js.
 */

const SLOT = 'cancellation';

const PRESENT = 'a cancellation is already present';

const NOT_YET = 'this transfer cannot be cancelled yet';

export const assistedTransferCancel = Object.freeze({
  type: 'assistedTransferCancel',
  table: ASSISTED_TRANSFERS,
  signerField: 'accountId',
  requiredStake: null,

  checkShape() {
    return null;
  },

  verify(payload, { row, signerId }) {
    if (!signerId.equals(row.accountId)) return "payload.accountId is not the transfer's sender";
    // The wait: an assisted transfer that could still be sent in again is not
    // cancelled yet. A break-glass move's row is left as it was.
    const transfer = row.ogTransaction?.payload;
    if (transfer?.transactionType === ASSISTED_ANOS_TRANSFER && canBeSentInAgain(transfer)) return NOT_YET;
    if (row.slots[SLOT].object !== null) return PRESENT;
    return null;
  },

  async store(transactionId, attachment) {
    const stored = await setAssistedSlot(transactionId, SLOT, attachment);
    return stored ? { stored: true, ref: SLOT } : { stored: false, reason: PRESENT };
  },

  async findStored(transactionId, attachmentId) {
    return findInSlots(await findAssisted(transactionId), [SLOT], attachmentId);
  },

  markApproved(transactionId, slot) {
    return markAssistedSlotApproved(transactionId, slot);
  },

  /** The transfer leaves for logs, cancelled by its sender. */
  async onAccepted(transactionId) {
    const client = await pool.connect();
    try {
      await moveToLogs(client, ASSISTED_TRANSFERS, USER_CANCELLED, transactionId);
    } finally {
      client.release();
    }
  },
});
