import { findInSlots } from '../attachments/stored-attachments.js';
import { pool } from '../db/pool.js';
import { ASSISTED_TRANSFERS } from '../held-transactions/held-transactions.js';
import { USER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { findAssisted, markAssistedSlotApproved, setAssistedSlot } from './assisted-transfers.queries.js';

/**
 * The assistedTransferCancel follow-up: the sender taking an assisted
 * transfer back.
 *
 *   payload: { type: 'assistedTransferCancel', transactionId, accountId, signedAt }
 *
 * The signer is `accountId`, the row's account_id, the sender; no stake is
 * needed. Own check: no cancellation present. Accepted until the transfer is
 * written, even when both attestations are approved; readiness excludes
 * rows with a cancellation present. Stored in the cancellation slot. Effect
 * on acceptance: the row moves to logs, outcome userCancelled.
 *
 * The interface is described in attestation.js.
 */

const SLOT = 'cancellation';

const PRESENT = 'a cancellation is already present';

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
