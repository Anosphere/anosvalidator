import { Router } from 'express';
import { requireAccount } from '../auth/require-account.js';
import { requireAttestor } from '../auth/require-attestor.js';
import {
  getAccountHandler,
  getAssistedTransferHandler,
  getLockedTransferHandler,
  listAssistedTransfersHandler,
  listDaoStakesHandler,
  listDisputedEscrowsHandler,
  listEscrowsHandler,
  listTransactionsHandler,
} from './reads.handlers.js';

/**
 * Reads feature router: the five routes of the account level (wallet spec
 * 5.4; /list-escrows is spec 16, /get-assisted-transfer spec 17,
 * /get-locked-transfer spec 18), each behind requireAccount; the two
 * attestor reads (spec 13.2), each behind requireAttestor: the account
 * level, then the attestor stake; and the one public read (spec 23),
 * /list-dao-stakes, behind nothing: no envelope, no signature, no
 * middleware, the first route of the kind.
 *
 * Mounted at the root in app.js, so the paths below are the full public
 * paths. Paths are lowercase kebab-case.
 */
export const readsRouter = Router();

readsRouter.post('/get-account', requireAccount, getAccountHandler);
readsRouter.post('/list-transactions', requireAccount, listTransactionsHandler);
readsRouter.post('/list-escrows', requireAccount, listEscrowsHandler);
readsRouter.post('/get-assisted-transfer', requireAccount, getAssistedTransferHandler);
readsRouter.post('/get-locked-transfer', requireAccount, getLockedTransferHandler);

readsRouter.post('/list-assisted-transfers', requireAttestor, listAssistedTransfersHandler);
readsRouter.post('/list-disputed-escrows', requireAttestor, listDisputedEscrowsHandler);

// The public read (spec 23): no middleware; the service checks the body's shape.
readsRouter.post('/list-dao-stakes', listDaoStakesHandler);
