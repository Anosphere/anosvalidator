import { Router } from 'express';
import { anosTransfer } from './transfer.handlers.js';

/**
 * Transfer feature router.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case (/anos-transfer).
 */
export const transferRouter = Router();

transferRouter.post('/anos-transfer', anosTransfer);
