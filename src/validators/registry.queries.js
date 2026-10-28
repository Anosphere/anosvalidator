/**
 * SQL for applying network/testnet.registry.json to the validators table at
 * boot (registry.service.js). Every function takes the client of the one
 * transaction the apply runs in. The per-call reads of the table are in
 * validators.queries.js, which this does not touch.
 */

/**
 * Inserts the row, or refreshes an existing one: public_key, url and
 * active from the file, is_leader as it was.
 */
export async function upsertValidator(client, { id, publicKey, url, active }) {
  await client.query(
    `INSERT INTO validators (id, public_key, url, active)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       public_key = EXCLUDED.public_key,
       url        = EXCLUDED.url,
       active     = EXCLUDED.active`,
    [id, publicKey, url, active],
  );
}

/** Sets every active row whose id is not in `ids` inactive. The rows stay. */
export async function deactivateMissing(client, ids) {
  await client.query('UPDATE validators SET active = false WHERE active AND NOT (id = ANY($1::int[]))', [ids]);
}

/** Whether any row is leader. */
export async function findHasLeader(client) {
  const { rows } = await client.query('SELECT EXISTS (SELECT FROM validators WHERE is_leader) AS has_leader');
  return rows[0].has_leader;
}

/** Makes `id` the leader: that row true, every other row false (setLeader's statement, on the client). */
export async function setLeaderOn(client, id) {
  await client.query('UPDATE validators SET is_leader = (id = $1)', [id]);
}

/**
 * Every row ordered by id as { id, publicKey, url, active }, the key as
 * lowercase hex and the leader flag left out: what the registry hash is
 * computed over.
 */
export async function findAllRows(client) {
  const { rows } = await client.query(
    "SELECT id, encode(public_key, 'hex') AS public_key, url, active FROM validators ORDER BY id",
  );
  return rows.map((row) => ({ id: row.id, publicKey: row.public_key, url: row.url, active: row.active }));
}
