import { answerSubmission } from '../util/submission-response.js';
import { runLeader } from '../validators/validators.service.js';
import { receiveAttachment } from './attachments.service.js';

/**
 * The route handler for a follow-up endpoint. HTTP in and out only: read
 * the request, call the service, send the response. Every follow-up
 * endpoint is this handler with the kinds it allows (attestation.js and the
 * other kind modules), so each feature's router builds its own:
 *
 *   router.post('/attestation', attachmentHandler(attestation));
 *
 * Same logging and codes as the anos-transfer handler
 * (util/submission-response.js), and runLeader after answering, as every
 * transaction handler does: an accepted follow-up may have completed a
 * transfer.
 */
export function attachmentHandler(...kinds) {
  return async function attachment(req, res) {
    const result = await receiveAttachment(req.body, kinds);
    answerSubmission(res, result);
    if (result.ok) runLeader().catch((err) => console.log(err));
  };
}
