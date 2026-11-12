import { ANY_TWO_PAIRS, verifyAccountSignatures } from '../accounts/account-signatures.js';
import { SPENDING } from '../accounts/account-types.js';
import { env } from '../config/env.js';
import { canonicalHash, canonicalize } from '../crypto/canonical.js';
import { decodeDigest, digestMatches, sha256 } from '../crypto/hash.js';
import { pool } from '../db/pool.js';
import { insertLink } from '../garlic-chain/garlic-chain.queries.js';
import {
  ASSISTED_TRANSFERS,
  ESCROW_TRANSFERS,
  FUND_PROPOSALS,
  HELD_TABLES,
  LOCKED_TRANSACTIONS,
  PENDING,
} from '../held-transactions/held-transactions.js';
import { fetchAnosAccount } from '../masterpod/masterpod.client.js';
import { VOTE_FAILED, moveToArchives } from '../records/records.queries.js';
import { PURPOSE_NAMES, isAppointedPurpose, isPurpose, minimumFor } from '../stakes/stake-purposes.js';
import { addStake, findStake, subtractStake } from '../stakes/stakes.queries.js';
import { guardianWeight } from '../stakes/stakes.service.js';
import { findAccount, findExisting, findLatestTransactionId } from '../transfer/transfer.queries.js';
import { isObject } from '../util/is-object.js';
import { sendProofOfAcceptance, sendTransactionApproval } from '../validators/validators.messages.js';
import { settleNoAnswers } from '../votes/votes.messages.js';
import { FUND_ACCOUNT_ID } from './fund-account.js';
import { findClosedProposals, findExistingAccounts, findProposalConflicts } from './fund.queries.js';

/**
 * The fund feature: the two transaction kinds that move anos to and from the
 * fund. A transferToFund stakes anos with the fund for a purpose
 * (stake-purposes.js) and is held in pending like a plain transfer; a
 * fundProposal is a guardian's list of payouts from the fund, held in
 * fund_proposals while the guardians vote on it (guardian-vote.js), then
 * written as one proposal link followed by one transferFromFund link per
 * payout. Both go round the validators exactly as every transaction does.
 */

/** The transactionType of a stake: a transfer from a spending account to the fund, naming its purpose. */
export const TRANSFER_TO_FUND = 'transferToFund';

/** The transactionType of a fund proposal. */
export const FUND_PROPOSAL = 'fundProposal';

/** The transactionType of a payout link written for each payout of a proposal that passed. */
export const TRANSFER_FROM_FUND = 'transferFromFund';

const MS_PER_MINUTE = 60_000;

/** The largest value a BIGINT column holds. */
const MAX_BIGINT = 2n ** 63n - 1n;

/**
 * Which field of transfer.queries.js findExisting reports a row in which
 * holding table, with the key of that table's conflict reason, in the order
 * the tables are checked.
 */
const HELD_CONFLICTS = [
  ['pendingTransaction', PENDING, 'transaction_id'],
  ['pendingForAccount', PENDING, 'account_id'],
  ['lockedTransaction', LOCKED_TRANSACTIONS, 'transaction_id'],
  ['lockedForAccount', LOCKED_TRANSACTIONS, 'account_id'],
  ['assistedTransaction', ASSISTED_TRANSFERS, 'transaction_id'],
  ['assistedForAccount', ASSISTED_TRANSFERS, 'account_id'],
  ['escrowTransaction', ESCROW_TRANSFERS, 'transaction_id'],
  ['escrowForAccount', ESCROW_TRANSFERS, 'account_id'],
  ['proposalTransaction', FUND_PROPOSALS, 'transaction_id'],
  ['proposalForAccount', FUND_PROPOSALS, 'account_id'],
];

