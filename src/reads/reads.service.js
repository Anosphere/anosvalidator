import { isObject } from '../util/is-object.js';
import { ok, refuse } from '../util/result.js';
import {
  findAccountSummary,
  findAssistedWaitingForAttestors,
  findLatestTransactionId,
  findOpenEscrowsFor,
  findPendingFor,
  findTransactions,
  findUndecidedDisputedEscrows,
} from './reads.queries.js';

/**
 * The reads feature (wallet spec 5.4): the three things an account may read
 * about itself (its account, its transactions, its open escrow trades),
 * nothing about anyone else. The caller is the verified
 * signer, req.account from src/auth/require-account.js; the body is the
 * route's own object. Each function returns ok(status, body) or
 * refuse(status, reason) (util/result.js), so the handlers only log and
 * answer.
 */

const BAD_SHAPE = 'bad request shape';

/** /list-transactions: the default and the most rows one call answers; /list-escrows answers at most MAX_LIMIT too. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The stages of an open escrow trade, as /list-escrows names them (spec
 * 16.2): waiting until every validator accepted the trade; held when
 * nothing is signed on it; releasing with the seller's success on it;
 * cancelling with the buyer's cancel on it; disputed with a dispute on it.
 */
export const ESCROW_STAGES = Object.freeze({
  WAITING: 'waiting',
  HELD: 'held',
  RELEASING: 'releasing',
  CANCELLING: 'cancelling',
  DISPUTED: 'disputed',
});

const hex = (buffer) => (buffer === null || buffer === undefined ? null : buffer.toString('hex'));

/**
 * POST /get-account. Body { }. The signer's type, balance as millionths in
 * a decimal string, latestTransactionId (the newest garlic chain link whose
 * account_id is the signer, hex, or null) and createdAt.
 */
export async function getAccount(accountId) {
  const [account, latest] = await Promise.all([findAccountSummary(accountId), findLatestTransactionId(accountId)]);
  if (account === null) return refuse(401, 'unknown account');
  return ok(200, {
    accountId: hex(accountId),
    type: account.type,
    balance: account.balance,
    latestTransactionId: hex(latest),
    createdAt: account.createdAt.toISOString(),
  });
}

/**
 * POST /list-transactions. Body { beforePosition?: integer, limit?: integer
 * (default 50, at most 200) }. transactions: the garlic chain links where
 * the signer sent or received, position descending, below beforePosition
 * when given, limit rows. pending: the signer's pending row, read from
 * og_transaction.payload, an array of at most one. The other holding
 * tables are not listed.
 */
export async function listTransactions(accountId, body) {
  if (!isObject(body)) return refuse(400, BAD_SHAPE);
  const beforePosition = body.beforePosition === undefined ? null : body.beforePosition;
  if (beforePosition !== null && !(Number.isInteger(beforePosition) && beforePosition >= 1)) {
    return refuse(400, 'invalid beforePosition');
  }
  const limit = body.limit === undefined ? DEFAULT_LIMIT : body.limit;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) return refuse(400, 'invalid limit');

  const [links, pendingRow] = await Promise.all([findTransactions(accountId, beforePosition, limit), findPendingFor(accountId)]);
  const transactions = links.map((row) => ({
    transactionId: hex(row.transaction_id),
    position: Number(row.position),
    type: row.type,
    accountId: hex(row.account_id),
    accountIdTo: hex(row.account_id_to),
    amount: String(row.amount),
    createdAt: row.created_at.toISOString(),
  }));
  const pending = pendingRow === null ? [] : [pendingOf(accountId, pendingRow)];
  return ok(200, { transactions, pending });
}

/** The pending row in wire form, its fields read from og_transaction.payload. */
function pendingOf(accountId, row) {
  const payload = isObject(row.og_transaction?.payload) ? row.og_transaction.payload : {};
  return {
    transactionId: hex(row.transaction_id),
    type: typeof payload.transactionType === 'string' ? payload.transactionType : null,
    accountId: hex(accountId),
    accountIdTo: typeof payload.accountIdTo === 'string' ? payload.accountIdTo : null,
    amount: typeof payload.amount === 'string' ? payload.amount : '0',
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : row.created_at.toISOString(),
    approved: row.approved,
  };
}

