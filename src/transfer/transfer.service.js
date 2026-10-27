import { ANY_TWO_PAIRS, PAIR_ONE_AND_WALLET, verifyAccountSignatures } from '../accounts/account-signatures.js';
import { ASSISTED, GUARDED, SPENDING, VAULT } from '../accounts/account-types.js';
import { env } from '../config/env.js';
import { canonicalHash, canonicalize } from '../crypto/canonical.js';
import { decodeDigest, digestMatches, sha256 } from '../crypto/hash.js';
import { insertLink } from '../garlic-chain/garlic-chain.queries.js';
import {
  ASSISTED_TRANSFERS,
  ESCROW_TRANSFERS,
  HELD_TABLES,
  LOCKED_TRANSACTIONS,
  PENDING,
} from '../held-transactions/held-transactions.js';
import { LOCKED_CONFLICT_REASONS } from '../locked-transactions/locked-transactions.queries.js';
import { PENDING_CONFLICT_REASONS } from '../pending/pending.queries.js';
import { isObject } from '../util/is-object.js';
import { sendProofOfAcceptance, sendTransactionApproval } from '../validators/validators.messages.js';
import { findAccount, findExisting, findLatestTransactionId } from './transfer.queries.js';

/** The transactionType of a plain transfer, out of a spending account, as the web app sends it. */
export const ANOS_TRANSFER = 'anosTransfer';

/** The transactionType of a transfer out of a guarded account. */
export const GUARDED_ANOS_TRANSFER = 'guardedAnosTransfer';

/** The transactionType of a transfer out of a vault account. */
export const VAULT_ANOS_TRANSFER = 'vaultAnosTransfer';

/** The transactionType of a transfer out of an assisted account, which two attestors must attest to. */
export const ASSISTED_ANOS_TRANSFER = 'assistedAnosTransfer';

/** The transactionType of an escrow transfer, out of a spending account, released by the seller, the buyer or arbitrators. */
export const ESCROW_TRANSFER = 'escrowTransfer';

/**
 * The five transfer types, each with the one account type it may be sent
 * from (a guarded account can only send a guardedAnosTransfer, a vault
 * account only a vaultAnosTransfer, an assisted account only an
 * assistedAnosTransfer, a spending account a plain anosTransfer or an
 * escrowTransfer), its time lock in minutes, from the env file, the holding
 * table it waits in until a leader round writes it (held-transactions.js)
 * and the signing rule its signatures must meet (account-signatures.js).
 * A plain transfer has no lock and goes into pending. A guarded or vault
 * transfer is dated the lock ahead by the wallet (verifyAnosTransfer checks
 * how far) and waits in locked_transactions until that moment. An assisted
 * transfer waits in assisted_transfers for two attestations, an escrow
 * transfer in escrow_transfers for the seller's success signature or the
 * arbitrators' verdicts; neither has a lock, and their createdAt is not
 * checked.
 */
const TRANSFER_TYPES = new Map([
  [ANOS_TRANSFER, { accountType: SPENDING, lockMinutes: 0, heldIn: PENDING, rule: ANY_TWO_PAIRS }],
  [GUARDED_ANOS_TRANSFER, { accountType: GUARDED, lockMinutes: env.locks.guardedMinutes, heldIn: LOCKED_TRANSACTIONS, rule: ANY_TWO_PAIRS }],
  [VAULT_ANOS_TRANSFER, { accountType: VAULT, lockMinutes: env.locks.vaultMinutes, heldIn: LOCKED_TRANSACTIONS, rule: ANY_TWO_PAIRS }],
  [ASSISTED_ANOS_TRANSFER, { accountType: ASSISTED, lockMinutes: 0, heldIn: ASSISTED_TRANSFERS, rule: PAIR_ONE_AND_WALLET }],
  [ESCROW_TRANSFER, { accountType: SPENDING, lockMinutes: 0, heldIn: ESCROW_TRANSFERS, rule: ANY_TWO_PAIRS }],
]);