/**
 * Validates a transferToFund, { payload, signatures }: the transfer payload
 * of transfer.service.js (accountId, transactionId, previousTransactionId,
 * transactionType, amount, accountIdTo, createdAt) plus stakeFor, the
 * purpose staked for. The checks run in the order of verifyAnosTransfer,
 * with the fund's extras after the ids: accountIdTo is the fund, stakeFor is
 * one of the six purposes, amount is at least that purpose's minimum. The
 * sender must be a spending account; the signatures follow the any-two-pairs
 * rule; createdAt is within LOCK_OFFSET_MINUTES of now, before or after,
 * as a fund proposal's is (since 2026-11-11, docs/schemas.md section 27: a
 * stake is dated now, and one older than the offset is never taken in);
 * the uniqueness checks cover the five holding tables and the chain.
 *
 * The shape, signature and id parts (the shape; the ids and the amount;
 * accountIdTo the fund and stakeFor a purpose; the sender exists; the
 * signatures; transactionId) are checkTransferToFundSignaturesAndIds,
 * lifted out for the replay of a chain chunk
 * (src/garlic-chain/replay.service.js), which runs them and nothing else;
 * the date, the minimum, the account's type and the rest follow here.
 *
 * Returns { ok: true, accountId, transactionId, accountIdTo, heldIn } with
 * the ids as 32-byte Buffers and heldIn 'pending', the shape every verify
 * function gives, or { ok: false, reason }. Storing is receiveTransferToFund's job,
 * and so is the appointment check of a moderator or attestor stake
 * (checkAppointment, docs/schemas.md section 24), run after this passed on
 * the receiving validator only: this function is what the approval path
 * runs on every peer (validators.service.js verifyTransaction), and it
 * never asks the masterpod.
 */
export async function verifyTransferToFund(body) {
  const checked = await checkTransferToFundSignaturesAndIds(body);
  if (!checked.ok) return checked;

  const { payload } = body;
  const { accountId, accountIdTo, amount, account, transactionId } = checked;

  // 1b. The date.
  const createdAt = Date.parse(payload.createdAt);
  if (!(Math.abs(createdAt - Date.now()) <= env.locks.offsetMinutes * MS_PER_MINUTE)) {
    return { ok: false, reason: `payload.createdAt must be within ${env.locks.offsetMinutes} minutes of now` };
  }

  // 1c. The purpose's minimum.
  if (amount < minimumFor(payload.stakeFor)) {
    return { ok: false, reason: `payload.amount is less than the minimum stake for ${payload.stakeFor}` };
  }

  // 2b. The sending account is a spending account.
  if (account.type !== SPENDING) {
    return { ok: false, reason: `${TRANSFER_TO_FUND} can only be sent from a ${SPENDING} account` };
  }

  // 5. previousTransactionId.
  const latest = await findLatestTransactionId(accountId);
  if (latest === null || !digestMatches(payload.previousTransactionId, latest)) {
    return { ok: false, reason: "payload.previousTransactionId is not the account's latest transaction" };
  }

  // 6. The fund exists, and uniqueness.
  const existing = await findExisting({ accountId, accountIdTo, transactionId });
  if (!existing.accountToExists) return { ok: false, reason: 'no account with this accountIdTo' };
  const conflict = heldConflict(existing);
  if (conflict) return { ok: false, reason: conflict };
  if (existing.chainTransaction) {
    return { ok: false, reason: 'a transaction with this transactionId is already in the garlic chain' };
  }

  // 7. Balance.
  if (BigInt(account.currentBalance) < amount) {
    return { ok: false, reason: "payload.amount is more than the account's balance" };
  }

  return { ok: true, accountId, transactionId, accountIdTo, heldIn: PENDING };
}

/**
 * The shape, signature and id checks of a transferToFund: the shape; the
 * ids and the amount; accountIdTo is the fund and stakeFor a purpose (not
 * the minimum); the sending account exists, read on `client` when one is
 * given (the replay of a chain chunk, inside its transaction) and through
 * the pool otherwise; the signatures, any two pairs; transactionId.
 * Returns { ok: true, accountId, accountIdTo, amount (BigInt), account,
 * transactionId } with the ids as 32-byte Buffers, or { ok: false, reason }.
 */
