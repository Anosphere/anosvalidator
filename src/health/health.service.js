import { query } from '../db/pool.js';

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
