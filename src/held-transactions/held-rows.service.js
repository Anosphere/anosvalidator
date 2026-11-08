import { ACCOUNT_CREATION, checkCreateAccountSignaturesAndIds } from '../accounts/accounts.service.js';
import { KINDS, checkAttachmentSignatures } from '../attachments/attachments.service.js';
import { canonicalize } from '../crypto/canonical.js';
import { decodeDigest } from '../crypto/hash.js';
import { pool, query } from '../db/pool.js';
import {
  FUND_PROPOSAL,
  TRANSFER_TO_FUND,
  checkFundProposalSignaturesAndIds,
  checkTransferToFundSignaturesAndIds,
} from '../fund/fund.service.js';
import { checkTransferSignaturesAndIds, isTransferType } from '../transfer/transfer.service.js';
import { isObject } from '../util/is-object.js';
import {
  ASSISTED_TRANSFERS,
  ESCROW_TRANSFERS,
  FUND_PROPOSALS,
  LOCKED_TRANSACTIONS,
  PENDING,
} from './held-transactions.js';

/**
 * The held rows a joiner pulls from the leader (docs/schemas.md section
 * 19): the five holding tables, a page at a time, child rows and
 * attachments with them. The leader's side reads a page as the wire
 * carries it (readHeldRows); the joiner's side checks every row and
 * inserts it with every column as received (storeHeldRows), with plain
 * inserts of its own: the five insert functions of the holding tables are
 * untouched.
 *
 * On the wire a row is every column of the table in camelCase: bytes as
 * hex, JSONB as it is, timestamps as ISO 8601, booleans and integers as
 * they are; an escrow row carries `arbitrations` and a proposal row
 * `votes`, each child row every column the same way.
 */

/** The column kinds, which decide how a value travels and lands. */
const BYTES = 'bytes';
const JSON_VALUE = 'json';
const TIME = 'time';
const BOOL = 'bool';
const INT = 'int';
const TEXT = 'text';

const COMMON = Object.freeze({
  transaction_id: BYTES,
  account_id: BYTES,
  og_transaction: JSON_VALUE,
  approved: BOOL,
  created_at: TIME,
  updated_at: TIME,
});

const CHILD_COMMON = Object.freeze({
  transaction_id: BYTES,
  signature: JSON_VALUE,
  approved: BOOL,
  created_at: TIME,
  updated_at: TIME,
});

/**
 * The five tables: their columns with kinds, the columns that may be null
 * besides a slot (`nullable`; assisted_transfers' future_date, a TIME that
 * only a break-glass move out of a guarded or vault account fills, since
 * 2026-11-08), the slots that hold a whole follow-up, and the child table
 * whose rows ride with each row.
 */
const TABLES = Object.freeze({
  [PENDING]: { columns: COMMON, slots: [], children: null },
  [LOCKED_TRANSACTIONS]: { columns: { ...COMMON, future_date: TIME }, slots: [], children: null },
  [ASSISTED_TRANSFERS]: {
    columns: {
      ...COMMON,
      attestation_1: JSON_VALUE,
      attestation_1_approved: BOOL,
      attestation_2: JSON_VALUE,
      attestation_2_approved: BOOL,
      cancellation: JSON_VALUE,
      cancellation_approved: BOOL,
      future_date: TIME,
    },
    nullable: ['future_date'],
    slots: ['attestation_1', 'attestation_2', 'cancellation'],
    children: null,
  },
  [ESCROW_TRANSFERS]: {
    columns: {
      ...COMMON,
      account_id_to: BYTES,
      success_signature: JSON_VALUE,
      success_signature_approved: BOOL,
      cancel_signature: JSON_VALUE,
      cancel_signature_approved: BOOL,
      dispute_signature: JSON_VALUE,
      dispute_signature_approved: BOOL,
    },
    slots: ['success_signature', 'cancel_signature', 'dispute_signature'],
    children: {
      key: 'arbitrations',
      table: 'escrow_arbitrations',
      orderBy: 'arbitrator_account_id',
      columns: { ...CHILD_COMMON, arbitrator_account_id: BYTES, verdict: TEXT },
    },
  },
  [FUND_PROPOSALS]: {
    columns: { ...COMMON, vote_closes_at: TIME, proposer_weight: INT },
    slots: [],
    children: {
      key: 'votes',
      table: 'guardian_votes',
      orderBy: 'guardian_account_id',
      columns: { ...CHILD_COMMON, guardian_account_id: BYTES, vote: TEXT, weight: INT },
    },
  },
});

