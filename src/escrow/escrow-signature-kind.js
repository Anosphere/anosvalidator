import { findInSlots } from '../attachments/stored-attachments.js';
import { ESCROW_TRANSFERS } from '../held-transactions/held-transactions.js';
import { ESCROW_SLOTS, findEscrow, markEscrowSlotApproved, setEscrowSlot } from './escrow.queries.js';

/**
 * What the three escrow signatures (escrow-success.js, escrow-cancel.js,
 * escrow-dispute.js) have in common. Each is
 *
 *   payload: { type, transactionId, accountId, signedAt }
 *
 * for an escrowTransfer, signed by `accountId`, a party to the escrow; no
 * stake is needed. Each has one slot of escrow_transfers, and the own check
 * of each is the same: no success, cancel or dispute signature present yet,
 * so between success and cancel the first stored wins, since each blocks
 * the other, and a dispute blocks both. What differs is who may sign
 * (`signerOf`), one more check of the kind's own when it has one (`check`:
 * the escrowCancel's wait) and the effect on acceptance (`onAccepted`).
 *
 * The interface built here is described in attestation.js.
 */

/** The slot's name in a reason, e.g. 'a success signature'. */
function describe(slot) {
  return `a ${slot.replace('_', ' ')}`;
}

/**
 * Builds one escrow signature kind: `type` the payload.type, `slot` its
 * escrow_transfers column, `signerOf(row, signerId)` null when the signer
 * may sign for this escrow or a reason, `check(row)`, which a kind may
 * leave out, one more check of its own against the row, null or a reason
 * (2026-11-11: the escrowCancel's wait, escrow-cancel.js), and
 * `onAccepted(transactionId)` the effect once approved on this validator.
 * `verify` runs `check` after `signerOf` and before it walks over the
 * slots; a kind that passes none is checked as before.
 */
export function escrowSignatureKind({ type, slot, signerOf, check, onAccepted }) {
  return Object.freeze({
    type,
    table: ESCROW_TRANSFERS,
    signerField: 'accountId',
    requiredStake: null,

    checkShape() {
      return null;
    },

    verify(payload, { row, signerId }) {
      const bad = signerOf(row, signerId);
      if (bad) return bad;
      const own = check ? check(row) : null;
      if (own) return own;
      for (const other of ESCROW_SLOTS) {
        if (row.slots[other].object !== null) return `${describe(other)} is already present`;
      }
      return null;
    },

    async store(transactionId, attachment) {
      const stored = await setEscrowSlot(transactionId, slot, attachment);
      return stored ? { stored: true, ref: slot } : { stored: false, reason: `${describe(slot)} is already present` };
    },

    async findStored(transactionId, attachmentId) {
      return findInSlots(await findEscrow(transactionId), [slot], attachmentId);
    },

    markApproved(transactionId, ref) {
      return markEscrowSlotApproved(transactionId, ref);
    },

    onAccepted,
  });
}
