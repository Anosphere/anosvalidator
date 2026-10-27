import { findInSlots } from '../attachments/stored-attachments.js';
import { digestMatches } from '../crypto/hash.js';
import { ASSISTED_TRANSFERS } from '../held-transactions/held-transactions.js';
import { ATTESTOR } from '../stakes/stake-purposes.js';
import { holdsRole } from '../stakes/stakes.service.js';
import { findAssisted, markAssistedSlotApproved, setAssistedSlot } from './assisted-transfers.queries.js';

/**
 * The attestation follow-up: an attestor vouching for an assisted transfer.
 *
 *   payload: { type: 'attestation', transactionId, accountId, attestorId, signedAt }
 *
 * `accountId` is the transfer's sender and must equal the row's account_id.
 * The signer is `attestorId`, an account holding attestor stake. Own checks:
 * the attestor is not the sender, and not the attestor in the other slot.
 * Stored in attestation_1 if empty, else attestation_2 if empty, else
 * refused. No effect on acceptance beyond readiness: a transfer with both
 * attestations approved (and no cancellation) is ready for a leader round.
 *
 * The interface every kind exports, for attachments.service.js:
 *   type, table, signerField: the payload.type, the holding table and the
 *     payload field naming the signer;
 *   requiredStake(stake): null, or a reason when the signer's stake (as
 *     stakes.queries.js findStake returns it) does not qualify; or null
 *     when the kind needs no stake;
 *   checkShape(payload): a reason for the first problem with the kind's
 *     own fields, or null;
 *   verify(payload, { row, signerId, stake }): the kind's own checks
 *     against the held row; a reason or null;
 *   store(transactionId, attachment, context): stores the whole object,
 *     approved = false; { stored: true, ref } or { stored: false, reason };
 *   findStored(transactionId, attachmentId): { approved, ref } for the
 *     stored object with this attachmentId, or null;
 *   markApproved(transactionId, ref): true when a row changed;
 *   onAccepted(transactionId, ref): the kind's effect once approved here.
 */

/** The two slots an attestation may land in, in order. */
const SLOTS = ['attestation_1', 'attestation_2'];

const SLOTS_TAKEN = 'both attestation slots are taken';

export const attestation = Object.freeze({
  type: 'attestation',
  table: ASSISTED_TRANSFERS,
  signerField: 'attestorId',

  requiredStake(stake) {
    return holdsRole(stake, ATTESTOR) ? null : 'the attestor does not hold attestor stake';
  },

  checkShape(payload) {
    if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
    return null;
  },

  verify(payload, { row, signerId }) {
    if (!digestMatches(payload.accountId, row.accountId)) {
      return "payload.accountId is not the transfer's sender";
    }
    if (signerId.equals(row.accountId)) return 'payload.attestorId is the sender';
    const taken = SLOTS.filter((slot) => row.slots[slot].object !== null);
    if (taken.length === SLOTS.length) return SLOTS_TAKEN;
    for (const slot of taken) {
      if (digestMatches(row.slots[slot].object.payload.attestorId, signerId)) {
        return 'this attestor has already attested to this transfer';
      }
    }
    return null;
  },

  /** The first empty slot, in order; the WHERE ... IS NULL is the backstop for a race. */
  async store(transactionId, attachment) {
    for (const slot of SLOTS) {
      if (await setAssistedSlot(transactionId, slot, attachment)) return { stored: true, ref: slot };
    }
    return { stored: false, reason: SLOTS_TAKEN };
  },

  async findStored(transactionId, attachmentId) {
    return findInSlots(await findAssisted(transactionId), SLOTS, attachmentId);
  },

  markApproved(transactionId, slot) {
    return markAssistedSlotApproved(transactionId, slot);
  },

  /** No effect beyond readiness. */
  async onAccepted() {},
});
