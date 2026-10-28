import { createPrivateKey } from 'node:crypto';
import { env } from '../config/env.js';
import { canonicalize } from '../crypto/canonical.js';
import { derivePublicKey, readKeyFile } from '../crypto/key-file.js';
import {
  ECDSA_P256,
  decodeSignature,
  signMessage,
  verifySignature,
} from '../crypto/signatures.js';

/**
 * Signatures on validator-to-validator messages.
 *
 * A message is { payload, signature }. The payload is signed as its RFC 8785
 * canonical bytes, exactly like an account payload, by the sending
 * validator's P-256 key: `signature.key` is that signature (64-byte r || s,
 * hex). Validators have no post-quantum key; only accounts do.
 *
 * This validator's private key comes from its key file (KEY_FILE in .env;
 * JSON { privateKey } as PKCS#8 DER hex, written by scripts/make-keys.js)
 * and is loaded once here, through src/crypto/key-file.js, so a missing,
 * open or unparsable key file fails at boot. The public key is derived from
 * it, never configured: ownPublicKey is the 33-byte compressed point the
 * registry row must carry (registry.service.js) and /health answers,
 * ownPublicKeyHex the same as hex, for the boot line.
 */

const keyFile = readKeyFile(env.validator.keyFile, { privateKey: null });

function loadPrivateKey(hex) {
  return createPrivateKey({ key: Buffer.from(hex, 'hex'), format: 'der', type: 'pkcs8' });
}

const OWN_KEYS = Object.freeze({
  key: loadPrivateKey(keyFile.privateKey),
});

/** This validator's public key, the 33-byte compressed P-256 point, as a Buffer. */
export const ownPublicKey = derivePublicKey(keyFile.privateKey);

/** The same as 66 lowercase hex characters: the registry's and /health's form. */
export const ownPublicKeyHex = ownPublicKey.toString('hex');

function messageBytes(payload) {
  return Buffer.from(canonicalize(payload), 'utf8');
}

/** Signs `payload` with this validator's key. Returns { key } as hex. */
export function signPayload(payload) {
  const message = messageBytes(payload);
  return {
    key: signMessage(ECDSA_P256, OWN_KEYS.key, message).toString('hex'),
  };
}

/**
 * Checks the signature on `payload` against `validator`'s public key, as
 * read from this validator's own registry (validators.queries.js). Returns
 * null when it verifies, otherwise a reason that is safe to send back.
 */
export function verifyPayloadSignature(payload, signature, validator) {
  const message = messageBytes(payload);
  const checks = [
    ['key', ECDSA_P256, validator.publicKey],
  ];
  for (const [name, algorithm, publicKey] of checks) {
    const decoded = decodeSignature(algorithm, signature[name]);
    if (!decoded) {
      return `signature.${name} is not a valid ${algorithm} signature`;
    }
    if (!verifySignature(algorithm, publicKey, message, decoded)) {
      return `signature.${name} does not verify against validator ${validator.id}'s ${algorithm} public key`;
    }
  }
  return null;
}
