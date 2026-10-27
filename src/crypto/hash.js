import { createHash, timingSafeEqual } from 'node:crypto';
import { decodeBytes } from './bytes.js';

/**
 * SHA-256, the one hash used everywhere: account ids, transaction ids,
 * hashes of canonical JSON. Every hash column in the database is a 32-byte
 * BYTEA with a length CHECK to match.
 */

/** Byte length of a SHA-256 digest. */
export const DIGEST_BYTES = 32;

/**
 * SHA-256 of `data` as a 32-byte Buffer. A string is hashed as its UTF-8
 * bytes; a Buffer is hashed as-is.
 */
export function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest();
}

/**
 * Decodes a digest given as raw bytes, a 64-char hex string, or a base64 /
 * base64url string. Returns null if it is not a 32-byte digest in one of
 * those forms, so callers can reject bad input without try/catch.
 */
export function decodeDigest(encoded) {
  return decodeBytes(encoded, [DIGEST_BYTES]);
}

/**
 * True when `expected` (bytes, hex or base64, as received) is the digest
 * `actual` (a Buffer from sha256). A malformed `expected` is simply false.
 * Constant-time comparison.
 */
export function digestMatches(expected, actual) {
  const expectedBytes = decodeDigest(expected);
  if (expectedBytes === null) return false;
  return timingSafeEqual(actual, expectedBytes);
}
