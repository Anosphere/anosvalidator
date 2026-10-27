/**
 * Decoding of byte strings that arrive inside JSON.
 *
 * Keys, signatures and digests are raw bytes on both ends and in the database
 * (BYTEA). Inside JSON they travel as strings, hex or base64. Both are accepted
 * because the expected byte length tells them apart: n bytes are exactly 2n hex
 * characters but only about 4n/3 base64 characters, so at most one decoding
 * can come out at an acceptable length.
 */

/**
 * Decodes a hex, base64 or base64url string to a Buffer, keeping the result
 * only if `accept` allows its byte length. `accept` is an array of lengths or
 * a predicate on the length. Raw bytes (Buffer / Uint8Array) go through the
 * same length check. Returns null for anything else, so callers never need
 * try/catch around untrusted input.
 */
export function decodeBytes(encoded, accept) {
  const ok = typeof accept === 'function' ? accept : (n) => accept.includes(n);

  if (Buffer.isBuffer(encoded) || encoded instanceof Uint8Array) {
    const bytes = Buffer.from(encoded);
    return ok(bytes.length) ? bytes : null;
  }
  if (typeof encoded !== 'string' || encoded.length === 0) return null;

  if (encoded.length % 2 === 0 && /^[0-9a-f]+$/i.test(encoded)) {
    const bytes = Buffer.from(encoded, 'hex');
    if (ok(bytes.length)) return bytes;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) {
    // Node's base64 decoder takes both the standard and the URL-safe
    // alphabet, with or without padding.
    const bytes = Buffer.from(encoded, 'base64');
    if (ok(bytes.length)) return bytes;
  }
  return null;
}
