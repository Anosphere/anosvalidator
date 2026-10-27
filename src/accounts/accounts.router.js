import { Router } from 'express';
import { createAccount } from './accounts.handlers.js';

/**
 * Accounts feature router.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case (/create-account).
 */
export const accountsRouter = Router();

accountsRouter.post('/create-account', createAccount);
