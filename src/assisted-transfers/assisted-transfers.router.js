import { Router } from 'express';
import { attachmentHandler } from '../attachments/attachments.handlers.js';
import { assistedTransferCancel } from './assisted-transfer-cancel.js';
import { attestation } from './attestation.js';
import { breakGlassCancel } from './break-glass-cancel.js';

/**
 * Assisted transfers feature router: the follow-ups to an assisted transfer
 * and, since 2026-11-08, to a break-glass move, which is held in the same
 * table (docs/schemas.md section 22). The attestation and the sender's
 * cancel attach to either; /break-glass-cancel is the break-glass pair's
 * cancel of a move. The transfer itself comes in at /anos-transfer
 * (transfer.router.js).
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case (/assisted-transfer-cancel).
 */
export const assistedTransfersRouter = Router();

assistedTransfersRouter.post('/attestation', attachmentHandler(attestation));
assistedTransfersRouter.post('/assisted-transfer-cancel', attachmentHandler(assistedTransferCancel));
assistedTransfersRouter.post('/break-glass-cancel', attachmentHandler(breakGlassCancel));
