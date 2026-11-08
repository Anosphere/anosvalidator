import { ACCOUNT_KEYS } from '../accounts/account-keys.js';
import { insertAccount } from '../accounts/accounts.queries.js';
import { ACCOUNT_CREATION, checkCreateAccountSignaturesAndIds } from '../accounts/accounts.service.js';
import { env } from '../config/env.js';
import { canonicalHash, canonicalize } from '../crypto/canonical.js';
import { decodeDigest, sha256 } from '../crypto/hash.js';
import { decodePublicKey } from '../crypto/signatures.js';
import { pool } from '../db/pool.js';
import { FUND_ACCOUNT_ID } from '../fund/fund-account.js';
import {
  FUND_PROPOSAL,
  TRANSFER_FROM_FUND,
  TRANSFER_TO_FUND,
  checkFundProposalSignaturesAndIds,
  checkTransferToFundSignaturesAndIds,
  payoutObject,
} from '../fund/fund.service.js';
import { addStake, moveStake, subtractStake } from '../stakes/stakes.queries.js';
import { BREAK_GLASS_TRANSFER, checkTransferSignaturesAndIds, isTransferType } from '../transfer/transfer.service.js';
import { isObject } from '../util/is-object.js';
import { appliedRegistry } from '../validators/registry.service.js';
import { getHealth } from '../validators/validators.client.js';
import { findIgnoredIds, findMemberPeers, setIgnoredList } from '../validators/validators.queries.js';
import { findLinkPayload, findTailLink } from './chain-links.queries.js';
import { sendChainLinks } from './chain-links.service.js';
import { findTailRow, insertLink } from './garlic-chain.queries.js';

/**
 * Catching up: how a validator that is behind the network gets the links it
 * missed (docs/schemas.md section 19). Two parts.
 *
 * replayLinks writes a chunk of links (what chain-links.service.js
 * sendChainLinks brought back) as links, not as transactions: one database
 * transaction per chunk, each link checked and inserted at its position by
 * this small writer, which applies the side effect of its type (an account
 * row, a stake added or taken back; the balance trigger fires on the
 * insert). The clock checks, the masterpod check and the holding-table
 * checks of a normal arrival are skipped; the signature and id checks of
 * each type run, lifted out of the verify functions. The created_at time
 * is copied from the chunk. Nothing from the holding tables, logs or
 * archives is touched: the record hash is the network's agreement that the
 * writes were right.
 *
 * catchUp is the pass the join loop runs (validators/join.service.js): the
 * network's tail from the health of a majority of the members, then chunks
 * from that majority until the own chain reaches and matches it. The pass
 * also takes the network's view of who is ignored (adoptIgnoredList): the
 * list the counted members of the majority, on the same registry as this
 * validator, agree on.
 */

/**
 * Replays `links`, a chunk as the wire carries it (ascending positions),
 * onto the own chain in one database transaction. Each link, in order:
 *   1. its position is the own tail's plus one (the tail read once at the
 *      start of the chunk, then the link just written);
 *   2. transHash is the SHA-256 of the canonical JSON of
 *      ogTransaction.payload, for every type;
 *   3. recordHash is the SHA-256 of transHash followed by the previous
 *      link's recordHash, raw bytes, as the batch write chains them;
 *   4. type is the payload's transactionType, and transactionId, accountId,
 *      accountIdTo and amount are what the type's write would have put in
 *      the row;
 *   5. the signature and id checks of the type, nothing else (checkByType);
 *   6. the side effect of the type: an account creation inserts the account
 *      row, a transferToFund adds the stake, a transferFromFund with stakeFor
 *      takes it back, a breakGlassTransfer moves the sender's stakes row to
 *      the receiver; the balance trigger does the rest on the insert;
 *   7. the insert, with the chunk's createdAt; the position the identity
 *      column gives must be the link's.
 * A link that fails rolls the chunk back, with one log line naming the
 * position and the reason: `chain replay: ...`. Resolves with { ok: true,
 * position } (the new tail) or { ok: false }.
 */
