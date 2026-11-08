import { isObject } from '../util/is-object.js';
import { ok, refuse } from '../util/result.js';
import {
  findAccountSummary,
  findAssistedFor,
  findAssistedWaitingForAttestors,
  findLatestTransactionId,
  findLockedFor,
  findOpenEscrowsFor,
  findPendingFor,
  findTransactions,
  findUndecidedDisputedEscrows,
} from './reads.queries.js';

/**
 * The reads feature (wallet spec 5.4): the five things an account may read
 * about itself (its account, its transactions, its open escrow trades, its
 * held assisted transfer, its locked transfer), nothing about anyone else.
 * The caller is the verified signer, req.account from
 * src/auth/require-account.js; the body is the route's own object. Each
 * function returns ok(status, body) or refuse(status, reason)
 * (util/result.js), so the handlers only log and answer.
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

/**
 * The stages of a held assisted transfer or break-glass move, as
 * /get-assisted-transfer names them (spec 17.2, section 22): waiting until
 * every validator accepted the transfer; attesting while it waits for two
 * approved attestations; locked with both attestations approved and its
 * unlock moment, a break-glass move's future_date, still ahead; writing
 * with both attestations approved and no moment ahead, until the next
 * leader round writes it; cancelling with a cancel on it.
 */
export const ASSISTED_STAGES = Object.freeze({
  WAITING: 'waiting',
  ATTESTING: 'attesting',
  LOCKED: 'locked',
  WRITING: 'writing',
  CANCELLING: 'cancelling',
});

/**
 * The stages of a locked transfer, a guarded or vault account's transfer
 * waiting out its time lock, as /get-locked-transfer names them (spec
 * 18.2): waiting until every validator accepted the transfer; locked
 * while its unlock moment is ahead; due once that moment has passed,
 * until the next leader round writes it.
 */
