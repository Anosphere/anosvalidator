import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { findTailRow } from '../garlic-chain/garlic-chain.queries.js';
import { version } from '../util/version.js';
import { isCounted } from '../validators/join.service.js';
import { appliedRegistry } from '../validators/registry.service.js';
import { findIgnoredIds, findLeaderId } from '../validators/validators.queries.js';
import { ownPublicKeyHex } from '../validators/validators.signing.js';

/** Confirms the database is reachable with a trivial round trip. */
export async function checkDatabase() {
  const started = performance.now();
  try {
    await query('SELECT 1');
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    console.error('Database health check failed:', err.message);
    return { status: 'unreachable' };
  }
}

/**
 * What this process is: fixed at boot, its id and public key, the commit
 * and tag it runs, and the hash and active count of the registry it
 * applied (registry.service.js); read from the tables on every call, the
 * chain's tail as { position, recordHash } (garlic-chain.queries.js
 * findTailRow), the leader's id or null, and the ids this validator
 * ignores, ascending (validators.queries.js); and `counted`, the in-memory
 * flag of join.service.js. The three table reads are null when the
 * database cannot be read, which the status already says.
 */
export async function identity() {
  const tables = await readTables();
  return {
    validator: { id: env.validator.id, publicKey: ownPublicKeyHex },
    version,
    registry: appliedRegistry(),
    chain: tables.chain,
    leader: tables.leader,
    ignored: tables.ignored,
    counted: isCounted(),
  };
}

async function readTables() {
  try {
    return { chain: await findTailRow(), leader: await findLeaderId(), ignored: await findIgnoredIds() };
  } catch (err) {
    console.error('Health could not read the tables:', err.message);
    return { chain: null, leader: null, ignored: null };
  }
}
