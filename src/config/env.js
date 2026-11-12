/**
 * Reads and validates environment variables once at startup.
 * Everything else imports `env` from here instead of touching process.env,
 * so a missing or malformed variable fails at boot rather than mid-request.
 *
 * Two files are loaded, in this order: network/testnet.env, committed, with
 * every value that is the same on every VM of the network, then .env, the
 * machine file scripts/make-keys.js writes (the id, the database password,
 * the key file), which wins where both name a variable:
 *   node --env-file=network/testnet.env --env-file=.env src/server.js
 */

/** The placeholder the shared file ships with for an address that does not exist yet. */
const FILL_IN = '<fill in>';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  if (value === FILL_IN) {
    throw new Error(`${name} is still "${FILL_IN}": fill it in network/testnet.env or .env`);
  }
  return value;
}

/** A required variable that must be a positive integer. */
function requiredInteger(name) {
  const value = required(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

/**
 * An optional variable that must be a positive integer when set; `fallback`
 * when it is not set.
 */
function optionalInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return Number(value);
}

/** Millionths of an anos in one anos: the scale of every amount in the database. */
const MILLIONTHS_PER_ANOS = 1_000_000n;

/**
 * A required variable holding a whole number of anos (a positive integer),
 * returned in millionths as a BigInt, the scale amounts are compared at.
 */
function requiredAnos(name) {
  return BigInt(requiredInteger(name)) * MILLIONTHS_PER_ANOS;
}

/**
 * A required comma-separated list (the masterpod's parser, without a
 * default): items trimmed, empty ones dropped, at least one.
 */
function requiredList(name) {
  const value = required(name);
  const items = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0) throw new Error(`${name} must list at least one item, got "${value}"`);
  return Object.freeze(items);
}

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT) || 3000,

  // Variable names follow libpq (PGHOST, PGUSER, ...), so psql and other
  // PostgreSQL tools read the same env files without any translation.
  db: Object.freeze({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT) || 5432,
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
  }),

  // This validator's identity, from .env. `id` is its row in the validators
  // table. `keyFile` is where its P-256 private key is, the file
  // scripts/make-keys.js wrote (JSON, mode 0600), relative to the repo root
  // or absolute; src/crypto/key-file.js checks and reads it, and
  // validators/validators.signing.js derives the public key from it at
  // boot. No key passes through the environment.
  validator: Object.freeze({
    id: requiredInteger('VALIDATOR_ID'),
    keyFile: process.env.KEY_FILE || './validator.key',
  }),

  // Time locks on guarded and vault accounts, in minutes
  // (src/transfer/transfer.service.js). A guardedAnosTransfer must be dated
  // at least GUARDED_LOCK_MINUTES ahead of now and at most LOCK_OFFSET_MINUTES
  // more than that; a vaultAnosTransfer the same with VAULT_LOCK_MINUTES. The
  // wallet dates a transfer the lock plus the offset ahead, so one that takes
  // a while to reach a validator is still at least the lock ahead. The
  // offset also bounds how far a fund proposal's createdAt may be from the
  // validator's clock (src/fund/fund.service.js), and since 2026-11-11
  // (docs/schemas.md section 27) the createdAt of every transfer without a
  // lock: a plain, an assisted and an escrow transfer, a transferToFund and
  // a break-glass move out of a spending or assisted account must be dated
  // within the offset of the validator's clock, before or after. A cancel
  // of an assisted transfer or of an escrow trade waits until its transfer
  // is more than the offset old.
  locks: Object.freeze({
    guardedMinutes: requiredInteger('GUARDED_LOCK_MINUTES'),
    vaultMinutes: requiredInteger('VAULT_LOCK_MINUTES'),
    offsetMinutes: requiredInteger('LOCK_OFFSET_MINUTES'),
  }),

  // Stakes (src/stakes/). The least a transferToFund may stake for each
  // purpose, and the stake an account must hold to have that role. The env
  // file gives them in whole anos; they are converted to millionths once
  // here, as BigInt, the scale of every amount in the database.
  stakes: Object.freeze({
    minimums: Object.freeze({
      daoVote: requiredAnos('STAKE_MIN_DAO_VOTE_ANOS'),
      moderator: requiredAnos('STAKE_MIN_MODERATOR_ANOS'),
      attestor: requiredAnos('STAKE_MIN_ATTESTOR_ANOS'),
      guardian: requiredAnos('STAKE_MIN_GUARDIAN_ANOS'),
      validator: requiredAnos('STAKE_MIN_VALIDATOR_ANOS'),
      masterPod: requiredAnos('STAKE_MIN_MASTER_POD_ANOS'),
    }),
  }),

  // Guardian votes on fund proposals (src/fund/). anosPerVote is the guardian
  // stake behind one vote, GUARDIAN_VOTE_ANOS converted to millionths as
  // BigInt like the minimums above: a guardian's weight is its guardian
  // stake divided by this, rounded down. percent is the share of the votes
  // cast a proposal needs to pass, minutes how long it is open for votes.
  guardianVote: Object.freeze({
    anosPerVote: requiredAnos('GUARDIAN_VOTE_ANOS'),
    percent: requiredInteger('GUARDIAN_VOTE_PERCENT'),
    minutes: requiredInteger('GUARDIAN_VOTE_MINUTES'),
  }),

  // The wallet's origins, a comma-separated list: the CORS allow-list
  // (src/app.js). Required; in network/testnet.env.
  webOrigins: requiredList('WEB_ORIGIN'),

  // Where the masterpod's /get-anos-account is (src/masterpod/
  // masterpod.client.js): the binding check a create-account submission
  // must pass. Required; in network/testnet.env. A trailing slash is dropped.
  masterpodUrl: required('MASTERPOD_URL').replace(/\/+$/, ''),

  // How far a signed account-level request's timestamp may be from the
  // server clock, each way (src/auth/). Nonces are kept twice this long.
  // Optional.
  timestampWindowSeconds: optionalInteger('TIMESTAMP_WINDOW_SECONDS', 120),

  // The calls between validators (src/validators/validators.client.js) and
  // the catch-up, the ignore votes and the joining built on them
  // (docs/schemas.md section 19). All six in network/testnet.env and
  // required, so a validator with an old env file stops at boot naming the
  // variable: the timeout of every call, in seconds; the floor an ignore
  // vote may not take the counted validators below, a percent of the
  // active rows; how long a joiner may hold the leader's rounds, in
  // seconds; how long an originator waits for the vote after no answer, in
  // seconds; how many links a chain chunk carries at most; how many rows a
  // page of held rows carries at most.
  network: Object.freeze({
    callTimeoutSeconds: requiredInteger('VALIDATOR_CALL_TIMEOUT_SECONDS'),
    ignoreFloorPercent: requiredInteger('IGNORE_FLOOR_PERCENT'),
    joinHoldSeconds: requiredInteger('JOIN_HOLD_SECONDS'),
    noAnswerWaitSeconds: requiredInteger('NO_ANSWER_WAIT_SECONDS'),
    chainChunkLinks: requiredInteger('CHAIN_CHUNK_LINKS'),
    heldRowsPage: requiredInteger('HELD_ROWS_PAGE'),
  }),

  // How long a held row may stay unapproved before the validator that
  // holds it drops it, in seconds (src/held-transactions/unapproved-sweep.js,
  // docs/schemas.md section 21). Required; in network/testnet.env.
  unapprovedAgeLimitSeconds: requiredInteger('UNAPPROVED_AGE_LIMIT_SECONDS'),
});
