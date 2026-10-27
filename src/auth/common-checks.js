import { env } from '../config/env.js';
import { decodeBytes } from '../crypto/bytes.js';
import { refuse } from '../util/result.js';
import { insertNonce } from './nonces.queries.js';

/**
 * The steps of the account level (wallet spec 5.3) that do not depend on
 * the signer, each a function returning a refusal (util/result.js) or null
 * when the step passes, called in the spec's order: path (step 2) and
 * timestamp (step 3) before the account's own checks, the nonce (step 5)
 * after them, so a request that fails its account check never uses a nonce
 * up. Copied from keyholdersoftware's src/auth/common-checks.js.
 */

/** A nonce is 16 to 32 bytes. */
const nonceLength = (n) => n >= 16 && n <= 32;

/** Step 2: the signed path is this route. */
export function checkPath(payload, req) {
  return payload.path === req.baseUrl + req.path ? null : refuse(401, 'path mismatch');
}

/** Step 3: the timestamp parses and is within TIMESTAMP_WINDOW_SECONDS of the server clock, either way. */
export function checkTimestamp(payload) {
  const timestamp = Date.parse(payload.timestamp);
  if (Number.isNaN(timestamp) || Math.abs(timestamp - Date.now()) > env.timestampWindowSeconds * 1000) {
    return refuse(401, 'timestamp outside window');
  }
  return null;
}

/**
 * Step 5: the nonce decodes to 16 to 32 bytes (else 400 invalid nonce) and
 * is new (else 401 replay). It is kept twice the window, past which the
 * timestamp check refuses the request anyway.
 */
export async function recordNonce(payload) {
  const nonce = decodeBytes(payload.nonce, nonceLength);
  if (nonce === null) return refuse(400, 'invalid nonce');
  const expiresAt = new Date(Date.now() + 2 * env.timestampWindowSeconds * 1000);
  if (!(await insertNonce(nonce, expiresAt))) return refuse(401, 'replay');
  return null;
}
