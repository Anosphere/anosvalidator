import { Router } from 'express';
import { requireAccount } from '../auth/require-account.js';
import { requireAttestor } from '../auth/require-attestor.js';
import {
  getAccountHandler,
  listAssistedTransfersHandler,
  listDisputedEscrowsHandler,
  listEscrowsHandler,
  listTransactionsHandler,
} from './reads.handlers.js';

/**
 * Reads feature router: the three routes of the account level (wallet spec
 * 5.4; /list-escrows is spec 16), each behind requireAccount, and the two attestor reads (spec 13.2),
 * each behind requireAttestor: the account level, then the attestor stake.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case.
 */
export const readsRouter = Router();

readsRouter.post('/get-account', requireAccount, getAccountHandler);
readsRouter.post('/list-transactions', requireAccount, listTransactionsHandler);
readsRouter.post('/list-escrows', requireAccount, listEscrowsHandler);

readsRouter.post('/list-assisted-transfers', requireAttestor, listAssistedTransfersHandler);
readsRouter.post('/list-disputed-escrows', requireAttestor, listDisputedEscrowsHandler);
