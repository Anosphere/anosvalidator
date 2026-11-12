import { env } from '../config/env.js';
import { decodeDigest, digestMatches } from '../crypto/hash.js';
import { pool } from '../db/pool.js';
import { setLeaderOn } from '../validators/registry.queries.js';
import {
  findActiveValidator,
  findCountedPeers,
  findCountedValidators,
  findCounts,
  findIgnoredIds,
  findLeaderId,
  findNextCounted,
  setIgnored,
} from '../validators/validators.queries.js';
import { findCountedSender, releaseBusy, runLeader, takeBusy } from '../validators/validators.service.js';
import { verifyPayloadSignature } from '../validators/validators.signing.js';
import {
  IGNORE,
  INCLUDE,
  NO,
  YES,
  buildIgnoreVoteAccepted,
  buildIgnoreVoteRequest,
  buildIgnoreVoted,
  buildProofOfIgnoreVote,
  checkIgnoreVoteShape,
  checkIgnoreVotedReceipt,
  checkIgnoreVotedShape,
  checkNoAnswerReportShape,
  checkProofOfIgnoreVoteShape,
  checkReachable,
  sendIgnoreVote,
  sendProofOfIgnoreVote,
  voteIdOf,
} from './votes.messages.js';
import { findIgnoreVote, insertIgnoreVote } from './votes.queries.js';

/**
 * The votes (docs/schemas.md section 19): one rule stays for everything,
 * every counted validator answers or the network stops, and a validator
 * leaves the counted set only by a vote. The leader (or the next counted
 * validator in the ring, when the leader itself is named) starts an ignore
 * vote naming the validators that gave no answer, or that refused and fail
 * the health check; every other counted validator checks each named
 * validator's health itself and votes; with every vote yes, a proof
 * carrying every receipt goes round and the named are ignored everywhere.
 * An include vote is the same in the other direction, started by the
 * leader for a joiner (validators/join.service.js).
 *
 * This file is the receiving side of the three messages (the voter, the
 * proof's receiver, the report's receiver), the starter's side (runVote)
 * and the report queue. The messages themselves are votes.messages.js.
 */

/** The report queue: lists of ids reported while a round, a vote or a join held the busy flag. */
const queue = [];

/**
 * Handles a vote request from the starter. The checks of checkRequest,
 * then this validator's own check of each named validator (checkReachable).
 * The vote is yes for ignore when no named validator is reachable, yes for
 * include when every one is, no otherwise. Returns { ok: true, vote,
 * results, receipt } with the signed vote, or { ok: false, reason }.
 */
export async function receiveIgnoreVote(body) {
  const checked = await checkRequest(body);
  if (!checked.ok) return checked;
  const { payload, named } = checked;

  const checks = await Promise.all(named.map((row) => checkReachable(row)));
  const results = {};
  let reachable = 0;
  for (const [i, row] of named.entries()) {
    results[row.id] = checks[i].reachable ? 'ok' : checks[i].reason;
    if (checks[i].reachable) reachable += 1;
  }
  const vote = payload.action === IGNORE ? (reachable === 0 ? YES : NO) : (reachable === named.length ? YES : NO);
  return {
    ok: true,
    vote,
    results,
    receipt: buildIgnoreVoted({ voteId: payload.voteId, vote, results, validatorTo: payload.startedBy }),
  };
}

/**
 * The checks every vote request gets, on the voter and, through the proof,
 * on every validator that applies it (every check but the health check),
 * in order: the shape; startedBy is a counted validator whose key verifies
 * the signature; voteId is the hash of the payload without it; the starter
 * rule: startedBy is the leader per this validator's own table, or, when
 * the action is ignore and the named hold this validator's leader, the next
 * counted validator after the leader; every named id is an active row, not
 * startedBy, not this validator (except this validator named in an include
 * vote whose proof it applies); for ignore none is ignored already, for
 * include every one is ignored (this validator's own row excepted, as
 * above); for ignore the floor: the counted rows minus the named, times
 * 100, at least IGNORE_FLOOR_PERCENT times the active rows, else
 * `below the floor`. Returns { ok: true, payload, named } with the named
 * rows, or { ok: false, reason }.
 */
