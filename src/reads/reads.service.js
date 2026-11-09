import { env } from '../config/env.js';
import { findOpenProposals, findProposalVotes } from '../fund/fund.queries.js';
import { votePasses } from '../fund/fund.service.js';
import { VOTE_FAILED, WRITTEN, findArchivedProposal, findArchivedProposals } from '../records/records.queries.js';
import { PURPOSE_NAMES } from '../stakes/stake-purposes.js';
import { findStake, listDaoVoteStakes } from '../stakes/stakes.queries.js';
import { guardianWeight } from '../stakes/stakes.service.js';
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
 * The reads feature: the five things an account may read about itself
 * (wallet spec 5.4: its account, its transactions, its open escrow trades,
 * its held assisted transfer, its locked transfer), nothing about anyone
 * else; the two attestor reads (spec 13.2), the held transactions waiting
 * for an attestor; and the three public reads: every account's daoVote
 * stake for the masterpod's DAO voting snapshot (spec 23), and the fund's
 * proposals with their votes and payouts for the wallet's Guardians page
 * (spec 25), which /get-account serves too with the account's stakes and
 * guardian votes. The caller of a signed read is the verified signer,
 * req.account from src/auth/require-account.js (for the attestor reads the
 * verified attestor, src/auth/require-attestor.js); a public read has no
 * caller.
 * The body is the route's own object. Each function returns ok(status,
 * body) or refuse(status, reason) (util/result.js), so the handlers only
 * log and answer.
 */

const BAD_SHAPE = 'bad request shape';

/** /list-transactions: the default and the most rows one call answers; /list-escrows answers at most MAX_LIMIT too. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** /list-fund-proposals with status decided: the default number of archived proposals one call answers; at most MAX_LIMIT, as every list. */
const DECIDED_DEFAULT_LIMIT = 20;

/** The two lists /list-fund-proposals answers, as body.status names them (spec 25.1): the open proposal from fund_proposals, or the decided ones from archives. */
const OPEN_LIST = 'open';
const DECIDED_LIST = 'decided';

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

/**
 * The statuses of a fund proposal, as the two fund proposal reads name
 * them (spec 25.2), the first line that matches: waiting while the row is
 * not approved, so no vote is accepted on it yet (5.1); open while
 * vote_closes_at is ahead; closing once it has passed and the row is still
 * in fund_proposals, until the next ready list tallies it (section 6, "no
 * timer anywhere"); written for an archive row with outcome written, the
 * payouts on the chain; failed for outcome voteFailed. A wallet that meets
 * a status it does not know shows the proposal and offers no button.
 */
export const FUND_PROPOSAL_STATUSES = Object.freeze({
  WAITING: 'waiting',
  OPEN: 'open',
  CLOSING: 'closing',
  WRITTEN: 'written',
  FAILED: 'failed',
});

/** The status an archive row's outcome gives (spec 25.2): written stays written; voteFailed is failed. */
const ARCHIVE_STATUSES = Object.freeze({
  [WRITTEN]: FUND_PROPOSAL_STATUSES.WRITTEN,
  [VOTE_FAILED]: FUND_PROPOSAL_STATUSES.FAILED,
});

const hex = (buffer) => (buffer === null || buffer === undefined ? null : buffer.toString('hex'));

/**
 * POST /get-account. Body { }. The signer's type, balance as millionths in
 * a decimal string, latestTransactionId (the newest garlic chain link whose
 * account_id is the signer, hex, or null) and createdAt; since 2026-11-08
 * (spec 25) also its stakes, the six amounts by purpose (stakesOf), and
 * guardianVotes, its votes on fund proposals, floor(guardian /
 * GUARDIAN_VOTE_ANOS) as a number (stakes.service.js guardianWeight). One
 * findStake per call, beside the two reads it made already.
 */
export async function getAccount(accountId) {
  const [account, latest, stake] = await Promise.all([
    findAccountSummary(accountId),
    findLatestTransactionId(accountId),
    findStake(accountId),
  ]);
  if (account === null) return refuse(401, 'unknown account');
  return ok(200, {
    accountId: hex(accountId),
    type: account.type,
    balance: account.balance,
    latestTransactionId: hex(latest),
    createdAt: account.createdAt.toISOString(),
    stakes: stakesOf(stake),
    guardianVotes: guardianWeight(stake),
  });
}