export const LOCKED_STAGES = Object.freeze({
  WAITING: 'waiting',
  LOCKED: 'locked',
  DUE: 'due',
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
 * (default 50, at most 200), from?: ISO 8601, to?: ISO 8601 }.
 * transactions: the garlic chain links where the signer sent or received,
 * position descending, below beforePosition when given, with created_at at
 * or after from and before to when given (either alone works; to is the
 * first moment after the range), limit rows. pending: the signer's pending
 * row, read from og_transaction.payload, an array of at most one; the dates
 * do not cut it. The other holding tables are not listed.
 */
export async function listTransactions(accountId, body) {
  if (!isObject(body)) return refuse(400, BAD_SHAPE);
  const beforePosition = body.beforePosition === undefined ? null : body.beforePosition;
  if (beforePosition !== null && !(Number.isInteger(beforePosition) && beforePosition >= 1)) {
    return refuse(400, 'invalid beforePosition');
  }
  const limit = body.limit === undefined ? DEFAULT_LIMIT : body.limit;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) return refuse(400, 'invalid limit');
  if (body.from !== undefined && !(typeof body.from === 'string' && !Number.isNaN(Date.parse(body.from)))) return refuse(400, 'invalid from');
  if (body.to !== undefined && !(typeof body.to === 'string' && !Number.isNaN(Date.parse(body.to)))) return refuse(400, 'invalid to');
  const from = body.from === undefined ? null : new Date(body.from);
  const to = body.to === undefined ? null : new Date(body.to);

  const [links, pendingRow] = await Promise.all([findTransactions(accountId, beforePosition, limit, from, to), findPendingFor(accountId)]);
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
 * POST /get-assisted-transfer (spec 17). Body { }. transfer: the signer's
 * held assisted transfer or break-glass move (section 22), the
 * assisted_transfers row whose account_id is the signer (there is at most
 * one), or null when there is none: the held transfer only, nothing from
 * logs or archives. The transfer fields as the other held-transfer reads
 * answer them (heldTransferOf, `type` among them); stage from
 * assistedStageOf; attestations the number of attestation slots holding
 * an object, 0, 1 or 2; unlocksAt the row's future_date, the moment a
 * break-glass move out of a guarded or vault account may be written, as
 * ISO 8601, or null.
 */
export async function getAssistedTransfer(accountId) {
  const row = await findAssistedFor(accountId);
  if (row === null) return ok(200, { transfer: null });
  const transfer = {
    ...heldTransferOf(row),
    stage: assistedStageOf(row),
    attestations: [row.has_attestation_1, row.has_attestation_2].filter(Boolean).length,
    unlocksAt: row.future_date === null ? null : row.future_date.toISOString(),
  };
  return ok(200, { transfer });
}

/**
 * Where a held assisted transfer or break-glass move is, from its row (spec
 * 17.2), the first line that matches: not approved is waiting; a
 * cancellation present is cancelling; both attestations approved with the
 * unlock moment still ahead (row.due false: a break-glass move out of a
 * guarded or vault account, section 22) is locked; both attestations
 * approved and due is writing; else attesting, accepted and waiting for two
 * approved attestations. A cancel is accepted until the transfer is
 * written, even with both attestations approved, and a cancellation
 * present keeps the row off the ready list (5.3, section 6), so cancelling
 * is decided before locked and writing; the order is a definition, as
 * stageOf's is. row.due is decided by the database's clock, the one
 * findReadyAssistedIds reads, so the wallet and the ready list agree.
 */
function assistedStageOf(row) {
  if (!row.approved) return ASSISTED_STAGES.WAITING;
  if (row.has_cancellation) return ASSISTED_STAGES.CANCELLING;
  if (row.attestation_1_approved && row.attestation_2_approved) {
    return row.due ? ASSISTED_STAGES.WRITING : ASSISTED_STAGES.LOCKED;
  }
  return ASSISTED_STAGES.ATTESTING;
}

/**
 * POST /get-locked-transfer (spec 18). Body { }. transfer: the signer's
 * locked transfer, the locked_transactions row whose account_id is the
 * signer (there is at most one), a guarded or vault transfer waiting out
 * its time lock, or null when there is none: the held transfer only,
 * nothing from logs or archives. The transfer fields as the other
 * held-transfer reads answer them (heldTransferOf); unlocksAt the row's
 * future_date, the moment the transfer may be written; stage from
 * lockedStageOf.
 */
export async function getLockedTransfer(accountId) {
  const row = await findLockedFor(accountId);
  if (row === null) return ok(200, { transfer: null });
  const transfer = {
    ...heldTransferOf(row),
    unlocksAt: row.future_date.toISOString(),
    stage: lockedStageOf(row),
  };
  return ok(200, { transfer });
}

/**
 * Where a locked transfer is, from its row (spec 18.2), the first line
 * that matches: not approved is waiting; approved with its unlock moment
 * ahead is locked; approved with that moment passed is due, until the next
 * leader round writes it. row.due is decided by the database's clock, the
 * one findDueIds (section 6) reads, so the wallet and the ready list
 * agree.
 */
function lockedStageOf(row) {
  if (!row.approved) return LOCKED_STAGES.WAITING;
  if (!row.due) return LOCKED_STAGES.LOCKED;
  return LOCKED_STAGES.DUE;
}

/**
 * POST /list-assisted-transfers (spec 13.2). Body { }. The assisted
 * transfers waiting for attestors on this validator: approved, no
 * cancellation present, an attestation slot still empty; newest first.
 * type, accountId, accountIdTo, amount and createdAt are read from
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
 * A held transfer in wire form (every held-transfer read): its id and, read
 * from og_transaction.payload as pendingOf reads them, its type (since
 * 2026-11-08: an assisted_transfers row is an assistedAnosTransfer or a
 * breakGlassTransfer, section 22), the sender, the receiver, the amount and
 * createdAt.
 */
function heldTransferOf(row) {
  const payload = isObject(row.og_transaction?.payload) ? row.og_transaction.payload : {};
  return {
    transactionId: hex(row.transaction_id),
    type: stringOrNull(payload.transactionType),
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
