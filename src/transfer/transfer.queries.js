import { query } from '../db/pool.js';

/**
 * SQL for the transfer feature. Ids are Buffers of 32 raw bytes, matching the
 * BYTEA columns; pg sends a Buffer parameter as bytea.
 */

/**
 * The account a transfer is sent from: the six public keys a transfer may be
 * signed with, as Buffers of raw bytes (null where the account has none),
 * its balance and its type. current_balance is a BIGINT, which pg hands over
 * as a decimal string so nothing is lost; the service compares it as a
 * BigInt. Returns null when there is no account with this id.
 */
export async function findAccount(accountId) {
  const { rows } = await query(
    `SELECT public_key1, public_key_pq1, public_key2, public_key_pq2,
            alt_wallet_pk, alt_wallet_pk_pq, current_balance, type
     FROM accounts WHERE account_id = $1`,
    [accountId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    publicKey1: row.public_key1,
    publicKeyPq1: row.public_key_pq1,
    publicKey2: row.public_key2,
    publicKeyPq2: row.public_key_pq2,
    altWalletPk: row.alt_wallet_pk,
    altWalletPkPq: row.alt_wallet_pk_pq,
    currentBalance: row.current_balance,
    type: row.type,
  };
}

/**
 * The transaction_id of the newest garlic chain link that belongs to this
 * account (account_id, the sending side: its creation, then each transfer it
 * made; transfers it received belong to their senders), or null when it has
 * none. The newest is the one with the highest position, the order the rows
 * were written in (db/schema.sql).
 */
export async function findLatestTransactionId(accountId) {
  const { rows } = await query(
    `SELECT transaction_id FROM garlic_chain
     WHERE account_id = $1
     ORDER BY position DESC
     LIMIT 1`,
    [accountId],
  );
  return rows.length === 0 ? null : rows[0].transaction_id;
}

/**
 * Looks up what a transfer must and must not find, in one round trip: an
 * account for accountIdTo, and nothing with these ids yet: no transaction
 * with this transactionId or for the sending accountId in any of the five
 * holding tables (pending, locked_transactions, assisted_transfers,
 * escrow_transfers, fund_proposals), and no garlic chain transaction with
 * this transactionId. Each EXISTS is a primary-key or unique-index lookup,
 * so this costs the same on an empty table as on a full one.
 */
export async function findExisting({ accountId, accountIdTo, transactionId }) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM accounts            WHERE account_id     = $2) AS account_to_exists,
       EXISTS (SELECT 1 FROM pending             WHERE transaction_id = $3) AS pending_transaction,
       EXISTS (SELECT 1 FROM pending             WHERE account_id     = $1) AS pending_for_account,
       EXISTS (SELECT 1 FROM locked_transactions WHERE transaction_id = $3) AS locked_transaction,
       EXISTS (SELECT 1 FROM locked_transactions WHERE account_id     = $1) AS locked_for_account,
       EXISTS (SELECT 1 FROM assisted_transfers  WHERE transaction_id = $3) AS assisted_transaction,
       EXISTS (SELECT 1 FROM assisted_transfers  WHERE account_id     = $1) AS assisted_for_account,
       EXISTS (SELECT 1 FROM escrow_transfers    WHERE transaction_id = $3) AS escrow_transaction,
       EXISTS (SELECT 1 FROM escrow_transfers    WHERE account_id     = $1) AS escrow_for_account,
       EXISTS (SELECT 1 FROM fund_proposals      WHERE transaction_id = $3) AS proposal_transaction,
       EXISTS (SELECT 1 FROM fund_proposals      WHERE account_id     = $1) AS proposal_for_account,
       EXISTS (SELECT 1 FROM garlic_chain        WHERE transaction_id = $3) AS chain_transaction`,
    [accountId, accountIdTo, transactionId],
  );
  const row = rows[0];
  return {
    accountToExists: row.account_to_exists,
    pendingTransaction: row.pending_transaction,
    pendingForAccount: row.pending_for_account,
    lockedTransaction: row.locked_transaction,
    lockedForAccount: row.locked_for_account,
    assistedTransaction: row.assisted_transaction,
    assistedForAccount: row.assisted_for_account,
    escrowTransaction: row.escrow_transaction,
    escrowForAccount: row.escrow_for_account,
    proposalTransaction: row.proposal_transaction,
    proposalForAccount: row.proposal_for_account,
    chainTransaction: row.chain_transaction,
  };
}