export async function checkTransferToFundSignaturesAndIds(body, { client } = {}) {
  const problem = checkTransferToFundShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signatures } = body;

  // 1. Ids and amount.
  const accountId = decodeDigest(payload.accountId);
  if (!accountId) return { ok: false, reason: 'payload.accountId is not a SHA-256 digest' };
  const accountIdTo = decodeDigest(payload.accountIdTo);
  if (!accountIdTo) return { ok: false, reason: 'payload.accountIdTo is not a SHA-256 digest' };
  if (!decodeDigest(payload.previousTransactionId)) {
    return { ok: false, reason: 'payload.previousTransactionId is not a SHA-256 digest' };
  }
  const amount = parseAmount(payload.amount);
  if (amount === null) return { ok: false, reason: `payload.amount ${AMOUNT_RULE}` };

  // 1b. The fund and the purpose.
  if (!accountIdTo.equals(FUND_ACCOUNT_ID)) return { ok: false, reason: 'payload.accountIdTo is not the fund' };
  if (!isPurpose(payload.stakeFor)) {
    return { ok: false, reason: `payload.stakeFor must be one of ${PURPOSE_NAMES.join(', ')}` };
  }

  // 2a. The sending account exists.
  const account = await findAccount(accountId, client);
  if (!account) return { ok: false, reason: 'no account with this accountId' };

  // 3. Signatures.
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const badSignatures = verifyAccountSignatures(account, signatures, message, ANY_TWO_PAIRS);
  if (badSignatures) return { ok: false, reason: badSignatures };

  // 4. transactionId: the hash of the payload without itself.
  const transactionId = unsignedHash(payload);
  if (!digestMatches(payload.transactionId, transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the SHA-256 of the canonical payload without transactionId' };
  }

  return { ok: true, accountId, accountIdTo, amount, account, transactionId };
}

/**
 * What the initial validator does with a transferToFund: verify it
 * (verifyTransferToFund), then, for a moderator, attestor, validator or
 * masterPod stake, ask the masterpod whether the sending account's anoPod
 * is appointed for it (checkAppointment, docs/schemas.md sections 24 and
 * 26), store it in pending and send it round, exactly as
 * transfer.service.js receiveAnosTransfer does. Returns what that returns.
 */
export function receiveTransferToFund(body) {
  return receiveTransaction(body, async (b) => {
    const r = await verifyTransferToFund(b);
    return r.ok ? checkAppointment(b, r) : r;
  });
}

/**
 * The appointment check of a moderator, attestor, validator or masterPod
 * stake (docs/schemas.md section 24; validator and masterPod since
 * 2026-11-10, section 26), the way receiveCreateAccount's binding check
 * works (accounts.service.js): run by receiveTransferToFund once
 * verifyTransferToFund passed, with `verified` its result. When
 * payload.stakeFor is one of those four (stake-purposes.js
 * isAppointedPurpose) the masterpod is asked for the sending account
 * (masterpod.client.js fetchAnosAccount, five seconds), and the stake passes
 * only when the anoPod that made the account holds the appointment stakeFor
 * names. No answer, or an account not bound to a vouched anoPod, refuses
 * with "the masterpod could not confirm the sending account's anoPod"; a
 * bound anoPod whose role is not stakeFor (another role, none, or a
 * masterpod that does not send the role: one from before the appointments
 * sends none, one from before 2026-11-10 never sends validator or
 * masterPod) refuses with "the sending account's anoPod is not appointed
 * as <stakeFor>". For the other two purposes, daoVote and guardian,
 * `verified` comes back without a call. The handler logs the reason and
 * answers 400 like any refusal
 * (util/submission-response.js): the signer is the account's own holder and
 * learns nothing they did not know. Only the receiving validator asks: the
 * validator-to-validator approval path (validators.service.js
 * verifyTransaction) runs verifyTransferToFund alone and trusts the check,
 * as it trusts the binding; the replay of a chain chunk
 * (garlic-chain/replay.service.js) and the held-row checks
 * (held-transactions/held-rows.service.js) run
 * checkTransferToFundSignaturesAndIds alone, as before.
 */
