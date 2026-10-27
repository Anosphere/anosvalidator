import { canonicalHash } from '../crypto/canonical.js';

/**
 * Finding a stored follow-up by its attachmentId, the SHA-256 of its
 * canonical payload, which the validators compute and the signer never
 * sends. A proof of attachment acceptance names a follow-up by that id
 * alone, so each kind looks through what it has stored for the transaction
 * and hashes each stored object's payload. Two helpers, one per way of
 * storing: in a slot of the held row (assisted_transfers, escrow_transfers)
 * or as a row of a child table (guardian_votes, escrow_arbitrations).
 */

/**
 * The slot of `row` (a holding table's row with `slots`, as
 * assisted-transfers.queries.js and escrow.queries.js return it; null when
 * there is no row) among `slotNames` whose stored object's payload hashes to
 * `attachmentId` (32 raw bytes). Returns { approved, ref } with `ref` the
 * slot name, which markApproved takes, or null.
 */
export function findInSlots(row, slotNames, attachmentId) {
  if (!row) return null;
  for (const slot of slotNames) {
    const { object, approved } = row.slots[slot];
    if (object !== null && canonicalHash(object.payload).equals(attachmentId)) {
      return { approved, ref: slot };
    }
  }
  return null;
}

/**
 * The row of `rows` (votes or arbitrations, each with the stored object as
 * `signature` and its approved flag) whose stored object's payload hashes to
 * `attachmentId` (32 raw bytes). Returns { approved, ref } with `ref` the
 * row's `refField` (the signer's account id), which markApproved takes, or
 * null.
 */
export function findInRows(rows, refField, attachmentId) {
  for (const row of rows) {
    if (canonicalHash(row.signature.payload).equals(attachmentId)) {
      return { approved: row.approved, ref: row[refField] };
    }
  }
  return null;
}
