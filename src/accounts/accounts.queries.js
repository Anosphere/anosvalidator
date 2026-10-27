import { query } from '../db/pool.js';

/**
 * SQL for the accounts feature. Ids are Buffers of 32 raw bytes, matching the
 * BYTEA columns; pg sends a Buffer parameter as bytea.
 */

/**
 * Looks up an account id and a transaction id in every table that may
 * already hold them, in one round trip. Each EXISTS is a primary-key or
 * unique-index lookup, so this costs the same on an empty table as on a
 * full one.
 */
export async function findExisting({ accountId, transactionId }) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM accounts     WHERE account_id     = $1) AS account_exists,
       EXISTS (SELECT 1 FROM pending      WHERE transaction_id = $2) AS pending_transaction,
       EXISTS (SELECT 1 FROM pending      WHERE account_id     = $1) AS pending_for_account,
       EXISTS (SELECT 1 FROM garlic_chain WHERE transaction_id = $2) AS chain_transaction`,
    [accountId, transactionId],
  );
  const row = rows[0];
  return {
    accountExists: row.account_exists,
    pendingTransaction: row.pending_transaction,
    pendingForAccount: row.pending_for_account,
    chainTransaction: row.chain_transaction,
  };
}

/**
 * Inserts one account. `client` is a connection checked out of the pool: the
 * row is written inside the same database transaction as its garlic chain
 * link, and every statement of a transaction has to run on the same
 * connection. The keys are Buffers of raw bytes (crypto/signatures.js has
 * the formats). current_balance, created_at and updated_at take their
 * defaults. A database error is thrown; the caller's transaction is what
 * rolls back.
 */
export async function insertAccount(client, {
  accountId, publicKey1, publicKeyPq1, publicKey2, publicKeyPq2,
  altWalletPk, altWalletPkPq, breakGlassPk, breakGlassPkPq, type,
}) {
  await client.query(
    `INSERT INTO accounts
       (account_id, public_key1, public_key_pq1, public_key2, public_key_pq2,
        alt_wallet_pk, alt_wallet_pk_pq, break_glass_pk, break_glass_pk_pq, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [accountId, publicKey1, publicKeyPq1, publicKey2, publicKeyPq2,
      altWalletPk, altWalletPkPq, breakGlassPk, breakGlassPkPq, type],
  );
}