async function checkAppointment(body, verified) {
  const { stakeFor } = body.payload;
  if (!isAppointedPurpose(stakeFor)) return verified;

  const binding = await fetchAnosAccount(verified.accountId);
  if (!binding.bound) {
    return { ok: false, reason: "the masterpod could not confirm the sending account's anoPod" };
  }
  if (binding.role !== stakeFor) {
    return { ok: false, reason: `the sending account's anoPod is not appointed as ${stakeFor}` };
  }
  return verified;
}

/**
 * Writes one transferToFund on `client`, inside the batch that
 * accounts.service.js writeTransactions runs: its garlic chain link, exactly
 * as transfer.service.js writeAnosTransfer writes a transfer (the sender as
 * account_id, the fund as account_id_to, the amount, the transactionType as
 * its type; the balance trigger moves the anos), then the sender's stake for
 * payload.stakeFor grows by the amount (stakes.queries.js addStake), the
 * stakes row created if the account has none. Returns the link's
 * record_hash for the next link to chain on.
 */
export async function writeTransferToFund(client, { transactionId, accountId, ogTransaction }, previousRecordHash) {
  const { payload } = ogTransaction;
  const transHash = canonicalHash(payload);
  const recordHash = chainHash(transHash, previousRecordHash);
  await insertLink(client, {
    accountId,
    accountIdTo: decodeDigest(payload.accountIdTo),
    transactionId,
    amount: payload.amount,
    transHash,
    recordHash,
    type: payload.transactionType,
    ogTransaction,
  });
  await addStake(client, accountId, payload.stakeFor, payload.amount);
  return recordHash;
}

/**
 * Validates a fundProposal, { payload, signatures }:
 *
 *   payload: {
 *     accountId:       the fund's account id
 *     guardianId:      the proposer's account id
 *     transactionType: 'fundProposal'
 *     createdAt:       ISO 8601
 *     payouts:         [ { accountIdTo, amount, reason, stakeFor? }, ... ], at least one
 *     transactionId:   the SHA-256 of the canonical payload without transactionId
 *   }
 *   signatures: the proposer's account keys, any two pairs
 *
 * No previousTransactionId: the fund cannot sign, its newest link depends on
 * batch order, and one open proposal at a time plus the unique transactionId
 * already rule out replay and reordering.
 *
 * The checks, in the order they run: the shape; accountId is the fund; the
 * proposer's account exists; the signatures; transactionId; each payout's
 * recipient decodes and is not the fund, its amount is a positive integer,
 * its stakeFor, when present, a purpose (all of it
 * checkFundProposalSignaturesAndIds, lifted out for the replay of a chain
 * chunk, src/garlic-chain/replay.service.js, which runs it and nothing
 * else); then createdAt is within LOCK_OFFSET_MINUTES of now, either way,
 * because the voting window is counted from it; the proposer has at least
 * one guardian vote (stakes.service.js guardianWeight); each recipient is
 * an existing account; for each recipient and purpose, the recipient's
 * stake for the purpose covers the sum of the payouts returning it; the
 * sum of all amounts is within the fund's balance; the uniqueness checks,
 * which for the fund mean no open proposal.
 *
 * Returns { ok: true, accountId, transactionId, heldIn, voteClosesAt,
 * proposerWeight }: the fund's id and the proposal's as 32-byte Buffers,
 * heldIn 'fund_proposals', when voting ends (createdAt plus
 * GUARDIAN_VOTE_MINUTES, a Date) and the proposer's votes now, which the
 * fund_proposals row stores. Or { ok: false, reason }. Storing is
 * receiveFundProposal's job.
 */
