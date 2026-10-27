import { canonicalHash, canonicalize } from '../crypto/canonical.js';
import { decodeDigest, digestMatches, sha256 } from '../crypto/hash.js';
import { decodePublicKey, decodeSignature, verifySignature } from '../crypto/signatures.js';
import { ACCOUNT_KEYS } from './account-keys.js';
import { ACCOUNT_TYPES } from './account-types.js';
import { pool } from '../db/pool.js';
import { FUND_PROPOSAL, TRANSFER_TO_FUND, writeFundProposal, writeTransferToFund } from '../fund/fund.service.js';
import { findTail, insertLink } from '../garlic-chain/garlic-chain.queries.js';
import {
  ASSISTED_TRANSFERS,
  ESCROW_TRANSFERS,
  FUND_PROPOSALS,
  HELD_TABLES,
  HELD_TABLE_NAMES,
  LOCKED_TRANSACTIONS,
  PENDING,
} from '../held-transactions/held-transactions.js';
import { deleteLocked } from '../locked-transactions/locked-transactions.queries.js';
import {
  PENDING_CONFLICT_REASONS,
  deletePending,
  insertPending,
  markApproved,
} from '../pending/pending.queries.js';
import { ARBITRATED_SUCCESS, WRITTEN, moveToArchives, moveToLogs } from '../records/records.queries.js';
import { isTransferType, writeAnosTransfer } from '../transfer/transfer.service.js';
import { fetchAnosAccount } from '../masterpod/masterpod.client.js';
import { isObject } from '../util/is-object.js';
import { sendProofOfAcceptance, sendTransactionApproval } from '../validators/validators.messages.js';
import { findExisting, insertAccount } from './accounts.queries.js';

/** The transactionType of a create-account submission, as the web app sends it. */
export const ACCOUNT_CREATION = 'accountCreation';

/**
 * Validates a create-account submission: { payload, signatures }.
 *
 * `payload` is the signed part (accountId, accountType, createdAt,
 * transactionId, publicKeys). `signatures` has one entry per key in
 * payload.publicKeys, each a signature by that key over the RFC 8785
 * canonical bytes of `payload`.
 *
 * The shape check (checkShape) also requires accountType to be one of
 * ACCOUNT_TYPES (account-types.js): it is stored as the account's type and
 * decides how the account may spend. Then four checks, in this order:
 *   1. every signature verifies against its public key, which proves the
 *      submitter holds all eight private keys;
 *   2. accountId is the SHA-256 of key1 + postQuantumKey1, the two key
 *      strings exactly as sent, joined with nothing between them;
 *   3. transactionId is the SHA-256 of all eight public key strings as sent,
 *      joined in the order of ACCOUNT_KEYS;
 *   4. nothing with these ids exists yet: no account with this accountId, no
 *      pending transaction with this transactionId or for this accountId, and
 *      no garlic chain transaction with this transactionId. One query covers
 *      all four lookups. The database constraints (primary keys and
 *      pending.account_id UNIQUE) are the backstop if two validators race.
 *
 * Checks 1 to 3 are pure computation; only check 4 touches the database.
 * Returns { ok: true, accountId, transactionId } with both ids as the 32-byte
 * Buffers the database uses, or { ok: false, reason } with a reason that is
 * safe to send back to the caller. Storing is receiveCreateAccount's job.
 */
export async function verifyCreateAccount(body) {
  const problem = checkShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signatures } = body;
  const { publicKeys } = payload;

  // 1. Signatures.
  const message = Buffer.from(canonicalize(payload), 'utf8');

  for (const { name, algorithm } of ACCOUNT_KEYS) {
    const publicKey = decodePublicKey(algorithm, publicKeys[name]);
    if (!publicKey) {
      return { ok: false, reason: `payload.publicKeys.${name} is not a valid ${algorithm} public key` };
    }
    const signature = decodeSignature(algorithm, signatures[name]);
    if (!signature) {
      return { ok: false, reason: `signatures.${name} is not a valid ${algorithm} signature` };
    }
    if (!verifySignature(algorithm, publicKey, message, signature)) {
      return { ok: false, reason: `signatures.${name} does not verify against payload.publicKeys.${name}` };
    }
  }

  // 2. accountId. The digest is kept as the 32 raw bytes the database uses.
  const accountId = sha256(publicKeys.key1 + publicKeys.postQuantumKey1);
  if (!digestMatches(payload.accountId, accountId)) {
    return { ok: false, reason: 'payload.accountId is not the SHA-256 of key1 + postQuantumKey1' };
  }

  // 3. transactionId.
  const transactionId = sha256(ACCOUNT_KEYS.map(({ name }) => publicKeys[name]).join(''));
  if (!digestMatches(payload.transactionId, transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the SHA-256 of the eight public keys in order' };
  }

  // 4. Uniqueness.
  const existing = await findExisting({ accountId, transactionId });
  if (existing.accountExists) {
    return { ok: false, reason: 'an account with this accountId already exists' };
  }
  if (existing.pendingTransaction) {
    return { ok: false, reason: PENDING_CONFLICT_REASONS.transaction_id };
  }
  if (existing.pendingForAccount) {
    return { ok: false, reason: PENDING_CONFLICT_REASONS.account_id };
  }
  if (existing.chainTransaction) {
    return { ok: false, reason: 'a transaction with this transactionId is already in the garlic chain' };
  }

  return { ok: true, accountId, transactionId };
}

