import { ownPublicKeyHex } from './validators/validators.signing.js';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, query } from './db/pool.js';
import { runGenesis } from './genesis/genesis.service.js';
import { applyRegistry } from './validators/registry.service.js';

// Who this is, first. The key file was loaded by the import of
// validators.signing.js, the first import above, so a missing or open key
// file has already stopped the boot by now, before any connection is made.
console.log(`Validator ${env.validator.id}, public key ${ownPublicKeyHex}`);

// Verify the database connection before accepting traffic, so a bad
// configuration fails loudly at boot instead of on the first request.
try {
  const { rows } = await query('SHOW server_version');
  console.log(
    `Connected to PostgreSQL ${rows[0].server_version} ` +
      `at ${env.db.host}:${env.db.port}/${env.db.database}`,
  );
} catch (err) {
  console.error('Could not connect to PostgreSQL:', err.message);
  process.exit(1);
}

// The first two accounts, written once per database (src/genesis/). A
// database that has rows but no genesis accounts cannot be used, so this
// fails loudly at boot too.
try {
  const { written } = await runGenesis();
  console.log(written ? 'Genesis accounts written' : 'Genesis accounts in place');
} catch (err) {
  console.error('Genesis failed:', err.message);
  process.exit(1);
}

// The registry (src/validators/registry.service.js): network/testnet.registry.json
// applied to the validators table, this validator's own row checked against
// its key. A file that does not pass, or an own row that does not match,
// stops the boot.
try {
  const { hash, active } = await applyRegistry();
  console.log(`Registry ${hash.slice(0, 16)}, ${active} active`);
} catch (err) {
  console.error('Registry failed:', err.message);
  process.exit(1);
}

const app = createApp();

const server = app.listen(env.port, () => {
  console.log(`Validator ${env.validator.id} listening on http://localhost:${env.port}`);
});

let shuttingDown = false;

/** Stop accepting connections, let in-flight requests finish, drain the pool. */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);

  // Safety net: never hang forever if a connection refuses to close.
  setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await closePool();
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
