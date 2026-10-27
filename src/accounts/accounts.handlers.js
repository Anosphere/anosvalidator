import { receiveCreateAccount } from './accounts.service.js';
import { runLeader } from '../validators/validators.service.js';

/**
 * Route handlers for the accounts feature.
 *
 * A handler is the function Express calls with (req, res) once a route
 * matches. Handlers only translate HTTP in and out: read the request, call
 * the service, send the response. The checking and storing itself lives in
 * accounts.service.js.
 *
 * Handlers are async where the service is. Express 5 forwards a rejected
 * promise (for example the database being down) to the error handler.
 */

/** POST /create-account */
export async function createAccount(req, res) {
  const result = await receiveCreateAccount(req.body);

  // A submission the masterpod does not vouch for (check 5) is dropped like
  // garbage: 400 { error: "bad request" } and nothing in the log.
  if (!result.ok && result.dropped) {
    res.status(400).json({ error: result.reason });
    return;
  }

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
  runLeader().catch( err => console.log(err));
}
