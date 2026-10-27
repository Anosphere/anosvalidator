import { env } from '../config/env.js';
import { decodeDigest, digestMatches } from '../crypto/hash.js';
import { isObject } from '../util/is-object.js';
import { postToValidators } from './validators.client.js';
import { findActivePeers } from './validators.queries.js';
import { signPayload, verifyPayloadSignature } from './validators.signing.js';

/**
 * The messages validators exchange: how each is built and signed, and, for a
 * message that answers a call, how the answer is checked. The receiving side
 * of each call is in validators.service.js. Kept apart from the service so
 * the accounts feature can send without the two features importing each
 * other in a loop.
 *
 * Every message is { payload, signature }. The payload is signed as its RFC
 * 8785 canonical bytes by the sender's P-256 key (validators.signing.js).
 * All three payloads share a header: transactionId, type, the sender's id
 * and sentAt.
 */

/** payload.type of a transaction approval receipt: the call. */
export const TRANSACTION_APPROVAL = 'transactionApproval';

/** payload.type of a transaction approved receipt: the answer to that call. */
export const TRANSACTION_APPROVED = 'transactionApproved';

/** payload.type of a proof of transaction acceptance. */
export const PROOF_OF_ACCEPTANCE = 'proofOfTransactionAcceptance';

/** payload.type of a transaction accepted receipt: the answer to a proof of acceptance. */
export const TRANSACTION_ACCEPTED = 'transactionAccepted';

/**
 * Sends a transaction approval receipt for `transaction` (a submission this
 * validator has verified and put into pending; `transactionId` is its id as
 * 32 raw bytes) to every other active validator at POST /transaction-approval,
 * waits for all of them, and checks each answer as a transaction approved
 * receipt (checkTransactionApproved). Resolves with one
 * { id, approved: true, receipt } or { id, approved: false, reason } per
 * validator called, in ascending id order.
 *
 * Receipt shape; the payload is what is signed:
 *
 *   payload: {
 *     transaction:          the whole submission as received ({ payload, signatures })
 *     type:                 'transactionApproval'
 *     originatingValidator: this validator's id
 *     transactionId:        the transaction's id, as the submitter sent it
 *     sentAt:               ISO 8601 timestamp
 *   }
 *   signature: { key }   hex, by this validator's P-256 key
 */
export async function sendTransactionApproval({ transaction, transactionId }) {
  const payload = {
    transaction,
    type: TRANSACTION_APPROVAL,
    originatingValidator: env.validator.id,
    transactionId: transaction.payload.transactionId,
    sentAt: new Date().toISOString(),
  };
  const receipt = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/transaction-approval', receipt);

  return answers.map((answer, i) => {
    const checked = checkTransactionApproved(answer, { from: peers[i], transactionId });
    return checked.reason
      ? { id: peers[i].id, approved: false, reason: checked.reason }
      : { id: peers[i].id, approved: true, receipt: checked.receipt };
  });
}

/**
 * Builds and signs the transaction approved receipt a validator answers a
 * transaction approval call with, once the transaction is in its own pending.
 *
 *   payload: {
 *     transactionId: the id of the transaction being approved, as received
 *     type:          'transactionApproved'
 *     validatorFrom: this validator's id (the one that was called)
 *     validatorTo:   the originating validator's id (who the answer goes to)
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildTransactionApproved({ transactionId, validatorTo }) {
  const payload = {
    transactionId,
    type: TRANSACTION_APPROVED,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Builds and signs the transaction accepted receipt a validator answers a
 * proof of transaction acceptance with, once it has marked the transaction
 * approved in its own pending. Same schema as the transaction approved
 * receipt.
 *
 *   payload: {
 *     transactionId: the id of the transaction accepted, as received
 *     type:          'transactionAccepted'
 *     validatorFrom: this validator's id (the one the proof was sent to)
 *     validatorTo:   the originating validator's id (who the answer goes to)
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildTransactionAccepted({ transactionId, validatorTo }) {
  const payload = {
    transactionId,
    type: TRANSACTION_ACCEPTED,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Checks one validator's answer to a transaction approval call. `answer` is
 * { id, url, status, body } from postToValidators, `from` the registry row of
 * the validator that was called, and `transactionId` the id this validator is
 * working on, as 32 raw bytes. The answer must be a 200 whose JSON body is a
 * transaction approved receipt from that validator to this one for that
 * transaction (checkApprovedReceipt). Returns { receipt } when it is, else
 * { reason }.
 */
export function checkTransactionApproved(answer, { from, transactionId }) {
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }
  const reason = checkApprovedReceipt(receipt, { from, to: env.validator.id, transactionId });
  return reason ? { reason } : { receipt };
}

