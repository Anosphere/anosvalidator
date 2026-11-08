import { BREAK_GLASS_PAIR } from '../accounts/account-signatures.js';
import { findInSlots } from '../attachments/stored-attachments.js';
import { pool } from '../db/pool.js';
import { ASSISTED_TRANSFERS } from '../held-transactions/held-transactions.js';
import { USER_CANCELLED, moveToLogs } from '../records/records.queries.js';
import { BREAK_GLASS_TRANSFER } from '../transfer/transfer.service.js';
import { findAssisted, markAssistedSlotApproved, setAssistedSlot } from './assisted-transfers.queries.js';

/**
 * The breakGlassCancel follow-up: the break-glass pair taking a break-glass
 * move back (docs/schemas.md section 22).
 *
 *   payload: { type: 'breakGlassCancel', transactionId, accountId, signedAt }
 *
 * The signer is `accountId`, the row's account_id, the sender, under the
 * break-glass rule: the break-glass pair alone (`rule`, which
 * attachments.service.js checkAttachmentSignatures reads in place of any
 * two pairs); no stake is needed. Own checks: the row's transaction is a
 * breakGlassTransfer, and no cancellation present. Accepted until the move
 * is written, even when both attestations are approved; readiness excludes
 * rows with a cancellation present. Stored in the cancellation slot, as the
 * assistedTransferCancel is, which the account's own keys may still attach
 * to a break-glass row under any two pairs. Effect on acceptance: the row
 * moves to logs, outcome userCancelled.
 *
 * The interface is described in attestation.js.
 */

const SLOT = 'cancellation';

const PRESENT = 'a cancellation is already present';

export const breakGlassCancel = Object.freeze({
  type: 'breakGlassCancel',
  table: ASSISTED_TRANSFERS,
  signerField: 'accountId',
  requiredStake: null,
  rule: BREAK_GLASS_PAIR,

  checkShape() {
    return null;
  },

  verify(payload, { row, signerId }) {
    if (!signerId.equals(row.accountId)) return "payload.accountId is not the transfer's sender";
    if (row.ogTransaction?.payload?.transactionType !== BREAK_GLASS_TRANSFER) return 'not a break-glass transfer';
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

  /** The move leaves for logs, cancelled by the break-glass pair. */
  async onAccepted(transactionId) {
    const client = await pool.connect();
    try {
      await moveToLogs(client, ASSISTED_TRANSFERS, USER_CANCELLED, transactionId);
    } finally {
      client.release();
    }
  },
});
