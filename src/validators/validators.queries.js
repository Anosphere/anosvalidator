import { query } from '../db/pool.js';

/**
 * SQL for the validators table: the registry of every validator, this one
 * included (db/schema.sql, filled from network/testnet.registry.json at
 * boot by registry.service.js).
 *
 * Every lookup reads the table fresh on every call rather than caching at
 * boot. Two flags decide who is who: `active` is membership, from the
 * registry file; `ignored` means "not counted right now", set and cleared
 * only by the proof of an ignore or include vote (src/votes/). A validator
 * is counted when it is active and not ignored: messages go to the counted
 * peers and are accepted from counted validators. Membership alone (active,
 * ignored or not) is enough for the chain chunk read, the join request, the
 * held rows and ready, which a joiner sends while it is still ignored. A
 * removed validator keeps its row, inactive, so its old signatures can
 * still be verified.
 *
 * Rows come back as { id, url, publicKey, ignored } with the key as a
 * Buffer of raw bytes. That key is what a message claiming to come from
 * that validator is checked against, never keys in the message.
 */

const COLUMNS = 'id, url, public_key, ignored';

function toValidator(row) {
  return {
    id: row.id,
    url: row.url,
    publicKey: row.public_key,
    ignored: row.ignored,
  };
}

/** The counted validators other than `ownId`: who to send a message to. */
export async function findCountedPeers(ownId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND NOT ignored AND id <> $1 ORDER BY id`,
    [ownId],
  );
  return rows.map(toValidator);
}

/**
 * The active validators other than `ownId`, ignored or not: every member
 * of the network, for the health sweep of the catch-up pass
 * (src/garlic-chain/replay.service.js).
 */
export async function findMemberPeers(ownId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND id <> $1 ORDER BY id`,
    [ownId],
  );
  return rows.map(toValidator);
}

/**
 * One active validator by id, ignored or not (its `ignored` flag in the
 * row), or null when there is no active validator with that id.
 * Membership: the chunk read, the join request, the held rows, ready.
 */
export async function findActiveValidator(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toValidator(rows[0]);
}

/** One counted validator by id (active and not ignored), or null. */
export async function findCountedValidator(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM validators WHERE active AND NOT ignored AND id = $1`,
    [id],
  );
  return rows.length === 0 ? null : toValidator(rows[0]);
}

/**
 * Every counted validator, as a Map from id to validator. One read per
 * request; every lookup after that is in memory, so a whole message is
 * judged against one consistent view of the registry.
 */
export async function findCountedValidators() {
  const { rows } = await query(`SELECT ${COLUMNS} FROM validators WHERE active AND NOT ignored ORDER BY id`);
  return new Map(rows.map((row) => [row.id, toValidator(row)]));
}

/** Whether the validator with this id is the leader, per this validator's own registry. */
export async function findIsLeader(id) {
  const { rows } = await query('SELECT is_leader FROM validators WHERE id = $1', [id]);
  return rows.length === 1 && rows[0].is_leader;
}

/** The id of the row with is_leader, or null when no row is the leader. */
export async function findLeaderId() {
  const { rows } = await query('SELECT id FROM validators WHERE is_leader ORDER BY id LIMIT 1');
  return rows.length === 0 ? null : rows[0].id;
}

/** The ids of the active rows with `ignored`, ascending: the validators this one does not count. */
export async function findIgnoredIds() {
  const { rows } = await query('SELECT id FROM validators WHERE active AND ignored ORDER BY id');
  return rows.map((row) => row.id);
}

/**
 * The next validator in the ring: the lowest counted id above `afterId`,
 * wrapping round to the lowest counted id. Null when no row is counted.
 */
export async function findNextCounted(afterId) {
  const { rows } = await query(
    `SELECT id FROM validators WHERE active AND NOT ignored
     ORDER BY (id > $1) DESC, id
     LIMIT 1`,
    [afterId],
  );
  return rows.length === 0 ? null : rows[0].id;
}

/** The counts the floor rule needs: the active rows and, among them, the counted ones. */
export async function findCounts() {
  const { rows } = await query(
    `SELECT count(*) FILTER (WHERE active) AS active,
            count(*) FILTER (WHERE active AND NOT ignored) AS counted
     FROM validators`,
  );
  return { active: Number(rows[0].active), counted: Number(rows[0].counted) };
}

/** Makes `id` the leader in this validator's own registry: that row true, every other row false. */
export async function setLeader(id) {
  await query('UPDATE validators SET is_leader = (id = $1)', [id]);
}

/**
 * Makes `ids` the ignored rows and every other active row counted: the
 * network's view, adopted by a validator that joins
 * (src/garlic-chain/replay.service.js adoptIgnoredList).
 */
export async function setIgnoredList(ids) {
  await query('UPDATE validators SET ignored = (id = ANY($1::int[])) WHERE active', [ids]);
}

/**
 * Sets `ignored` to `flag` on the rows with these ids. `client` is the
 * connection of the one transaction that applies a vote's proof
 * (src/votes/), so the flags and the vote's row land together.
 */
export async function setIgnored(client, ids, flag) {
  await client.query('UPDATE validators SET ignored = $2 WHERE id = ANY($1::int[])', [ids, flag]);
}
