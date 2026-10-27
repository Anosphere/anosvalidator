import { ANY_TWO_PAIRS, verifyAccountSignatures } from '../accounts/account-signatures.js';
import { assistedTransferCancel } from '../assisted-transfers/assisted-transfer-cancel.js';
import { attestation } from '../assisted-transfers/attestation.js';
import { canonicalHash, canonicalize } from '../crypto/canonical.js';
import { decodeDigest, digestMatches } from '../crypto/hash.js';
import { escrowCancel } from '../escrow/escrow-cancel.js';
import { escrowDispute } from '../escrow/escrow-dispute.js';
import { escrowSuccess } from '../escrow/escrow-success.js';
import { escrowVerdict } from '../escrow/escrow-verdict.js';
import { guardianVote } from '../fund/guardian-vote.js';
import { HELD_TABLES, findHeld } from '../held-transactions/held-transactions.js';
import { findStake } from '../stakes/stakes.queries.js';
import { findAccount } from '../transfer/transfer.queries.js';
import { isObject } from '../util/is-object.js';
import {
  ATTACHMENT_APPROVAL,
  PROOF_OF_ATTACHMENT_ACCEPTANCE,
  buildAttachmentAccepted,
  buildAttachmentApproved,
  checkAttachmentApprovedReceipt,
  checkAttachmentApprovedShape,
  sendAttachmentApproval,
  sendProofOfAttachmentAcceptance,
} from '../validators/validators.messages.js';
import { findActiveValidator, findActiveValidators } from '../validators/validators.queries.js';
import { verifyPayloadSignature } from '../validators/validators.signing.js';

/**
 * Follow-ups, or attachments: signed objects attached to a transaction that
 * is waiting in a holding table. Every follow-up is { payload, signatures }:
 *
 *   payload: {
 *     type:          the kind, one of the seven KINDS
 *     transactionId: the held transaction it attaches to
 *     <signer>:      the signer's account id, under the field the kind names
 *     signedAt:      ISO 8601, recorded, not compared with the clock
 *     ...the kind's own fields
 *   }
 *   signatures: the signer's account keys, any two pairs
 *
 * This module is the flow every kind shares: the checks of each follow-up,
 * in order, and its way round the validators, which mirrors a transaction's
 * (validators.service.js receiveTransactionApproval and
 * receiveProofOfAcceptance) with the attachment messages of
 * validators.messages.js. The kinds themselves, one module each, supply
 * what differs: the table, the signer field, the stake required, their own
 * checks, where the object is stored and the effect once it is approved.
 * The interface is described in assisted-transfers/attestation.js.
 *
 * Validators identify a follow-up by its attachmentId, the SHA-256 of its
 * canonical payload, which they compute; the signer does not send it.
 */

/** The seven kinds, every one a peer accepts in an attachment approval. */
export const KINDS = Object.freeze([
  attestation,
  assistedTransferCancel,
  guardianVote,
  escrowSuccess,
  escrowCancel,
  escrowDispute,
  escrowVerdict,
]);

/**
 * What the validator a signer sent a follow-up to does with it. `kinds` are
 * the kinds the endpoint allows; the follow-up's payload.type picks one.
 *
 * The checks, in order (verifyAttachment): the shape; the held row exists in
 * the kind's table and is approved on this validator; the signer's account
 * exists and holds the stake the kind requires, if any; the signatures
 * verify against that account's keys; the kind's own checks. Then the kind
 * stores the object with approved = false (a slot or row taken in the
 * meantime refuses it), and it goes round: an attachment approval to every
 * other active validator, each answer checked as an attachment approved
 * receipt; then, if every one approved, the own copy is marked approved, the
 * proof of attachment acceptance bundling the receipts goes to everyone, and
 * the kind's effect is applied here.
 *
 * Returns { ok: false, reason }, or { ok: true, transactionId, approvals,
 * approved, proof } exactly as the transaction flows do, so the handlers
 * log alike: the held transaction's id as the signer sent it, one
 * { id, approved, reason? } per validator called, whether every one
 * approved, and, when they did, one { id, accepted, reason? } per validator
 * the proof went to. Written as if nothing can fail, like them.
 */
export async function receiveAttachment(body, kinds) {
  const verified = await verifyAttachment(body, kinds);
  if (!verified.ok) return verified;

  const { kind, transactionId, attachmentId, context } = verified;
  const stored = await kind.store(transactionId, body, context);
  if (!stored.stored) return { ok: false, reason: stored.reason };

  const approvals = await sendAttachmentApproval({ attachment: body, transactionId, attachmentId });
  const outcome = { ok: true, transactionId: body.payload.transactionId, approvals };
  if (!approvals.every((approval) => approval.approved)) {
    return { ...outcome, approved: false };
  }

  // Every validator approved: our own copy first, then tell them all, then
  // whatever the kind does once approved.
  await kind.markApproved(transactionId, stored.ref);
  const proof = await sendProofOfAttachmentAcceptance({
    transactionId: body.payload.transactionId,
    attachmentId: attachmentId.toString('hex'),
    receipts: approvals.map((approval) => approval.receipt),
  });
  await kind.onAccepted(transactionId, stored.ref);
  return { ...outcome, approved: true, proof };
}