/**
 * POST /list-escrows (spec 16). Body { }. escrows: the escrow_transfers
 * rows where the signer is the seller (account_id) or the buyer
 * (account_id_to), newest first, at most MAX_LIMIT: the open trades only,
 * nothing from logs or archives. The transfer fields as the attestor reads
 * answer them; stage from stageOf; disputedBy is
 * dispute_signature.payload.accountId or null; verdicts the escrow's
 * arbitrations in arbitrator order as { verdict, approved }, no arbitrator
 * ids.
 */
export async function listEscrows(accountId) {
  const rows = await findOpenEscrowsFor(accountId, MAX_LIMIT);
  const escrows = rows.map((row) => ({
    ...heldTransferOf(row),
    stage: stageOf(row),
    disputedBy: isObject(row.dispute_signature?.payload) ? stringOrNull(row.dispute_signature.payload.accountId) : null,
    verdicts: row.verdicts,
  }));
  return ok(200, { escrows });
}

/**
 * Where an open escrow trade is, from its row (spec 16.2), the first line
 * that matches: not approved is waiting; then the slot that holds an object
 * names the stage, dispute before cancel before success; an approved row
 * with every slot empty is held. A slot is only filled on an approved row
 * and each slot blocks the other two (5.5), so at most one of the three
 * ever holds an object; the order is a definition, not a race.
 */
function stageOf(row) {
  if (!row.approved) return ESCROW_STAGES.WAITING;
  if (row.has_dispute) return ESCROW_STAGES.DISPUTED;
  if (row.has_cancel) return ESCROW_STAGES.CANCELLING;
  if (row.has_success) return ESCROW_STAGES.RELEASING;
  return ESCROW_STAGES.HELD;
}

/**
 * POST /list-assisted-transfers (spec 13.2). Body { }. The assisted
 * transfers waiting for attestors on this validator: approved, no
 * cancellation present, an attestation slot still empty; newest first.
 * accountId, accountIdTo, amount and createdAt are read from
 * og_transaction.payload; attestorIds lists payload.attestorId of the
 * attestations present, slot order, so a second attestor sees who signed
 * first. The caller is the verified attestor, req.account from
 * src/auth/require-attestor.js; the list is the same for every attestor.
 */
export async function listAssistedTransfers(accountId) {
  const rows = await findAssistedWaitingForAttestors();
  const transfers = rows.map((row) => ({
    ...heldTransferOf(row),
    attestorIds: [row.attestation_1, row.attestation_2]
      .filter((attestation) => isObject(attestation?.payload))
      .map((attestation) => stringOrNull(attestation.payload.attestorId)),
  }));
  return ok(200, { transfers });
}

/**
 * POST /list-disputed-escrows (spec 13.2). Body { }. The escrows in dispute
 * on this validator that no verdict has decided: approved, the dispute
 * signature approved, no verdict value with two approved arbitrations;
 * newest first. The transfer fields as above; disputedBy is
 * dispute_signature.payload.accountId; verdicts the escrow's
 * escrow_arbitrations rows, arbitrator order, approved as stored. The
 * caller is the verified attestor; the list is the same for every attestor.
 */
export async function listDisputedEscrows(accountId) {
  const rows = await findUndecidedDisputedEscrows();
  const escrows = rows.map((row) => ({
    ...heldTransferOf(row),
    disputedBy: isObject(row.dispute_signature?.payload) ? stringOrNull(row.dispute_signature.payload.accountId) : null,
    verdicts: row.verdicts,
  }));
  return ok(200, { escrows });
}

/**
 * A held transfer in wire form (the two attestor reads): its id and, read
 * from og_transaction.payload as pendingOf reads them, the sender, the
 * receiver, the amount and createdAt.
 */
function heldTransferOf(row) {
  const payload = isObject(row.og_transaction?.payload) ? row.og_transaction.payload : {};
  return {
    transactionId: hex(row.transaction_id),
    accountId: stringOrNull(payload.accountId),
    accountIdTo: stringOrNull(payload.accountIdTo),
    amount: typeof payload.amount === 'string' ? payload.amount : '0',
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : row.created_at.toISOString(),
  };
}

/** A payload field that should be a string, or null when it is not there. */
function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}
