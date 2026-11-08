import { query } from '../db/pool.js';

/**
 * SQL for the chain chunk read and the replay (chain-links.service.js,
 * replay.service.js): the links above a position as the wire carries them,
 * and what the replay reads before it writes a chunk. The inserts are
 * garlic-chain.queries.js insertLink, as for every link.
 *
 * Ids and hashes are Buffers of 32 raw bytes in the database and lowercase
 * hex on the wire; pg hands a BIGINT over as a decimal string, which is how
 * an amount travels and how a position is turned into a number.
 */

/**
 * The links whose position is above `afterPosition`, ascending, at most
 * `limit`, each as the chunk carries it: { position (a number), accountId
 * (hex or null), accountIdTo (hex or null), transactionId (hex), amount
 * (a decimal string, millionths), transHash (hex), recordHash (hex), type,
 * createdAt (ISO 8601), ogTransaction (the JSONB value as it is) }.
 */
export async function findLinksAfter(afterPosition, limit) {
  const { rows } = await query(
    `SELECT position,
            encode(account_id, 'hex')     AS account_id,
            encode(account_id_to, 'hex')  AS account_id_to,
            encode(transaction_id, 'hex') AS transaction_id,
            amount,
            encode(trans_hash, 'hex')     AS trans_hash,
            encode(record_hash, 'hex')    AS record_hash,
            type, created_at, og_transaction
     FROM garlic_chain
     WHERE position > $1
     ORDER BY position
     LIMIT $2`,
    [afterPosition, limit],
  );
  return rows.map((row) => ({
    position: Number(row.position),
    accountId: row.account_id,
    accountIdTo: row.account_id_to,
    transactionId: row.transaction_id,
    amount: row.amount,
    transHash: row.trans_hash,
    recordHash: row.record_hash,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    ogTransaction: row.og_transaction,
  }));
}

/**
 * The newest link as the replay chains on it, on `client`, the connection
 * of the chunk's transaction: { position (a number), recordHash (a Buffer),
 * type, ogTransaction }, or null when the chain is empty.
 */
export async function findTailLink(client) {
  const { rows } = await client.query(
    `SELECT position, record_hash, type, og_transaction FROM garlic_chain
     ORDER BY position DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    position: Number(row.position),
    recordHash: row.record_hash,
    type: row.type,
    ogTransaction: row.og_transaction,
  };
}

/**
 * The payload of the link with this transaction id (a Buffer), on `client`:
 * how the replay finds the proposal a payout link at the tail belongs to.
 * Null when there is no such link.
 */
export async function findLinkPayload(client, transactionId) {
  const { rows } = await client.query(
    'SELECT og_transaction FROM garlic_chain WHERE transaction_id = $1',
    [transactionId],
  );
  return rows.length === 0 ? null : rows[0].og_transaction.payload;
}
