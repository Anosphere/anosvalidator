import { Router } from 'express';
import { attachmentHandler } from '../attachments/attachments.handlers.js';
import { fundProposal, transferToFund } from './fund.handlers.js';
import { guardianVote } from './guardian-vote.js';

/**
 * Fund feature router: the transactions that move anos to and from the
 * fund, and the guardian vote, the follow-up to a fund proposal.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case (/transfer-to-fund).
 */
export const fundRouter = Router();

fundRouter.post('/transfer-to-fund', transferToFund);
fundRouter.post('/fund-proposal', fundProposal);
fundRouter.post('/guardian-vote', attachmentHandler(guardianVote));