export async function verifyFundProposal(body) {
  const checked = await checkFundProposalSignaturesAndIds(body);
  if (!checked.ok) return checked;

  const { payload } = body;
  const { guardianId, transactionId, payouts } = checked;

  // 1b. The date.
  const createdAt = Date.parse(payload.createdAt);
  if (!(Math.abs(createdAt - Date.now()) <= env.locks.offsetMinutes * MS_PER_MINUTE)) {
    return { ok: false, reason: `payload.createdAt must be within ${env.locks.offsetMinutes} minutes of now` };
  }

  // 2b. The proposer has at least one guardian vote.
  const proposerWeight = guardianWeight(await findStake(guardianId));
  if (proposerWeight < 1) return { ok: false, reason: 'the proposer has no guardian vote' };

  // 5b. Each recipient exists.
  const recipients = new Map(payouts.map(({ recipient }) => [recipient.toString('hex'), recipient]));
  const found = new Set((await findExistingAccounts([...recipients.values()])).map((id) => id.toString('hex')));
  for (const { index, recipient } of payouts) {
    if (!found.has(recipient.toString('hex'))) {
      return { ok: false, reason: `payload.payouts[${index}].accountIdTo is not an existing account` };
    }
  }

  // 6. Returned stake: per recipient and purpose, the stake covers the sum.
  const returned = new Map();
  for (const { recipient, amount, stakeFor } of payouts) {
    if (stakeFor === undefined) continue;
    const key = `${recipient.toString('hex')}:${stakeFor}`;
    returned.set(key, (returned.get(key) ?? 0n) + amount);
  }
  for (const [key, sum] of returned) {
    const [hex, purpose] = key.split(':');
    const stake = await findStake(recipients.get(hex));
    if (stake === null || stake[purpose] < sum) {
      return { ok: false, reason: `payload.payouts return more ${purpose} stake than account ${hex} holds` };
    }
  }

  // 7. The fund's balance covers the lot.
  const total = payouts.reduce((sum, { amount }) => sum + amount, 0n);
  if (total > MAX_BIGINT) return { ok: false, reason: 'payload.payouts add up to more than a BIGINT holds' };
  const fund = await findAccount(FUND_ACCOUNT_ID);
  if (!fund) return { ok: false, reason: 'the fund account is missing' };
  if (BigInt(fund.currentBalance) < total) {
    return { ok: false, reason: "payload.payouts add up to more than the fund's balance" };
  }

  // 8. Uniqueness: nothing with this id anywhere, and no other open proposal.
  const existing = await findProposalConflicts({ transactionId, accountId: FUND_ACCOUNT_ID });
  if (existing.held) {
    return { ok: false, reason: HELD_TABLES[existing.held.table].conflictReasons[existing.held.conflict] };
  }
  if (existing.chainTransaction) {
    return { ok: false, reason: 'a transaction with this transactionId is already in the garlic chain' };
  }

  return {
    ok: true,
    accountId: FUND_ACCOUNT_ID,
    transactionId,
    heldIn: FUND_PROPOSALS,
    voteClosesAt: new Date(createdAt + env.guardianVote.minutes * MS_PER_MINUTE),
    proposerWeight,
  };
}

/**
 * The shape, signature and id checks of a fundProposal: the shape;
 * accountId is the fund; guardianId decodes; the proposer's account
 * exists, read on `client` when one is given (the replay of a chain chunk,
 * inside its transaction) and through the pool otherwise; the signatures,
 * any two pairs, against its keys; transactionId; each payout's recipient
 * decodes and is not the fund, its amount is a positive integer, its
 * stakeFor, when present, a purpose. No clock, no stake, no lookup of the
 * recipients, no balance, no holding table. Returns { ok: true, accountId
 * (the fund's), guardianId, proposer, transactionId, payouts: [ { index,
 * recipient, amount (BigInt), stakeFor } ] } with the ids as 32-byte
 * Buffers, or { ok: false, reason }.
 */
