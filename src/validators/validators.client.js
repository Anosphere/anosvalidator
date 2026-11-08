import { env } from '../config/env.js';
import { isObject } from '../util/is-object.js';

/**
 * HTTP to the other validators. A message is one JSON body POSTed to the
 * same path on each validator, all in parallel, with the answers collected
 * in the same order as `validators`.
 *
 * Every call has a timeout, VALIDATOR_CALL_TIMEOUT_SECONDS
 * (env.network.callTimeoutSeconds). A validator that refuses the
 * connection, drops it, or does not answer within the timeout, or whose
 * body cannot be read, gives no answer: that never rejects the call any
 * more. The peer's entry says so, with the reason, and the other entries
 * come back as before. No retries here; what a caller does with no answer
 * is its own (docs/schemas.md section 19).
 */

/** The timeout of every call, in milliseconds. */
const TIMEOUT_MS = env.network.callTimeoutSeconds * 1000;

/** Why a call got no answer: fetch's message, with its cause when it has one. */
function reasonOf(err) {
  return err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
}

/**
 * POSTs `body` to `path` on every validator in `validators`. Resolves with
 * one entry per validator, in order: { id, url, status, body } with the
 * body as text, or { id, url, noAnswer: true, reason } when that validator
 * gave no answer. `timeoutSeconds`, optional, replaces the timeout for
 * this call: the vote request waits twice the usual, since a voter's own
 * check of a silent validator takes one timeout before it answers.
 */
export async function postToValidators(validators, path, body, { timeoutSeconds } = {}) {
  const json = JSON.stringify(body);
  const timeoutMs = timeoutSeconds === undefined ? TIMEOUT_MS : timeoutSeconds * 1000;
  return Promise.all(
    validators.map(async ({ id, url }) => {
      try {
        const response = await fetch(url + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json,
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { id, url, status: response.status, body: await response.text() };
      } catch (err) {
        return { id, url, noAnswer: true, reason: reasonOf(err) };
      }
    }),
  );
}

/**
 * GETs `path` on one validator ({ id, url }) with the same timeout.
 * Resolves with { status, body }, the body parsed as JSON, or
 * { noAnswer: true, reason } when the validator gave no answer or its body
 * is not JSON.
 */
export async function getFromValidator(validator, path) {
  try {
    const response = await fetch(validator.url + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: response.status, body: await response.json() };
  } catch (err) {
    return { noAnswer: true, reason: reasonOf(err) };
  }
}

/**
 * Another validator's GET /health, through getFromValidator. Through a
 * doorman the worker's health sits under `worker` in the doorman's own
 * answer, so the body answered here is `body.worker` when that is an
 * object and `body` otherwise: the rig, which has no doorman, and the
 * network are read the same way. The status is the one answered, the
 * doorman's through a doorman.
 */
export async function getHealth(validator) {
  const answer = await getFromValidator(validator, '/health');
  if (answer.noAnswer) return answer;
  const { status, body } = answer;
  return { status, body: isObject(body) && isObject(body.worker) ? body.worker : body };
}