async function checkRequest(request, { receiverNamed = false } = {}) {
  const problem = checkIgnoreVoteShape(request);
  if (problem) return { ok: false, reason: problem };
  const { payload, signature } = request;

  const starter = await findCountedSender(payload.startedBy, 'startedBy');
  if (starter.reason) return { ok: false, reason: starter.reason };
  const badSignature = verifyPayloadSignature(payload, signature, starter.validator);
  if (badSignature) return { ok: false, reason: badSignature };

  if (!digestMatches(payload.voteId, voteIdOf(payload))) {
    return { ok: false, reason: 'payload.voteId is not the hash of the payload without it' };
  }

  // The starter rule.
  const leaderId = await findLeaderId();
  const namesLeader = leaderId !== null && payload.validatorIds.includes(leaderId);
  if (payload.action === IGNORE && namesLeader) {
    const next = await findNextCounted(leaderId);
    if (payload.startedBy !== next) {
      return { ok: false, reason: `startedBy ${payload.startedBy} is not the next validator after the leader` };
    }
  } else if (payload.startedBy !== leaderId) {
    return { ok: false, reason: `startedBy ${payload.startedBy} is not the leader` };
  }

  // The named.
  const own = env.validator.id;
  const named = [];
  for (const id of payload.validatorIds) {
    if (id === payload.startedBy) return { ok: false, reason: `validatorIds names the starter, validator ${id}` };
    const self = id === own;
    if (self && !(receiverNamed && payload.action === INCLUDE)) {
      return { ok: false, reason: 'validatorIds names this validator' };
    }
    const row = await findActiveValidator(id);
    if (!row) return { ok: false, reason: `validator ${id} is not an active validator` };
    if (payload.action === IGNORE && row.ignored) return { ok: false, reason: `validator ${id} is ignored already` };
    if (payload.action === INCLUDE && !row.ignored && !self) return { ok: false, reason: `validator ${id} is not ignored` };
    named.push(row);
  }

  // The floor.
  if (payload.action === IGNORE && !(await aboveFloor(named.length))) {
    return { ok: false, reason: 'below the floor' };
  }
  return { ok: true, payload, named };
}

/** The floor rule: after ignoring `count` more validators the counted rows are still at least IGNORE_FLOOR_PERCENT of the active rows. */
async function aboveFloor(count) {
  const { active, counted } = await findCounts();
  return (counted - count) * 100 >= env.network.ignoreFloorPercent * active;
}

/**
 * Handles the proof of a passed vote. Checks, in order: the shape; a
 * voteId already stored answers the accepted receipt again, applying
 * nothing; startedBy is a counted validator whose key verifies the
 * signature; the request inside is this vote's, started by startedBy, and
 * passes every check of checkRequest but the health check (this validator
 * named in an include vote is allowed, since that is the one proof a
 * validator that is not counted accepts); every receipt is a vote from a
 * counted validator other than startedBy and the named, genuinely signed,
 * for this voteId, yes, addressed to startedBy, no validator twice; no
 * counted validator is missing (counted, minus startedBy, minus the named).
 * Then applyProof. Returns { ok: true, applied, receipt } or
 * { ok: false, reason }.
 */
