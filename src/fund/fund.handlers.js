import { answerSubmission } from '../util/submission-response.js';
import { runLeader } from '../validators/validators.service.js';
import { receiveFundProposal, receiveTransferToFund } from './fund.service.js';

/**
 * Route handlers for the fund feature's transactions. HTTP in and out only:
 * read the request, call the service, send the response. The checking and
 * storing lives in fund.service.js. Same logging and codes as the
 * anos-transfer handler (util/submission-response.js), and runLeader after
 * answering, as every transaction handler does. The guardian vote, a
 * follow-up, is handled by the attachments feature (fund.router.js).
 */

/** POST /transfer-to-fund */
export async function transferToFund(req, res) {
  const result = await receiveTransferToFund(req.body);
  answerSubmission(res, result);
  if (result.ok) runLeader().catch((err) => console.log(err));
}

/** POST /fund-proposal */
export async function fundProposal(req, res) {
  const result = await receiveFundProposal(req.body);
  answerSubmission(res, result);
  if (result.ok) runLeader().catch((err) => console.log(err));
}
