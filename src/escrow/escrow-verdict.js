import { findInRows } from '../attachments/stored-attachments.js';
import { pool } from '../db/pool.js';
import { ESCROW_TRANSFERS } from '../held-transactions/held-transactions.js';
import { ARBITRATED_CANCEL, moveToArchives } from '../records/records.queries.js';
import { ATTESTOR } from '../stakes/stake-purposes.js';
import { holdsRole } from '../stakes/stakes.service.js';
import {
  DECIDING_VERDICTS,
  VERDICTS,
  countApprovedVerdicts,
  findArbitrations,
  insertArbitration,
  markArbitrationApproved,
} from './escrow.queries.js';

/**
 * The escrowVerdict follow-up: an arbitrator deciding a disputed escrow.
 *
 *   payload: { type: 'escrowVerdict', transactionId, arbitratorId, verdict, signedAt }
 *
 * The signer is `arbitratorId`, an account holding attestor stake. `verdict`
 * is 'success' or 'cancel'. Own checks: the dispute signature is approved;
 * the arbitrator is neither the seller nor the buyer; no row from this
 * arbitrator yet. Stored as an escrow_arbitrations row. The first verdict to
 * have DECIDING_VERDICTS approved rows decides the escrow: success makes it
 * ready for a leader round (escrow.queries.js findReadyEscrowIds); cancel,
 * the effect on acceptance here, moves the row and its arbitrations to
 * archives, outcome arbitratedCancel.
 *
 * The interface is described in attestation.js.
 */

const ALREADY_DECIDED = 'this arbitrator has already given a verdict on this escrow';

export const escrowVerdict = Object.freeze({
  type: 'escrowVerdict',
  table: ESCROW_TRANSFERS,
  signerField: 'arbitratorId',

  requiredStake(stake) {
    return holdsRole(stake, ATTESTOR) ? null : 'the arbitrator does not hold attestor stake';
  },

  checkShape(payload) {
    if (!VERDICTS.includes(payload.verdict)) {
      return `payload.verdict must be ${VERDICTS.map((verdict) => `"${verdict}"`).join(' or ')}`;
    }
    return null;
  },

  async verify(payload, { row, signerId }) {
    if (!row.slots.dispute_signature.approved) return 'this escrow has no approved dispute';
    if (signerId.equals(row.accountId) || signerId.equals(row.accountIdTo)) {
      return 'payload.arbitratorId is a party to the escrow';
    }
    const arbitrations = await findArbitrations(row.transactionId);
    if (arbitrations.some(({ arbitratorAccountId }) => arbitratorAccountId.equals(signerId))) return ALREADY_DECIDED;
    return null;
  },

  /** One row per arbitrator; the primary key is the backstop for a race. */
  async store(transactionId, attachment, { signerId }) {
    const stored = await insertArbitration({
      transactionId,
      arbitratorAccountId: signerId,
      verdict: attachment.payload.verdict,
      signature: attachment,
    });
    return stored ? { stored: true, ref: signerId } : { stored: false, reason: ALREADY_DECIDED };
  },

  async findStored(transactionId, attachmentId) {
    return findInRows(await findArbitrations(transactionId), 'arbitratorAccountId', attachmentId);
  },

  markApproved(transactionId, arbitratorAccountId) {
    return markArbitrationApproved(transactionId, arbitratorAccountId);
  },

  /**
   * Once DECIDING_VERDICTS approved verdicts say cancel, the escrow leaves
   * for archives with its arbitrations, unless success got there first: the
   * first verdict to reach that many decides, and a success decision leaves
   * the escrow to the next leader round.
   */
  async onAccepted(transactionId) {
    if ((await countApprovedVerdicts(transactionId, 'cancel')) < DECIDING_VERDICTS) return;
    if ((await countApprovedVerdicts(transactionId, 'success')) >= DECIDING_VERDICTS) return;
    const client = await pool.connect();
    try {
      await moveToArchives(client, ESCROW_TRANSFERS, ARBITRATED_CANCEL, transactionId);
    } finally {
      client.release();
    }
  },
});