/**
 * Checks a transaction approved receipt wherever one turns up: as the answer
 * to an approval call, or inside a proof of acceptance. `from` is the registry
 * row of the validator it must come from, `to` the id it must be addressed
 * to, `transactionId` the transaction it must approve, as 32 raw bytes. In
 * order: the shape; the signature against `from`'s key; validatorFrom and
 * validatorTo; the transaction. Returns null when it all holds, else a reason.
 */
export function checkApprovedReceipt(receipt, { from, to, transactionId }) {
  const problem = checkApprovedShape(receipt);
  if (problem) return problem;

  const { payload, signature } = receipt;
  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return badSignature;

  if (payload.validatorFrom !== from.id) {
    return `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}`;
  }
  if (payload.validatorTo !== to) {
    return `payload.validatorTo is ${payload.validatorTo}, expected ${to}`;
  }
  if (!digestMatches(payload.transactionId, transactionId)) {
    return 'payload.transactionId is not the transaction being approved';
  }
  return null;
}

/** Returns a description of the first structural problem with an approved receipt, or null. */
export function checkApprovedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== TRANSACTION_APPROVED) return `payload.type must be "${TRANSACTION_APPROVED}"`;
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/**
 * Sends a proof of transaction acceptance to every other active validator at
 * POST /proof-of-acceptance, once every one of them has answered the approval
 * call with a valid transaction approved receipt and this validator has marked
 * its own pending row approved. `receipts` are those answers, untouched, in
 * ascending validator order. Waits for all of them and checks each answer as
 * a transaction accepted receipt (checkTransactionAccepted). Resolves with
 * one { id, accepted: true, receipt } or { id, accepted: false, reason } per
 * validator called, in ascending id order.
 *
 *   payload: {
 *     transactionId:        the transaction being accepted, as the submitter sent it
 *     type:                 'proofOfTransactionAcceptance'
 *     originatingValidator: this validator's id
 *     sentAt:               ISO 8601 timestamp
 *     receipts:             [ { payload, signature }, ... ]  one approved receipt per other validator
 *   }
 *   signature: { key }
 */
export async function sendProofOfAcceptance({ transactionId, receipts }) {
  const payload = {
    transactionId,
    type: PROOF_OF_ACCEPTANCE,
    originatingValidator: env.validator.id,
    sentAt: new Date().toISOString(),
    receipts,
  };
  const proof = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/proof-of-acceptance', proof);

  // The checks compare ids as bytes; the payload carried the submitter's string.
  const transactionIdBytes = decodeDigest(transactionId);
  return answers.map((answer, i) => {
    const checked = checkTransactionAccepted(answer, { from: peers[i], transactionId: transactionIdBytes });
    return checked.reason
      ? { id: peers[i].id, accepted: false, reason: checked.reason }
      : { id: peers[i].id, accepted: true, receipt: checked.receipt };
  });
}

/**
 * Checks one validator's answer to a proof of acceptance. `answer` is
 * { id, url, status, body } from postToValidators, `from` the registry row of
 * the validator the proof went to, and `transactionId` the id this validator
 * is working on, as 32 raw bytes. The answer must be a 200 whose JSON body is
 * a transaction accepted receipt from that validator to this one for that
 * transaction (checkAcceptedReceipt). Returns { receipt } when it is, else
 * { reason }.
 */
export function checkTransactionAccepted(answer, { from, transactionId }) {
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }
  const reason = checkAcceptedReceipt(receipt, { from, to: env.validator.id, transactionId });
  return reason ? { reason } : { receipt };
}

/**
 * Checks a transaction accepted receipt. `from` is the registry row of the
 * validator it must come from, `to` the id it must be addressed to,
 * `transactionId` the transaction it must accept, as 32 raw bytes. In order:
 * the shape; the signature against `from`'s key; validatorFrom and
 * validatorTo; the transaction. Returns null when it all holds, else a reason.
 */
export function checkAcceptedReceipt(receipt, { from, to, transactionId }) {
  const problem = checkAcceptedShape(receipt);
  if (problem) return problem;

  const { payload, signature } = receipt;
  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return badSignature;

  if (payload.validatorFrom !== from.id) {
    return `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}`;
  }
  if (payload.validatorTo !== to) {
    return `payload.validatorTo is ${payload.validatorTo}, expected ${to}`;
  }
  if (!digestMatches(payload.transactionId, transactionId)) {
    return 'payload.transactionId is not the transaction being accepted';
  }
  return null;
}

