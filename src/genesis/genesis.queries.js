import { query } from '../db/pool.js';

/**
 * SQL for genesis (genesis.service.js). Ids and keys are Buffers of raw
 * bytes, matching the BYTEA columns; pg sends a Buffer parameter as bytea.
 */

/**
 * What genesis needs to know before it writes anything, in one round trip:
 * whether the fund account is there (genesis already ran on this database),
 * and whether the accounts and garlic_chain tables hold any rows at all.
 * Each EXISTS stops at the first row it finds, so this costs the same on a
 * full table as on an empty one.
 */
export async function findState(fundAccountId) {
  const { rows } = await query(
    `SELECT
       EXISTS (SELECT 1 FROM accounts WHERE account_id = $1) AS fund_exists,
       EXISTS (SELECT 1 FROM accounts)                       AS has_accounts,
       EXISTS (SELECT 1 FROM garlic_chain)                   AS has_links`,
    [fundAccountId],
  );
  const row = rows[0];
  return {
    fundExists: row.fund_exists,
    hasAccounts: row.has_accounts,
    hasLinks: row.has_links,
  };
}

/**
 * Inserts one genesis account: the insert of accounts.queries.js
 * insertAccount with current_balance given, instead of left at its default
 * of 0. `client` is a connection checked out of the pool: the row is
 * written inside the same database transaction as its garlic chain link,
 * and every statement of a transaction has to run on the same connection.
 * The keys are Buffers of raw bytes (crypto/signatures.js has the formats).
 * `currentBalance` is a decimal string in millionths of an anos; pg hands
 * it to the BIGINT column as text, so nothing is lost. created_at and
 * updated_at take their defaults. A database error is thrown; the caller's
 * transaction is what rolls back.
 */
export async function insertGenesisAccount(client, {
  accountId, publicKey1, publicKeyPq1, publicKey2, publicKeyPq2,
  altWalletPk, altWalletPkPq, breakGlassPk, breakGlassPkPq, type, currentBalance,
}) {
  await client.query(
    `INSERT INTO accounts
       (account_id, public_key1, public_key_pq1, public_key2, public_key_pq2,
        alt_wallet_pk, alt_wallet_pk_pq, break_glass_pk, break_glass_pk_pq, type,
        current_balance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [accountId, publicKey1, publicKeyPq1, publicKey2, publicKeyPq2,
      altWalletPk, altWalletPkPq, breakGlassPk, breakGlassPkPq, type,
      currentBalance],
  );
}
