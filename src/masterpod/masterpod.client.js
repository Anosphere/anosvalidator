import { env } from '../config/env.js';
import { decodeDigest } from '../crypto/hash.js';
import { isAppointedPurpose } from '../stakes/stake-purposes.js';

/**
 * The one call this server makes to the masterpod: POST /get-anos-account
 * (wallet spec 4.4), asked twice over. At a create-account submission it
 * asks whether a vouched anoPod made the account (the binding,
 * accounts.service.js receiveCreateAccount); at a transferToFund for
 * moderator, attestor, validator or masterPod it asks whether that anoPod
 * is appointed for the purpose (the appointment, fund.service.js
 * checkAppointment, docs/schemas.md section 24; validator and masterPod
 * since 2026-11-10, section 26). Shaped like the keyholder's
 * masterpod.client.js: a fetch with a timeout, every failure one outcome.
 */

/** How long the masterpod has to answer. */
const TIMEOUT_MS = 5_000;

/**
 * Asks the masterpod about `accountId` (a 32-byte Buffer). Returns
 * { bound: true, anopodId, role } only on a 200 whose anopodId decodes to
 * 32 bytes and whose vouched is true: anopodId a 32-byte Buffer, role the
 * answer's role when it is 'moderator', 'attestor', 'validator' or
 * 'masterPod' (the four of stake-purposes.js isAppointedPurpose; the last
 * two since 2026-11-10) and null otherwise (a masterpod from before the
 * appointments of 2026-11-08 sends no role at all). { bound: false } for
 * anything else: a 404, a timeout, a 5xx, a body that is not that shape, or
 * vouched false. Both callers treat every refusal alike (wallet spec 5.2);
 * receiveCreateAccount ignores role.
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
  const role = isAppointedPurpose(body.role) ? body.role : null;
  return { bound: true, anopodId, role };
}