/** True when `transactionType` is one of the five transfer types. */
export function isTransferType(transactionType) {
  return TRANSFER_TYPES.has(transactionType);
}

const MS_PER_MINUTE = 60_000;

/** The largest value a BIGINT column holds. */
const MAX_BIGINT = 2n ** 63n - 1n;

/**
 * Validates a transfer submission, { payload, signatures }, of any of the
 * five transfer types.
 *
 * `payload` is the signed part (accountId, transactionId,
 * previousTransactionId, transactionType, amount, accountIdTo, createdAt).
 * `signatures` holds signatures over the RFC 8785 canonical bytes of
 * `payload` by the sending account's keys, which the accounts table holds.
 *
 * The checks, in order:
 *   1. the shape, with transactionType one of the five; the three ids are
 *      SHA-256 digests; amount is a positive integer (millionths of a unit)
 *      as a decimal string that fits a BIGINT; and, for a guarded or vault
 *      transfer, createdAt is the account's lock ahead of now: at least the
 *      lock, at most the lock plus LOCK_OFFSET_MINUTES (env.js), the slack
 *      the wallet adds so a transfer that takes a while to arrive still
 *      passes. The other types' createdAt is not checked here;
 *   2. an account with this accountId exists, and is of the type this
 *      transfer type is for (TRANSFER_TYPES). Its keys and balance are read
 *      once here for the checks below;
 *   3. the signatures, under the type's signing rule
 *      (account-signatures.js verifyAccountSignatures): any two of the
 *      three key pairs, or, for an assisted transfer, pair 1 and the wallet
 *      pair; both keys of each pair, every one verifying against the
 *      account's stored public key;
 *   4. transactionId is the SHA-256 of the canonical JSON of the payload
 *      without transactionId, which is how the web app makes it;
 *   5. previousTransactionId is the account's newest transaction on the
 *      garlic chain (its creation, the OG hash, or its last transfer). That
 *      chains the account's transactions together and lets each previous id
 *      be used once;
 *   6. accountIdTo is a different account that exists, and nothing with these
 *      ids exists yet: no transaction with this transactionId or for this
 *      accountId in any of the five holding tables, and no garlic chain
 *      transaction with this transactionId. One query covers the twelve
 *      lookups. The database constraints are the backstop if two validators
 *      race;
 *   7. the account's balance covers the amount. One held transaction per
 *      account means nothing else can spend from it before this is written.
 *
 * Returns { ok: true, accountId, transactionId, accountIdTo, heldIn,
 * futureDate } with the ids as the 32-byte Buffers the database uses, the
 * same shape as verifyCreateAccount gives so the validator-to-validator flow
 * treats both alike, plus heldIn, the holding table the transfer waits in
 * (held-transactions.js), and futureDate: for a guarded or vault transfer,
 * createdAt as a Date, the moment the transfer may be written; undefined for
 * the other types. Or { ok: false, reason } with a reason that is safe to
 * send back to the caller. Storing is receiveAnosTransfer's job.
 */
