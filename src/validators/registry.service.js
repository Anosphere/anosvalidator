import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { canonicalize } from '../crypto/canonical.js';
import { sha256 } from '../crypto/hash.js';
import { pool } from '../db/pool.js';
import { isObject } from '../util/is-object.js';
import {
  deactivateMissing,
  findAllRows,
  findHasLeader,
  setLeaderOn,
  upsertValidator,
} from './registry.queries.js';
import { ownPublicKeyHex } from './validators.signing.js';

/**
 * The registry: network/testnet.registry.json, the committed list of every
 * validator of the network, applied to this validator's validators table at
 * boot (src/server.js), after genesis and before listening. A row changes
 * only through a commit to that file; nobody edits the table by hand. The
 * server reads the file from that path and nowhere else.
 *
 * The file is { firstLeader, validators: [{ id, publicKey, url, active }] }:
 * firstLeader null or the id of a row in the file; id a positive integer,
 * unique; publicKey the 33-byte compressed P-256 point as 66 lowercase hex
 * characters; url scheme, host and port, no trailing slash; active false
 * once a validator has left. Each shape check that fails names the row and
 * the field, and the boot stops.
 *
 * Applying it, in one database transaction:
 *   1. every row in the file is upserted: public_key, url and active from
 *      the file, is_leader untouched;
 *   2. every row in the table that is not in the file is set inactive; the
 *      row stays, so what that validator signed still verifies;
 *   3. if no row in the table is leader and the file names a firstLeader,
 *      that row becomes leader; otherwise leadership stays where it is,
 *      since it moves while the validators run;
 *   4. this validator's own id must be in the file, active, with the
 *      publicKey derived from its key file (validators.signing.js), or the
 *      boot stops saying which of the three failed; checked against the
 *      file before the transaction starts;
 *   5. the registry hash is the SHA-256 of the canonical JSON (RFC 8785,
 *      src/crypto/canonical.js) of every row in the table after the apply,
 *      ordered by id, each { id, publicKey, url, active } with the key as
 *      lowercase hex and the leader flag left out, so two validators with
 *      the same file agree whoever leads. It is kept here with the count of
 *      active rows for /health; the boot log shows its first 16 hex
 *      characters.
 *
 * The per-call reads (validators.queries.js) are untouched: they still read
 * the table fresh on every call.
 */

/** The file, as the messages name it. */
const REGISTRY_FILE = 'network/testnet.registry.json';

/** Where it is: the repo root, whatever the working directory. */
const REGISTRY_PATH = fileURLToPath(new URL(`../../${REGISTRY_FILE}`, import.meta.url));

/** The placeholder a row ships with before its validator's key exists. */
const FILL_IN = '<fill in>';

/** { hash, active } as applied at boot; null until applyRegistry has run. */
let applied = null;

/** The registry as applied at boot: { hash (64 hex), active (count) }, or null before the apply. */
export function appliedRegistry() {
  return applied;
}

function fail(message) {
  throw new Error(`${REGISTRY_FILE}: ${message}`);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** One row of the file, checked; `ids` collects the ids seen so far. */
function checkRow(row, index, ids) {
  const where = `row ${index + 1}`;
  if (!isObject(row)) fail(`${where} must be an object`);
  if (!isPositiveInteger(row.id)) fail(`${where}: id must be a positive integer`);
  if (ids.has(row.id)) fail(`${where}: id ${row.id} appears twice`);
  ids.add(row.id);

  const at = `${where} (id ${row.id})`;
  if (row.publicKey === FILL_IN) {
    fail(`${at}: publicKey is still "${FILL_IN}": fill it in ${REGISTRY_FILE}`);
  }
  if (typeof row.publicKey !== 'string' || !/^[0-9a-f]{66}$/.test(row.publicKey)) {
    fail(`${at}: publicKey must be 66 lowercase hex characters`);
  }
  if (typeof row.url !== 'string' || !/^https?:\/\//.test(row.url) || row.url.endsWith('/')) {
    fail(`${at}: url must start with http:// or https:// and have no trailing slash`);
  }
  if (typeof row.active !== 'boolean') fail(`${at}: active must be true or false`);
  return { id: row.id, publicKey: row.publicKey, url: row.url, active: row.active };
}

/** Reads and checks the file. Returns { firstLeader, rows }. */
function readRegistry() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (err) {
    fail(`could not be read: ${err.message}`);
  }
  if (!isObject(parsed)) fail('must be a JSON object');

  const { firstLeader, validators } = parsed;
  if (!Array.isArray(validators) || validators.length === 0) fail('validators must be a non-empty array');
  const ids = new Set();
  const rows = validators.map((row, index) => checkRow(row, index, ids));
  if (firstLeader !== null && !(isPositiveInteger(firstLeader) && ids.has(firstLeader))) {
    fail('firstLeader must be null or the id of a row in the file');
  }
  return { firstLeader, rows };
}

/** Rule 4: this validator's own row, checked against the file. */
function checkOwnRow(rows) {
  const { id } = env.validator;
  const own = rows.find((row) => row.id === id);
  if (own === undefined) fail(`has no row for this validator (id ${id})`);
  if (!own.active) fail(`this validator's row (id ${id}) is inactive`);
  if (own.publicKey !== ownPublicKeyHex) {
    fail(`this validator's row (id ${id}) has publicKey ${own.publicKey}, but the key file derives ${ownPublicKeyHex}`);
  }
}

/** Rule 5: the hash of the rows as findAllRows returns them. */
function registryHash(rows) {
  return sha256(canonicalize(rows)).toString('hex');
}

/**
 * Applies the file to the table as described above and returns
 * { hash, active }. Throws, with a message naming what failed, when the
 * file does not pass or this validator's row does not match.
 */
export async function applyRegistry() {
  const { firstLeader, rows } = readRegistry();
  checkOwnRow(rows);

  const client = await pool.connect();
  let all;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await upsertValidator(client, { ...row, publicKey: Buffer.from(row.publicKey, 'hex') });
    }
    await deactivateMissing(client, rows.map((row) => row.id));
    if (firstLeader !== null && !(await findHasLeader(client))) {
      await setLeaderOn(client, firstLeader);
    }
    all = await findAllRows(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  applied = Object.freeze({
    hash: registryHash(all),
    active: all.filter((row) => row.active).length,
  });
  return applied;
}
