import { env } from '../config/env.js';
import { decodeDigest } from '../crypto/hash.js';
import { isAppointedPurpose } from '../stakes/stake-purposes.js';

/**
 * The three calls this server makes to the masterpod. The first: POST
 * /get-anos-account (wallet spec 4.4), asked twice over. At a
 * create-account submission it asks whether a vouched anoPod made the
 * account (the binding, accounts.service.js receiveCreateAccount); at a
 * transferToFund for moderator, attestor, validator or masterPod it asks
 * whether that anoPod is appointed for the purpose (the appointment,
 * fund.service.js checkAppointment, docs/schemas.md section 24; validator
 * and masterPod since 2026-11-10, section 26). Shaped like the keyholder's
 * masterpod.client.js: a fetch with a timeout, every failure one outcome.
 * The second, since 2026-11-22 (docs/schemas.md section 34), is
 * reportWaitingTransfers, further down in this file: what
 * masterpod-reports.js sends. The third (docs/schemas.md section 35) is
 * checkFundPayment, at the end of this file: the question the receiving
 * validator asks before it takes a payment to the fund
 * (fund.service.js askMasterpodAboutPayment).
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

/**
 * Tells the masterpod about waiting transfers: POST
 * /report-waiting-transfers (docs/schemas.md section 34; the masterpod's
 * spec section 25) with `message`, { payload, signature } as
 * masterpod-reports.js built and signed it. Returns null when the
 * masterpod answered 200, else a few words that say what went wrong, for
 * the log: the status, or the fetch's own error. A redirect is not
 * followed.
 */
export async function reportWaitingTransfers(message) {
  let response;
  try {
    response = await fetch(`${env.masterpodUrl}/report-waiting-transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return err.message;
  }
  return response.status === 200 ? null : `status ${response.status}`;
}

/** A refusal's reason as the masterpod words it: a short phrase of letters, digits and spaces. Anything else is not passed on. */
const REASON = /^[A-Za-z0-9 ]{1,60}$/;

/**
 * Asks the masterpod whether a payment to the fund may be taken: POST
 * /check-fund-payment (docs/schemas.md section 35) with { payload }, the
 * payment's payload as the wallet signed it, without the signatures. The
 * masterpod knows what a payment may be for and who may pay it; this
 * server knows neither. Returns one of three things:
 *   { answered: true, ok: true }: a 200 whose body says ok: true.
 *   { answered: true, ok: false, reason }: a 200 whose body says ok: false
 *     and gives a reason that reads like one (REASON).
 *   { answered: false, detail }: everything else. No answer within
 *     TIMEOUT_MS, no connection, a redirect, which is not followed, any
 *     status but 200 (a 404 from a masterpod that does not have the route
 *     among them), a body that is not JSON, or one that says neither.
 *     `detail` is a few words for the log, as reportWaitingTransfers gives
 *     them: the fetch's own error, the status, or what the body lacked. It
 *     holds nothing that the payment's sender or the masterpod wrote.
 * The caller refuses the payment unless the first came back.
 */
export async function checkFundPayment(payload) {
  let response;
  try {
    response = await fetch(`${env.masterpodUrl}/check-fund-payment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { answered: false, detail: err.message };
  }
  if (response.status !== 200) return { answered: false, detail: `status ${response.status}` };

  let body;
  try {
    body = await response.json();
  } catch {
    return { answered: false, detail: 'a 200 whose body is not JSON' };
  }
  if (body?.ok === true) return { answered: true, ok: true };
  if (body?.ok === false && typeof body.reason === 'string' && REASON.test(body.reason)) {
    return { answered: true, ok: false, reason: body.reason };
  }
  return { answered: false, detail: 'a 200 that says neither a yes nor a no with a reason' };
}