export async function verifyAnosTransfer(body) {
  const problem = checkShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signatures } = body;
  const { accountType, lockMinutes, heldIn, rule } = TRANSFER_TYPES.get(payload.transactionType);

  // 1. Ids and amount.
  const accountId = decodeDigest(payload.accountId);
  if (!accountId) return { ok: false, reason: 'payload.accountId is not a SHA-256 digest' };
  const accountIdTo = decodeDigest(payload.accountIdTo);
  if (!accountIdTo) return { ok: false, reason: 'payload.accountIdTo is not a SHA-256 digest' };
  if (!decodeDigest(payload.previousTransactionId)) {
    return { ok: false, reason: 'payload.previousTransactionId is not a SHA-256 digest' };
  }
  if (!/^[1-9][0-9]*$/.test(payload.amount) || BigInt(payload.amount) > MAX_BIGINT) {
    return { ok: false, reason: 'payload.amount must be a positive integer (millionths of a unit) as a decimal string' };
  }
  const amount = BigInt(payload.amount);

  // 1b. For a guarded or vault transfer, how far ahead createdAt is.
  let futureDate;
  if (lockMinutes > 0) {
    const createdAt = Date.parse(payload.createdAt);
    const ahead = createdAt - Date.now();
    const lock = lockMinutes * MS_PER_MINUTE;
    const offset = env.locks.offsetMinutes * MS_PER_MINUTE;
    if (!(ahead >= lock && ahead <= lock + offset)) {
      return {
        ok: false,
        reason: `payload.createdAt must be at least ${lockMinutes} and at most ${lockMinutes + env.locks.offsetMinutes} minutes ahead of now`,
      };
    }
    futureDate = new Date(createdAt);
  }

  // 2. The sending account, of the type this transfer type is for.
  const account = await findAccount(accountId);
  if (!account) return { ok: false, reason: 'no account with this accountId' };
  if (account.type !== accountType) {
    return { ok: false, reason: `${payload.transactionType} can only be sent from a ${accountType} account` };
  }

  // 3. Signatures, under the type's rule.
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const badSignatures = verifyAccountSignatures(account, signatures, message, rule);
  if (badSignatures) return { ok: false, reason: badSignatures };

  // 4. transactionId: the hash of the payload without itself.
  const unsigned = { ...payload };
  delete unsigned.transactionId;
  const transactionId = canonicalHash(unsigned);
  if (!digestMatches(payload.transactionId, transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the SHA-256 of the canonical payload without transactionId' };
  }

  // 5. previousTransactionId.
  const latest = await findLatestTransactionId(accountId);
  if (latest === null || !digestMatches(payload.previousTransactionId, latest)) {
    return { ok: false, reason: "payload.previousTransactionId is not the account's latest transaction" };
  }

  // 6. The receiving account, and uniqueness.
  if (accountIdTo.equals(accountId)) {
    return { ok: false, reason: 'payload.accountIdTo is the sending account' };
  }
  const existing = await findExisting({ accountId, accountIdTo, transactionId });
  if (!existing.accountToExists) {
    return { ok: false, reason: 'no account with this accountIdTo' };
  }
  if (existing.pendingTransaction) {
    return { ok: false, reason: PENDING_CONFLICT_REASONS.transaction_id };
  }
  if (existing.pendingForAccount) {
    return { ok: false, reason: PENDING_CONFLICT_REASONS.account_id };
  }
  if (existing.lockedTransaction) {
    return { ok: false, reason: LOCKED_CONFLICT_REASONS.transaction_id };
  }
  if (existing.lockedForAccount) {
    return { ok: false, reason: LOCKED_CONFLICT_REASONS.account_id };
  }
  if (existing.assistedTransaction) {
    return { ok: false, reason: HELD_TABLES[ASSISTED_TRANSFERS].conflictReasons.transaction_id };
  }
  if (existing.assistedForAccount) {
    return { ok: false, reason: HELD_TABLES[ASSISTED_TRANSFERS].conflictReasons.account_id };
  }
  if (existing.escrowTransaction) {
    return { ok: false, reason: HELD_TABLES[ESCROW_TRANSFERS].conflictReasons.transaction_id };
  }
  if (existing.escrowForAccount) {
    return { ok: false, reason: HELD_TABLES[ESCROW_TRANSFERS].conflictReasons.account_id };
  }
  if (existing.proposalTransaction) {
    return { ok: false, reason: HELD_TABLES.fund_proposals.conflictReasons.transaction_id };
  }
  if (existing.proposalForAccount) {
    return { ok: false, reason: HELD_TABLES.fund_proposals.conflictReasons.account_id };
  }
  if (existing.chainTransaction) {
    return { ok: false, reason: 'a transaction with this transactionId is already in the garlic chain' };
  }

  // 7. Balance.
  if (BigInt(account.currentBalance) < amount) {
    return { ok: false, reason: "payload.amount is more than the account's balance" };
  }

  return { ok: true, accountId, transactionId, accountIdTo, heldIn, futureDate };
}

