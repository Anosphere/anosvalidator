import { createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { decodeBytes } from './bytes.js';

/**
 * Signature verification for the two algorithms an account uses: classical
 * ECDSA on P-256 and post-quantum ML-DSA-87 (FIPS 204). Both are built into
 * Node 24, so nothing here needs a dependency. Account signatures are only
 * verified here (the web app makes them). Validator signatures, on the
 * messages validators send each other, are made here too, in the same
 * formats, so one verify path serves both.
 *
 * Wire formats, which the web app sends and the database stores:
 *   - P-256 public keys are raw bytes: 33 bytes compressed SEC1 (0x02 or
 *     0x03 || X), which is what the app sends, or 65 bytes uncompressed
 *     (0x04 || X || Y).
 *   - ECDSA signatures are the 64-byte r || s form (IEEE P1363). DER-encoded
 *     signatures are accepted as well.
 *   - ECDSA signs the SHA-256 of the message. The message itself is what is
 *     passed in here; the hashing happens inside the verify.
 *   - ML-DSA-87 public keys are 2592 raw bytes; signatures are 4627 bytes.
 *     The "pure" variant is used: the message itself, no pre-hash, with an
 *     empty context string.
 *
 * OpenSSL takes public keys as SubjectPublicKeyInfo (SPKI) DER. For a fixed
 * algorithm and key length that is a constant prefix in front of the raw
 * bytes. The prefixes below were checked against keys Node generated itself
 * when this module was written.
 */

export const ECDSA_P256 = 'ecdsa-p256';
export const ML_DSA_87 = 'ml-dsa-87';

// SPKI DER = SEQUENCE { AlgorithmIdentifier, BIT STRING { 0x00, raw key } }.
const P256_SPKI_PREFIX = {
  // ecPublicKey (1.2.840.10045.2.1), prime256v1 (1.2.840.10045.3.1.7)
  65: Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
  33: Buffer.from('3039301306072a8648ce3d020106082a8648ce3d030107032200', 'hex'),
};
// id-ml-dsa-87 (2.16.840.1.101.3.4.3.19)
const ML_DSA_87_SPKI_PREFIX = Buffer.from('30820a32300b060960864801650304031303820a2100', 'hex');

const ALGORITHMS = {
  [ECDSA_P256]: {
    publicKeyLength: (n) => n === 65 || n === 33,
    // 64 = P1363. DER is normally 70 to 72 bytes, rarely shorter.
    signatureLength: (n) => n === 64 || (n >= 8 && n <= 72),
    toKeyObject: (raw) =>
      createPublicKey({
        key: Buffer.concat([P256_SPKI_PREFIX[raw.length], raw]),
        format: 'der',
        type: 'spki',
      }),
    verify: (keyObject, message, signature) =>
      nodeVerify(
        'sha256',
        message,
        { key: keyObject, dsaEncoding: signature.length === 64 ? 'ieee-p1363' : 'der' },
        signature,
      ),
    sign: (privateKey, message) =>
      nodeSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
  },
  [ML_DSA_87]: {
    publicKeyLength: (n) => n === 2592,
    signatureLength: (n) => n === 4627,
    toKeyObject: (raw) =>
      createPublicKey({
        key: Buffer.concat([ML_DSA_87_SPKI_PREFIX, raw]),
        format: 'der',
        type: 'spki',
      }),
    verify: (keyObject, message, signature) => nodeVerify(null, message, keyObject, signature),
  },
};

function algorithm(name) {
  const found = ALGORITHMS[name];
  if (!found) throw new TypeError(`Unknown signature algorithm: ${name}`);
  return found;
}

/**
 * Decodes a public key from hex, base64 or raw bytes.
 * Null if the length is wrong for the algorithm.
 */
export function decodePublicKey(name, encoded) {
  return decodeBytes(encoded, algorithm(name).publicKeyLength);
}

/**
 * Decodes a signature from hex, base64 or raw bytes.
 * Null if the length is wrong for the algorithm.
 */
export function decodeSignature(name, encoded) {
  return decodeBytes(encoded, algorithm(name).signatureLength);
}

/**
 * True when `signature` is a valid signature by `publicKey` over `message`.
 * All three are Buffers (see decodePublicKey / decodeSignature). Never throws
 * on bad input: a malformed key or signature is simply false.
 */
export function verifySignature(name, publicKey, message, signature) {
  const alg = algorithm(name);
  if (!alg.publicKeyLength(publicKey.length) || !alg.signatureLength(signature.length)) {
    return false;
  }
  try {
    return alg.verify(alg.toKeyObject(publicKey), message, signature);
  } catch {
    return false;
  }
}

/**
 * Signs `message` (a Buffer) with `privateKey` (a KeyObject) and returns the
 * signature in the wire format described above: 64-byte r || s for P-256.
 * ML-DSA-87 is verify-only here: validators sign with P-256 alone, and the
 * web app makes the account signatures. Encode to hex at the API boundary.
 */
export function signMessage(name, privateKey, message) {
  return algorithm(name).sign(privateKey, message);
}