/** Returns a description of the first structural problem with an accepted receipt, or null. */
export function checkAcceptedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== TRANSACTION_ACCEPTED) return `payload.type must be "${TRANSACTION_ACCEPTED}"`;
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** payload.type of an attachment approval: the call that carries a follow-up to the other validators. */
export const ATTACHMENT_APPROVAL = 'attachmentApproval';

/** payload.type of an attachment approved receipt: the answer to that call. */
export const ATTACHMENT_APPROVED = 'attachmentApproved';

/** payload.type of a proof of attachment acceptance. */
export const PROOF_OF_ATTACHMENT_ACCEPTANCE = 'proofOfAttachmentAcceptance';

/** payload.type of an attachment accepted receipt: the answer to a proof of attachment acceptance. */
export const ATTACHMENT_ACCEPTED = 'attachmentAccepted';

/**
 * The four attachment messages: the transaction messages above, for a
 * follow-up (src/attachments/attachments.service.js). Each carries the held
 * transaction's id and the follow-up's attachmentId, the SHA-256 of its
 * canonical payload, as hex; otherwise they are built and checked exactly
 * as the transaction messages are.
 *
 * Sends an attachment approval for `attachment` (a follow-up this validator
 * has verified and stored; `transactionId` the held transaction's id and
 * `attachmentId` the follow-up's, both as 32 raw bytes) to every other
 * active validator at POST /attachment-approval, waits for all of them, and
 * checks each answer as an attachment approved receipt. Resolves with one
 * { id, approved: true, receipt } or { id, approved: false, reason } per
 * validator called, in ascending id order.
 *
 *   payload: {
 *     attachment:           the follow-up exactly as received ({ payload, signatures })
 *     type:                 'attachmentApproval'
 *     originatingValidator: this validator's id
 *     transactionId:        the held transaction's id, as the attachment names it
 *     attachmentId:         the SHA-256 of the attachment's canonical payload, hex
 *     sentAt:               ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendAttachmentApproval({ attachment, transactionId, attachmentId }) {
  const payload = {
    attachment,
    type: ATTACHMENT_APPROVAL,
    originatingValidator: env.validator.id,
    transactionId: attachment.payload.transactionId,
    attachmentId: attachmentId.toString('hex'),
    sentAt: new Date().toISOString(),
  };
  const approval = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/attachment-approval', approval);

  return answers.map((answer, i) => {
    const checked = checkAttachmentAnswer(answer, ATTACHMENT_APPROVED, { from: peers[i], transactionId, attachmentId });
    return checked.reason
      ? { id: peers[i].id, approved: false, reason: checked.reason }
      : { id: peers[i].id, approved: true, receipt: checked.receipt };
  });
}

/**
 * Builds and signs the attachment approved receipt a validator answers an
 * attachment approval with, once the follow-up is stored in its own tables.
 *
 *   payload: {
 *     transactionId: the held transaction's id, as received
 *     attachmentId:  the follow-up's id, as received
 *     type:          'attachmentApproved'
 *     validatorFrom: this validator's id (the one that was called)
 *     validatorTo:   the originating validator's id (who the answer goes to)
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildAttachmentApproved({ transactionId, attachmentId, validatorTo }) {
  return buildAttachmentReceipt(ATTACHMENT_APPROVED, { transactionId, attachmentId, validatorTo });
}

/**
 * Builds and signs the attachment accepted receipt a validator answers a
 * proof of attachment acceptance with, once it has marked the follow-up
 * approved. Same schema as the attachment approved receipt, type
 * 'attachmentAccepted'.
 */
export function buildAttachmentAccepted({ transactionId, attachmentId, validatorTo }) {
  return buildAttachmentReceipt(ATTACHMENT_ACCEPTED, { transactionId, attachmentId, validatorTo });
}

/**
 * Sends a proof of attachment acceptance to every other active validator at
 * POST /proof-of-attachment-acceptance, once every one of them has answered
 * the approval with a valid attachment approved receipt and this validator
 * has marked its own copy approved. `transactionId` and `attachmentId` are
 * hex, as the wire carries them; `receipts` are those answers, untouched, in
 * ascending validator order. Waits for all of them and checks each answer as
 * an attachment accepted receipt. Resolves with one
 * { id, accepted: true, receipt } or { id, accepted: false, reason } per
 * validator called, in ascending id order.
 *
 *   payload: {
 *     transactionId:        the held transaction's id
 *     attachmentId:         the follow-up's id
 *     type:                 'proofOfAttachmentAcceptance'
 *     originatingValidator: this validator's id
 *     sentAt:               ISO 8601 timestamp
 *     receipts:             [ { payload, signature }, ... ]  one approved receipt per other validator
 *   }
 *   signature: { key }
 */