export async function checkFundProposalSignaturesAndIds(body, { client } = {}) {
  const problem = checkProposalShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signatures } = body;

  // 1. The fund and the proposer's id.
  const accountId = decodeDigest(payload.accountId);
  if (!accountId) return { ok: false, reason: 'payload.accountId is not a SHA-256 digest' };
  if (!accountId.equals(FUND_ACCOUNT_ID)) return { ok: false, reason: 'payload.accountId is not the fund' };
  const guardianId = decodeDigest(payload.guardianId);
  if (!guardianId) return { ok: false, reason: 'payload.guardianId is not a SHA-256 digest' };

  // 2a. The proposer's account exists.
  const proposer = await findAccount(guardianId, client);
  if (!proposer) return { ok: false, reason: 'no account with this guardianId' };

  // 3. Signatures.
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const badSignatures = verifyAccountSignatures(proposer, signatures, message, ANY_TWO_PAIRS);
  if (badSignatures) return { ok: false, reason: badSignatures };

  // 4. transactionId: the hash of the payload without itself.
  const transactionId = unsignedHash(payload);
  if (!digestMatches(payload.transactionId, transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the SHA-256 of the canonical payload without transactionId' };
  }

  // 5a. Each payout: recipient, amount, purpose.
  const payouts = [];
  for (const [i, payout] of payload.payouts.entries()) {
    const recipient = decodeDigest(payout.accountIdTo);
    if (!recipient) return { ok: false, reason: `payload.payouts[${i}].accountIdTo is not a SHA-256 digest` };
    if (recipient.equals(FUND_ACCOUNT_ID)) return { ok: false, reason: `payload.payouts[${i}].accountIdTo is the fund` };
    const amount = parseAmount(payout.amount);
    if (amount === null) return { ok: false, reason: `payload.payouts[${i}].amount ${AMOUNT_RULE}` };
    if (payout.stakeFor !== undefined && !isPurpose(payout.stakeFor)) {
      return { ok: false, reason: `payload.payouts[${i}].stakeFor must be one of ${PURPOSE_NAMES.join(', ')}` };
    }
    payouts.push({ index: i, recipient, amount, stakeFor: payout.stakeFor });
  }

  return { ok: true, accountId, guardianId, proposer, transactionId, payouts };
}

/**
 * What the initial validator does with a fundProposal: verify it
 * (verifyFundProposal), store it in fund_proposals with vote_closes_at and
 * proposer_weight, and send it round, exactly as transfer.service.js
 * receiveAnosTransfer does. Returns what that returns.
 */
export function receiveFundProposal(body) {
  return receiveTransaction(body, verifyFundProposal);
}

/**
 * Writes one fund proposal that passed its vote on `client`, inside the
 * batch that accounts.service.js writeTransactions runs: the proposal link
 * (type fundProposal, account_id the fund, no account_id_to, amount 0,
 * og_transaction the proposal as received, trans_hash the hash of its
 * payload), then one payout link per payout in index order: type
 * transferFromFund, account_id the fund, account_id_to the recipient, the
 * amount, og_transaction { payload } holding the payout object
 * (payoutObject), whose canonical hash is both the link's transaction_id
 * and its trans_hash. The balance trigger moves each payout's amount. A
 * payout with stakeFor also takes its amount off the recipient's stake for
 * that purpose (stakes.queries.js subtractStake), deleting the stakes row
 * when nothing is left in it. record_hash chains over every link written,
 * the proposal's then each payout's. Returns the last record_hash for the
 * next link to chain on.
 */
