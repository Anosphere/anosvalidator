import { Router } from 'express';
import { attachmentHandler } from '../attachments/attachments.handlers.js';
import { lockedTransferCancel } from './locked-transfer-cancel.js';

/**
 * Locked transactions feature router: the one follow-up to a guarded or
 * vault transfer waiting in locked_transactions, the sender's cancel
 * (2026-11-11, docs/schemas.md section 28). The transfer itself comes in at
 * /anos-transfer (transfer.router.js).
 *
 * Mounted at the root in app.js, so the path below is the full public
 * path. Paths are lowercase kebab-case (/locked-transfer-cancel).
 */
export const lockedTransactionsRouter = Router();

lockedTransactionsRouter.post('/locked-transfer-cancel', attachmentHandler(lockedTransferCancel));
