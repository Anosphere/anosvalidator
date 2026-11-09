import { ECDSA_P256, ML_DSA_87, decodeSignature, verifySignature } from '../crypto/signatures.js';

/**
 * Signatures an account makes over a payload: the signing rules shared by
 * transfers of every kind and by follow-ups (attestations, cancellations,
 * votes, escrow signatures and verdicts). Three signing pairs under any two
 * pairs; the break-glass pair under its own rule, for the break-glass
 * transfer and its cancel (2026-11-08, docs/schemas.md section 22). The
 * payload is signed as its RFC 8785 canonical bytes; the keys to verify
 * with come from the accounts table, never from the object itself.
 */

/**
 * The three signing pairs that may sign for an account under any two pairs:
 * pair 1, pair 2 and the wallet pair, each a classical P-256 key with its
 * post-quantum ML-DSA-87 partner. `publicKey` names the field of the
 * account row (transfer.queries.js findAccount) that holds the key to
 * verify with. An object signed by a pair carries both keys' signatures: a
 * pair with only one present is a malformed object. The break-glass pair is
 * not among them: it signs under its own rule (BREAK_GLASS_KEYS, 2026-11-08,
 * section 22).
 */
export const SIGNING_PAIRS = Object.freeze([
  Object.freeze([
    { name: 'key1', algorithm: ECDSA_P256, publicKey: 'publicKey1' },
    { name: 'postQuantumKey1', algorithm: ML_DSA_87, publicKey: 'publicKeyPq1' },
  ]),
  Object.freeze([
    { name: 'key2', algorithm: ECDSA_P256, publicKey: 'publicKey2' },
    { name: 'postQuantumKey2', algorithm: ML_DSA_87, publicKey: 'publicKeyPq2' },
  ]),
  Object.freeze([
    { name: 'walletKey', algorithm: ECDSA_P256, publicKey: 'altWalletPk' },
    { name: 'walletPostQuantumKey', algorithm: ML_DSA_87, publicKey: 'altWalletPkPq' },
  ]),
]);

/** The break-glass pair: signs a breakGlassTransfer and a breakGlassCancel, nothing else. Not among SIGNING_PAIRS: it never counts toward any two pairs. */
export const BREAK_GLASS_KEYS = Object.freeze([
  { name: 'breakGlassKey', algorithm: ECDSA_P256, publicKey: 'breakGlassPk' },
  { name: 'breakGlassPostQuantumKey', algorithm: ML_DSA_87, publicKey: 'breakGlassPkPq' },
].map(Object.freeze));

/**
 * Signing rule: at least two of the three pairs, both keys of each. Every
 * transfer kind but the break-glass transfer, transfers to the fund, fund
 * proposals and every follow-up but the break-glass cancel use it: their
 * one rule since 2026-11-07, when the assisted transfer's own rule, pair
 * one and the wallet pair, was dropped.
 */
export const ANY_TWO_PAIRS = 'anyTwoPairs';

/**
 * Signing rule: the break-glass pair alone, both keys present and verifying
 * against break_glass_pk and break_glass_pk_pq, and no signature from the
 * three user pairs beside them. The rule of the breakGlassTransfer and the
 * breakGlassCancel (2026-11-08, section 22).
 */
export const BREAK_GLASS_PAIR = 'breakGlassPair';

/** How many of SIGNING_PAIRS the ANY_TWO_PAIRS rule needs. */
const MIN_SIGNING_PAIRS = 2;

/**
 * Checks `signatures`, the signatures object of a transfer or a follow-up,
 * over `message` (the canonical bytes of the payload, a Buffer) against
 * `account`, the account row transfer.queries.js findAccount returns, under
 * `rule` (ANY_TWO_PAIRS or BREAK_GLASS_PAIR).
 *
 * Every signing pair with a signature present is checked (checkPair): both
 * keys of the pair must be present, the account must hold both keys, and
 * each signature must decode and verify against the account's stored key.
 * Then the rule says which pairs had to be among them. Under ANY_TWO_PAIRS
 * at least two of the three; a stray break-glass signature is ignored, as
 * any unknown field is. Under BREAK_GLASS_PAIR none of the three may be
 * present, and the break-glass pair goes through the same per-key checks.
 * Returns null when it all holds, else a reason that is safe to send back
 * to the caller.
 */
export function verifyAccountSignatures(account, signatures, message, rule) {
  const signed = [];
  for (const pair of SIGNING_PAIRS) {
    if (pair.every(({ name }) => signatures[name] === undefined)) continue;
    const bad = checkPair(account, signatures, message, pair);
    if (bad) return bad;
    signed.push(pair);
  }

  if (rule === ANY_TWO_PAIRS) {
    if (signed.length < MIN_SIGNING_PAIRS) {
      return `signatures must come from at least ${MIN_SIGNING_PAIRS} of the key pairs key1, key2 and walletKey`;
    }
    return null;
  }
  if (rule === BREAK_GLASS_PAIR) {
    if (signed.length > 0) return 'a breakGlassTransfer is signed by the break-glass pair alone';
    return checkPair(account, signatures, message, BREAK_GLASS_KEYS);
  }
  throw new TypeError(`Unknown signing rule: ${rule}`);
}

/**
 * One pair's checks: both keys present, each a string the account holds a
 * key for, decoding to a signature that verifies against that key over
 * `message`. Returns a reason or null. The walk over SIGNING_PAIRS and the
 * break-glass branch share it, so every reason string exists once.
 */
function checkPair(account, signatures, message, pair) {
  const present = pair.filter(({ name }) => signatures[name] !== undefined);
  if (present.length !== pair.length) {
    return `signatures.${pair[0].name} and signatures.${pair[1].name} must both be present`;
  }
  for (const { name, algorithm, publicKey } of pair) {
    if (typeof signatures[name] !== 'string') {
      return `signatures.${name} must be a string`;
    }
    if (!account[publicKey]) {
      return `the account has no ${name}`;
    }
    const signature = decodeSignature(algorithm, signatures[name]);
    if (!signature) {
      return `signatures.${name} is not a valid ${algorithm} signature`;
    }
    if (!verifySignature(algorithm, account[publicKey], message, signature)) {
      return `signatures.${name} does not verify against the account's ${name}`;
    }
  }
  return null;
}
