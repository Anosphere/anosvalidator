/**
 * How a handler logs and answers a submission from a wallet: a transaction
 * or a follow-up that a receive function has verified, stored and sent round
 * the validators. The same lines and codes as the create-account and
 * anos-transfer handlers (accounts.handlers.js, transfer.handlers.js), so
 * every endpoint reads alike in the log.
 */

/**
 * Logs `result`, what a receive function returned, and answers `res` with
 * it: `400` + { error } for { ok: false, reason }; otherwise the pending
 * line, one line per validator's approval, and, when every one approved,
 * one per validator's answer to the proof, then `202` + { transactionId }.
 * The caller's final answer is not designed yet, so still 202 Accepted
 * whatever the validators said. Returns whether the submission was accepted,
 * so the caller can start a leader round.
 */
export function answerSubmission(res, result) {
  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return false;
  }

  console.log('pending:', result.transactionId);
  for (const { id, approved, reason } of result.approvals) {
    console.log(approved ? `validator ${id} approved` : `validator ${id} failed: ${reason}`);
  }
  if (result.approved) {
    console.log('all validators approve');
    for (const { id, accepted, reason } of result.proof) {
      console.log(accepted ? `validator ${id} accepted the proof` : `validator ${id} did not accept the proof: ${reason}`);
    }
  }

  res.status(202).json({ transactionId: result.transactionId });
  return true;
}
