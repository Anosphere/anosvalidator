import { escrowSignatureKind } from './escrow-signature-kind.js';

/**
 * The escrowSuccess follow-up: the seller confirming the buyer paid, which
 * releases the escrow.
 *
 *   payload: { type: 'escrowSuccess', transactionId, accountId, signedAt }
 *
 * The signer is the seller, the row's account_id. Own checks: no dispute,
 * cancel or success signature present. Stored in success_signature.
 * Approved, it makes the escrow ready for a leader round; nothing else
 * happens on acceptance.
 */
export const escrowSuccess = escrowSignatureKind({
  type: 'escrowSuccess',
  slot: 'success_signature',

  signerOf(row, signerId) {
    return signerId.equals(row.accountId) ? null : 'payload.accountId is not the seller';
  },

  /** No effect beyond readiness. */
  async onAccepted() {},
});
