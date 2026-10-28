import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * What is running: the short commit and the exact tag of the checkout this
 * process was started from, read once at boot with git and answered by
 * /health. Each is null when git is not installed, the directory is not a
 * repository, or the command fails; no tag is the normal case until the
 * first testnet-N tag exists.
 */

/** The repo root, where git is run, whatever the working directory. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The trimmed output of `git <args>`, or null when it fails or prints nothing. */
function git(...args) {
  try {
    const output = execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

export const version = Object.freeze({
  commit: git('rev-parse', '--short', 'HEAD'),
  tag: git('describe', '--tags', '--exact-match'),
});
