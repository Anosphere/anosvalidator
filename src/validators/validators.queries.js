import { query } from '../db/pool.js';

/**
 * SQL for the validators table: the registry of every validator, this one
 * included (db/schema.sql, seeded from db/validators.sql).
 *
 * Both lookups read the table fresh on every call rather than caching at
 * boot, so adding or removing a validator takes effect without a restart.
 * Only active rows count: a removed validator keeps its row so its old
 * signatures can still be verified, but it is neither called nor trusted for
 * new messages.
 *
 * Rows come back as { id, url, publicKey } with the key as a Buffer of raw
 * bytes. That key is what a message claiming to come from that validator is
 * checked against, never keys in the message.
 */

const COLUMNS = 'id, url, public_key';

function toValidator(row) {
  return {
    id: row.id,
    url: row.url,
    publicKey: row.public_key,
  };
}

/** The active validators other than `ownId`: who to send a message to. */
export async function findActivePeers(ownId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND id <> $1 ORDER BY id`,
    [ownId],
  );
  return rows.map(toValidator);
}

/** One active validator by id, or null when there is no active validator with that id. */
export async function findActiveValidator(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toValidator(rows[0]);
}

/**
 * Every active validator, as a Map from id to validator. One read per
 * request; every lookup after that is in memory, so a whole message is
 * judged against one consistent view of the registry.
 */
export async function findActiveValidators() {
  const { rows } = await query(`SELECT ${COLUMNS} FROM validators WHERE active ORDER BY id`);
  return new Map(rows.map((row) => [row.id, toValidator(row)]));
}

/** Whether the validator with this id is the leader, per this validator's own registry. */
export async function findIsLeader(id) {
  const { rows } = await query('SELECT is_leader FROM validators WHERE id = $1', [id]);
  return rows.length === 1 && rows[0].is_leader;
}

/** Makes `id` the leader in this validator's own registry: that row true, every other row false. */
export async function setLeader(id) {
  await query('UPDATE validators SET is_leader = (id = $1)', [id]);
}
