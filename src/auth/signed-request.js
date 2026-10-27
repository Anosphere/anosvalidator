import { canonicalize } from '../crypto/canonical.js';
import { ECDSA_P256, ML_DSA_87, decodeSignature, verifySignature } from '../crypto/signatures.js';
import { isObject } from '../util/is-object.js';

/**
 * The signed request envelope of the account level (wallet spec 5.3):
 * { payload, signatures }, the signatures over the RFC 8785 canonical bytes
 * of payload. The field that names the signer is accountId; both a P-256
 * and an ML-DSA-87 signature are required, by the account's pair one.
 * Copied from keyholdersoftware's src/auth/signed-request.js.
 */

/** The reason every shape failure answers with. */
export const BAD_SHAPE = 'bad request shape';

/**
 * Checks the envelope (step 1 of 5.3): `payload` an object with string
 * `signerField`, path, timestamp and nonce and an object body; `signatures`
 * an object with string ecdsa and, when `mldsa` is true, string mldsa.
 * Returns { payload, signatures } or { reason }.
 */
export function parseSignedRequest(body, signerField, { mldsa }) {
  if (!isObject(body) || !isObject(body.payload) || !isObject(body.signatures)) {
    return { reason: BAD_SHAPE };
  }
  const { payload, signatures } = body;
  if (typeof signatures.ecdsa !== 'string') return { reason: BAD_SHAPE };
  if (mldsa && typeof signatures.mldsa !== 'string') return { reason: BAD_SHAPE };
  for (const field of [signerField, 'path', 'timestamp', 'nonce']) {
    if (typeof payload[field] !== 'string') return { reason: BAD_SHAPE };
  }
  if (!isObject(payload.body)) return { reason: BAD_SHAPE };
  return { payload, signatures };
}

/** The bytes both signatures are over: the canonical form of the payload. Null when it has none. */
function messageOf(payload) {
  try {
    return Buffer.from(canonicalize(payload), 'utf8');
  } catch {
    return null;
  }
}

/**
 * True when both signatures verify over the canonical bytes of `payload`:
 * `ecdsa` by the P-256 key `ecdsaKey`, `mldsa` by the ML-DSA-87 key
 * `mldsaKey`, both keys raw Buffers (an account's public_key1 and
 * public_key_pq1 from the accounts table). A key or signature that does not
 * decode is simply false.
 */
export function verifyBoth(payload, signatures, ecdsaKey, mldsaKey) {
  if (!ecdsaKey || !mldsaKey) return false;
  const ecdsa = decodeSignature(ECDSA_P256, signatures.ecdsa);
  const mldsa = decodeSignature(ML_DSA_87, signatures.mldsa);
  if (ecdsa === null || mldsa === null) return false;
  const message = messageOf(payload);
  if (message === null) return false;
  return verifySignature(ECDSA_P256, ecdsaKey, message, ecdsa) && verifySignature(ML_DSA_87, mldsaKey, message, mldsa);
}