/**
 * Handles an attachment approval from another validator, the peers' side
 * of receiveAttachment, mirroring validators.service.js
 * receiveTransactionApproval. Checks, in order:
 *   1. the shape of the message;
 *   2. originatingValidator is an active validator in this validator's own
 *      registry, and the signature verifies against that row's key;
 *   3. attachmentId is the hash of the embedded follow-up's payload;
 *   4. the embedded follow-up passes every check the originating validator
 *      ran (verifyAttachment, any of the seven kinds), against this
 *      validator's own database, and transactionId is the one it names;
 *   5. the kind stores it here, approved = false.
 * Returns { ok: true, receipt } with the signed attachment approved receipt
 * to answer with, or { ok: false, reason }.
 */
export async function receiveAttachmentApproval(body) {
  const problem = checkApprovalShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;

  // 2. Who sent it, and did they really.
  const sender = await findActiveValidator(payload.originatingValidator);
  if (!sender) {
    return { ok: false, reason: `originatingValidator ${payload.originatingValidator} is not an active validator` };
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  // 3. The id is the hash of what it carries.
  if (!digestMatches(payload.attachmentId, canonicalHash(payload.attachment.payload))) {
    return { ok: false, reason: 'payload.attachmentId is not the hash of payload.attachment.payload' };
  }

  // 4. The follow-up itself, same checks as the originating validator.
  const verified = await verifyAttachment(payload.attachment, KINDS);
  if (!verified.ok) return { ok: false, reason: `attachment: ${verified.reason}` };
  if (!digestMatches(payload.transactionId, verified.transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the transaction payload.attachment names' };
  }

  // 5. Store it, exactly as the originating validator did.
  const stored = await verified.kind.store(verified.transactionId, payload.attachment, verified.context);
  if (!stored.stored) return { ok: false, reason: `attachment: ${stored.reason}` };

  return {
    ok: true,
    receipt: buildAttachmentApproved({
      transactionId: payload.transactionId,
      attachmentId: payload.attachmentId,
      validatorTo: payload.originatingValidator,
    }),
  };
}

/**
 * Handles a proof of attachment acceptance from the originating validator,
 * mirroring validators.service.js receiveProofOfAcceptance. Checks, in
 * order:
 *   1. the shape of the proof;
 *   2. originatingValidator is an active validator here, and the signature
 *      verifies against that row's key;
 *   3. this validator holds this attachment for this transaction
 *      (locateAttachment), not yet approved;
 *   4. every receipt is an attachment approved receipt genuinely signed by
 *      an active validator other than the originating one, addressed to the
 *      originating validator, for this transaction and attachment, with no
 *      validator twice;
 *   5. there is a receipt from every active validator other than the
 *      originating one.
 * The registry is read once, up front. If all of it holds, the attachment
 * is marked approved here and the kind's effect applied.
 *
 * Returns { ok: true, receipt } with the signed attachment accepted receipt
 * to answer with, or { ok: false, reason }.
 */
export async function receiveProofOfAttachmentAcceptance(body) {
  const problem = checkProofShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;

  // 2. Who sent it, and did they really.
  const validators = await findActiveValidators();
  const sender = validators.get(payload.originatingValidator);
  if (!sender) {
    return { ok: false, reason: `originatingValidator ${payload.originatingValidator} is not an active validator` };
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  // 3. An attachment we hold and have not approved yet.
  const transactionId = decodeDigest(payload.transactionId);
  if (!transactionId) return { ok: false, reason: 'payload.transactionId is not a SHA-256 digest' };
  const attachmentId = decodeDigest(payload.attachmentId);
  if (!attachmentId) return { ok: false, reason: 'payload.attachmentId is not a SHA-256 digest' };
  const located = await locateAttachment(transactionId, attachmentId);
  if (!located) return { ok: false, reason: 'no held attachment with this attachmentId for this transactionId' };
  if (located.approved) return { ok: false, reason: 'this attachment is already approved' };

  // 4. Each receipt, and who it is from.
  const seen = new Set();
  for (const [i, receipt] of payload.receipts.entries()) {
    const shape = checkAttachmentApprovedShape(receipt);
    if (shape) return { ok: false, reason: `receipts[${i}]: ${shape}` };

    const from = validators.get(receipt.payload.validatorFrom);
    if (!from) {
      return { ok: false, reason: `receipts[${i}]: validatorFrom ${receipt.payload.validatorFrom} is not an active validator` };
    }
    if (from.id === payload.originatingValidator) {
      return { ok: false, reason: `receipts[${i}]: a receipt from the originating validator itself` };
    }
    if (seen.has(from.id)) {
      return { ok: false, reason: `receipts[${i}]: a second receipt from validator ${from.id}` };
    }
    const bad = checkAttachmentApprovedReceipt(receipt, {
      from,
      to: payload.originatingValidator,
      transactionId,
      attachmentId,
    });
    if (bad) return { ok: false, reason: `receipts[${i}]: ${bad}` };

    seen.add(from.id);
  }

  // 5. Nobody missing.
  const missing = [...validators.keys()].filter((id) => id !== payload.originatingValidator && !seen.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: `no receipt from validator${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  }

  // Approved here, then the kind's effect. The mark is false only if another
  // request got here first.
  const marked = await located.kind.markApproved(transactionId, located.ref);
  if (!marked) return { ok: false, reason: 'this attachment is already approved' };
  await located.kind.onAccepted(transactionId, located.ref);

  return {
    ok: true,
    receipt: buildAttachmentAccepted({
      transactionId: payload.transactionId,
      attachmentId: payload.attachmentId,
      validatorTo: payload.originatingValidator,
    }),
  };
}

/**
 * The checks every follow-up gets, in order: the shape, common and the
 * kind's own; the ids decode; the held row exists in the kind's table and
 * is approved here; the signer's account exists and its stake qualifies,
 * when the kind requires stake; the signatures, any two pairs, against that
 * account's keys; the kind's own checks against the row. Returns
 * { ok: true, kind, transactionId, attachmentId, context } with the ids as
 * 32-byte Buffers and the context ({ row, signerId, stake }) the kind's
 * store takes, or { ok: false, reason }.
 */
async function verifyAttachment(body, kinds) {
  const shape = checkAttachmentShape(body, kinds);
  if (shape.reason) return { ok: false, reason: shape.reason };

  const { kind } = shape;
  const { payload, signatures } = body;
  const transactionId = decodeDigest(payload.transactionId);
  if (!transactionId) return { ok: false, reason: 'payload.transactionId is not a SHA-256 digest' };
  const signerId = decodeDigest(payload[kind.signerField]);
  if (!signerId) return { ok: false, reason: `payload.${kind.signerField} is not a SHA-256 digest` };

  // The held transaction, approved here.
  const row = await HELD_TABLES[kind.table].find(transactionId);
  if (!row) return { ok: false, reason: `no ${kind.table} transaction with this transactionId` };
  if (!row.approved) return { ok: false, reason: 'this transaction is not approved yet' };

  // The signer, and its stake when the kind needs one.
  const signer = await findAccount(signerId);
  if (!signer) return { ok: false, reason: `no account with this ${kind.signerField}` };
  let stake = null;
  if (kind.requiredStake) {
    stake = await findStake(signerId);
    const badStake = kind.requiredStake(stake);
    if (badStake) return { ok: false, reason: badStake };
  }

  // The signatures.
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const badSignatures = verifyAccountSignatures(signer, signatures, message, ANY_TWO_PAIRS);
  if (badSignatures) return { ok: false, reason: badSignatures };

  // The kind's own checks.
  const context = { row, signerId, stake };
  const own = await kind.verify(payload, context);
  if (own) return { ok: false, reason: own };

  return { ok: true, kind, transactionId, attachmentId: canonicalHash(payload), context };
}

/**
 * Finds the stored follow-up with this attachmentId for this transaction:
 * the holding table that has the transaction says which kinds to ask, and
 * each kind looks through what it stored (findStored). Returns
 * { kind, approved, ref } or null.
 */
async function locateAttachment(transactionId, attachmentId) {
  const held = await findHeld(transactionId);
  if (!held) return null;
  for (const kind of KINDS) {
    if (kind.table !== held.table) continue;
    const stored = await kind.findStored(transactionId, attachmentId);
    if (stored) return { kind, ...stored };
  }
  return null;
}

/**
 * The common shape of a follow-up, then the kind's own. Returns { kind } for
 * the kind payload.type names among `kinds`, or { reason } for the first
 * problem.
 */
function checkAttachmentShape(body, kinds) {
  if (!isObject(body)) return { reason: 'body must be a JSON object' };
  if (!isObject(body.payload)) return { reason: 'payload must be an object' };
  const { payload } = body;
  const kind = kinds.find((candidate) => candidate.type === payload.type);
  if (!kind) {
    return { reason: `payload.type must be ${kinds.map(({ type }) => `"${type}"`).join(' or ')}` };
  }
  if (typeof payload.transactionId !== 'string') return { reason: 'payload.transactionId must be a string' };
  if (typeof payload[kind.signerField] !== 'string') return { reason: `payload.${kind.signerField} must be a string` };
  if (typeof payload.signedAt !== 'string') return { reason: 'payload.signedAt must be a string' };
  const own = kind.checkShape(payload);
  if (own) return { reason: own };
  if (!isObject(body.signatures)) return { reason: 'signatures must be an object' };
  return { kind };
}

/** Returns a description of the first structural problem with an attachment approval, or null. */
function checkApprovalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== ATTACHMENT_APPROVAL) return `payload.type must be "${ATTACHMENT_APPROVAL}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!isObject(payload.attachment)) return 'payload.attachment must be an object';
  if (!isObject(payload.attachment.payload)) return 'payload.attachment.payload must be an object';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of attachment acceptance, or null. */
function checkProofShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_ATTACHMENT_ACCEPTANCE) return `payload.type must be "${PROOF_OF_ATTACHMENT_ACCEPTANCE}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}