export async function sendProofOfAttachmentAcceptance({ transactionId, attachmentId, receipts }) {
  const payload = {
    transactionId,
    attachmentId,
    type: PROOF_OF_ATTACHMENT_ACCEPTANCE,
    originatingValidator: env.validator.id,
    sentAt: new Date().toISOString(),
    receipts,
  };
  const proof = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/proof-of-attachment-acceptance', proof);

  // The checks compare ids as bytes; the payload carried them as hex.
  const ids = { transactionId: decodeDigest(transactionId), attachmentId: decodeDigest(attachmentId) };
  return answers.map((answer, i) => {
    const checked = checkAttachmentAnswer(answer, ATTACHMENT_ACCEPTED, { from: peers[i], ...ids });
    return checked.reason
      ? { id: peers[i].id, accepted: false, reason: checked.reason }
      : { id: peers[i].id, accepted: true, receipt: checked.receipt };
  });
}

/**
 * Checks an attachment approved receipt wherever one turns up: as the answer
 * to an approval, or inside a proof of attachment acceptance. `from` is the
 * registry row of the validator it must come from, `to` the id it must be
 * addressed to, `transactionId` and `attachmentId` what it must approve, as
 * 32 raw bytes. Returns null when it all holds, else a reason.
 */
export function checkAttachmentApprovedReceipt(receipt, { from, to, transactionId, attachmentId }) {
  return checkAttachmentReceipt(receipt, ATTACHMENT_APPROVED, { from, to, transactionId, attachmentId });
}

/** Returns a description of the first structural problem with an attachment approved receipt, or null. */
export function checkAttachmentApprovedShape(receipt) {
  return checkAttachmentReceiptShape(receipt, ATTACHMENT_APPROVED);
}

function buildAttachmentReceipt(type, { transactionId, attachmentId, validatorTo }) {
  const payload = {
    transactionId,
    attachmentId,
    type,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Checks one validator's answer to an attachment call. `answer` is
 * { id, url, status, body } from postToValidators, `type` the receipt type
 * the answer must be, `from` the registry row of the validator that was
 * called, `transactionId` and `attachmentId` the ids this validator is
 * working on, as 32 raw bytes. The answer must be a 200 whose JSON body is a
 * receipt of that type from that validator to this one for those ids.
 * Returns { receipt } when it is, else { reason }.
 */
function checkAttachmentAnswer(answer, type, { from, transactionId, attachmentId }) {
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }
  const reason = checkAttachmentReceipt(receipt, type, { from, to: env.validator.id, transactionId, attachmentId });
  return reason ? { reason } : { receipt };
}

/**
 * Checks an attachment receipt of `type`: the shape; the signature against
 * `from`'s key; validatorFrom and validatorTo; the transaction and the
 * attachment. Returns null when it all holds, else a reason.
 */
function checkAttachmentReceipt(receipt, type, { from, to, transactionId, attachmentId }) {
  const problem = checkAttachmentReceiptShape(receipt, type);
  if (problem) return problem;

  const { payload, signature } = receipt;
  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return badSignature;

  if (payload.validatorFrom !== from.id) {
    return `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}`;
  }
  if (payload.validatorTo !== to) {
    return `payload.validatorTo is ${payload.validatorTo}, expected ${to}`;
  }
  if (!digestMatches(payload.transactionId, transactionId)) {
    return 'payload.transactionId is not the transaction the attachment is for';
  }
  if (!digestMatches(payload.attachmentId, attachmentId)) {
    return 'payload.attachmentId is not the attachment being approved';
  }
  return null;
}

/** Returns a description of the first structural problem with an attachment receipt of `type`, or null. */
function checkAttachmentReceiptShape(receipt, type) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== type) return `payload.type must be "${type}"`;
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.attachmentId !== 'string') return 'payload.attachmentId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** payload.type of the leader's ready announcement: the call. */
export const READY_ANNOUNCEMENT = 'readyAnnouncement';

/** payload.type of an approved pending list: the answer to a ready announcement. */
export const APPROVED_PENDING_LIST = 'approvedPendingList';

/** payload.type of the leader's official list: the call. */
export const OFFICIAL_LIST = 'officialList';

/** payload.type of a written receipt: the answer to an official list. */
export const TRANSACTIONS_WRITTEN = 'transactionsWritten';

/** payload.type of the leader's final declaration: the call. */
export const FINAL_DECLARATION = 'finalDeclaration';

