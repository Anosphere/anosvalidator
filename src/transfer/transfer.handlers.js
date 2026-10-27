import { receiveAnosTransfer } from './transfer.service.js';
import { runLeader } from '../validators/validators.service.js';

/**
 * Route handlers for the transfer feature. HTTP in and out only: read the
 * request, call the service, send the response. The checking and storing
 * lives in transfer.service.js. Same shape as the create-account handler in
 * accounts.handlers.js, including what it logs.
 */

/** POST /anos-transfer */
export async function anosTransfer(req, res) {
  const result = await receiveAnosTransfer(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
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

  // The caller's final answer is not designed yet, so still 202 Accepted
  // whatever the validators said.
  res.status(202).json({ transactionId: result.transactionId });
  runLeader().catch((err) => console.log(err));
}
