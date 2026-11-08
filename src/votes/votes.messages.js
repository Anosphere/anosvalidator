import { env } from '../config/env.js';
import { canonicalHash } from '../crypto/canonical.js';
import { decodeDigest, digestMatches } from '../crypto/hash.js';
import { isObject } from '../util/is-object.js';
import { postToValidators } from '../validators/validators.client.js';
import { postToPeers } from '../validators/validators.messages.js';
import {
  findActiveValidator,
  findCountedPeers,
  findIgnoredIds,
  findLeaderId,
  findNextCounted,
} from '../validators/validators.queries.js';
import { signPayload, verifyPayloadSignature } from '../validators/validators.signing.js';

/**
 * The three messages of the votes (docs/schemas.md section 19.2): how each
 * is built and signed, sent and checked. The receiving side is
 * votes.service.js. Kept apart from the service, like
 * validators.messages.js, so the originators (accounts, transfer, fund and
 * attachments) can report and wait without importing the service.
 *
 * Every message is { payload, signature }, the payload signed as its RFC
 * 8785 canonical bytes by the sender's P-256 key (validators.signing.js).
 */

/** payload.type of the vote request: the call. */
export const IGNORE_VOTE = 'ignoreVote';

/** payload.type of a vote: the answer to that call. */
export const IGNORE_VOTED = 'ignoreVoted';

/** payload.type of the proof of a passed vote. */
export const PROOF_OF_IGNORE_VOTE = 'proofOfIgnoreVote';

/** payload.type of the accepted receipt: the answer to a proof. */
export const IGNORE_VOTE_ACCEPTED = 'ignoreVoteAccepted';

/** payload.type of a report that a validator gave no answer. */
export const NO_ANSWER_REPORT = 'noAnswerReport';

/** The two directions of a vote. */
export const IGNORE = 'ignore';
export const INCLUDE = 'include';
export const ACTIONS = Object.freeze([IGNORE, INCLUDE]);

/** The two ways a voter answers. */
export const YES = 'yes';
export const NO = 'no';

/** The vote's id: the SHA-256 of the canonical payload without voteId, as a Buffer. */
export function voteIdOf(payload) {
  const { voteId, ...rest } = payload;
  return canonicalHash(rest);
}

/**
 * Builds and signs a vote request, from this validator as the starter.
 *
 *   payload: {
 *     type:         'ignoreVote'
 *     action:       'ignore' | 'include'
 *     validatorIds: [ id, ... ]   distinct, ascending
 *     voteId:       hex, the SHA-256 of the canonical payload without voteId
 *     startedBy:    this validator's id
 *     sentAt:       ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildIgnoreVoteRequest({ action, validatorIds }) {
  const unsigned = {
    type: IGNORE_VOTE,
    action,
    validatorIds: [...new Set(validatorIds)].sort((a, b) => a - b),
    startedBy: env.validator.id,
    sentAt: new Date().toISOString(),
  };
  const payload = { ...unsigned, voteId: canonicalHash(unsigned).toString('hex') };
  return { payload, signature: signPayload(payload) };
}

/**
 * Sends `request` (buildIgnoreVoteRequest) to `voters` at POST /ignore-vote
 * and checks each answer as a vote receipt (checkIgnoreVotedReceipt).
 * Resolves with one { id, vote, results, receipt } or { id, reason,
 * noAnswer? } per voter, in order. The call waits twice
 * VALIDATOR_CALL_TIMEOUT_SECONDS: a voter's own check of a silent
 * validator takes one timeout before the voter can answer.
 */
export async function sendIgnoreVote(request, voters) {
  const answers = await postToPeers(voters, '/ignore-vote', request, { timeoutSeconds: env.network.callTimeoutSeconds * 2 });
  const voteId = decodeDigest(request.payload.voteId);
  return answers.map((answer, i) => {
    const checked = checkAnswer(answer, (receipt) => checkIgnoreVotedReceipt(receipt, { from: voters[i], to: env.validator.id, voteId }));
    return checked.reason
      ? { id: voters[i].id, reason: checked.reason, ...(checked.noAnswer && { noAnswer: true }) }
      : { id: voters[i].id, vote: checked.receipt.payload.vote, results: checked.receipt.payload.results, receipt: checked.receipt };
  });
}

/**
 * Builds and signs the vote a voter answers a request with.
 *
 *   payload: {
 *     type:          'ignoreVoted'
 *     voteId:        as in the request
 *     vote:          'yes' | 'no'
 *     results:       { '<id>': 'ok' | '<reason>', ... }   one per named validator
 *     validatorFrom: this validator's id
 *     validatorTo:   the starter's id
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildIgnoreVoted({ voteId, vote, results, validatorTo }) {
  const payload = {
    type: IGNORE_VOTED,
    voteId,
    vote,
    results,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Checks a vote receipt wherever one turns up: as the answer to a request,
 * or inside a proof. `from` is the registry row it must come from, `to` the
 * id it must be addressed to, `voteId` the vote, as 32 raw bytes. In order:
 * the shape; the signature against `from`'s key; validatorFrom and
 * validatorTo; voteId. Returns null when it all holds, else a reason.
 */
