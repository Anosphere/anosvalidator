import { Router } from 'express';
import { requireAccount } from '../auth/require-account.js';
import { requireAttestor } from '../auth/require-attestor.js';
import {
  getAccountHandler,
  listAssistedTransfersHandler,
  listDisputedEscrowsHandler,
  listTransactionsHandler,
} from './reads.handlers.js';

/**
 * Reads feature router: the two routes of the account level (wallet spec
 * 5.4), each behind requireAccount, and the two attestor reads (spec 13.2),
 * each behind requireAttestor: the account level, then the attestor stake.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case.
 */
export const readsRouter = Router();

readsRouter.post('/get-account', requireAccount, getAccountHandler);
readsRouter.post('/list-transactions', requireAccount, listTransactionsHandler);

readsRouter.post('/list-assisted-transfers', requireAttestor, listAssistedTransfersHandler);
readsRouter.post('/list-disputed-escrows', requireAttestor, listDisputedEscrowsHandler);