export async function replayLinks(links) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tail = await findTailLink(client);
    let state = {
      position: tail === null ? 0 : tail.position,
      previousRecordHash: tail === null ? null : tail.recordHash,
      proposal: await openProposal(client, tail),
    };
    for (const link of links) {
      const result = await replayLink(client, link, state);
      if (!result.ok) {
        console.log(`chain replay: ${result.reason}`);
        await client.query('ROLLBACK');
        return { ok: false };
      }
      state = result.state;
    }
    await client.query('COMMIT');
    return { ok: true, position: state.position };
  } catch (err) {
    console.log(`chain replay: ${err.message}`);
    await client.query('ROLLBACK');
    return { ok: false };
  } finally {
    client.release();
  }
}

/**
 * One link of a chunk, checked and written on `client` against `state`
 * ({ position, previousRecordHash, proposal }: the tail so far, and the
 * proposal whose payout links are due next, or null). Returns
 * { ok: true, state } with the state after this link, or
 * { ok: false, reason } with the reason naming the position.
 */
async function replayLink(client, link, state) {
  if (link.position !== state.position + 1) {
    return { ok: false, reason: `expected position ${state.position + 1}, got ${link.position}` };
  }
  const at = `position ${link.position}`;
  const transHash = decodeDigest(link.transHash);
  if (!transHash) return failed(at, 'transHash is not a SHA-256 digest');
  const recordHash = decodeDigest(link.recordHash);
  if (!recordHash) return failed(at, 'recordHash is not a SHA-256 digest');
  if (!isObject(link.ogTransaction) || !isObject(link.ogTransaction.payload)) {
    return failed(at, 'ogTransaction must be an object with an object payload');
  }
  const { ogTransaction } = link;
  const { payload } = ogTransaction;

  // 2. The trans hash over the payload.
  if (!canonicalHash(payload).equals(transHash)) return failed(at, 'transHash is not the hash of the canonical payload');

  // 3. The record hash over the previous link.
  const expectedRecordHash = sha256(
    state.previousRecordHash === null ? transHash : Buffer.concat([transHash, state.previousRecordHash]),
  );
  if (!expectedRecordHash.equals(recordHash)) return failed(at, 'recordHash does not chain on the previous link');

  // 4. and 5. The type, what its write puts in the row, its own checks.
  if (link.type !== payload.transactionType) {
    return failed(at, `type ${JSON.stringify(link.type)} is not the payload's transactionType`);
  }
  const typed = await checkByType(client, link, transHash, state.proposal);
  if (!typed.ok) return failed(at, typed.reason);
  const { expected, sideEffect, proposal } = typed;
  if (!sameId(link.transactionId, expected.transactionId)) return failed(at, "transactionId is not what the type's write puts there");
  if (!sameId(link.accountId, expected.accountId)) return failed(at, "accountId is not what the type's write puts there");
  if (!sameId(link.accountIdTo, expected.accountIdTo)) return failed(at, "accountIdTo is not what the type's write puts there");
  if (!/^(0|[1-9][0-9]*)$/.test(link.amount) || BigInt(link.amount) !== expected.amount) {
    return failed(at, "amount is not what the type's write puts there");
  }
  const createdAt = Date.parse(link.createdAt);
  if (Number.isNaN(createdAt)) return failed(at, 'createdAt is not a date');

  // 6. The side effect, then 7. the link itself at its position.
  if (sideEffect) await sideEffect();
  const position = await insertLink(client, {
    accountId: expected.accountId,
    accountIdTo: expected.accountIdTo,
    transactionId: expected.transactionId,
    amount: link.amount,
    transHash,
    recordHash,
    type: link.type,
    ogTransaction,
    createdAt: new Date(createdAt),
  });
  if (position !== link.position) return failed(at, `the identity column gave position ${position}`);

  return { ok: true, state: { position, previousRecordHash: recordHash, proposal } };
}

function failed(at, reason) {
  return { ok: false, reason: `${at}: ${reason}` };
}

/** True when `actual` (hex or null, from the wire) is `expected` (a Buffer or null). */
function sameId(actual, expected) {
  if (actual === null || expected === null) return actual === null && expected === null;
  const bytes = decodeDigest(actual);
  return bytes !== null && bytes.equals(expected);
}

