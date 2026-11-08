import { query } from '../db/pool.js';
import { STAKE_PURPOSES, columnFor } from './stake-purposes.js';

/**
 * SQL for the stakes table: per account, the amount staked for each purpose
 * (db/schema.sql). Account ids are Buffers of 32 raw bytes, matching the
 * BYTEA column; amounts are BigInt in millionths, sent to and read from the
 * BIGINT columns as decimal strings so nothing is lost.
 *
 * The column names come from stake-purposes.js, a fixed table, never from
 * a request, so they are safe to put into the SQL text.
 *
 * findStake reads a row; addStake and subtractStake move one purpose's
 * amount; moveStake moves a whole row to another account, the side effect
 * of a breakGlassTransfer (2026-11-08, docs/schemas.md section 22);
 * listDaoVoteStakes lists every account's daoVote stake with their total,
 * the public read the masterpod takes its DAO voting snapshot from
 * (2026-11-08, section 23).
 */

const COLUMNS = STAKE_PURPOSES.map(({ column }) => column).join(', ');

/** `column = 0` for every purpose: the condition for a row that holds nothing any more. */
const ALL_ZERO = STAKE_PURPOSES.map(({ column }) => `${column} = 0`).join(' AND ');

/** A stakes row as an object keyed by purpose name, each amount a BigInt. */
function toStake(row) {
  const stake = {};
  for (const { name, column } of STAKE_PURPOSES) {
    stake[name] = BigInt(row[column]);
  }
  return stake;
}

/**
 * The stake of one account: an object with one BigInt amount per purpose
 * name (daoVote, moderator, attestor, guardian, validator, masterPod), or
 * null when the account has no stakes row, which is the same as holding
 * nothing.
 */
export async function findStake(accountId) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM stakes WHERE account_id = $1`, [accountId]);
  return rows.length === 0 ? null : toStake(rows[0]);
}

/**
 * Adds `amount` (BigInt or decimal string, millionths) to the account's
 * stake for `purpose`, creating the row when the account has none. `client`
 * is a connection checked out of the pool: the stake moves inside the same
 * database transaction as the transferToFund link that pays for it. A
 * database error is thrown; the caller's transaction is what rolls back.
 */
export async function addStake(client, accountId, purpose, amount) {
  const column = columnFor(purpose);
  await client.query(
    `INSERT INTO stakes (account_id, ${column}) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET ${column} = stakes.${column} + EXCLUDED.${column}`,
    [accountId, amount.toString()],
  );
}

/**
 * Takes `amount` (BigInt or decimal string, millionths) off the account's
 * stake for `purpose`, then deletes the row when every amount in it is zero.
 * `client` as for addStake: this runs inside the batch that writes the fund
 * proposal returning the stake. The column's CHECK (>= 0) fails the batch if
 * the stake does not cover the amount, and so does a missing row; the
 * proposal was checked against both when it was accepted.
 */
export async function subtractStake(client, accountId, purpose, amount) {
  const column = columnFor(purpose);
  const { rowCount } = await client.query(
    `UPDATE stakes SET ${column} = ${column} - $2 WHERE account_id = $1`,
    [accountId, amount.toString()],
  );
  if (rowCount !== 1) {
    throw new Error(`no stakes row for account ${accountId.toString('hex')} to take ${purpose} stake from`);
  }
  await client.query(`DELETE FROM stakes WHERE account_id = $1 AND ${ALL_ZERO}`, [accountId]);
}

/**
 * Moves every stake of `fromAccountId` to `toAccountId`: the whole stakes row,
 * all six purposes, added to the receiver's row (created when it has none),
 * then the sender's row deleted. `client` as for addStake: this runs inside
 * the batch that writes the breakGlassTransfer link (transfer.service.js
 * writeAnosTransfer) and inside the replay of such a link. A sender with no
 * stakes row moves nothing.
 */
export async function moveStake(client, fromAccountId, toAccountId) {
  const sums = STAKE_PURPOSES.map(({ column }) => `${column} = stakes.${column} + EXCLUDED.${column}`).join(', ');
  await client.query(
    `INSERT INTO stakes (account_id, ${COLUMNS})
     SELECT $2, ${COLUMNS} FROM stakes WHERE account_id = $1
     ON CONFLICT (account_id) DO UPDATE SET ${sums}`,
    [fromAccountId, toAccountId],
  );
  await client.query('DELETE FROM stakes WHERE account_id = $1', [fromAccountId]);
}

/**
 * Every account's daoVote stake, for the masterpod's snapshot of DAO voting
 * weights (docs/schemas.md section 23): the stakes rows with
 * dao_vote_stake > 0, account id ascending, each { accountId (Buffer),
 * daoVoteStake (a decimal string of millionths) }, and total, their sum as
 * a decimal string, '0' when there is no row. The sum is a window over the
 * same rows, so it is read off the first one.
 */
export async function listDaoVoteStakes() {
  const { rows } = await query(
    `SELECT account_id, dao_vote_stake, SUM(dao_vote_stake) OVER () AS total
     FROM stakes WHERE dao_vote_stake > 0 ORDER BY account_id`,
  );
  return {
    total: rows.length === 0 ? '0' : String(rows[0].total),
    rows: rows.map((row) => ({ accountId: row.account_id, daoVoteStake: row.dao_vote_stake })),
  };
}
