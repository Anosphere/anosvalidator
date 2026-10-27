import { answer } from '../util/result.js';
import { getAccount, listAssistedTransfers, listDisputedEscrows, listTransactions } from './reads.service.js';

/**
 * Route handlers for the reads feature. HTTP in and out only: the caller is
 * req.account (src/auth/require-account.js; for the two attestor reads the
 * verified attestor, src/auth/require-attestor.js), the route's object is
 * req.body; the service checks and answers.
 */

/** POST /get-account */
export async function getAccountHandler(req, res) {
  answer(res, await getAccount(req.account));
}

/** POST /list-transactions */
export async function listTransactionsHandler(req, res) {
  answer(res, await listTransactions(req.account, req.body));
}

/** POST /list-assisted-transfers */
export async function listAssistedTransfersHandler(req, res) {
  answer(res, await listAssistedTransfers(req.account));
}

/** POST /list-disputed-escrows */
export async function listDisputedEscrowsHandler(req, res) {
  answer(res, await listDisputedEscrows(req.account));
}