/**
 * What the initial validator does with a create-account submission: verify
 * it (verifyCreateAccount); check 5, the binding (below); store the whole
 * submission in pending with approved = false; send a signed transaction
 * approval receipt to every
 * other active validator, wait for all of them, and check each answer as a
 * transaction approved receipt; then, if every one approved, mark its own
 * pending row approved and send everyone the proof of acceptance bundling
 * those receipts.
 *
 * Returns { ok: false, reason }, or { ok: true, transactionId, approvals,
 * approved, proof } with the id as the caller sent it, one
 * { id, approved, reason? } per validator called, whether every one
 * approved, and, when they did, one { id, status, body } per validator the
 * proof went to. A unique-key conflict on the insert gets the same
 * reason the manual check would have given; it only happens when two
 * requests race past check 4 at the same moment.
 *
 * Check 5, the binding (wallet spec 5.2): after uniqueness, the masterpod
 * is asked for the account (masterpod.client.js fetchAnosAccount) and the
 * submission passes only when a vouched anoPod made it. Anything else, a
 * 404, a timeout, a 5xx, a bad body, vouched false, refuses it with
 * { ok: false, reason: 'bad request', dropped: true }: the handler answers
 * 400 { error: "bad request" } and writes no log line, so the request is
 * dropped like garbage. Only the receiving validator asks; the
 * validator-to-validator approval path (validators.service.js) runs
 * verifyCreateAccount alone and trusts the binding, as it does for
 * everything else, which is why the check lives here and not there.
 *
 * Written as if nothing can fail: a validator that is down makes the send
 * reject and this request fails with it, the pending row already in place.
 * Not written yet: what the caller gets once it is all over (today still a
 * 202), and what happens when not every validator approved.
 */
export async function receiveCreateAccount(body) {
  const result = await verifyCreateAccount(body);
  if (!result.ok) return result;

  // 5. The binding.
  const binding = await fetchAnosAccount(result.accountId);
  if (!binding.bound) return { ok: false, reason: 'bad request', dropped: true };

  const { accountId, transactionId } = result;
  const stored = await insertPending({ transactionId, accountId, ogTransaction: body });
  if (!stored.inserted) {
    return { ok: false, reason: PENDING_CONFLICT_REASONS[stored.conflict] };
  }

  const approvals = await sendTransactionApproval({ transaction: body, transactionId });
  const outcome = { ok: true, transactionId: body.payload.transactionId, approvals };
  if (!approvals.every((approval) => approval.approved)) {
    return { ...outcome, approved: false };
  }

  // Every validator approved: our own row first, then tell them all.
  await markApproved(transactionId);
  const proof = await sendProofOfAcceptance({
    transactionId: body.payload.transactionId,
    receipts: approvals.map((approval) => approval.receipt),
  });
  return { ...outcome, approved: true, proof };
}

/**
 * What a validator does with the leader's official list, `transactionIds` as
 * hex: the approved transactions it holds among them, in any of the five
 * holding tables (held-transactions.js), go to writeTransactions together,
 * in id order. Then each table's rows leave it: pending and
 * locked_transactions rows are deleted; assisted_transfers rows move to
 * logs, outcome written; escrow_transfers rows move to logs, outcome
 * written, or, when a dispute signature is present, to archives, outcome
 * arbitratedSuccess, with their arbitrations; fund_proposals rows move to
 * archives, outcome written, with their votes (records.queries.js). Returns
 * the ids written, as hex. When the batch write fails nothing was written,
 * the rows stay, and the list is empty.
 */
export async function writeApproved(transactionIds) {
  const ids = transactionIds.map((id) => decodeDigest(id));
  const held = {};
  for (const table of HELD_TABLE_NAMES) {
    held[table] = await HELD_TABLES[table].findApproved(ids);
  }
  const rows = Object.values(held).flat().sort((a, b) => Buffer.compare(a.transactionId, b.transactionId));
  if (!(await writeTransactions(rows))) return [];

  await deletePending(held[PENDING].map(({ transactionId }) => transactionId));
  await deleteLocked(held[LOCKED_TRANSACTIONS].map(({ transactionId }) => transactionId));
  const client = await pool.connect();
  try {
    for (const { transactionId } of held[ASSISTED_TRANSFERS]) {
      await moveToLogs(client, ASSISTED_TRANSFERS, WRITTEN, transactionId);
    }
    for (const { transactionId, disputed } of held[ESCROW_TRANSFERS]) {
      if (disputed) await moveToArchives(client, ESCROW_TRANSFERS, ARBITRATED_SUCCESS, transactionId);
      else await moveToLogs(client, ESCROW_TRANSFERS, WRITTEN, transactionId);
    }
    for (const { transactionId } of held[FUND_PROPOSALS]) {
      await moveToArchives(client, FUND_PROPOSALS, WRITTEN, transactionId);
    }
  } finally {
    client.release();
  }
  return rows.map(({ transactionId }) => transactionId.toString('hex'));
}

