import { ECDSA_P256, ML_DSA_87 } from '../crypto/signatures.js';

/**
 * The eight keys every account has, in the order the web app lists them.
 * The order matters: transactionId is a hash over the keys in this order.
 *
 * Each classical P-256 key is paired with a post-quantum ML-DSA-87 key.
 */
export const ACCOUNT_KEYS = Object.freeze([
  { name: 'key1', algorithm: ECDSA_P256 },
  { name: 'postQuantumKey1', algorithm: ML_DSA_87 },
  { name: 'key2', algorithm: ECDSA_P256 },
  { name: 'postQuantumKey2', algorithm: ML_DSA_87 },
  { name: 'breakGlassKey', algorithm: ECDSA_P256 },
  { name: 'breakGlassPostQuantumKey', algorithm: ML_DSA_87 },
  { name: 'walletKey', algorithm: ECDSA_P256 },
  { name: 'walletPostQuantumKey', algorithm: ML_DSA_87 },
].map(Object.freeze));