export function checkIgnoreVotedReceipt(receipt, { from, to, voteId }) {
  const problem = checkIgnoreVotedShape(receipt);
  if (problem) return problem;

  const { payload, signature } = receipt;
  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return badSignature;
  if (payload.validatorFrom !== from.id) return `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}`;
  if (payload.validatorTo !== to) return `payload.validatorTo is ${payload.validatorTo}, expected ${to}`;
  if (!digestMatches(payload.voteId, voteId)) return 'payload.voteId is not the vote being answered';
  return null;
}

/** Returns a description of the first structural problem with a vote receipt, or null. */
export function checkIgnoreVotedShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== IGNORE_VOTED) return `payload.type must be "${IGNORE_VOTED}"`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (payload.vote !== YES && payload.vote !== NO) return `payload.vote must be "${YES}" or "${NO}"`;
  if (!isObject(payload.results)) return 'payload.results must be an object';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/**
 * Builds and signs the proof of a passed vote.
 *
 *   payload: {
 *     type:      'proofOfIgnoreVote'
 *     voteId
 *     request:   { payload, signature }   the request as sent
 *     receipts:  [ { payload, signature }, ... ]   every yes receipt, by validator id
 *     startedBy: this validator's id
 *     sentAt:    ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildProofOfIgnoreVote({ voteId, request, receipts }) {
  const payload = {
    type: PROOF_OF_IGNORE_VOTE,
    voteId,
    request,
    receipts,
    startedBy: env.validator.id,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Sends `proof` to `targets` at POST /proof-of-ignore-vote and checks each
 * answer as an accepted receipt. Resolves with one { id, accepted: true,
 * receipt } or { id, accepted: false, reason, noAnswer? } per target.
 */
export async function sendProofOfIgnoreVote(proof, targets) {
  const answers = await postToPeers(targets, '/proof-of-ignore-vote', proof);
  const voteId = decodeDigest(proof.payload.voteId);
  return answers.map((answer, i) => {
    const checked = checkAnswer(answer, (receipt) => checkIgnoreVoteAcceptedReceipt(receipt, { from: targets[i], to: env.validator.id, voteId }));
    return checked.reason
      ? { id: targets[i].id, accepted: false, reason: checked.reason, ...(checked.noAnswer && { noAnswer: true }) }
      : { id: targets[i].id, accepted: true, receipt: checked.receipt };
  });
}

/**
 * Builds and signs the accepted receipt a validator answers a proof with.
 *
 *   payload: {
 *     type:          'ignoreVoteAccepted'
 *     voteId
 *     validatorFrom: this validator's id
 *     validatorTo:   the starter's id
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export function buildIgnoreVoteAccepted({ voteId, validatorTo }) {
  const payload = {
    type: IGNORE_VOTE_ACCEPTED,
    voteId,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/** Checks an accepted receipt: the shape, the signature, from, to, voteId. Null when it all holds, else a reason. */
export function checkIgnoreVoteAcceptedReceipt(receipt, { from, to, voteId }) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== IGNORE_VOTE_ACCEPTED) return `payload.type must be "${IGNORE_VOTE_ACCEPTED}"`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';

  const badSignature = verifyPayloadSignature(payload, signature, from);
  if (badSignature) return badSignature;
  if (payload.validatorFrom !== from.id) return `payload.validatorFrom is ${payload.validatorFrom}, expected ${from.id}`;
  if (payload.validatorTo !== to) return `payload.validatorTo is ${payload.validatorTo}, expected ${to}`;
  if (!digestMatches(payload.voteId, voteId)) return 'payload.voteId is not the vote being accepted';
  return null;
}

