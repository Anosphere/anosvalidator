import { query } from '../db/pool.js';

/**
 * SQL for the nonces table, the replay cache of signed account-level
 * requests (wallet spec 5.3, step 5). Copied from keyholdersoftware's
 * src/auth/nonces.queries.js.
 */

/**
 * Records that `nonce` (a Buffer of 16 to 32 bytes) was seen, kept until
 * `expiresAt`. One round trip: the sweep of expired nonces, then the insert.
 * Returns true when the nonce was new, false when it was already there: a
 * replay.
 */
export async function insertNonce(nonce, expiresAt) {
  const { rowCount } = await query(
    `WITH swept AS (DELETE FROM nonces WHERE expires_at < now())
     INSERT INTO nonces (nonce, expires_at)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [nonce, expiresAt],
  );
  return rowCount === 1;
}
