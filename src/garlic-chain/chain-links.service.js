import { env } from '../config/env.js';
import { isObject } from '../util/is-object.js';
import { postToValidators } from '../validators/validators.client.js';
import { findActiveValidator } from '../validators/validators.queries.js';
import { signPayload, verifyPayloadSignature } from '../validators/validators.signing.js';
import { findLinksAfter } from './chain-links.queries.js';

/**
 * The chain chunk read: how a validator that is behind asks another for the
 * links it misses, at most CHAIN_CHUNK_LINKS at a time, and how the other
 * answers (docs/schemas.md section 19). Both sides are here: sendChainLinks
 * asks one validator and checks the answer, receiveChainLinks checks a
 * request and reads the links. Replaying what came back is
 * replay.service.js. A validator-to-validator message like the others
 * (validators/validators.messages.js): { payload, signature }, the payload
 * signed as its RFC 8785 canonical bytes by the sender's P-256 key.
 */

/** payload.type of the chunk read: the call. */
export const CHAIN_LINKS = 'chainLinks';

/** payload.type of a chain links list: the answer to that call. */
export const CHAIN_LINKS_LIST = 'chainLinksList';

/**
 * Asks `validator` (a registry row, { id, url, publicKey }) at
 * POST /chain-links for the links above `afterPosition`, at most `limit`,
 * and checks the answer as a receipt is checked: a 200, the shape, the
 * signature against the registry key of the validator asked, validatorFrom
 * that validator, validatorTo this one, and afterPosition the one asked.
 * Resolves with { links } (ascending, at most limit, each as
 * chain-links.queries.js findLinksAfter shapes them) or { reason }, with
 * noAnswer: true when the validator gave no answer.
 *
 *   payload: {
 *     type:          'chainLinks'
 *     validator:     this validator's id
 *     afterPosition: integer >= 0, the own tail's position
 *     limit:         integer 1..CHAIN_CHUNK_LINKS
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function sendChainLinks(validator, { afterPosition, limit }) {
  const payload = {
    type: CHAIN_LINKS,
    validator: env.validator.id,
    afterPosition,
    limit,
    sentAt: new Date().toISOString(),
  };
  const request = { payload, signature: signPayload(payload) };

  const [answer] = await postToValidators([validator], '/chain-links', request);
  if (answer.noAnswer) return { reason: `no answer: ${answer.reason}`, noAnswer: true };
  if (answer.status !== 200) return { reason: `answered ${answer.status}: ${answer.body}` };

  let receipt;
  try {
    receipt = JSON.parse(answer.body);
  } catch {
    return { reason: 'answer is not JSON' };
  }
  const problem = checkListShape(receipt);
  if (problem) return { reason: problem };

  const badSignature = verifyPayloadSignature(receipt.payload, receipt.signature, validator);
  if (badSignature) return { reason: badSignature };
  if (receipt.payload.validatorFrom !== validator.id) {
    return { reason: `payload.validatorFrom is ${receipt.payload.validatorFrom}, expected ${validator.id}` };
  }
  if (receipt.payload.validatorTo !== env.validator.id) {
    return { reason: `payload.validatorTo is ${receipt.payload.validatorTo}, expected ${env.validator.id}` };
  }
  if (receipt.payload.afterPosition !== afterPosition) {
    return { reason: `payload.afterPosition is ${receipt.payload.afterPosition}, expected ${afterPosition}` };
  }
  return { links: receipt.payload.links };
}

/**
 * Handles a chunk read from another validator. Checks, in order: the shape;
 * that `limit` is at most CHAIN_CHUNK_LINKS; that `validator` is an active
 * row of this validator's own registry, ignored or not (a joiner is ignored
 * while it catches up), and that the signature verifies against that row's
 * key. Then reads the links above `afterPosition`, ascending, at most
 * `limit`, and answers them. Returns { ok: true, receipt } with the signed
 * chain links list, or { ok: false, reason }.
 *
 *   payload: {
 *     type:          'chainLinksList'
 *     validatorFrom: this validator's id (the one that was asked)
 *     validatorTo:   the asker's id
 *     afterPosition: as asked
 *     links:         [ { position, accountId, accountIdTo, transactionId, amount,
 *                        transHash, recordHash, type, createdAt, ogTransaction }, ... ]
 *     sentAt:        ISO 8601 timestamp
 *   }
 *   signature: { key }
 */
export async function receiveChainLinks(body) {
  const problem = checkChainLinksShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;
  if (payload.limit > env.network.chainChunkLinks) {
    return { ok: false, reason: `payload.limit must be at most ${env.network.chainChunkLinks}` };
  }

  const sender = await findActiveValidator(payload.validator);
  if (!sender) return { ok: false, reason: `validator ${payload.validator} is not an active validator` };
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  const links = await findLinksAfter(payload.afterPosition, payload.limit);
  const answer = {
    type: CHAIN_LINKS_LIST,
    validatorFrom: env.validator.id,
    validatorTo: payload.validator,
    afterPosition: payload.afterPosition,
    links,
    sentAt: new Date().toISOString(),
  };
  return { ok: true, receipt: { payload: answer, signature: signPayload(answer) } };
}

/** Returns a description of the first structural problem with a chunk read, or null. */
export function checkChainLinksShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== CHAIN_LINKS) return `payload.type must be "${CHAIN_LINKS}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) {
    return 'payload.validator must be a positive integer';
  }
  if (!Number.isInteger(payload.afterPosition) || payload.afterPosition < 0) {
    return 'payload.afterPosition must be an integer of 0 or more';
  }
  if (!Number.isInteger(payload.limit) || payload.limit < 1) return 'payload.limit must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a chain links list, or null. */
function checkListShape(receipt) {
  if (!isObject(receipt)) return 'receipt must be a JSON object';
  if (!isObject(receipt.payload)) return 'payload must be an object';
  if (!isObject(receipt.signature)) return 'signature must be an object';

  const { payload, signature } = receipt;
  if (payload.type !== CHAIN_LINKS_LIST) return `payload.type must be "${CHAIN_LINKS_LIST}"`;
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (!Number.isInteger(payload.afterPosition)) return 'payload.afterPosition must be an integer';
  if (!Array.isArray(payload.links)) return 'payload.links must be an array';
  for (const [i, link] of payload.links.entries()) {
    const bad = checkLinkShape(link);
    if (bad) return `payload.links[${i}]: ${bad}`;
  }
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with one link of a list, or null. */
function checkLinkShape(link) {
  if (!isObject(link)) return 'must be an object';
  if (!Number.isInteger(link.position) || link.position < 1) return 'position must be a positive integer';
  for (const field of ['accountId', 'accountIdTo']) {
    if (link[field] !== null && typeof link[field] !== 'string') return `${field} must be a string or null`;
  }
  for (const field of ['transactionId', 'amount', 'transHash', 'recordHash', 'type', 'createdAt']) {
    if (typeof link[field] !== 'string') return `${field} must be a string`;
  }
  if (!isObject(link.ogTransaction) || !isObject(link.ogTransaction.payload)) {
    return 'ogTransaction must be an object with an object payload';
  }
  return null;
}