/**
 * Writes transactions into accounts and the garlic chain, as one database
 * transaction: every row in `rows` lands or none does. `rows` are
 * { transactionId, accountId, ogTransaction } straight from pending or
 * any other holding table, in id order. Each row is written by its
 * transactionType: an account creation by writeAccountCreation below, a
 * transfer of any of the five types by transfer.service.js
 * writeAnosTransfer, a transfer to the fund and a fund proposal (the
 * proposal link, then its payout links) by fund.service.js
 * writeTransferToFund and writeFundProposal. Returns true when the batch
 * committed, false when it was rolled back: a row whose transactionType is
 * none of these, or a database error on one of the writes. A connection
 * that drops still throws, like every other query.
 *
 * Each link's record_hash is the SHA-256 of its trans_hash followed by the
 * previous link's record_hash, both as raw bytes. The previous link is the
 * newest row in the chain when the batch starts (findTail), then the link
 * just written. The first link ever hashes its trans_hash alone.
 */
async function writeTransactions(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let previousRecordHash = await findTail(client);
    for (const row of rows) {
      const { transactionType } = row.ogTransaction.payload;
      if (transactionType === ACCOUNT_CREATION) {
        previousRecordHash = await writeAccountCreation(client, row, previousRecordHash);
      } else if (isTransferType(transactionType)) {
        previousRecordHash = await writeAnosTransfer(client, row, previousRecordHash);
      } else if (transactionType === TRANSFER_TO_FUND) {
        previousRecordHash = await writeTransferToFund(client, row, previousRecordHash);
      } else if (transactionType === FUND_PROPOSAL) {
        previousRecordHash = await writeFundProposal(client, row, previousRecordHash);
      } else {
        throw new Error(`unknown transactionType ${transactionType} on ${row.transactionId.toString('hex')}`);
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    console.log('batch write failed:', err.message);
    await client.query('ROLLBACK');
    return false;
  } finally {
    client.release();
  }
}

/**
 * Writes one account creation on `client`: the account row, with the eight
 * public keys and the accountType from the payload, then its garlic chain
 * link, with the same account_id, no account_id_to, amount 0 and the
 * transactionType as its type.
 * trans_hash is the hash of the canonical JSON of the payload, the signed
 * part. Returns the link's record_hash for the next link to chain on.
 */
async function writeAccountCreation(client, { transactionId, accountId, ogTransaction }, previousRecordHash) {
  const { payload } = ogTransaction;
  const keys = {};
  for (const { name, algorithm } of ACCOUNT_KEYS) {
    keys[name] = decodePublicKey(algorithm, payload.publicKeys[name]);
  }
  await insertAccount(client, {
    accountId,
    publicKey1: keys.key1,
    publicKeyPq1: keys.postQuantumKey1,
    publicKey2: keys.key2,
    publicKeyPq2: keys.postQuantumKey2,
    altWalletPk: keys.walletKey,
    altWalletPkPq: keys.walletPostQuantumKey,
    breakGlassPk: keys.breakGlassKey,
    breakGlassPkPq: keys.breakGlassPostQuantumKey,
    type: payload.accountType,
  });

  const transHash = canonicalHash(payload);
  const recordHash = sha256(
    previousRecordHash === null ? transHash : Buffer.concat([transHash, previousRecordHash]),
  );
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
  return recordHash;
}

/** Returns a description of the first structural problem, or null if the shape is right. */
function checkShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (typeof body.payload.accountId !== 'string') return 'payload.accountId must be a string';
  if (typeof body.payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (!ACCOUNT_TYPES.includes(body.payload.accountType)) {
    return `payload.accountType must be one of ${ACCOUNT_TYPES.join(', ')}`;
  }
  if (!isObject(body.payload.publicKeys)) return 'payload.publicKeys must be an object';
  if (!isObject(body.signatures)) return 'signatures must be an object';

  for (const { name } of ACCOUNT_KEYS) {
    if (typeof body.payload.publicKeys[name] !== 'string') {
      return `payload.publicKeys.${name} must be a string`;
    }
    if (typeof body.signatures[name] !== 'string') {
      return `signatures.${name} must be a string`;
    }
  }
  return null;
}
