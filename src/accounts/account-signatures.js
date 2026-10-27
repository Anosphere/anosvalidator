import { ECDSA_P256, ML_DSA_87, decodeSignature, verifySignature } from '../crypto/signatures.js';

/**
 * Signatures an account makes over a payload: the signing rules shared by
 * transfers of every kind and by follow-ups (attestations, cancellations,
 * votes, escrow signatures and verdicts). The payload is signed as its RFC
 * 8785 canonical bytes; the keys to verify with come from the accounts
 * table, never from the object itself.
 */

/**
 * The key pairs that may sign for an account: pair 1, pair 2 and the wallet
 * pair, each a classical P-256 key with its post-quantum ML-DSA-87 partner.
 * `publicKey` names the field of the account row (transfer.queries.js
 * findAccount) that holds the key to verify with. An object signed by a
 * pair carries both keys' signatures: a pair with only one present is a
 * malformed object.
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

/**
 * Signing rule: at least two of the three pairs, both keys of each. Plain,
 * guarded, vault and escrow transfers, transfers to the fund, fund proposals
 * and every follow-up use it.
 */
export const ANY_TWO_PAIRS = 'anyTwoPairs';

/**
 * Signing rule: pair 1 and the wallet pair, all four keys. A pair 2 also
 * present is checked like any other and accepted. Assisted transfers use it.
 */
export const PAIR_ONE_AND_WALLET = 'pairOneAndWallet';

/** How many of SIGNING_PAIRS the ANY_TWO_PAIRS rule needs. */
const MIN_SIGNING_PAIRS = 2;

/** The pairs the PAIR_ONE_AND_WALLET rule needs: pair 1 and the wallet pair. */
const PAIR_ONE_AND_WALLET_PAIRS = [SIGNING_PAIRS[0], SIGNING_PAIRS[2]];

/**
 * Checks `signatures`, the signatures object of a transfer or a follow-up,
 * over `message` (the canonical bytes of the payload, a Buffer) against
 * `account`, the account row transfer.queries.js findAccount returns, under
 * `rule` (ANY_TWO_PAIRS or PAIR_ONE_AND_WALLET).
 *
 * Every pair with a signature present is checked: both keys of the pair must
 * be present, the account must hold both keys, and each signature must
 * decode and verify against the account's stored key. Then the rule says
 * which pairs had to be among them. Returns null when it all holds, else a
 * reason that is safe to send back to the caller.
 */
export function verifyAccountSignatures(account, signatures, message, rule) {
  const signed = [];
  for (const pair of SIGNING_PAIRS) {
    const present = pair.filter(({ name }) => signatures[name] !== undefined);
    if (present.length === 0) continue;
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
    signed.push(pair);
  }

  if (rule === ANY_TWO_PAIRS) {
    if (signed.length < MIN_SIGNING_PAIRS) {
      return `signatures must come from at least ${MIN_SIGNING_PAIRS} of the key pairs key1, key2 and walletKey`;
    }
    return null;
  }
  if (rule === PAIR_ONE_AND_WALLET) {
    for (const pair of PAIR_ONE_AND_WALLET_PAIRS) {
      if (!signed.includes(pair)) {
        return `signatures must include ${pair[0].name} and ${pair[1].name}`;
      }
    }
    return null;
  }
  throw new TypeError(`Unknown signing rule: ${rule}`);
}
