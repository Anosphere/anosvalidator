import { Router } from 'express';
import { chainLinks } from '../garlic-chain/chain-links.handlers.js';
import { ignoreVote, noAnswerReport, proofOfIgnoreVote } from '../votes/votes.handlers.js';
import {
  attachmentApproval,
  finalDeclaration,
  heldRows,
  joinRequest,
  officialList,
  proofOfAcceptance,
  proofOfAttachmentAcceptance,
  ready,
  readyAnnouncement,
  transactionApproval,
} from './validators.handlers.js';

/**
 * Validators feature router: the endpoints other validators call.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. One endpoint per message type; the reply to each call carries the
 * answering message (a transaction approval call answers with a transaction
 * approved receipt), so answers are not endpoints of their own.
 */
export const validatorsRouter = Router();

validatorsRouter.post('/transaction-approval', transactionApproval);
validatorsRouter.post('/proof-of-acceptance', proofOfAcceptance);
validatorsRouter.post('/attachment-approval', attachmentApproval);
validatorsRouter.post('/proof-of-attachment-acceptance', proofOfAttachmentAcceptance);
validatorsRouter.post('/ready-announcement', readyAnnouncement);
validatorsRouter.post('/official-list', officialList);
validatorsRouter.post('/final-declaration', finalDeclaration);
validatorsRouter.post('/chain-links', chainLinks);
validatorsRouter.post('/ignore-vote', ignoreVote);
validatorsRouter.post('/proof-of-ignore-vote', proofOfIgnoreVote);
validatorsRouter.post('/no-answer-report', noAnswerReport);
validatorsRouter.post('/join-request', joinRequest);
validatorsRouter.post('/held-rows', heldRows);
validatorsRouter.post('/ready', ready);