/**
 * The checks of the link's type and what the type's write function puts in
 * the row. Returns { ok: true, expected: { accountId, accountIdTo,
 * transactionId, amount (BigInt) }, sideEffect (a function or null),
 * proposal (the proposal whose payouts are due next, or null) } or
 * { ok: false, reason }:
 *   accountCreation: checks 1 to 3 of verifyCreateAccount; the account row
 *     with the eight keys and the type;
 *   the six transfer types: the shape, the signatures under the type's
 *     rule against the sender's account as the own table has it by now, and
 *     the transactionId rule; a breakGlassTransfer moves the sender's
 *     stakes row to the receiver (stakes.queries.js moveStake), as its
 *     write does;
 *   transferToFund and fundProposal: the shape, signature and id parts of
 *     their verify functions; a transferToFund adds the stake;
 *   transferFromFund: no signatures; the link must follow a fundProposal
 *     link or a transferFromFund link of the same proposal (`proposal`), and
 *     its payload must equal the payout object for the next index; a payout
 *     with stakeFor takes the stake back.
 */
async function checkByType(client, link, transHash, proposal) {
  const { ogTransaction } = link;
  const { payload } = ogTransaction;
  const type = payload.transactionType;

  if (type === ACCOUNT_CREATION) {
    const checked = checkCreateAccountSignaturesAndIds(ogTransaction);
    if (!checked.ok) return checked;
    const keys = {};
    for (const { name, algorithm } of ACCOUNT_KEYS) {
      keys[name] = decodePublicKey(algorithm, payload.publicKeys[name]);
    }
    return {
      ok: true,
      expected: { accountId: checked.accountId, accountIdTo: null, transactionId: checked.transactionId, amount: 0n },
      sideEffect: () => insertAccount(client, {
        accountId: checked.accountId,
        publicKey1: keys.key1,
        publicKeyPq1: keys.postQuantumKey1,
        publicKey2: keys.key2,
        publicKeyPq2: keys.postQuantumKey2,
        altWalletPk: keys.walletKey,
        altWalletPkPq: keys.walletPostQuantumKey,
        breakGlassPk: keys.breakGlassKey,
        breakGlassPkPq: keys.breakGlassPostQuantumKey,
        type: payload.accountType,
      }),
      proposal: null,
    };
  }

  if (isTransferType(type)) {
    const checked = await checkTransferSignaturesAndIds(ogTransaction, { client });
    if (!checked.ok) return checked;
    const { accountId, accountIdTo, transactionId, amount } = checked;
    const sideEffect = payload.transactionType === BREAK_GLASS_TRANSFER ? () => moveStake(client, accountId, accountIdTo) : null;
    return { ok: true, expected: { accountId, accountIdTo, transactionId, amount }, sideEffect, proposal: null };
  }

  if (type === TRANSFER_TO_FUND) {
    const checked = await checkTransferToFundSignaturesAndIds(ogTransaction, { client });
    if (!checked.ok) return checked;
    const { accountId, accountIdTo, transactionId, amount } = checked;
    return {
      ok: true,
      expected: { accountId, accountIdTo, transactionId, amount },
      sideEffect: () => addStake(client, accountId, payload.stakeFor, payload.amount),
      proposal: null,
    };
  }

  if (type === FUND_PROPOSAL) {
    const checked = await checkFundProposalSignaturesAndIds(ogTransaction, { client });
    if (!checked.ok) return checked;
    return {
      ok: true,
      expected: { accountId: FUND_ACCOUNT_ID, accountIdTo: null, transactionId: checked.transactionId, amount: 0n },
      sideEffect: null,
      proposal: { payload, nextIndex: 0 },
    };
  }

  if (type === TRANSFER_FROM_FUND) {
    if (proposal === null) return { ok: false, reason: 'a transferFromFund link that does not follow its proposal' };
    const { payload: proposalPayload, nextIndex } = proposal;
    const payout = proposalPayload.payouts[nextIndex];
    const object = payoutObject(proposalPayload.transactionId, nextIndex, payout);
    if (canonicalize(payload) !== canonicalize(object)) {
      return { ok: false, reason: `the payload is not payout ${nextIndex} of proposal ${proposalPayload.transactionId}` };
    }
    const recipient = decodeDigest(payout.accountIdTo);
    const following = nextIndex + 1 < proposalPayload.payouts.length
      ? { payload: proposalPayload, nextIndex: nextIndex + 1 }
      : null;
    return {
      ok: true,
      expected: { accountId: FUND_ACCOUNT_ID, accountIdTo: recipient, transactionId: transHash, amount: BigInt(payout.amount) },
      sideEffect: payout.stakeFor === undefined ? null : () => subtractStake(client, recipient, payout.stakeFor, payout.amount),
      proposal: following,
    };
  }

  return { ok: false, reason: `${JSON.stringify(type)} is not a link type this validator knows` };
}