export async function writeFundProposal(client, { transactionId, accountId, ogTransaction }, previousRecordHash) {
  const { payload } = ogTransaction;
  const transHash = canonicalHash(payload);
  let recordHash = chainHash(transHash, previousRecordHash);
  await insertLink(client, {
    accountId,
    accountIdTo: null,
    transactionId,
    amount: 0,
    transHash,
    recordHash,
    type: payload.transactionType,
    ogTransaction,
  });

  for (const [index, payout] of payload.payouts.entries()) {
    const object = payoutObject(payload.transactionId, index, payout);
    const payoutHash = canonicalHash(object);
    recordHash = chainHash(payoutHash, recordHash);
    const recipient = decodeDigest(payout.accountIdTo);
    await insertLink(client, {
      accountId,
      accountIdTo: recipient,
      transactionId: payoutHash,
      amount: payout.amount,
      transHash: payoutHash,
      recordHash,
      type: TRANSFER_FROM_FUND,
      ogTransaction: { payload: object },
    });
    if (payout.stakeFor !== undefined) {
      await subtractStake(client, recipient, payout.stakeFor, payout.amount);
    }
  }
  return recordHash;
}

/**
 * The payout object a transferFromFund link carries as its payload, and
 * whose canonical SHA-256 is the link's id: the proposal's transactionId as
 * the proposer sent it, the payout's position in payouts from 0, the
 * payout's own fields, and the type.
 */
export function payoutObject(proposalId, index, { accountIdTo, amount, reason, stakeFor }) {
  const object = { proposalId, index, accountIdTo, amount, reason, transactionType: TRANSFER_FROM_FUND };
  if (stakeFor !== undefined) object.stakeFor = stakeFor;
  return object;
}

/**
 * The tally of one closed proposal, as fund.queries.js findClosedProposals
 * reports it: the votes for (the proposer's weight plus the approved votes
 * for) and against. The proposal passes when the votes for are at least
 * GUARDIAN_VOTE_PERCENT of the votes cast. Guardians who did not vote count
 * for nothing.
 */
export function votePasses({ forWeight, againstWeight }) {
  return forWeight * 100 >= env.guardianVote.percent * (forWeight + againstWeight);
}

/**
 * The ids of every fund proposal a leader round may write, in id order, as
 * hex strings: approved, its vote closed, and the tally passing. A closed
 * proposal whose vote failed is moved to archives here, outcome voteFailed,
 * with its votes, by the validator that finds it while building its list;
 * nothing is written for it.
 */
export async function findReadyProposalIds() {
  const ready = [];
  const failed = [];
  for (const proposal of await findClosedProposals()) {
    (votePasses(proposal) ? ready : failed).push(proposal.transactionId);
  }
  if (failed.length > 0) {
    const client = await pool.connect();
    try {
      for (const transactionId of failed) {
        await moveToArchives(client, FUND_PROPOSALS, VOTE_FAILED, transactionId);
        console.log('vote failed:', transactionId.toString('hex'));
      }
    } finally {
      client.release();
    }
  }
  return ready.map((transactionId) => transactionId.toString('hex'));
}

/**
 * The receive flow every transaction shares (accounts.service.js
 * receiveCreateAccount, transfer.service.js receiveAnosTransfer), with
 * `verify` as the check: verify; store the whole submission with approved =
 * false in the holding table the check named (heldIn, through the registry
 * in held-transactions.js); send a signed transaction approval receipt to
 * every other active validator, wait for all of them, and check each answer
 * as a transaction approved receipt; then, if every one approved, mark the
 * own row approved and send everyone the proof of acceptance bundling those
 * receipts. Returns { ok: false, reason }, or { ok: true, transactionId,
 * approvals, approved, proof } exactly as those two do. Written as if
 * nothing can fail, like them.
 */
