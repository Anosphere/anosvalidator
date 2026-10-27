import { env } from '../config/env.js';
import { GUARDIAN, minimumFor } from './stake-purposes.js';

/**
 * What a stake means: the roles it gives. `stake` is what stakes.queries.js
 * findStake returns, an object of BigInt amounts by purpose, or null for an
 * account with no stakes row.
 */

/**
 * True when the account holds the role for `purpose`: its stake for that
 * purpose is at or above the purpose's minimum. An account with no stakes
 * row holds nothing.
 */
export function holdsRole(stake, purpose) {
  return stake !== null && stake[purpose] >= minimumFor(purpose);
}

/**
 * The account's votes on fund proposals: one per GUARDIAN_VOTE_ANOS of
 * guardian stake, rounded down. An account with at least one vote may
 * propose and vote. A Number, since it is summed and stored as an INTEGER.
 */
export function guardianWeight(stake) {
  if (stake === null) return 0;
  return Number(stake[GUARDIAN] / env.guardianVote.anosPerVote);
}
