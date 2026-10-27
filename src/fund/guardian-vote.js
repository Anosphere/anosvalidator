import { findInRows } from '../attachments/stored-attachments.js';
import { digestMatches } from '../crypto/hash.js';
import { FUND_PROPOSALS } from '../held-transactions/held-transactions.js';
import { guardianWeight } from '../stakes/stakes.service.js';
import { VOTES, findVotes, insertVote, markVoteApproved } from './fund.queries.js';

/**
 * The guardianVote follow-up: a guardian's vote on an open fund proposal.
 *
 *   payload: { type: 'guardianVote', transactionId, guardianId, vote, signedAt }
 *
 * `transactionId` is a proposal's. The signer is `guardianId`, an account
 * with at least one vote (stakes.service.js guardianWeight). `vote` is
 * 'for' or 'against'. Own checks: now is before vote_closes_at; the guardian
 * is not the proposer, whose vote for is already counted; no row from this
 * guardian yet. Stored as a guardian_votes row with the guardian's weight at
 * this moment. No effect on acceptance; the tally happens in the leader
 * round (fund.service.js findReadyProposalIds).
 *
 * The interface is described in attestation.js.
 */

const ALREADY_VOTED = 'this guardian has already voted on this proposal';

export const guardianVote = Object.freeze({
  type: 'guardianVote',
  table: FUND_PROPOSALS,
  signerField: 'guardianId',

  requiredStake(stake) {
    return guardianWeight(stake) >= 1 ? null : 'the guardian has no guardian vote';
  },

  checkShape(payload) {
    if (!VOTES.includes(payload.vote)) return `payload.vote must be ${VOTES.map((vote) => `"${vote}"`).join(' or ')}`;
    return null;
  },

  async verify(payload, { row, signerId }) {
    if (!(Date.now() < row.voteClosesAt.getTime())) return 'the vote on this proposal has closed';
    if (digestMatches(row.ogTransaction.payload.guardianId, signerId)) {
      return 'payload.guardianId is the proposer, whose vote for is already counted';
    }
    const votes = await findVotes(row.transactionId);
    if (votes.some(({ guardianAccountId }) => guardianAccountId.equals(signerId))) return ALREADY_VOTED;
    return null;
  },

  /** One row per guardian; the primary key is the backstop for a race. */
  async store(transactionId, attachment, { signerId, stake }) {
    const stored = await insertVote({
      transactionId,
      guardianAccountId: signerId,
      vote: attachment.payload.vote,
      weight: guardianWeight(stake),
      signature: attachment,
    });
    return stored ? { stored: true, ref: signerId } : { stored: false, reason: ALREADY_VOTED };
  },

  async findStored(transactionId, attachmentId) {
    return findInRows(await findVotes(transactionId), 'guardianAccountId', attachmentId);
  },

  markApproved(transactionId, guardianAccountId) {
    return markVoteApproved(transactionId, guardianAccountId);
  },

  /** No effect on acceptance; the round tallies the approved votes. */
  async onAccepted() {},
});