async function receiveTransaction(body, verify) {
  const result = await verify(body);
  if (!result.ok) return result;

  const { transactionId, heldIn } = result;
  const table = HELD_TABLES[heldIn];
  const stored = await table.insert({ ...result, ogTransaction: body });
  if (!stored.inserted) {
    return { ok: false, reason: table.conflictReasons[stored.conflict] };
  }

  // No answer from a peer: the report, the wait, the one re-send
  // (src/votes/votes.messages.js settleNoAnswers); a refusal is a refusal.
  const approvals = await settleNoAnswers(
    await sendTransactionApproval({ transaction: body, transactionId }),
    (peers) => sendTransactionApproval({ transaction: body, transactionId, peers }),
  );
  const outcome = { ok: true, transactionId: body.payload.transactionId, approvals };
  if (!approvals.every((approval) => approval.approved)) {
    return { ...outcome, approved: false };
  }

  // Every counted validator approved: our own row first, then tell them all.
  await table.markApproved(transactionId);
  const proof = await sendProofOfAcceptance({
    transactionId: body.payload.transactionId,
    receipts: approvals.map((approval) => approval.receipt),
  });
  return { ...outcome, approved: true, proof };
}

/** How an amount must look, for the reasons that quote it. */
const AMOUNT_RULE = 'must be a positive integer (millionths of a unit) as a decimal string';

/** An amount from a payload as a BigInt, or null when it is not a positive integer that fits a BIGINT. */
function parseAmount(amount) {
  if (typeof amount !== 'string' || !/^[1-9][0-9]*$/.test(amount)) return null;
  const value = BigInt(amount);
  return value > MAX_BIGINT ? null : value;
}

/** The SHA-256 of the canonical payload without its transactionId: how every transfer-like id is made. */
function unsignedHash(payload) {
  const unsigned = { ...payload };
  delete unsigned.transactionId;
  return canonicalHash(unsigned);
}

/** The next record_hash: the SHA-256 of this link's trans_hash followed by the previous record_hash, or of the trans_hash alone for the first link ever. */
function chainHash(transHash, previousRecordHash) {
  return sha256(previousRecordHash === null ? transHash : Buffer.concat([transHash, previousRecordHash]));
}

/** The reason for the first holding table findExisting found a row in, or null. */
function heldConflict(existing) {
  for (const [field, table, conflict] of HELD_CONFLICTS) {
    if (existing[field]) return HELD_TABLES[table].conflictReasons[conflict];
  }
  return null;
}

/** Returns a description of the first structural problem with a transferToFund, or null. */
function checkTransferToFundShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.previousTransactionId !== 'string') return 'payload.previousTransactionId must be a string';
  if (payload.transactionType !== TRANSFER_TO_FUND) return `payload.transactionType must be "${TRANSFER_TO_FUND}"`;
  if (typeof payload.amount !== 'string') return 'payload.amount must be a string';
  if (typeof payload.accountIdTo !== 'string') return 'payload.accountIdTo must be a string';
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (typeof payload.stakeFor !== 'string') return 'payload.stakeFor must be a string';
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}

/** Returns a description of the first structural problem with a fundProposal, or null. */
function checkProposalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.guardianId !== 'string') return 'payload.guardianId must be a string';
  if (payload.transactionType !== FUND_PROPOSAL) return `payload.transactionType must be "${FUND_PROPOSAL}"`;
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!Array.isArray(payload.payouts) || payload.payouts.length === 0) {
    return 'payload.payouts must be an array with at least one payout';
  }
  for (const [i, payout] of payload.payouts.entries()) {
    if (!isObject(payout)) return `payload.payouts[${i}] must be an object`;
    if (typeof payout.accountIdTo !== 'string') return `payload.payouts[${i}].accountIdTo must be a string`;
    if (typeof payout.amount !== 'string') return `payload.payouts[${i}].amount must be a string`;
    if (typeof payout.reason !== 'string') return `payload.payouts[${i}].reason must be a string`;
    if (payout.stakeFor !== undefined && typeof payout.stakeFor !== 'string') {
      return `payload.payouts[${i}].stakeFor must be a string when present`;
    }
  }
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}
