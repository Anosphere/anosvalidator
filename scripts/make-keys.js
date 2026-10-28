import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { derivePublicKey } from '../src/crypto/key-file.js';

/**
 * Makes this validator's key and its machine file, on the VM, once:
 *
 *   npm run make-keys -- --id <N> [--key-file <path>]
 *
 * --id is the validator's id, handed out before the visit; the only thing
 * anyone types. A fresh P-256 pair is generated here. The private key goes
 * into the key file (default ./validator.key: JSON { privateKey } as PKCS#8
 * DER hex, mode 0600) and is never shown; the public key, the 33-byte
 * compressed point that goes into network/testnet.registry.json, is
 * printed. .env is written beside it with exactly three lines, the id, a
 * random database password and the key file's path, mode 0644 so
 * scripts/setup-db.sh can read it as postgres. Everything shared by every
 * VM is in network/testnet.env.
 *
 * Both files are created with the exclusive flag. If either exists the
 * script says which and writes nothing: a key is made once, and a lost key
 * means a new id and a new registry row, never a new key under the old id.
 */

const USAGE = 'usage: npm run make-keys -- --id <N> [--key-file <path>]';

/** The repo root: where .env goes and what a relative --key-file is resolved against. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

let args;
try {
  args = parseArgs({
    options: {
      id: { type: 'string' },
      'key-file': { type: 'string', default: './validator.key' },
    },
  }).values;
} catch (err) {
  console.error(`${err.message}\n${USAGE}`);
  process.exit(1);
}

const id = args.id;
if (id === undefined || !/^[1-9][0-9]*$/.test(id)) {
  console.error(`--id must be a positive integer, the validator's id.\n${USAGE}`);
  process.exit(1);
}
const keyFile = args['key-file'];
const keyFilePath = resolve(REPO_ROOT, keyFile);
const envPath = resolve(REPO_ROOT, '.env');

// Both existence checks before any write, so a second run never half-writes.
const existing = [keyFilePath, envPath].filter((file) => existsSync(file));
if (existing.length > 0) {
  console.error(`${existing.join(' and ')} already exist${existing.length === 1 ? 's' : ''}; nothing written.`);
  process.exit(1);
}

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyHex = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
const publicKeyHex = derivePublicKey(privateKeyHex).toString('hex');

writeFileSync(keyFilePath, `${JSON.stringify({ privateKey: privateKeyHex }, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
writeFileSync(
  envPath,
  [`VALIDATOR_ID=${id}`, `PGPASSWORD=${randomBytes(16).toString('hex')}`, `KEY_FILE=${keyFile}`, ''].join('\n'),
  { flag: 'wx', mode: 0o644 },
);
// The umask may have narrowed the mode at creation; postgres has to read it.
chmodSync(envPath, 0o644);

console.log(`Validator ${id}, public key ${publicKeyHex}`);
console.log('');
console.log(`Wrote ${keyFilePath} (mode 0600, never shown) and ${envPath}.`);
console.log('Next (the operator guide, steps 8 to 10): the database, then, once this public key');
console.log('is in network/testnet.registry.json and pulled, the unit:');
console.log('');
console.log('  sudo -u postgres sh scripts/setup-db.sh');
console.log('  sudo cp deploy/anos-validator.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now anos-validator');
