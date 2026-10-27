import { Router } from 'express';
import { attachmentHandler } from '../attachments/attachments.handlers.js';
import { escrowCancel } from './escrow-cancel.js';
import { escrowDispute } from './escrow-dispute.js';
import { escrowSuccess } from './escrow-success.js';
import { escrowVerdict } from './escrow-verdict.js';

/**
 * Escrow feature router: the follow-ups to an escrow transfer, all four at
 * one path, told apart by payload.type. The transfer itself comes in at
 * /anos-transfer (transfer.router.js).
 *
 * Mounted at the root in app.js, so the path below is the full public path.
 */
export const escrowRouter = Router();

escrowRouter.post('/escrow-signature', attachmentHandler(escrowSuccess, escrowCancel, escrowDispute, escrowVerdict));
