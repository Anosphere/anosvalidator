import canonicalizeJson from 'canonicalize';
import { digestMatches, sha256 } from './hash.js';

/**
 * Canonical JSON (RFC 8785, "JCS") and the SHA-256 hash over it.
 *
 * Incoming objects were hashed and signed in the web app after being
 * serialised canonically. Parsers and JSONB do not preserve key order or
 * whitespace, so to check a hash or a signature we must rebuild the exact
 * bytes the app produced. The app uses the `canonicalize` npm package, and so
 * does this module: the same code on both ends, so the bytes cannot differ.
 *
 * What the package produces: object keys sorted by UTF-16 code unit, no
 * whitespace, numbers in ES Number.toString form, strings escaped as
 * JSON.stringify does. It throws on NaN, Infinity, BigInt and lone
 * surrogates. For everything else it follows JSON.stringify: Dates and
 * Buffers go through toJSON, undefined properties are dropped, and a value
 * with no JSON form at all (undefined, a function) comes back as undefined.
 */

/** The RFC 8785 canonical string of a JSON value, straight from the package. */
export const canonicalize = canonicalizeJson;

/** SHA-256 over the UTF-8 bytes of the canonical form, as a 32-byte Buffer. */
export function canonicalHash(value) {
  const canonical = canonicalize(value);
  if (typeof canonical !== 'string') {
    throw new TypeError('Cannot hash a value that has no JSON representation');
  }
  return sha256(canonical);
}

/**
 * True when `expected` (bytes, hex or base64) is the SHA-256 of the canonical
 * form of `value`. A malformed `expected` is simply a mismatch (false).
 */
export function verifyCanonicalHash(value, expected) {
  return digestMatches(expected, canonicalHash(value));
}
