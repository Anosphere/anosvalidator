import { env } from '../config/env.js';

/**
 * The six purposes an account may stake anos for, as payload.stakeFor names
 * them in a transferToFund and in a fund proposal's payout, each with the
 * stakes column that holds the amount (db/schema.sql) and the minimum one
 * transferToFund must stake for it, which is also the stake an account must
 * hold to have the role (env.js, in millionths as BigInt). Of the six,
 * attestor (attests assisted transfers, arbitrates escrow disputes) and
 * guardian (proposes and votes on fund proposals) do something today; the
 * rest are recorded only.
 */
export const DAO_VOTE = 'daoVote';
export const MODERATOR = 'moderator';
export const ATTESTOR = 'attestor';
export const GUARDIAN = 'guardian';
export const VALIDATOR = 'validator';
export const MASTER_POD = 'masterPod';

export const STAKE_PURPOSES = Object.freeze([
  { name: DAO_VOTE, column: 'dao_vote_stake', minimum: env.stakes.minimums.daoVote },
  { name: MODERATOR, column: 'moderator_stake', minimum: env.stakes.minimums.moderator },
  { name: ATTESTOR, column: 'attestor_stake', minimum: env.stakes.minimums.attestor },
  { name: GUARDIAN, column: 'guardian_stake', minimum: env.stakes.minimums.guardian },
  { name: VALIDATOR, column: 'validator_stake', minimum: env.stakes.minimums.validator },
  { name: MASTER_POD, column: 'master_pod_stake', minimum: env.stakes.minimums.masterPod },
].map(Object.freeze));

/** The six names, in the order above, for messages and shape checks. */
export const PURPOSE_NAMES = Object.freeze(STAKE_PURPOSES.map(({ name }) => name));

const BY_NAME = new Map(STAKE_PURPOSES.map((purpose) => [purpose.name, purpose]));

/** True when `name` is one of the six purposes. */
export function isPurpose(name) {
  return BY_NAME.has(name);
}

/** The stakes column that holds the amount staked for `name`. Throws for anything else. */
export function columnFor(name) {
  return purpose(name).column;
}

/** The minimum stake for `name`, in millionths as BigInt. Throws for anything else. */
export function minimumFor(name) {
  return purpose(name).minimum;
}

function purpose(name) {
  const found = BY_NAME.get(name);
  if (!found) throw new TypeError(`Unknown stake purpose: ${name}`);
  return found;
}
