import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { version } from '../util/version.js';
import { appliedRegistry } from '../validators/registry.service.js';
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
 * What this process is, fixed at boot: its id and public key, the commit and
 * tag it runs, and the hash and active count of the registry it applied
 * (registry.service.js).
 */
export function identity() {
  return {
    validator: { id: env.validator.id, publicKey: ownPublicKeyHex },
    version,
    registry: appliedRegistry(),
  };
}