/**
 * An account's stakes as /get-account answers them (spec 25): one amount
 * per purpose name, in the order of stake-purposes.js (daoVote, moderator,
 * attestor, guardian, validator, masterPod), millionths as a decimal
 * string; "0" each for an account with no stakes row (findStake null),
 * which holds nothing.
 */
function stakesOf(stake) {
  const stakes = {};
  for (const name of PURPOSE_NAMES) {
    stakes[name] = stake === null ? '0' : stake[name].toString();
  }
  return stakes;
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
 * POST /list-dao-stakes (spec 23). Public: no envelope, no signature, no
 * caller; the body must be an object and nothing in it is read. stakes:
 * every stakes row with dao_vote_stake > 0, accountId hex, daoVoteStake
 * millionths as a decimal string, account id ascending; total their sum as
 * a decimal string, "0" with no rows; asOf this server's clock at the
 * read, ISO 8601. The masterpod reads it once when a DAO proposal is
 * posted and once when it goes to a vote, and boils it down to one weight
 * per anoPod. Everything in it is already on the public chain: each
 * transferToFund link names its purpose.
 */
export async function listDaoStakes(body) {
  if (!isObject(body)) return refuse(400, BAD_SHAPE);
  const { total, rows } = await listDaoVoteStakes();
  const stakes = rows.map((row) => ({ accountId: hex(row.accountId), daoVoteStake: row.daoVoteStake }));
  return ok(200, { asOf: new Date().toISOString(), total, stakes });
}

/**
 * POST /list-fund-proposals (spec 25). Public: no envelope, no signature,
 * no caller; the body must be an object. Body { status: 'open' | 'decided',
 * limit?, offset?, from?, to? }. settings: this validator's four
 * guardian-vote numbers (settingsOf). proposals: one item per proposal
 * (proposalItemOf, archivedItemOf), each with its votes. For 'open' the
 * fund_proposals rows, at most one; the other fields are not read. For
 * 'decided' the archives rows that left fund_proposals, newest first by
 * created_at, limit rows (default 20, at most 200) after offset rows (default
 * 0), with created_at at or after from and before to when given (ISO 8601;
 * either alone works; to is the first moment after the range, as
 * /list-transactions takes them). Anything else in status is 400 invalid
 * status; a bad limit, offset, from or to is 400 invalid <field>.
 * Everything answered is the fund's business: a written proposal's payouts
 * are on the public chain as transferFromFund links, and the votes are the
 * guardians' public act on the fund's money.
 */
export async function listFundProposals(body) {
  if (!isObject(body)) return refuse(400, BAD_SHAPE);
  if (body.status === OPEN_LIST) {
    const proposals = await Promise.all((await findOpenProposals()).map(proposalItemOf));
    return ok(200, { settings: settingsOf(), proposals });
  }
  if (body.status !== DECIDED_LIST) return refuse(400, 'invalid status');

  const limit = body.limit === undefined ? DECIDED_DEFAULT_LIMIT : body.limit;
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT)) return refuse(400, 'invalid limit');
  const offset = body.offset === undefined ? 0 : body.offset;
  if (!(Number.isInteger(offset) && offset >= 0)) return refuse(400, 'invalid offset');
  if (body.from !== undefined && !(typeof body.from === 'string' && !Number.isNaN(Date.parse(body.from)))) return refuse(400, 'invalid from');
  if (body.to !== undefined && !(typeof body.to === 'string' && !Number.isNaN(Date.parse(body.to)))) return refuse(400, 'invalid to');
  const from = body.from === undefined ? null : new Date(body.from);
  const to = body.to === undefined ? null : new Date(body.to);

  const rows = await findArchivedProposals({ limit, offset, from, to });
  return ok(200, { settings: settingsOf(), proposals: rows.map(archivedItemOf) });
}

/**
 * POST /get-fund-proposal (spec 25). Public, as /list-fund-proposals. Body
 * { transactionId: hex }, a proposal's id as 64 hex characters (else 400
 * invalid transactionId). proposal: the item as the list answers it, plus
 * proposerWeight, the proposer's votes when the proposal was stored, and
 * payouts, the payload's payouts in index order (payoutsOf). The open row
 * in fund_proposals is looked for first, then the archives row it became;
 * neither is 404 unknown proposal. settings as the list.
 */
