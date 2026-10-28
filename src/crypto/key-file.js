import { ECDH, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The key file: this validator's private key, JSON with lowercase-hex
 * values, written once by scripts/make-keys.js with the exclusive-create
 * flag and mode 0600, so it is never overwritten and only its owner reads
 * it. KEY_FILE in .env names it, relative to the repo root or absolute
 * (src/config/env.js; default ./validator.key).
 *
 * readKeyFile(path, fields) is how the server loads it
 * (validators/validators.signing.js) and how scripts/show-key.js reads it.
 * It refuses a file that is missing, not a regular file, unreadable, or has
 * any group or other permission bit set, naming the path and the mode it
 * found; then it parses the JSON and requires every field named in
 * `fields` to be lowercase hex of the byte length given there (null: any
 * even length). derivePublicKey turns the private key into the 33-byte
 * compressed P-256 point the registry carries, so the public key is never
 * configured, only derived.
 *
 * keyholdersoftware has its own copy of readKeyFile; the two repos share no
 * code.
 */

/** The repo root, which a relative KEY_FILE is resolved against. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The group and other permission bits: none may be set on a key file. */
const GROUP_OTHER_BITS = 0o077;

// SPKI DER of a P-256 public key: a 26-byte prefix, then the 65-byte
// uncompressed point (0x04 || X || Y).
const P256_SPKI_PREFIX_BYTES = 26;
const P256_UNCOMPRESSED_BYTES = 65;

/**
 * Reads the key file at `path` (relative to the repo root, or absolute) and
 * returns the parsed object. `fields` maps each required field to its byte
 * length, or null for any even length. Throws, with a message naming the
 * file, on every failure listed above.
 */
export function readKeyFile(path, fields) {
  const file = resolve(REPO_ROOT, path);

  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    throw new Error(
      err.code === 'ENOENT' ? `key file ${file} is missing` : `key file ${file} cannot be read: ${err.message}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`key file ${file} is not a regular file`);
  }
  const mode = stat.mode & 0o777;
  if ((mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(
      `key file ${file} has mode ${mode.toString(8).padStart(4, '0')}; it must be readable by its owner only (chmod 600)`,
    );
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`key file ${file} is unreadable: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`key file ${file} is not JSON: ${err.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`key file ${file} must hold a JSON object`);
  }

  for (const [name, bytes] of Object.entries(fields)) {
    const value = parsed[name];
    if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) {
      throw new Error(`key file ${file}: ${name} must be lowercase hex with an even number of digits`);
    }
    if (bytes !== null && value.length !== bytes * 2) {
      throw new Error(
        `key file ${file}: ${name} must be ${bytes} bytes (${bytes * 2} hex digits), got ${value.length / 2}`,
      );
    }
  }
  return parsed;
}

/**
 * The public key of a P-256 private key given as PKCS#8 DER hex: the
 * 33-byte compressed point, as a Buffer. Node exports the public key as
 * SPKI DER, a constant prefix in front of the uncompressed point, which is
 * cut off and compressed here. Throws when the key is not a P-256 key.
 */
export function derivePublicKey(privateKeyHex) {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const expected = P256_SPKI_PREFIX_BYTES + P256_UNCOMPRESSED_BYTES;
  if (spki.length !== expected) {
    throw new Error(`the private key is not a P-256 key: its SPKI is ${spki.length} bytes, expected ${expected}`);
  }
  const uncompressed = spki.subarray(P256_SPKI_PREFIX_BYTES);
  return ECDH.convertKey(uncompressed, 'prime256v1', undefined, undefined, 'compressed');
}
