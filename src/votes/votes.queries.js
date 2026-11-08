import { pool } from '../db/pool.js';

/**
 * SQL for the ignore_votes table (db/schema.sql): one row per vote this
 * validator applied (outcome passed; every validator stores it when it
 * applies the proof) or started and lost (outcome failed; the starter
 * only, with the receipts it got). Rows are never deleted.
 *
 * vote_id is a Buffer of 32 raw bytes, matching the BYTEA column; record
 * is { request, receipts } as JSONB.
 */

/**
 * Inserts one vote. On `client` when the row lands in the transaction
 * that applies a proof's flags (votes.service.js applyProof), through the
 * pool otherwise. A row with this vote_id already there is left alone.
 */
export async function insertIgnoreVote({ voteId, action, validatorIds, startedBy, outcome, record }, client = pool) {
  await client.query(
    `INSERT INTO ignore_votes (vote_id, action, validator_ids, started_by, outcome, record)
     VALUES ($1, $2, $3::int[], $4, $5, $6::jsonb)
     ON CONFLICT (vote_id) DO NOTHING`,
    [voteId, action, validatorIds, startedBy, outcome, JSON.stringify(record)],
  );
}

/** The vote with this id (a Buffer), as { outcome }, or null when none is stored. */
export async function findIgnoreVote(voteId) {
  const { rows } = await pool.query('SELECT outcome FROM ignore_votes WHERE vote_id = $1', [voteId]);
  return rows.length === 0 ? null : { outcome: rows[0].outcome };
}