export async function getFundProposal(body) {
  if (!isObject(body)) return refuse(400, BAD_SHAPE);
  if (!(typeof body.transactionId === 'string' && /^[0-9a-f]{64}$/i.test(body.transactionId))) {
    return refuse(400, 'invalid transactionId');
  }
  const transactionId = Buffer.from(body.transactionId, 'hex');

  let fields;
  const open = (await findOpenProposals()).find((row) => row.transactionId.equals(transactionId));
  if (open) {
    fields = await proposalFieldsOf(open);
  } else {
    const archive = await findArchivedProposal(transactionId);
    if (archive === null) return refuse(404, 'unknown proposal');
    fields = archivedFieldsOf(archive);
  }
  const proposal = { ...itemOf(fields), proposerWeight: fields.proposerWeight, payouts: payoutsOf(fields.payload) };
  return ok(200, { settings: settingsOf(), proposal });
}

/**
 * This validator's four guardian-vote numbers, answered as settings by both
 * fund proposal reads (spec 25.1) so the wallet's notice, its rule and its
 * become-a-guardian sentence read the validator's own values: anosPerVote
 * (GUARDIAN_VOTE_ANOS) and minimumStake (STAKE_MIN_GUARDIAN_ANOS) in
 * millionths as decimal strings like every amount; percent
 * (GUARDIAN_VOTE_PERCENT) and minutes (GUARDIAN_VOTE_MINUTES) as numbers.
 */
function settingsOf() {
  return {
    anosPerVote: env.guardianVote.anosPerVote.toString(),
    minimumStake: env.stakes.minimums.guardian.toString(),
    percent: env.guardianVote.percent,
    minutes: env.guardianVote.minutes,
  };
}

/** A fund_proposals row (findOpenProposals) as an item (spec 25.1), its votes read with findProposalVotes. */
async function proposalItemOf(row) {
  return itemOf(await proposalFieldsOf(row));
}

/** An archives row that left fund_proposals (findArchivedProposals) as an item (spec 25.1), its votes from the record. */
function archivedItemOf(archive) {
  return itemOf(archivedFieldsOf(archive));
}

/**
 * What itemOf and the single read need, from a fund_proposals row
 * (findOpenProposals): the id as hex, the payload
 * (og_transaction.payload), the row's created_at and vote_closes_at as ISO
 * 8601, the status (openStatusOf), the proposer's weight, the tally as the
 * row's sums give it, decidedAt null since the row is still open, and the
 * votes (findProposalVotes) in wire form, guardian id order.
 */
async function proposalFieldsOf(row) {
  const votes = await findProposalVotes(row.transactionId);
  return {
    transactionId: hex(row.transactionId),
    payload: isObject(row.ogTransaction?.payload) ? row.ogTransaction.payload : {},
    rowCreatedAt: row.createdAt.toISOString(),
    voteClosesAt: row.voteClosesAt.toISOString(),
    status: openStatusOf(row),
    approved: row.approved,
    proposerWeight: row.proposerWeight,
    forWeight: row.forWeight,
    againstWeight: row.againstWeight,
    decidedAt: null,
    votes: votes.map((vote) => ({
      guardianId: hex(vote.guardianAccountId),
      vote: vote.vote,
      weight: vote.weight,
      approved: vote.approved,
      votedAt: vote.votedAt.toISOString(),
    })),
  };
}

/**
 * Where an open proposal is (spec 25.2), the first line that matches: not
 * approved is waiting; its vote closed by the database's clock (row.closed,
 * the clock the ready list reads, so the wallet and the ready list agree) is
 * closing, until the next round tallies it; else open.
 */
function openStatusOf(row) {
  if (!row.approved) return FUND_PROPOSAL_STATUSES.WAITING;
  if (row.closed) return FUND_PROPOSAL_STATUSES.CLOSING;
  return FUND_PROPOSAL_STATUSES.OPEN;
}

/**
 * The same fields from an archives row (findArchivedProposals). record is
 * { row, votes } as records.queries.js built it with to_jsonb: bytes as hex
 * text with a leading \x, timestamps in PostgreSQL's ISO 8601 form with the
 * server's offset. The \x is stripped (hexOf) and the timestamps re-read
 * (isoOf), so an archived item has the same shape as an open one. The
 * payload comes from record.row.og_transaction.payload, the tally from
 * record.votes as the round tallied it (proposer_weight plus the approved
 * votes for; the approved votes against), the status from the outcome
 * (ARCHIVE_STATUSES: written, or failed for voteFailed; any other outcome
 * passes through as it is), decidedAt from the archive row's created_at.
 */
