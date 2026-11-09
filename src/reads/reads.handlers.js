import { answer } from '../util/result.js';
import {
  getAccount,
  getAssistedTransfer,
  getFundProposal,
  getLockedTransfer,
  listAssistedTransfers,
  listDaoStakes,
  listDisputedEscrows,
  listEscrows,
  listFundProposals,
  listTransactions,
} from './reads.service.js';

/**
 * Route handlers for the reads feature. HTTP in and out only: the caller is
 * req.account (src/auth/require-account.js; for the two attestor reads the
 * verified attestor, src/auth/require-attestor.js; the three public reads,
 * /list-dao-stakes, /list-fund-proposals and /get-fund-proposal, have
 * none), the route's object is req.body; the service checks and answers.
 */

/** POST /get-account */
export async function getAccountHandler(req, res) {
  answer(res, await getAccount(req.account));
}

/** POST /list-transactions */
export async function listTransactionsHandler(req, res) {
  answer(res, await listTransactions(req.account, req.body));
}

/** POST /list-escrows */
export async function listEscrowsHandler(req, res) {
  answer(res, await listEscrows(req.account));
}

/** POST /get-assisted-transfer */
export async function getAssistedTransferHandler(req, res) {
  answer(res, await getAssistedTransfer(req.account));
}

/** POST /get-locked-transfer */
export async function getLockedTransferHandler(req, res) {
  answer(res, await getLockedTransfer(req.account));
}

/** POST /list-assisted-transfers */
export async function listAssistedTransfersHandler(req, res) {
  answer(res, await listAssistedTransfers(req.account));
}

/** POST /list-disputed-escrows */
export async function listDisputedEscrowsHandler(req, res) {
  answer(res, await listDisputedEscrows(req.account));
}

/** POST /list-dao-stakes */
export async function listDaoStakesHandler(req, res) {
  answer(res, await listDaoStakes(req.body));
}

/** POST /list-fund-proposals */
export async function listFundProposalsHandler(req, res) {
  answer(res, await listFundProposals(req.body));
}

/** POST /get-fund-proposal */
export async function getFundProposalHandler(req, res) {
  answer(res, await getFundProposal(req.body));
}