/**
 * Sends the leader's ready announcement to every other active validator at
 * POST /ready-announcement, waits for all of them, and checks each answer as
 * an approved pending list (checkListAnswer). Resolves with one
 * { id, transactionIds } or { id, reason } per validator called, in
 * ascending id order.
 *
 *   payload: {
 *     type:   'readyAnnouncement'
 *     leader: this validator's id
 *     sentAt: ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendReadyAnnouncement() {
  const payload = {
    type: READY_ANNOUNCEMENT,
    leader: env.validator.id,
    sentAt: new Date().toISOString(),
  };
  const announcement = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/ready-announcement', announcement);

  return answers.map((answer, i) => {
    const checked = checkListAnswer(answer, { type: APPROVED_PENDING_LIST, from: peers[i] });
    return checked.reason
      ? { id: peers[i].id, reason: checked.reason }
      : { id: peers[i].id, transactionIds: checked.receipt.payload.transactionIds };
  });
}

/**
 * Sends the leader's official list to every other active validator at
 * POST /official-list, waits for all of them, and checks each answer as a
 * written receipt (checkListAnswer). Resolves with one { id, transactionIds }
 * (the ids that validator wrote) or { id, reason } per validator called, in
 * ascending id order.
 *
 *   payload: {
 *     type:           'officialList'
 *     leader:         this validator's id
 *     transactionIds: [ hex, ... ]  the transactions to write, in id order
 *     sentAt:         ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendOfficialList(transactionIds) {
  const payload = {
    type: OFFICIAL_LIST,
    leader: env.validator.id,
    transactionIds,
    sentAt: new Date().toISOString(),
  };
  const list = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  const answers = await postToValidators(peers, '/official-list', list);

  return answers.map((answer, i) => {
    const checked = checkListAnswer(answer, { type: TRANSACTIONS_WRITTEN, from: peers[i] });
    return checked.reason
      ? { id: peers[i].id, reason: checked.reason }
      : { id: peers[i].id, transactionIds: checked.receipt.payload.transactionIds };
  });
}

/**
 * Sends the leader's final declaration to every other active validator at
 * POST /final-declaration and waits for all of them. Resolves with the raw
 * answers, one { id, url, status, body } per validator called.
 *
 *   payload: {
 *     type:           'finalDeclaration'
 *     leader:         this validator's id
 *     transactionIds: [ hex, ... ]  the official list, now written everywhere
 *     nextLeader:     the id of the validator that leads next
 *     sentAt:         ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendFinalDeclaration({ transactionIds, nextLeader }) {
  const payload = {
    type: FINAL_DECLARATION,
    leader: env.validator.id,
    transactionIds,
    nextLeader,
    sentAt: new Date().toISOString(),
  };
  const declaration = { payload, signature: signPayload(payload) };

  const peers = await findActivePeers(env.validator.id);
  return postToValidators(peers, '/final-declaration', declaration);
}

/**
 * Builds and signs the two answers that carry a list of transaction ids: the
 * approved pending list ('approvedPendingList', answering a ready
 * announcement with every approved pending transaction, in id order) and
 * the written receipt ('transactionsWritten', answering an official list
 * with the ids just written).
 *
 *   payload: {
 *     type:           'approvedPendingList' | 'transactionsWritten'
 *     validatorFrom:  this validator's id (the one that was called)
 *     validatorTo:    the leader's id (who the answer goes to)
 *     transactionIds: [ hex, ... ]
 *     sentAt:         ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildListReceipt(type, { transactionIds, validatorTo }) {
  const payload = {
    type,
    validatorFrom: env.validator.id,
    validatorTo,
    transactionIds,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Checks one validator's answer to a leader call. `answer` is
 * { id, url, status, body } from postToValidators, `type` the answer's
 * payload.type, `from` the registry row of the validator that was called.
 * The answer must be a 200 whose JSON body is a list receipt of that type,
 * signed by that validator, from it, to this one. Returns { receipt } when
 * it is, else { reason }.
 */
function checkListAnswer(answer, { type, from }) {
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }

  const problem = checkListShape(receipt, type);
  if (problem) return { reason: problem };

  const { payload, signature } = receipt;
  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return { reason: badSignature };
  if (payload.validatorFrom !== from.id) {
    return { reason: `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}` };
  }
  if (payload.validatorTo !== env.validator.id) {
    return { reason: `payload.validatorTo is ${payload.validatorTo}, expected ${env.validator.id}` };
  }
  return { receipt };
}

/** Returns a description of the first structural problem with a list receipt of `type`, or null. */
function checkListShape(receipt, type) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== type) return `payload.type must be "${type}"`;
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (!Array.isArray(payload.transactionIds)) return 'payload.transactionIds must be an array';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}
