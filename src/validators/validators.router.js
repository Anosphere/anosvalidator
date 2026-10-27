import { Router } from 'express';
import {
  attachmentApproval,
  finalDeclaration,
  officialList,
  proofOfAcceptance,
  proofOfAttachmentAcceptance,
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