/** The five table names a held rows request may name. */
export const HELD_ROW_TABLES = Object.freeze(Object.keys(TABLES));

/** The wire name of a column: camelCase of its snake_case name. */
function camel(column) {
  return column.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** A database row as the wire carries it. */
function toWire(row, columns) {
  const wire = {};
  for (const [column, kind] of Object.entries(columns)) {
    const value = row[column];
    wire[camel(column)] = value === null
      ? null
      : kind === BYTES ? value.toString('hex')
        : kind === TIME ? value.toISOString()
          : value;
  }
  return wire;
}

/**
 * The leader's side: the rows of `table` with transaction_id above
 * `afterTransactionId` (a Buffer, or null for the first page), ordered by
 * transaction_id, at most `limit`, each as the wire carries it, with its
 * child rows.
 */
export async function readHeldRows(table, afterTransactionId, limit) {
  const spec = TABLES[table];
  const columns = Object.keys(spec.columns).join(', ');
  const { rows } = await query(
    `SELECT ${columns} FROM ${table}
     WHERE ($1::bytea IS NULL OR transaction_id > $1)
     ORDER BY transaction_id
     LIMIT $2`,
    [afterTransactionId, limit],
  );
  const out = [];
  for (const row of rows) {
    const wire = toWire(row, spec.columns);
    if (spec.children) {
      const { children } = spec;
      const { rows: kids } = await query(
        `SELECT ${Object.keys(children.columns).join(', ')} FROM ${children.table}
         WHERE transaction_id = $1
         ORDER BY ${children.orderBy}`,
        [row.transaction_id],
      );
      wire[children.key] = kids.map((kid) => toWire(kid, children.columns));
    }
    out.push(wire);
  }
  return out;
}

/**
 * The joiner's side: checks and stores one page of `table`. Per row: the
 * shape of every column; the transaction's signature and id checks by its
 * type (the helpers the replay uses, src/garlic-chain/replay.service.js);
 * every stored follow-up's signatures (attachments.service.js
 * checkAttachmentSignatures), in the slots and the child rows; then the
 * insert with every column as received, children included, in one
 * database transaction. A row already present with the same og_transaction
 * is skipped (a live approval got there first); present with another one,
 * the page stops. The approved flags are kept on trust. Resolves with
 * { ok: true, inserted, skipped } or { ok: false, reason }.
 */
export async function storeHeldRows(table, rows) {
  const spec = TABLES[table];
  let inserted = 0;
  let skipped = 0;
  for (const [i, wire] of rows.entries()) {
    const shape = checkRowShape(wire, spec);
    if (shape) return { ok: false, reason: `row ${i}: ${shape}` };
    const transactionId = decodeDigest(wire.transactionId);
    const at = `row ${wire.transactionId.slice(0, 8)}`;

    const checked = await checkHeldTransaction(wire.ogTransaction, transactionId, decodeDigest(wire.accountId));
    if (!checked.ok) return { ok: false, reason: `${at}: ${checked.reason}` };

    for (const slot of spec.slots) {
      const object = wire[camel(slot)];
      if (object === null) continue;
      const bad = await checkAttachmentSignatures(object, KINDS);
      if (!bad.ok) return { ok: false, reason: `${at}, ${slot}: ${bad.reason}` };
    }
    if (spec.children) {
      for (const [j, kid] of wire[spec.children.key].entries()) {
        const bad = await checkAttachmentSignatures(kid.signature, KINDS);
        if (!bad.ok) return { ok: false, reason: `${at}, ${spec.children.key}[${j}]: ${bad.reason}` };
      }
    }

    const present = await findStored(table, transactionId);
    if (present !== null) {
      if (canonicalize(present) === canonicalize(wire.ogTransaction)) {
        skipped += 1;
        continue;
      }
      return { ok: false, reason: `${at} is already here from another submission` };
    }
    await insertRow(table, spec, wire);
    inserted += 1;
  }
  return { ok: true, inserted, skipped };
}

/**
 * The transaction a held row carries, checked by its type: the shape,
 * signature and id checks the replay runs, and the row's transactionId and
 * accountId being the transaction's own.
 */
async function checkHeldTransaction(ogTransaction, transactionId, accountId) {
  const type = isObject(ogTransaction) && isObject(ogTransaction.payload) ? ogTransaction.payload.transactionType : undefined;
  let checked;
  if (type === ACCOUNT_CREATION) checked = checkCreateAccountSignaturesAndIds(ogTransaction);
  else if (isTransferType(type)) checked = await checkTransferSignaturesAndIds(ogTransaction);
  else if (type === TRANSFER_TO_FUND) checked = await checkTransferToFundSignaturesAndIds(ogTransaction);
  else if (type === FUND_PROPOSAL) checked = await checkFundProposalSignaturesAndIds(ogTransaction);
  else return { ok: false, reason: `transactionType ${JSON.stringify(type)} is not one this validator knows` };
  if (!checked.ok) return checked;
  if (!checked.transactionId.equals(transactionId)) return { ok: false, reason: "transactionId is not the transaction's own" };
  if (!checked.accountId.equals(accountId)) return { ok: false, reason: "accountId is not the transaction's own" };
  return { ok: true };
}

/** The og_transaction of the row with this transaction id in `table`, or null when there is none. */
async function findStored(table, transactionId) {
  const { rows } = await query(`SELECT og_transaction FROM ${table} WHERE transaction_id = $1`, [transactionId]);
  return rows.length === 0 ? null : rows[0].og_transaction;
}

/** The row and its child rows, inserted with every column as received, in one database transaction. */
async function insertRow(table, spec, wire) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertOne(client, table, spec.columns, wire);
    if (spec.children) {
      for (const kid of wire[spec.children.key]) {
        await insertOne(client, spec.children.table, spec.children.columns, kid);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertOne(client, table, columns, wire) {
  const names = Object.keys(columns);
  const placeholders = names.map((column, i) => (columns[column] === JSON_VALUE ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const values = names.map((column) => fromWire(wire[camel(column)], columns[column]));
  await client.query(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`, values);
}

/** A wire value as the database takes it. */
function fromWire(value, kind) {
  if (value === null) return null;
  if (kind === BYTES) return decodeDigest(value);
  if (kind === JSON_VALUE) return JSON.stringify(value);
  if (kind === TIME) return new Date(value);
  return value;
}

/** Returns a description of the first structural problem with a wire row of `spec`, or null. */
function checkRowShape(wire, spec) {
  if (!isObject(wire)) return 'must be an object';
  const bad = checkColumns(wire, spec.columns, spec.nullable);
  if (bad) return bad;
  if (spec.children) {
    const kids = wire[spec.children.key];
    if (!Array.isArray(kids)) return `${spec.children.key} must be an array`;
    for (const [j, kid] of kids.entries()) {
      if (!isObject(kid)) return `${spec.children.key}[${j}] must be an object`;
      const badKid = checkColumns(kid, spec.children.columns);
      if (badKid) return `${spec.children.key}[${j}]: ${badKid}`;
    }
  }
  return null;
}

/**
 * Every column of `columns` as its kind demands. A slot (a JSON column other
 * than og_transaction and a child's signature) may be null, and so may a
 * TIME column the table's spec lists in `nullable` (assisted_transfers'
 * future_date; locked_transactions' is never null).
 */
function checkColumns(wire, columns, nullable = []) {
  for (const [column, kind] of Object.entries(columns)) {
    const name = camel(column);
    const value = wire[name];
    if (value === null && kind === JSON_VALUE && column !== 'og_transaction' && column !== 'signature') continue;
    if (value === null && kind === TIME && nullable.includes(column)) continue;
    if (kind === BYTES && !decodeDigest(value)) return `${name} must be a SHA-256 digest`;
    if (kind === JSON_VALUE && !isObject(value)) return `${name} must be an object`;
    if (kind === TIME && (typeof value !== 'string' || Number.isNaN(Date.parse(value)))) return `${name} must be a date`;
    if (kind === BOOL && typeof value !== 'boolean') return `${name} must be true or false`;
    if (kind === INT && !Number.isInteger(value)) return `${name} must be an integer`;
    if (kind === TEXT && typeof value !== 'string') return `${name} must be a string`;
  }
  return null;
}
