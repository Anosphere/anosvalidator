/**
 * SQL for the garlic_chain table: the transactions written for good, one row
 * per link (db/schema.sql). Every transaction type lands here, so it has its
 * own feature folder rather than living under accounts, like pending.
 *
 * Both functions take `client`, a connection checked out of the pool, rather
 * than using the pool's query(): a batch of links is written inside one
 * database transaction together with the account rows that go with them, and
 * every statement of a transaction has to run on the same connection.
 *
 * Ids and hashes are Buffers of 32 raw bytes, matching the BYTEA columns; pg
 * sends a Buffer parameter as bytea.
 */

/**
 * The record_hash of the newest link, the one the next link chains on, or
 * null when the chain is empty. The newest link is the one with the highest
 * position: the rows are numbered in the order they were written
 * (db/schema.sql), so nothing is inferred from timestamps or ids.
 */
export async function findTail(client) {
  const { rows } = await client.query(
    `SELECT record_hash FROM garlic_chain
     ORDER BY position DESC
     LIMIT 1`,
  );
  return rows.length === 0 ? null : rows[0].record_hash;
}

/**
 * Inserts one link. `accountId` and `accountIdTo` are Buffers, or null when
 * not applicable (an account creation has no account_id_to). `ogTransaction`
 * is the submission object exactly as received, stored as JSONB like
 * pending.og_transaction.
 * A database error is thrown; the caller's transaction is what rolls back.
 */
export async function insertLink(client, {
  accountId, accountIdTo, transactionId, amount, transHash, recordHash, type, ogTransaction,
}) {
  await client.query(
    `INSERT INTO garlic_chain
       (account_id, account_id_to, transaction_id, amount, trans_hash, record_hash, type, og_transaction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [accountId, accountIdTo, transactionId, amount, transHash, recordHash, type, JSON.stringify(ogTransaction)],
  );
}
