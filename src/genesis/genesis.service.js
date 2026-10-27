import { ACCOUNT_KEYS } from '../accounts/account-keys.js';
import { canonicalHash } from '../crypto/canonical.js';
import { decodeDigest, sha256 } from '../crypto/hash.js';
import { decodePublicKey } from '../crypto/signatures.js';
import { pool } from '../db/pool.js';
import { findTail, insertLink } from '../garlic-chain/garlic-chain.queries.js';
import { findState, insertGenesisAccount } from './genesis.queries.js';
import fundAccount from './fund-account.json' with { type: 'json' };
import ogAccount from './og-account.json' with { type: 'json' };

/**
 * Genesis: the first two accounts of the chain, written by every validator
 * the first time it boots on an empty database (src/server.js), before it
 * accepts any request.
 *
 *   The fund: accountId the SHA-256 of the word "anosFund", accountType
 *   "fund", 200,000,000 anos.
 *   The OG account: an ordinary spending account, 10,000,000 anos.
 *
 * Each has a signed create-account object, fund-account.json and
 * og-account.json, made once by make-genesis-accounts.mjs in the
 * anossoftwarescripts folder next to this project. They are constants:
 * every validator writes the same bytes, so every validator's chain starts
 * from the same rows and the same record hashes.
 *
 * Each account gets its accounts row, with the starting balance written
 * straight into current_balance, and its garlic chain creation link, the
 * same link accounts.service.js writeAccountCreation writes: amount 0, type
 * accountCreation, no account_id_to. The balances are the one thing the
 * chain does not carry: rebuilding the accounts table from the chain means
 * starting from these two rows and replaying the rest.
 *
 * The fund's keys were thrown away after signing, so nothing can ever sign
 * for it, and its accountId is not the hash of its keys, as every other
 * account's is, so its object would not pass verifyCreateAccount. Genesis
 * does not run that check: these two objects are trusted because they are
 * part of the code.
 */

/** Millionths of an anos: whole anos times a million. */
const ANOS = 1_000_000n;

/** The two genesis accounts: the signed create-account object and the starting balance of each. */
const GENESIS_ACCOUNTS = [
  { transaction: fundAccount, balance: 200_000_000n * ANOS },
  { transaction: ogAccount, balance: 10_000_000n * ANOS },
];

/**
 * Writes the genesis accounts if this database has none yet. Returns
 * { written: true } when it wrote them, { written: false } when the fund
 * account was already there. Throws when the fund account is missing but
 * the accounts or garlic_chain table is not empty: the genesis rows must be
 * the first rows, so such a database has to be rebuilt (npm run db:reset).
 *
 * Both accounts go in one database transaction, in transaction_id order
 * like a batch (accounts.service.js writeTransactions): rows written in one
 * transaction share a created_at, and findTail breaks that tie by
 * transaction_id, so the one written last must have the largest id.
 */
export async function runGenesis() {
  const fundAccountId = decodeDigest(fundAccount.payload.accountId);
  const state = await findState(fundAccountId);
  if (state.fundExists) return { written: false };
  if (state.hasAccounts || state.hasLinks) {
    throw new Error(
      'the fund account is missing but accounts or garlic_chain already has rows; ' +
        'genesis must come first (npm run db:reset)',
    );
  }

  const accounts = GENESIS_ACCOUNTS
    .map((account) => ({ ...account, transactionId: decodeDigest(account.transaction.payload.transactionId) }))
    .sort((a, b) => Buffer.compare(a.transactionId, b.transactionId));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let previousRecordHash = await findTail(client);
    for (const account of accounts) {
      previousRecordHash = await writeGenesisAccount(client, account, previousRecordHash);
    }
    await client.query('COMMIT');
    return { written: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Writes one genesis account on `client`: the accounts row, with the eight
 * public keys and the accountType from the payload and the starting
 * balance, then its garlic chain link, as writeAccountCreation writes one:
 * account_id the account, no account_id_to, amount 0, type the
 * transactionType, trans_hash the hash of the canonical payload (the signed
 * part), record_hash the hash of that followed by the previous link's
 * record_hash, or of the trans_hash alone for the first link ever. Returns
 * the record_hash for the next link to chain on.
 */
async function writeGenesisAccount(client, { transaction, balance, transactionId }, previousRecordHash) {
  const { payload } = transaction;
  const accountId = decodeDigest(payload.accountId);
  const keys = {};
  for (const { name, algorithm } of ACCOUNT_KEYS) {
    keys[name] = decodePublicKey(algorithm, payload.publicKeys[name]);
  }
  await insertGenesisAccount(client, {
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
    currentBalance: balance.toString(),
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
    ogTransaction: transaction,
  });
  return recordHash;
}
