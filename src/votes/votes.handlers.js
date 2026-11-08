import { handleReport, receiveIgnoreVote, receiveNoAnswerReport, receiveProofOfIgnoreVote } from './votes.service.js';

/**
 * Route handlers for the three vote messages (mounted by
 * validators/validators.router.js). HTTP in and out only; the checking
 * lives in votes.service.js.
 */

/** POST /ignore-vote. Answers with this validator's vote. */
export async function ignoreVote(req, res) {
  const result = await receiveIgnoreVote(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log(`voted ${result.vote} on ${req.body.payload.action} vote ${req.body.payload.voteId.slice(0, 8)}`);
  res.status(200).json(result.receipt);
}

/** POST /proof-of-ignore-vote. Applies the vote and answers with the accepted receipt. */
export async function proofOfIgnoreVote(req, res) {
  const result = await receiveProofOfIgnoreVote(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log(result.applied ? 'vote applied' : 'vote applied before; the same receipt');
  res.status(200).json(result.receipt);
}

/**
 * POST /no-answer-report. Answers 200 {} at once, then handles the report
 * fire-and-forget: the vote, or the queue, or nothing (votes.service.js
 * handleReport).
 */
export async function noAnswerReport(req, res) {
  const result = await receiveNoAnswerReport(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  res.status(200).json({});
  handleReport(result.validatorIds, result.reporter).catch((err) => console.log(err));
}