/**
 * Sends a report that `validatorIds` gave no answer: to the leader per
 * this validator's own table, or, when the leader is among the ids or gives
 * no answer to the report, to the next counted validator in the ring after
 * the leader (validators.queries.js findNextCounted). Logs where it went
 * and what came back; resolves with nothing.
 *
 *   payload: {
 *     type:         'noAnswerReport'
 *     validatorIds: [ id, ... ]   distinct, ascending
 *     reporter:     this validator's id
 *     sentAt:       ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendNoAnswerReport(validatorIds) {
  const ids = [...new Set(validatorIds)].sort((a, b) => a - b);
  const payload = { type: NO_ANSWER_REPORT, validatorIds: ids, reporter: env.validator.id, sentAt: new Date().toISOString() };
  const report = { payload, signature: signPayload(payload) };

  const leaderId = await findLeaderId();
  if (leaderId === null) {
    console.log(`no answer report for validator${plural(ids)} ${ids.join(', ')}: no leader known`);
    return;
  }
  let target = ids.includes(leaderId) ? await findNextCounted(leaderId) : leaderId;
  let answer = await postReport(report, target);
  if (answer.noAnswer && target === leaderId) {
    target = await findNextCounted(leaderId);
    answer = await postReport(report, target);
  }
  const outcome = answer.noAnswer ? `no answer: ${answer.reason}` : `answered ${answer.status}`;
  console.log(`no answer report for validator${plural(ids)} ${ids.join(', ')} sent to validator ${target}: ${outcome}`);
}

async function postReport(report, target) {
  const row = target === null ? null : await findActiveValidator(target);
  if (!row) return { noAnswer: true, reason: `validator ${target} is not an active validator` };
  const [answer] = await postToValidators([row], '/no-answer-report', report);
  return answer;
}

/**
 * What an originator does with approvals that got no answer (section
 * 19.1): `approvals` are the per-validator results of an approval send
 * (validators.messages.js). The validators that gave no answer are
 * reported; then the own table is polled once a second, for at most
 * NO_ANSWER_WAIT_SECONDS, until every one of them is ignored; then the
 * approval goes once more, through `resend(peers)`, to the ones still
 * counted. Resolves with the approvals to go on with: the first answers
 * without the silent validators, plus the second answers, in id order. A
 * second no answer is logged (`validator N gave no answer twice`) and
 * stays an entry with approved: false, so the caller treats it as a
 * refusal; a validator ignored meanwhile drops out of the list.
 */
export async function settleNoAnswers(approvals, resend) {
  const silent = approvals.filter((approval) => approval.noAnswer).map((approval) => approval.id);
  if (silent.length === 0) return approvals;

  await sendNoAnswerReport(silent);
  const deadline = Date.now() + env.network.noAnswerWaitSeconds * 1000;
  let ignored = await findIgnoredIds();
  while (!silent.every((id) => ignored.includes(id)) && Date.now() < deadline) {
    await sleep(1000);
    ignored = await findIgnoredIds();
  }

  const peers = (await findCountedPeers(env.validator.id)).filter((peer) => silent.includes(peer.id));
  const again = peers.length === 0 ? [] : await resend(peers);
  for (const answer of again) {
    if (answer.noAnswer) console.log(`validator ${answer.id} gave no answer twice`);
  }
  return approvals
    .filter((approval) => !silent.includes(approval.id))
    .concat(again)
    .sort((a, b) => a.id - b.id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plural(ids) {
  return ids.length > 1 ? 's' : '';
}

/**
 * One validator's answer to a vote call: { id, url, status, body } from
 * postToValidators, checked by `check` as a receipt of the expected kind.
 * Returns { receipt } when it is, else { reason } with noAnswer when the
 * validator gave none.
 */
function checkAnswer(answer, check) {
  if (answer.noAnswer) return { reason: `no answer: ${answer.reason}`, noAnswer: true };
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }
  const reason = check(receipt);
  return reason ? { reason } : { receipt };
}

/** Returns a description of the first structural problem with a vote request, or null. */
export function checkIgnoreVoteShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== IGNORE_VOTE) return `payload.type must be "${IGNORE_VOTE}"`;
  if (!ACTIONS.includes(payload.action)) return `payload.action must be "${IGNORE}" or "${INCLUDE}"`;
  const ids = checkIdList(payload.validatorIds);
  if (ids) return `payload.validatorIds ${ids}`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!Number.isInteger(payload.startedBy) || payload.startedBy < 1) return 'payload.startedBy must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of a vote, or null. */
export function checkProofOfIgnoreVoteShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_IGNORE_VOTE) return `payload.type must be "${PROOF_OF_IGNORE_VOTE}"`;
  if (typeof payload.voteId !== 'string') return 'payload.voteId must be a string';
  if (!isObject(payload.request) || !isObject(payload.request.payload) || !isObject(payload.request.signature)) {
    return 'payload.request must be an object with an object payload and an object signature';
  }
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (!Number.isInteger(payload.startedBy) || payload.startedBy < 1) return 'payload.startedBy must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a no-answer report, or null. */
export function checkNoAnswerReportShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== NO_ANSWER_REPORT) return `payload.type must be "${NO_ANSWER_REPORT}"`;
  const ids = checkIdList(payload.validatorIds);
  if (ids) return `payload.validatorIds ${ids}`;
  if (!Number.isInteger(payload.reporter) || payload.reporter < 1) return 'payload.reporter must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** The rule every list of validator ids meets: a non-empty array of positive integers, distinct, ascending. Null or a reason. */
export function checkIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'must be a non-empty array';
  for (const [i, id] of ids.entries()) {
    if (!Number.isInteger(id) || id < 1) return 'must hold positive integers';
    if (i > 0 && id <= ids[i - 1]) return 'must be distinct and ascending';
  }
  return null;
}
