import { derivePublicKey, readKeyFile } from '../src/crypto/key-file.js';

/**
 * Prints the public key derived from a validator key file, as 66 lowercase
 * hex characters, and starts nothing:
 *
 *   npm run show-key              # ./validator.key
 *   npm run show-key -- <path>    # another key file, relative to the repo root or absolute
 *
 * The file is read with the server's own checks (src/crypto/key-file.js):
 * a missing or open file is refused with its path and mode. The private key
 * is never printed.
 */

const [path = './validator.key', ...rest] = process.argv.slice(2);
if (rest.length > 0) {
  console.error('usage: npm run show-key -- [path]');
  process.exit(1);
}

try {
  const { privateKey } = readKeyFile(path, { privateKey: null });
  console.log(derivePublicKey(privateKey).toString('hex'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
