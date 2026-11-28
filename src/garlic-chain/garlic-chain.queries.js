import { pool } from '../db/pool.js';

/**
 * SQL for the garlic_chain table: the transactions written for good, one row
 * per link (db/schema.sql). Every transaction type lands here, so it has its
 * own feature folder rather than living under accounts, like pending.
 *
 * findTail and insertLink take `client`, a connection checked out of the
 * pool, rather than using the pool's query(): a batch of links is written
 * inside one database transaction together with the account rows that go
 * with them, and every statement of a transaction has to run on the same
 * connection. findTailRow takes one too, or reads through the pool when
 * none is given. The chunk read's queries are in chain-links.queries.js.
 * balanceTriggerNames, at the end of the file, reads the table's balance
 * trigger for the check the server runs at its start (src/server.js).
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
 * The tail as /health and the catch-up pass read it: { position, recordHash }
 * of the newest link, the position as a number and the hash as 64 hex
 * characters, or null when the chain is empty. On `client` when one is
 * given, else through the pool.
 */
export async function findTailRow(client = pool) {
  const { rows } = await client.query(
    `SELECT position, encode(record_hash, 'hex') AS record_hash FROM garlic_chain
     ORDER BY position DESC
     LIMIT 1`,
  );
  return rows.length === 0 ? null : { position: Number(rows[0].position), recordHash: rows[0].record_hash };
}

/**
 * Inserts one link. `accountId` and `accountIdTo` are Buffers, or null when
 * not applicable (an account creation has no account_id_to). `ogTransaction`
 * is the submission object exactly as received, stored as JSONB like
 * pending.og_transaction. `createdAt`, optional, is the row's created_at
 * (a Date or an ISO 8601 string): the replay of a chain chunk copies it
 * from the chunk; every other caller leaves it out and gets now().
 * Returns the position the identity column gave the row, as a number.
 * A database error is thrown; the caller's transaction is what rolls back.
 */
export async function insertLink(client, {
  accountId, accountIdTo, transactionId, amount, transHash, recordHash, type, ogTransaction, createdAt,
}) {
  const { rows } = await client.query(
    `INSERT INTO garlic_chain
       (account_id, account_id_to, transaction_id, amount, trans_hash, record_hash, type, og_transaction, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, coalesce($9::timestamptz, now()))
     RETURNING position`,
    [accountId, accountIdTo, transactionId, amount, transHash, recordHash, type, JSON.stringify(ogTransaction),
      createdAt ?? null],
  );
  return Number(rows[0].position);
}

/**
 * The first statements of every database transaction that inserts links. A lock that
 * only another writer of links waits for, held to the end of the transaction, so two
 * writes never cross. Then the counter behind garlic_chain.position set to the
 * chain's end, so the next link gets the tail's position plus one, 1 on an empty
 * chain. A batch that is rolled back moves the counter on; this puts it back.
 */
export async function prepareChainWrite(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('garlic_chain'))");
  await client.query(
    `SELECT setval(pg_get_serial_sequence('garlic_chain', 'position'), coalesce(max(position), 0) + 1, false)
     FROM garlic_chain`,
  );
}

/** Tries prepareChainWrite once, in a transaction that is rolled back. Throws when the database user may not run it. */
export async function checkChainWrite() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await prepareChainWrite(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Whether the balance trigger of garlic_chain (db/schema.sql,
 * garlic_chain_apply_anos_transfer) names `type` among the link types it
 * moves the anos for. Read from the trigger's own text as the database has
 * it (pg_get_triggerdef writes each type as a quoted word). False too when
 * the trigger is not there. The server asks it once, at its start
 * (src/server.js).
 */
export async function balanceTriggerNames(type) {
  const { rows } = await pool.query(
    `SELECT pg_get_triggerdef(t.oid) AS definition
     FROM pg_trigger t
     WHERE t.tgrelid = 'garlic_chain'::regclass
       AND t.tgname = 'garlic_chain_apply_anos_transfer'`,
  );
  return rows.length === 1 && rows[0].definition.includes(`'${type}'`);
}
