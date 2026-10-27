import { decodeDigest } from '../crypto/hash.js';
import { findAccount } from '../transfer/transfer.queries.js';
import { answer, refuse } from '../util/result.js';
import { checkPath, checkTimestamp, recordNonce } from './common-checks.js';
import { parseSignedRequest, verifyBoth } from './signed-request.js';

/**
 * The account level (wallet spec 5.3): a request signed by an account's pair
 * one, both signatures, for the reads (src/reads/). Runs the six steps in
 * order and stops at the first failure; on success `req.account` is the
 * account's id as a 32-byte Buffer and `req.body` is `payload.body`, the
 * route's own object, so a handler reads the caller from req.account and
 * nothing else.
 */
export async function requireAccount(req, res, next) {
  // 1. Shape.
  const parsed = parseSignedRequest(req.body, 'accountId', { mldsa: true });
  if (parsed.reason) return answer(res, refuse(400, parsed.reason));
  const { payload, signatures } = parsed;

  // 2. and 3. The path and the timestamp.
  const common = checkPath(payload, req) ?? checkTimestamp(payload);
  if (common) return answer(res, common);

  // 4. The account: its id decodes, it has a row, and both signatures are
  //    by pair one (public_key1, public_key_pq1).
  const accountId = decodeDigest(payload.accountId);
  if (accountId === null) return answer(res, refuse(400, 'invalid accountId'));
  const account = await findAccount(accountId);
  if (account === null) return answer(res, refuse(401, 'unknown account'));
  if (!verifyBoth(payload, signatures, account.publicKey1, account.publicKeyPq1)) {
    return answer(res, refuse(401, 'bad signature'));
  }

  // 5. The nonce is new.
  const replay = await recordNonce(payload);
  if (replay) return answer(res, replay);

  // 6. The caller, and the route's object.
  req.account = accountId;
  req.body = payload.body;
  next();
}
