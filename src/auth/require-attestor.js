import { ATTESTOR } from '../stakes/stake-purposes.js';
import { findStake } from '../stakes/stakes.queries.js';
import { holdsRole } from '../stakes/stakes.service.js';
import { answer, refuse } from '../util/result.js';
import { requireAccount } from './require-account.js';

/**
 * The attestor gate (spec 13.1): the account level, then the stake. Behind
 * requireAccount the signer is req.account; it must hold attestor_stake at
 * or above STAKE_MIN_ATTESTOR_ANOS (stakes.service.js holdsRole, the rule
 * the attestation and verdict follow-ups apply to their signer, 5.2 and
 * 5.6), else 403 not an attestor, logged like every other refusal. The two
 * attestor reads of src/reads/ sit behind requireAttestor; nothing else
 * does.
 */

/** After the six steps of requireAccount: the signer holds attestor stake. */
export async function mustHoldAttestorStake(req, res, next) {
  const stake = await findStake(req.account);
  if (!holdsRole(stake, ATTESTOR)) return answer(res, refuse(403, 'not an attestor'));
  next();
}

/** The middleware chain of the two attestor reads: the account level, then the stake. */
export const requireAttestor = [requireAccount, mustHoldAttestorStake];
