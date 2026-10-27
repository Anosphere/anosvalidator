import { Router } from 'express';
import { attachmentHandler } from '../attachments/attachments.handlers.js';
import { assistedTransferCancel } from './assisted-transfer-cancel.js';
import { attestation } from './attestation.js';

/**
 * Assisted transfers feature router: the follow-ups to an assisted transfer.
 * The transfer itself comes in at /anos-transfer (transfer.router.js).
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case (/assisted-transfer-cancel).
 */
export const assistedTransfersRouter = Router();

assistedTransfersRouter.post('/attestation', attachmentHandler(attestation));
assistedTransfersRouter.post('/assisted-transfer-cancel', attachmentHandler(assistedTransferCancel));