export async function receiveProofOfIgnoreVote(body) {
  const problem = checkProofOfIgnoreVoteShape(body);
  if (problem) return { ok: false, reason: problem };
  const { payload, signature } = body;
  const voteId = decodeDigest(payload.voteId);
  if (!voteId) return { ok: false, reason: 'payload.voteId is not a SHA-256 digest' };

  const accepted = () => buildIgnoreVoteAccepted({ voteId: payload.voteId, validatorTo: payload.startedBy });
  if (await findIgnoreVote(voteId)) return { ok: true, applied: false, receipt: accepted() };

  const starter = await findCountedSender(payload.startedBy, 'startedBy');
  if (starter.reason) return { ok: false, reason: starter.reason };
  const badSignature = verifyPayloadSignature(payload, signature, starter.validator);
  if (badSignature) return { ok: false, reason: badSignature };

  // The request inside.
  const { request } = payload;
  if (request.payload.voteId !== payload.voteId) return { ok: false, reason: 'payload.request is not the request of this vote' };
  if (request.payload.startedBy !== payload.startedBy) return { ok: false, reason: 'payload.request was not started by startedBy' };
  const own = env.validator.id;
  const receiverNamed = request.payload.action === INCLUDE && request.payload.validatorIds.includes(own);
  const checked = await checkRequest(request, { receiverNamed });
  if (!checked.ok) return { ok: false, reason: `request: ${checked.reason}` };
  const namedIds = new Set(checked.named.map((row) => row.id));

  // Every receipt, and who it is from.
  const validators = await findCountedValidators();
  const seen = new Set();
  for (const [i, receipt] of payload.receipts.entries()) {
    const shape = checkIgnoreVotedShape(receipt);
    if (shape) return { ok: false, reason: `receipts[${i}]: ${shape}` };
    const from = validators.get(receipt.payload.validatorFrom);
    if (!from) {
      return { ok: false, reason: `receipts[${i}]: validatorFrom ${receipt.payload.validatorFrom} is not a counted validator` };
    }
    if (from.id === payload.startedBy) return { ok: false, reason: `receipts[${i}]: a receipt from the starter itself` };
    if (namedIds.has(from.id)) return { ok: false, reason: `receipts[${i}]: a receipt from a named validator` };
    if (seen.has(from.id)) return { ok: false, reason: `receipts[${i}]: a second receipt from validator ${from.id}` };
    const bad = checkIgnoreVotedReceipt(receipt, { from, to: payload.startedBy, voteId });
    if (bad) return { ok: false, reason: `receipts[${i}]: ${bad}` };
    if (receipt.payload.vote !== YES) return { ok: false, reason: `receipts[${i}]: validator ${from.id} voted no` };
    seen.add(from.id);
  }

  // Nobody missing.
  const missing = [...validators.keys()].filter((id) => id !== payload.startedBy && !namedIds.has(id) && !seen.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: `no receipt from validator${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  }

  await applyProof(request, payload.receipts);
  return { ok: true, applied: true, receipt: accepted() };
}

/**
 * Applies a passed vote to this validator's own table, in one database
 * transaction: for ignore, the named rows get `ignored` and, when they hold
 * this validator's leader, the starter becomes the leader; for include, the
 * named rows lose `ignored` and the starter becomes the leader (the starter
 * of an include vote is the leader). The vote's row is stored with outcome
 * passed and the record { request, receipts }.
 */
async function applyProof(request, receipts) {
  const { action, validatorIds, startedBy } = request.payload;
  const leaderId = await findLeaderId();
  const movesLeader = action === INCLUDE || (leaderId !== null && validatorIds.includes(leaderId));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setIgnored(client, validatorIds, action === IGNORE);
    if (movesLeader) await setLeaderOn(client, startedBy);
    await insertIgnoreVote({
      voteId: decodeDigest(request.payload.voteId),
      action,
      validatorIds,
      startedBy,
      outcome: 'passed',
      record: { request, receipts },
    }, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const ids = validatorIds.join(', ');
  console.log(`${action} vote ${shortId(request.payload.voteId)} applied: validator${plural(validatorIds)} ${ids} ${action === IGNORE ? 'ignored' : 'counted'}${movesLeader ? `; validator ${startedBy} is the leader` : ''}`);
}

/**
 * Runs one vote as its starter: `validatorIds` the named validators,
 * `action` ignore or include. For an ignore vote, this validator's own
 * check of each id comes first: an id ignored already, not an active row,
 * or reachable (checkReachable) is dropped with a line (`validator N
 * answers; no vote`), an empty list is nothing, and the floor is checked
 * before anything is sent. Then the request goes to every counted
 * validator except this one and the named; the vote passed when every one
 * answered yes. Otherwise it failed: the row is stored with outcome failed
 * and the receipts got, each result logged. A voter that gave no answer to
 * an ignore vote, or refused it, fails it, and one new vote names that
 * voter as well (one that passes this validator's own check is dropped from
 * it again, as above); a second time ends it with a line. A passed vote is
 * applied to the own table first (applyProof), then the proof goes to every
 * counted validator except this one, the named of an include vote now among
 * them. Resolves with { passed: true } or { passed: false, reason }.
 */
export async function runVote(validatorIds, action, { retried = false } = {}) {
  let ids = [...new Set(validatorIds)].sort((a, b) => a - b);
  if (action === IGNORE) {
    const ignored = await findIgnoredIds();
    const kept = [];
    for (const id of ids) {
      if (ignored.includes(id)) {
        console.log(`validator ${id} is ignored already; no vote`);
        continue;
      }
      const row = await findActiveValidator(id);
      if (!row) {
        console.log(`validator ${id} is not an active validator; no vote`);
        continue;
      }
      const check = await checkReachable(row);
      if (check.reachable) {
        console.log(`validator ${id} answers; no vote`);
        continue;
      }
      kept.push(id);
    }
    ids = kept;
    if (ids.length === 0) return { passed: false, reason: 'nothing to vote on' };
    if (!(await aboveFloor(ids.length))) {
      const { active, counted } = await findCounts();
      console.log(`no ignore vote naming validator${plural(ids)} ${ids.join(', ')}: below the floor (${counted} counted of ${active} active)`);
      return { passed: false, reason: 'below the floor' };
    }
  }

  const request = buildIgnoreVoteRequest({ action, validatorIds: ids });
  const short = shortId(request.payload.voteId);
  const voters = (await findCountedPeers(env.validator.id)).filter((peer) => !ids.includes(peer.id));
  console.log(`${action} vote ${short} naming validator${plural(ids)} ${ids.join(', ')}: ${voters.length} voter${plural(voters)}`);
  const answers = await sendIgnoreVote(request, voters);

  const receipts = [];
  const silent = [];
  const refusing = [];
  let failure = null;
  for (const answer of answers) {
    if (answer.reason) {
      console.log(`validator ${answer.id} ${answer.noAnswer ? 'gave no answer to the vote' : 'refused the vote'}: ${answer.reason}`);
      (answer.noAnswer ? silent : refusing).push(answer.id);
      failure ??= `validator ${answer.id}: ${answer.reason}`;
      continue;
    }
    const results = Object.entries(answer.results).map(([id, result]) => `${id}: ${result}`).join('; ');
    console.log(`validator ${answer.id} voted ${answer.vote} (${results})`);
    if (answer.vote !== YES) failure ??= `validator ${answer.id} voted no (${results})`;
    receipts.push(answer.receipt);
  }

  if (failure !== null) {
    await insertIgnoreVote({
      voteId: decodeDigest(request.payload.voteId),
      action,
      validatorIds: ids,
      startedBy: env.validator.id,
      outcome: 'failed',
      record: { request, receipts },
    });
    console.log(`${action} vote ${short} failed: ${failure}`);
    const added = [...silent, ...refusing].sort((a, b) => a - b);
    if (action === IGNORE && added.length > 0) {
      if (retried) {
        console.log(`no vote twice from validator${plural(added)} ${added.join(', ')}; no further vote`);
      } else {
        console.log(`one new vote naming validator${plural(added)} ${added.join(', ')} as well`);
        return runVote([...ids, ...added], IGNORE, { retried: true });
      }
    }
    return { passed: false, reason: failure };
  }

  // Passed: the own table first, then everyone.
  await applyProof(request, receipts);
  const proof = buildProofOfIgnoreVote({ voteId: request.payload.voteId, request, receipts });
  const targets = await findCountedPeers(env.validator.id);
  const accepted = await sendProofOfIgnoreVote(proof, targets);
  for (const answer of accepted) {
    console.log(answer.accepted ? `validator ${answer.id} accepted the proof` : `validator ${answer.id} did not accept the proof: ${answer.reason}`);
  }
  console.log(`${action} vote ${short} passed`);
  return { passed: true };
}

/**
 * Handles a no-answer report: the shape; `reporter` is a counted validator
 * whose key verifies the signature; every id is an active row. Returns
 * { ok: true, validatorIds, reporter } (the handler answers 200 {} and then
 * calls handleReport) or { ok: false, reason }.
 */
export async function receiveNoAnswerReport(body) {
  const problem = checkNoAnswerReportShape(body);
  if (problem) return { ok: false, reason: problem };
  const { payload, signature } = body;

  const reporter = await findCountedSender(payload.reporter, 'reporter');
  if (reporter.reason) return { ok: false, reason: reporter.reason };
  const badSignature = verifyPayloadSignature(payload, signature, reporter.validator);
  if (badSignature) return { ok: false, reason: badSignature };
  for (const id of payload.validatorIds) {
    if (!(await findActiveValidator(id))) return { ok: false, reason: `validator ${id} is not an active validator` };
  }
  return { ok: true, validatorIds: payload.validatorIds, reporter: payload.reporter };
}

/**
 * What the receiver of a report does after answering: if it may start a
 * vote (it is the leader, or the ids hold its leader and it is the next
 * counted validator in the ring), startVote; otherwise a line and nothing.
 */
export async function handleReport(validatorIds, reporter) {
  const own = env.validator.id;
  const leaderId = await findLeaderId();
  const may = leaderId === own
    || (leaderId !== null && validatorIds.includes(leaderId) && (await findNextCounted(leaderId)) === own);
  const ids = validatorIds.join(', ');
  if (!may) {
    console.log(`report from validator ${reporter} naming validator${plural(validatorIds)} ${ids}: not for this validator (the leader is ${leaderId})`);
    return;
  }
  console.log(`report from validator ${reporter} naming validator${plural(validatorIds)} ${ids}`);
  await startVote(validatorIds);
}

/**
 * Starts an ignore vote in a busy section of its own (validators.service.js
 * takeBusy): when a round, a vote or a join holds the flag, the ids go
 * into the report queue instead, drained when that section ends. After the
 * vote the queue is drained and runLeader called, as at the end of every
 * busy section.
 */
export async function startVote(validatorIds) {
  if (!takeBusy()) {
    queue.push(validatorIds);
    console.log(`report naming validator${plural(validatorIds)} ${validatorIds.join(', ')} queued: busy`);
    return;
  }
  try {
    await runVote(validatorIds, IGNORE);
  } finally {
    releaseBusy();
  }
  await drainReports();
  await runLeader();
}

/** Runs the queued reports, one vote each, until the queue is empty. Called by whoever ends a busy section. */
export async function drainReports() {
  while (queue.length > 0) {
    await startVote(queue.shift());
  }
}

function shortId(voteId) {
  return voteId.slice(0, 8);
}

function plural(items) {
  return items.length > 1 ? 's' : '';
}