/**
 * The proposal whose payout links are due right after `tail` (the own
 * tail as findTailLink returns it, or null): { payload, nextIndex } when
 * the tail is a fundProposal link, or a transferFromFund link of a proposal
 * with payouts still to come (its proposal found by id); null otherwise.
 */
async function openProposal(client, tail) {
  if (tail === null) return null;
  if (tail.type === FUND_PROPOSAL) return { payload: tail.ogTransaction.payload, nextIndex: 0 };
  if (tail.type !== TRANSFER_FROM_FUND) return null;
  const { proposalId, index } = tail.ogTransaction.payload;
  const proposalPayload = await findLinkPayload(client, decodeDigest(proposalId));
  if (proposalPayload === null) return null;
  const nextIndex = index + 1;
  return nextIndex < proposalPayload.payouts.length ? { payload: proposalPayload, nextIndex } : null;
}

/** Waits VALIDATOR_CALL_TIMEOUT_SECONDS, the pause between two sweeps. */
function wait() {
  return new Promise((resolve) => setTimeout(resolve, env.network.callTimeoutSeconds * 1000));
}

/** The own tail as { position, recordHash (hex) }, position 0 and no hash on an empty chain. */
export async function ownTail() {
  return (await findTailRow()) ?? { position: 0, recordHash: null };
}

/**
 * Makes `ids` the ignored rows of the own table, every other active row
 * counted, when the table says otherwise: the network's view, from
 * `source` (the sweep's majority, or the leader at a join). One line when
 * something changed.
 */
export async function adoptIgnoredList(ids, source) {
  const wanted = [...new Set(ids)].sort((a, b) => a - b);
  const current = await findIgnoredIds();
  if (current.length === wanted.length && current.every((id, i) => id === wanted[i])) return;
  await setIgnoredList(wanted);
  console.log(`ignored validators adopted from ${source}: ${wanted.length === 0 ? 'none' : wanted.join(', ')}`);
}

/**
 * One health sweep: GET /health on every active row but this validator
 * (validators.client.js getHealth), the answers that carry `chain` kept
 * and grouped by tail, (position, recordHash). The largest group must hold
 * more than half of the kept answers. Resolves with { majority: true,
 * tail: { position, recordHash }, leader, ignored, sources, answered,
 * asked, agreeing }: the group's tail, the leader most of the group names
 * (a tie goes to the lower id; null when most name none), the ignored
 * list most of the group's counted members on this validator's registry
 * name (null when there is none: a member on another registry cannot know
 * a row it lacks), the group's validators lowest id first, and the counts;
 * or { majority: false, answered, asked }.
 */