/**
 * What the initial validator does with a transfer submission: the same
 * steps as receiveCreateAccount in accounts.service.js, with
 * verifyAnosTransfer as the check. Verify it; store the whole submission
 * with approved = false, under the sending account's id, in the holding
 * table the type is held in (heldIn, through the registry in
 * held-transactions.js); send a signed transaction approval receipt to every
 * other active validator, wait for all of them, and check each answer as a
 * transaction approved receipt; then, if every one approved, mark its own
 * row approved, in whichever table holds it, and send everyone the proof of
 * acceptance bundling those receipts.
 *
 * Returns { ok: false, reason }, or { ok: true, transactionId, approvals,
 * approved, proof } exactly as receiveCreateAccount does: the id as the
 * caller sent it, one { id, approved, reason? } per validator called,
 * whether every one approved, and, when they did, one { id, status, body }
 * per validator the proof went to. Written as if nothing can fail, like the
 * create-account flow.
 */
export async function receiveAnosTransfer(body) {
  const result = await verifyAnosTransfer(body);
  if (!result.ok) return result;

  const { accountId, transactionId, accountIdTo, heldIn, futureDate } = result;
  const table = HELD_TABLES[heldIn];
  const stored = await table.insert({ transactionId, accountId, accountIdTo, futureDate, ogTransaction: body });
  if (!stored.inserted) {
    return { ok: false, reason: table.conflictReasons[stored.conflict] };
  }

  const approvals = await sendTransactionApproval({ transaction: body, transactionId });
  const outcome = { ok: true, transactionId: body.payload.transactionId, approvals };
  if (!approvals.every((approval) => approval.approved)) {
    return { ...outcome, approved: false };
  }

  // Every validator approved: our own row first, then tell them all.
  await table.markApproved(transactionId);
  const proof = await sendProofOfAcceptance({
    transactionId: body.payload.transactionId,
    receipts: approvals.map((approval) => approval.receipt),
  });
  return { ...outcome, approved: true, proof };
}

/**
 * Writes one transfer, of any of the five types, on `client`, inside the
 * batch that accounts.service.js writeTransactions runs: its garlic chain
 * link, with the sender as account_id, the receiver as account_id_to, the
 * amount, and the transactionType as its type. trans_hash and record_hash
 * are computed as for an account creation: the hash of the canonical JSON
 * of the payload (the signed part), and the hash of that followed by the
 * previous link's record_hash.
 *
 * The balances move in the database: the garlic_chain_apply_anos_transfer
 * trigger (db/schema.sql), which fires for all five types, deducts the
 * amount from the sender and adds it to the receiver as the link is
 * inserted, and fails the insert, and with it the batch, if either account
 * is missing or the sender would go negative. Returns the link's
 * record_hash for the next link to chain on.
 */
export async function writeAnosTransfer(client, { transactionId, accountId, ogTransaction }, previousRecordHash) {
  const { payload } = ogTransaction;
  const transHash = canonicalHash(payload);
  const recordHash = sha256(
    previousRecordHash === null ? transHash : Buffer.concat([transHash, previousRecordHash]),
  );
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
  return recordHash;
}

/** Returns a description of the first structural problem, or null if the shape is right. */
function checkShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  const { payload } = body;
  if (typeof payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.previousTransactionId !== 'string') return 'payload.previousTransactionId must be a string';
  if (!isTransferType(payload.transactionType)) {
    return `payload.transactionType must be "${ANOS_TRANSFER}", "${GUARDED_ANOS_TRANSFER}", "${VAULT_ANOS_TRANSFER}", "${ASSISTED_ANOS_TRANSFER}" or "${ESCROW_TRANSFER}"`;
  }
  if (typeof payload.amount !== 'string') return 'payload.amount must be a string';
  if (typeof payload.accountIdTo !== 'string') return 'payload.accountIdTo must be a string';
  if (typeof payload.createdAt !== 'string') return 'payload.createdAt must be a string';
  if (!isObject(body.signatures)) return 'signatures must be an object';
  return null;
}
