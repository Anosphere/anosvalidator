import { env } from '../config/env.js';
import { decodeDigest } from '../crypto/hash.js';

/**
 * The one call this server makes to the masterpod: POST /get-anos-account
 * (wallet spec 4.4), asking whether an account a create-account submission
 * names was made by a vouched anoPod. Shaped like the keyholder's
 * masterpod.client.js: a fetch with a timeout, every failure one outcome.
 */

/** How long the masterpod has to answer. */
const TIMEOUT_MS = 5_000;

/**
 * Asks the masterpod about `accountId` (a 32-byte Buffer). Returns
 * { bound: true, anopodId } (a 32-byte Buffer) only on a 200 whose anopodId
 * decodes to 32 bytes and whose vouched is true; { bound: false } for
 * anything else: a 404, a timeout, a 5xx, a body that is not that shape, or
 * vouched false. The caller treats every refusal alike (wallet spec 5.2).
 */
export async function fetchAnosAccount(accountId) {
  let response;
  try {
    response = await fetch(`${env.masterpodUrl}/get-anos-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: accountId.toString('hex') }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { bound: false };
  }
  if (response.status !== 200) return { bound: false };

  let body;
  try {
    body = await response.json();
  } catch {
    return { bound: false };
  }
  const anopodId = decodeDigest(body?.anopodId);
  if (anopodId === null || body?.vouched !== true) return { bound: false };
  return { bound: true, anopodId };
}
