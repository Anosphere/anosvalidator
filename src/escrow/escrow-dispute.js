import { escrowSignatureKind } from './escrow-signature-kind.js';

/**
 * The escrowDispute follow-up: either party handing the escrow to the
 * arbitrators.
 *
 *   payload: { type: 'escrowDispute', transactionId, accountId, signedAt }
 *
 * The signer is the seller or the buyer, the row's account_id or
 * account_id_to. Own checks: no success, cancel or dispute signature
 * present. Stored in dispute_signature. From then on only verdicts
 * (escrow-verdict.js) move the escrow; nothing else happens on acceptance.
 */
export const escrowDispute = escrowSignatureKind({
  type: 'escrowDispute',
  slot: 'dispute_signature',

  signerOf(row, signerId) {
    return signerId.equals(row.accountId) || signerId.equals(row.accountIdTo)
      ? null
      : 'payload.accountId is neither the seller nor the buyer';
  },

  /** No effect: the verdicts decide from here. */
  async onAccepted() {},
});