export async function sweepHealth() {
  const peers = await findMemberPeers(env.validator.id);
  const answers = await Promise.all(peers.map(async (peer) => ({ peer, answer: await getHealth(peer) })));
  const ownRegistry = appliedRegistry()?.hash;

  const kept = [];
  for (const { peer, answer } of answers) {
    if (answer.noAnswer || !isObject(answer.body) || !isObject(answer.body.chain)) continue;
    const { body } = answer;
    const { position, recordHash } = body.chain;
    if (!Number.isInteger(position) || typeof recordHash !== 'string') continue;
    const sameRegistry = isObject(body.registry) && body.registry.hash === ownRegistry;
    const ignored = body.counted === true && sameRegistry && Array.isArray(body.ignored) ? body.ignored : null;
    kept.push({ peer, position, recordHash, leader: body.leader, ignored });
  }

  const groups = new Map();
  for (const entry of kept) {
    const key = `${entry.position}:${entry.recordHash}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  let largest = [];
  for (const group of groups.values()) {
    if (group.length > largest.length) largest = group;
  }
  if (largest.length === 0 || largest.length * 2 <= kept.length) {
    return { majority: false, answered: kept.length, asked: peers.length };
  }
  return {
    majority: true,
    tail: { position: largest[0].position, recordHash: largest[0].recordHash },
    leader: mostNamed(largest.map(({ leader }) => leader)),
    ignored: mostNamedList(largest.filter(({ ignored }) => ignored !== null).map(({ ignored }) => ignored)),
    sources: largest.map(({ peer }) => peer).sort((a, b) => a.id - b.id),
    answered: kept.length,
    asked: peers.length,
    agreeing: largest.length,
  };
}

/** The value most of `values` name: the id with the most mentions, the lower id on a tie, null when most name no id. */
function mostNamed(values) {
  const counts = new Map();
  for (const value of values) {
    const key = Number.isInteger(value) ? value : null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    const wins = count > bestCount || (count === bestCount && value !== null && (best === null || value < best));
    if (wins) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** The list most of `lists` name (each a list of ids), the first on a tie, or null for none. */
function mostNamedList(lists) {
  const counts = new Map();
  for (const list of lists) {
    const key = JSON.stringify([...new Set(list)].sort((a, b) => a - b));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best === null ? null : JSON.parse(best);
}

/**
 * The catch-up pass: brings the own chain to the network's tail.
 *   1. The health sweep (sweepHealth); no majority: wait
 *      VALIDATOR_CALL_TIMEOUT_SECONDS and sweep again. The majority's tail
 *      is the network's, P and H, and its ignored list is adopted.
 *   2. Own position above P: `own chain is ahead of the network`, stop.
 *      Own position P and hash H: caught up. Own position P and another
 *      hash: `own chain differs from the network at position P; wipe the
 *      database and start again`, stop. Otherwise chunks from the first
 *      source (afterPosition the own position, limit the smaller of
 *      CHAIN_CHUNK_LINKS and what is missing), replayed, until the own
 *      position is P; a source that gives no answer, an empty chunk or a
 *      failed chunk moves to the next source, and with none left step 1
 *      again after the wait. At P the hashes are compared as above, then
 *      step 1 again, since the tail may have moved, until caught up.
 * Resolves with { caughtUp: true, tail, leader, sources, ... } (the
 * sweep's fields) or { caughtUp: false, ... } when the pass stopped.
 */
export async function catchUp() {
  for (;;) {
    const sweep = await sweepHealth();
    if (!sweep.majority) {
      console.log(`no majority tail: ${sweep.answered} of ${sweep.asked} health answers carry a chain tail`);
      await wait();
      continue;
    }
    const { tail, sources } = sweep;
    console.log(`network tail: position ${tail.position}, ${sweep.agreeing} of ${sweep.answered} agree, leader ${sweep.leader}`);
    if (sweep.ignored !== null) await adoptIgnoredList(sweep.ignored, 'the network');

    let own = await ownTail();
    if (own.position > tail.position) {
      console.log('own chain is ahead of the network');
      return { caughtUp: false, ...sweep };
    }
    if (own.position === tail.position) {
      if (own.recordHash === tail.recordHash) return { caughtUp: true, ...sweep };
      console.log(`own chain differs from the network at position ${tail.position}; wipe the database and start again`);
      return { caughtUp: false, ...sweep };
    }

    own = await fetchChainFrom(sources, tail);
    if (own.position < tail.position) {
      await wait();
      continue;
    }
    if (own.recordHash !== tail.recordHash) {
      console.log(`own chain differs from the network at position ${tail.position}; wipe the database and start again`);
      return { caughtUp: false, ...sweep };
    }
    // Step 1 again: the tail may have moved while the chunks came in.
  }
}

/**
 * Chunks from `sources` (registry rows) in turn, replayed, until the own
 * position reaches `tail.position` or every source failed. The join
 * handshake uses it with the leader as the one source. Returns the own
 * tail afterwards.
 */
export async function fetchChainFrom(sources, tail) {
  let own = await ownTail();
  for (const source of sources) {
    while (own.position < tail.position) {
      const limit = Math.min(env.network.chainChunkLinks, tail.position - own.position);
      const answer = await sendChainLinks(source, { afterPosition: own.position, limit });
      if (answer.reason) {
        console.log(`validator ${source.id} sent no chain links: ${answer.reason}`);
        break;
      }
      if (answer.links.length === 0) {
        console.log(`validator ${source.id} has no links after position ${own.position}`);
        break;
      }
      const replayed = await replayLinks(answer.links);
      if (!replayed.ok) break;
      own = await ownTail();
      console.log(`replayed ${answer.links.length} links from validator ${source.id}, now at position ${own.position}`);
    }
    if (own.position >= tail.position) break;
  }
  return own;
}