function archivedFieldsOf(archive) {
  const record = isObject(archive.record) ? archive.record : {};
  const row = isObject(record.row) ? record.row : {};
  const votes = (Array.isArray(record.votes) ? record.votes : []).filter(isObject).map((vote) => ({
    guardianId: hexOf(vote.guardian_account_id),
    vote: stringOrNull(vote.vote),
    weight: Number(vote.weight) || 0,
    approved: vote.approved === true,
    votedAt: isoOf(vote.created_at),
  }));
  const proposerWeight = Number(row.proposer_weight) || 0;
  return {
    transactionId: hex(archive.transaction_id),
    payload: isObject(row.og_transaction?.payload) ? row.og_transaction.payload : {},
    rowCreatedAt: isoOf(row.created_at),
    voteClosesAt: isoOf(row.vote_closes_at),
    status: ARCHIVE_STATUSES[archive.outcome] ?? archive.outcome,
    approved: row.approved === true,
    proposerWeight,
    forWeight: proposerWeight + weightOf(votes, 'for'),
    againstWeight: weightOf(votes, 'against'),
    decidedAt: archive.created_at.toISOString(),
    votes,
  };
}

/** The weight of the approved votes on one side, 'for' or 'against', as the tally counts them (section 6): a vote not yet approved counts for nothing. */
function weightOf(votes, side) {
  return votes.filter((vote) => vote.approved && vote.vote === side).reduce((sum, vote) => sum + vote.weight, 0);
}

/**
 * An item, the fund proposal in wire form both reads answer (spec 25.1),
 * from the fields proposalFieldsOf or archivedFieldsOf made: the proposer
 * (guardianId) and createdAt from the payload (createdAt falls back to the
 * row's when the payload has none, as pendingOf does), the payouts counted
 * and summed (total, millionths as a decimal string), the tally and whether
 * it passes as it stands (fund.service.js votePasses, the round's own
 * rule), and the votes.
 */
function itemOf(fields) {
  const { payload } = fields;
  const payouts = Array.isArray(payload.payouts) ? payload.payouts : [];
  return {
    transactionId: fields.transactionId,
    guardianId: stringOrNull(payload.guardianId),
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : fields.rowCreatedAt,
    voteClosesAt: fields.voteClosesAt,
    status: fields.status,
    approved: fields.approved,
    payoutCount: payouts.length,
    total: totalOf(payouts),
    forWeight: fields.forWeight,
    againstWeight: fields.againstWeight,
    passing: votePasses({ forWeight: fields.forWeight, againstWeight: fields.againstWeight }),
    decidedAt: fields.decidedAt,
    votes: fields.votes,
  };
}

/** The payouts' amounts summed, millionths as a decimal string: each a positive integer in a decimal string, as the proposal's checks made sure (fund.service.js); anything else counts as 0. */
function totalOf(payouts) {
  return payouts
    .reduce((sum, payout) => sum + (isObject(payout) && typeof payout.amount === 'string' && /^[0-9]+$/.test(payout.amount) ? BigInt(payout.amount) : 0n), 0n)
    .toString();
}

/**
 * The payload's payouts in wire form for the single read (spec 25.1), index
 * order: { index, accountIdTo, amount, reason, stakeFor }, the fields as the
 * proposer sent them, stakeFor null when the payout returns no stake.
 */
function payoutsOf(payload) {
  const payouts = Array.isArray(payload.payouts) ? payload.payouts : [];
  return payouts.map((payout, index) => {
    const fields = isObject(payout) ? payout : {};
    return {
      index,
      accountIdTo: stringOrNull(fields.accountIdTo),
      amount: typeof fields.amount === 'string' ? fields.amount : '0',
      reason: stringOrNull(fields.reason),
      stakeFor: stringOrNull(fields.stakeFor),
    };
  });
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

/** Bytes as to_jsonb wrote them into an archive record, hex text with a leading \x, as plain hex; null when the value is not such a string. */
function hexOf(value) {
  if (typeof value !== 'string') return null;
  return value.startsWith('\\x') ? value.slice(2) : value;
}

/** A timestamp as to_jsonb wrote it into an archive record (PostgreSQL's ISO 8601 form, with the server's offset) as ISO 8601 in UTC, the form every other read answers; null when it is not a date. */
function isoOf(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
