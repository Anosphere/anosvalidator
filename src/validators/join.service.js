import { env } from '../config/env.js';
import { decodeDigest } from '../crypto/hash.js';
import { adoptIgnoredList, catchUp, fetchChainFrom, ownTail, sweepHealth } from '../garlic-chain/replay.service.js';
import { HELD_ROW_TABLES, readHeldRows, storeHeldRows } from '../held-transactions/held-rows.service.js';
import { isObject } from '../util/is-object.js';
import { IGNORE, INCLUDE } from '../votes/votes.messages.js';
import { drainReports, runVote } from '../votes/votes.service.js';
import { appliedRegistry } from './registry.service.js';
import { getHealth, postToValidators } from './validators.client.js';
import { findActiveValidator, findIsLeader, findLeaderId, setLeader } from './validators.queries.js';
import { releaseBusy, runLeader, takeBusy } from './validators.service.js';
import { signPayload, verifyPayloadSignature } from './validators.signing.js';

/**
 * Joining a running network (docs/schemas.md section 19), both sides.
 *
 * The joiner: every boot asks to join (startJoinLoop, from server.js after
 * listen), serving in the meantime. The loop: the health sweep of the
 * catch-up pass, until a majority agrees on a tail; the own table takes
 * the majority's leader and its ignored list; a validator that is that
 * leader is counted at once; any other runs the catch-up pass to the
 * majority tail, then join requests to the leader until it is counted, or
 * included, after which it pulls the held rows, says ready and is counted.
 *
 * The leader: a join request from a validator it does not count opens a
 * hold (the busy flag of validators.service.js, so no round or vote runs
 * meanwhile): the joiner catches up to the leader's tail from the leader
 * alone, the leader runs the include vote, the joiner pulls the holding
 * tables a page at a time and says ready, and the hold ends. A hold also
 * ends when the vote fails, or after JOIN_HOLD_SECONDS.
 *
 * `counted` is the in-memory flag every boot starts false: while it is
 * false the app answers 503 "not counted yet" to every POST but the proof
 * of an include vote naming this validator and the chain chunk read
 * (app.js), and GET /health answers it as `counted`. A counted validator
 * whose peers refuse it as ignored clears the flag and joins again
 * (noticeIgnoredAnswers).
 */

/** payload.type of the six join messages. */
export const JOIN_REQUEST = 'joinRequest';
export const JOIN_ANSWER = 'joinAnswer';
export const HELD_ROWS = 'heldRows';
export const HELD_ROWS_LIST = 'heldRowsList';
export const READY = 'ready';
export const READY_ACCEPTED = 'readyAccepted';

/** The states a join answer carries. */
export const COUNTED = 'counted';
export const BEHIND = 'behind';
export const BUSY = 'busy';
export const CATCH_UP = 'catchUp';
export const VOTING = 'voting';
export const INCLUDED = 'included';
export const REFUSED = 'refused';
const STATES = Object.freeze([COUNTED, BEHIND, BUSY, CATCH_UP, VOTING, INCLUDED, REFUSED]);

/** Whether this validator counts itself: false at boot. */
let counted = false;

/** The in-memory flag, as /health answers it and app.js reads it. */
export function isCounted() {
  return counted;
}

/** Sets the flag: true once the join loop finds this validator counted, false when its peers refuse it as ignored. */
export function setCounted(flag) {
  counted = flag;
}

/**
 * What every send watches for (validators.messages.js postToPeers): more
 * than half of the peers answering 400 `validator <own> is ignored` means
 * the network does not count this validator any more. It stops counting
 * itself and runs the join loop again from its first step.
 */
export function noticeIgnoredAnswers(answers) {
  if (!counted || answers.length === 0) return;
  const refused = answers.filter((answer) => !answer.noAnswer && answer.status === 400 && saysIgnored(answer.body)).length;
  if (refused * 2 <= answers.length) return;
  console.log(`${refused} of ${answers.length} peers answer that this validator is ignored; joining again`);
  setCounted(false);
  startJoinLoop();
}

function saysIgnored(body) {
  try {
    return JSON.parse(body).error === `validator ${env.validator.id} is ignored`;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The leader's side.
// ---------------------------------------------------------------------------

/** The join this leader holds rounds for: null, or { id, since, vote: null | { result }, timer }. */
let joining = null;

function refuse(reason) {
  return { ok: false, status: 400, body: { error: reason } };
}

async function notTheLeader() {
  return { ok: false, status: 400, body: { error: 'not the leader', leader: await findLeaderId() } };
}

/** The sender of a join message: an active row, ignored or not, whose key verifies the signature. { validator } or { reason }. */
async function checkSender({ payload, signature }) {
  const validator = await findActiveValidator(payload.validator);
  if (!validator) return { reason: `validator ${payload.validator} is not an active validator` };
  const badSignature = verifyPayloadSignature(payload, signature, validator);
  if (badSignature) return { reason: badSignature };
  return { validator };
}

/**
 * Handles a join request. This validator must be the leader per its own
 * table, else 400 { error: "not the leader", leader } so the joiner
 * switches; the sender an active row, ignored or not, whose key verifies.
 * Then the state (docs/schemas.md 19.3): the joiner this validator holds
 * rounds for is answered `catchUp` while its tail differs, `voting` once
 * the include vote naming it has started, `included` when the vote passed
 * (it is counted here from then on, but the hold ends with its ready),
 * `refused` with the reason when it failed, which ends the hold; any
 * other sender this validator counts is `counted` when its tail is this
 * validator's and `behind` otherwise; any other sender it does not count
 * opens the hold when no round, vote or join is on, else gets `busy`.
 * Returns { ok: true, state, receipt } with the signed answer, or
 * { ok: false, status, body }.
 *
 *   payload: {
 *     type:           'joinAnswer'
 *     state:          counted | behind | busy | catchUp | voting | included | refused
 *     reason:         with refused
 *     leader:         this validator's id
 *     tailPosition:   this validator's tail
 *     tailRecordHash: hex
 *     validatorFrom, validatorTo, sentAt
 *   }
 *   signature: { key }
 */
export async function receiveJoinRequest(body) {
  const problem = checkJoinRequestShape(body);
  if (problem) return refuse(problem);
  if (!(await findIsLeader(env.validator.id))) return notTheLeader();
  const sender = await checkSender(body);
  if (sender.reason) return refuse(sender.reason);

  const { payload } = body;
  const { id } = sender.validator;
  const tail = await ownTail();
  const sameTail = payload.tailPosition === tail.position && payload.tailRecordHash === tail.recordHash;
  const answer = (state, reason) => ({ ok: true, state, receipt: buildJoinAnswer({ state, reason, tail, validatorTo: id }) });

  // The joiner this validator holds rounds for gets the hold's states, even
  // once the include vote has made it counted here: the hold ends with
  // ready, not with the count.
  if (joining === null || joining.id !== id) {
    if (!sender.validator.ignored) return answer(sameTail ? COUNTED : BEHIND);
    if (joining !== null || !takeBusy()) return answer(BUSY);
    const hold = { id, since: Date.now(), vote: null, timer: null };
    hold.timer = setTimeout(() => {
      holdTimedOut(hold).catch((err) => console.log(err));
    }, env.network.joinHoldSeconds * 1000);
    joining = hold;
    console.log(`join of validator ${id} started; rounds held`);
  }

  if (!sameTail) return answer(CATCH_UP);
  if (joining.vote === null) {
    const hold = joining;
    hold.vote = { result: null };
    runVote([id], INCLUDE)
      .then((result) => {
        hold.vote.result = result;
      })
      .catch((err) => {
        hold.vote.result = { passed: false, reason: err.message };
      });
    return answer(VOTING);
  }
  if (joining.vote.result === null) return answer(VOTING);
  if (joining.vote.result.passed) return answer(INCLUDED);

  const { reason } = joining.vote.result;
  endHold(`join of validator ${id} refused: ${reason}; rounds released`);
  return answer(REFUSED, reason);
}

function buildJoinAnswer({ state, reason, tail, validatorTo }) {
  const payload = {
    type: JOIN_ANSWER,
    state,
    ...(reason !== undefined && { reason }),
    leader: env.validator.id,
    tailPosition: tail.position,
    tailRecordHash: tail.recordHash,
    validatorFrom: env.validator.id,
    validatorTo,
    sentAt: new Date().toISOString(),
  };
  return { payload, signature: signPayload(payload) };
}

/**
 * Handles a held rows request from the joiner this validator holds rounds
 * for: this validator must be the leader, the sender the joiner, `limit`
 * at most HELD_ROWS_PAGE; answers a page of the table
 * (held-rows.service.js readHeldRows). Returns { ok: true, count, receipt }
 * or { ok: false, status, body }.
 *
 *   payload: {
 *     type:          'heldRowsList'
 *     validatorFrom: this validator's id
 *     validatorTo:   the joiner's id
 *     table
 *     rows:          [ ... ]   the table's rows above afterTransactionId, at most limit
 *     sentAt
 *   }
 *   signature: { key }
 */
export async function receiveHeldRows(body) {
  const problem = checkHeldRowsShape(body);
  if (problem) return refuse(problem);
  if (!(await findIsLeader(env.validator.id))) return notTheLeader();
  const sender = await checkSender(body);
  if (sender.reason) return refuse(sender.reason);

  const { payload } = body;
  if (joining === null || joining.id !== payload.validator) {
    return refuse(`no join in progress for validator ${payload.validator}`);
  }
  if (payload.limit > env.network.heldRowsPage) return refuse(`payload.limit must be at most ${env.network.heldRowsPage}`);
  const after = payload.afterTransactionId === null ? null : decodeDigest(payload.afterTransactionId);
  if (payload.afterTransactionId !== null && !after) return refuse('payload.afterTransactionId is not a SHA-256 digest');

  const rows = await readHeldRows(payload.table, after, payload.limit);
  const answer = {
    type: HELD_ROWS_LIST,
    validatorFrom: env.validator.id,
    validatorTo: payload.validator,
    table: payload.table,
    rows,
    sentAt: new Date().toISOString(),
  };
  return { ok: true, count: rows.length, receipt: { payload: answer, signature: signPayload(answer) } };
}

/**
 * Handles the joiner's ready: this validator must be the leader, the
 * sender the joiner, its tail equal to this validator's (else 400
 * `behind`). Then the hold is over: busy off, the report queue drained,
 * runLeader. Returns { ok: true, receipt } with the signed readyAccepted
 * ({ type, validatorFrom, validatorTo, sentAt }) or { ok: false, status, body }.
 */
export async function receiveReady(body) {
  const problem = checkReadyShape(body);
  if (problem) return refuse(problem);
  if (!(await findIsLeader(env.validator.id))) return notTheLeader();
  const sender = await checkSender(body);
  if (sender.reason) return refuse(sender.reason);

  const { payload } = body;
  if (joining === null || joining.id !== payload.validator) {
    return refuse(`no join in progress for validator ${payload.validator}`);
  }
  const tail = await ownTail();
  if (payload.tailPosition !== tail.position || payload.tailRecordHash !== tail.recordHash) return refuse('behind');

  const answer = {
    type: READY_ACCEPTED,
    validatorFrom: env.validator.id,
    validatorTo: payload.validator,
    sentAt: new Date().toISOString(),
  };
  endHold(`validator ${payload.validator} is ready; rounds released`);
  return { ok: true, receipt: { payload: answer, signature: signPayload(answer) } };
}

/** Ends the hold: the timer off, busy off, the report queue drained, then runLeader, in the background. */
function endHold(line) {
  if (joining === null) return;
  clearTimeout(joining.timer);
  joining = null;
  console.log(line);
  releaseBusy();
  drainReports()
    .then(() => runLeader())
    .catch((err) => console.log(err));
}

/**
 * JOIN_HOLD_SECONDS after the hold began: `join of validator N timed out`;
 * when the include vote had passed, an ignore vote naming the joiner, in
 * this busy section; then the hold ends.
 */
async function holdTimedOut(hold) {
  if (joining !== hold) return;
  console.log(`join of validator ${hold.id} timed out`);
  if (hold.vote !== null && hold.vote.result !== null && hold.vote.result.passed) {
    await runVote([hold.id], IGNORE);
  }
  endHold(`join of validator ${hold.id} ended; rounds released`);
}

// ---------------------------------------------------------------------------
// The joiner's side.
// ---------------------------------------------------------------------------

let loopRunning = false;

/** Starts the join loop in the background, once at a time; it never stops the process. */
export function startJoinLoop() {
  if (loopRunning) return;
  loopRunning = true;
  joinLoop()
    .catch((err) => console.log(`join loop stopped: ${err.message}`))
    .finally(() => {
      loopRunning = false;
    });
}

/** Waits VALIDATOR_CALL_TIMEOUT_SECONDS. */
function wait() {
  return new Promise((resolve) => setTimeout(resolve, env.network.callTimeoutSeconds * 1000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The loop every boot runs (docs/schemas.md 19.1):
 *   1. the health sweep (replay.service.js sweepHealth); nobody answers:
 *      `no validator answers yet`, again after the wait; no majority
 *      otherwise: the same wait. With a majority, the own table takes the
 *      majority's leader when it differs and its ignored list
 *      (adoptIgnoredList);
 *   2. own id is that leader: counted, `leading at position P`, done;
 *   3. the catch-up pass to the majority tail (catchUp); a pass that stops
 *      ends the loop, the validator serving but not counted;
 *   4. join requests to the leader (joinThrough) until counted, `counted
 *      at position P`; a refusal, no answer or a stop of the handshake goes
 *      back to step 1 after the wait.
 */
async function joinLoop() {
  for (;;) {
    const sweep = await sweepHealth();
    if (!sweep.majority) {
      console.log(sweep.answered === 0
        ? 'no validator answers yet'
        : `no majority tail: ${sweep.answered} of ${sweep.asked} health answers carry a chain tail`);
      await wait();
      continue;
    }
    if (sweep.leader !== null && sweep.leader !== (await findLeaderId())) {
      await setLeader(sweep.leader);
      console.log(`validator ${sweep.leader} is the leader`);
    }
    if (sweep.ignored !== null) await adoptIgnoredList(sweep.ignored, 'the network');

    if (sweep.leader === env.validator.id) {
      setCounted(true);
      console.log(`leading at position ${(await ownTail()).position}`);
      return;
    }

    const caught = await catchUp();
    if (!caught.caughtUp) {
      console.log('join loop stopped: the own chain cannot reach the network tail');
      return;
    }

    const outcome = await joinThrough(caught.leader ?? sweep.leader);
    if (outcome === COUNTED) return;
    if (outcome === 'stopped') return;
    await wait();
  }
}

/**
 * The handshake with the leader `leaderId`, per 19.3: join requests until
 * `counted`, or `included`, the held rows, ready, counted. Returns
 * COUNTED, 'again' (back to the sweep after the wait) or 'stopped' (the
 * catch-up pass stopped).
 */
async function joinThrough(leaderId) {
  if (leaderId === null) {
    console.log('join: no leader known');
    return 'again';
  }
  const leader = await findActiveValidator(leaderId);
  if (!leader) {
    console.log(`join: validator ${leaderId} is not an active validator`);
    return 'again';
  }
  await adoptFromLeader(leader);

  for (;;) {
    const own = await ownTail();
    const answer = await sendJoinRequest(leader, own);
    if (answer.reason) {
      console.log(`join: validator ${leader.id} ${answer.reason}`);
      return 'again';
    }
    const { state, reason, tailPosition, tailRecordHash } = answer.payload;
    console.log(`join: ${state}${reason !== undefined ? `: ${reason}` : ''}`);

    switch (state) {
      case COUNTED:
        setCounted(true);
        console.log(`counted at position ${own.position}`);
        return COUNTED;
      case BEHIND: {
        const caught = await catchUp();
        if (!caught.caughtUp) return 'stopped';
        continue;
      }
      case BUSY:
        await wait();
        continue;
      case CATCH_UP:
        await fetchChainFrom([leader], { position: tailPosition, recordHash: tailRecordHash });
        continue;
      case VOTING:
        await sleep(1000);
        continue;
      case INCLUDED: {
        if (!(await pullHeldRows(leader))) return 'again';
        if (!(await sayReady(leader))) return 'again';
        setCounted(true);
        console.log(`counted at position ${(await ownTail()).position}`);
        return COUNTED;
      }
      case REFUSED:
        return 'again';
      default:
        console.log(`join: state ${JSON.stringify(state)} is not one this validator knows`);
        return 'again';
    }
  }
}

/**
 * The leader's view of who is ignored, adopted before the handshake: its
 * health, when it counts itself and runs the same registry as this
 * validator, carries the list (adoptIgnoredList). A mob of fresh joiners
 * can form the sweep's majority with empty lists; the leader's is the
 * network's.
 */
async function adoptFromLeader(leader) {
  const answer = await getHealth(leader);
  if (answer.noAnswer || !isObject(answer.body)) return;
  const { body } = answer;
  const ownHash = appliedRegistry()?.hash;
  if (body.counted !== true || !isObject(body.registry) || body.registry.hash !== ownHash || !Array.isArray(body.ignored)) return;
  await adoptIgnoredList(body.ignored, `validator ${leader.id}`);
}

/** Pulls the five holding tables from the leader, a page at a time (held-rows.service.js). True when every page landed. */
async function pullHeldRows(leader) {
  for (const table of HELD_ROW_TABLES) {
    let after = null;
    for (;;) {
      const answer = await sendHeldRows(leader, { table, afterTransactionId: after, limit: env.network.heldRowsPage });
      if (answer.reason) {
        console.log(`held rows of ${table}: ${answer.reason}`);
        return false;
      }
      const { rows } = answer.payload;
      const stored = await storeHeldRows(table, rows);
      if (!stored.ok) {
        console.log(`held rows of ${table}: ${stored.reason}; starting over`);
        return false;
      }
      console.log(`held rows of ${table}: ${rows.length} received, ${stored.inserted} stored, ${stored.skipped} already here`);
      if (rows.length < env.network.heldRowsPage) break;
      after = rows[rows.length - 1].transactionId;
    }
  }
  return true;
}

/**
 * Says ready to the leader. On `behind` the chain is fetched from the
 * leader up to the tail its health names and ready is sent once more.
 * True when the leader accepted.
 */
async function sayReady(leader) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await sendReady(leader, await ownTail());
    if (answer.accepted) return true;
    if (!answer.behind) {
      console.log(`ready: validator ${leader.id} ${answer.reason}`);
      return false;
    }
    const health = await getHealth(leader);
    const chain = !health.noAnswer && isObject(health.body) ? health.body.chain : null;
    if (!isObject(chain)) {
      console.log("ready: behind, and the leader's tail could not be read");
      return false;
    }
    await fetchChainFrom([leader], chain);
  }
  console.log('ready: behind twice');
  return false;
}

/**
 * POST /join-request to the leader, the answer checked as a receipt: 200,
 * the shape, the signature against the leader's key, validatorFrom and
 * validatorTo. Resolves with { payload } or { reason }.
 *
 *   payload: { type: 'joinRequest', validator, tailPosition, tailRecordHash, sentAt }
 *   signature: { key }
 */
async function sendJoinRequest(leader, tail) {
  const payload = {
    type: JOIN_REQUEST,
    validator: env.validator.id,
    tailPosition: tail.position,
    tailRecordHash: tail.recordHash,
    sentAt: new Date().toISOString(),
  };
  return sendToLeader(leader, '/join-request', payload, checkJoinAnswerShape);
}

/**
 * POST /held-rows to the leader, the answer checked the same way.
 *
 *   payload: { type: 'heldRows', validator, table, afterTransactionId: hex | null, limit, sentAt }
 *   signature: { key }
 */
async function sendHeldRows(leader, { table, afterTransactionId, limit }) {
  const payload = {
    type: HELD_ROWS,
    validator: env.validator.id,
    table,
    afterTransactionId,
    limit,
    sentAt: new Date().toISOString(),
  };
  return sendToLeader(leader, '/held-rows', payload, (receipt) => checkHeldRowsListShape(receipt, table));
}

/**
 * POST /ready to the leader. Resolves with { accepted: true },
 * { behind: true } on 400 `behind`, or { reason }.
 *
 *   payload: { type: 'ready', validator, tailPosition, tailRecordHash, sentAt }
 *   signature: { key }
 */
async function sendReady(leader, tail) {
  const payload = {
    type: READY,
    validator: env.validator.id,
    tailPosition: tail.position,
    tailRecordHash: tail.recordHash,
    sentAt: new Date().toISOString(),
  };
  const answer = await sendToLeader(leader, '/ready', payload, checkReadyAcceptedShape);
  if (answer.payload) return { accepted: true };
  if (answer.error === 'behind') return { behind: true };
  return answer;
}

/** One signed call to the leader; the answer a 200 passing `shape`, signed by the leader, from it, to this validator. */
async function sendToLeader(leader, path, payload, shape) {
  const [answer] = await postToValidators([leader], path, { payload, signature: signPayload(payload) });
  if (answer.noAnswer) return { reason: `gave no answer: ${answer.reason}`, noAnswer: true };
  let parsed;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    return { reason: `answered ${answer.status}: ${answer.body}` };
  }
  if (answer.status !== 200) {
    const error = isObject(parsed) && typeof parsed.error === 'string' ? parsed.error : answer.body;
    return { reason: `answered ${answer.status}: ${error}`, error };
  }
  const problem = shape(parsed);
  if (problem) return { reason: `answered with a bad ${path.slice(1)} answer: ${problem}` };
  const badSignature = verifyPayloadSignature(parsed.payload, parsed.signature, leader);
  if (badSignature) return { reason: `answered with a bad signature: ${badSignature}` };
  if (parsed.payload.validatorFrom !== leader.id) return { reason: `answered as validator ${parsed.payload.validatorFrom}` };
  if (parsed.payload.validatorTo !== env.validator.id) return { reason: `answered validator ${parsed.payload.validatorTo}` };
  return { payload: parsed.payload };
}

// ---------------------------------------------------------------------------
// The shapes.
// ---------------------------------------------------------------------------

function checkEnvelope(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';
  if (typeof body.signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

function checkTailFields(payload) {
  if (!Number.isInteger(payload.tailPosition) || payload.tailPosition < 0) return 'payload.tailPosition must be an integer of 0 or more';
  if (typeof payload.tailRecordHash !== 'string') return 'payload.tailRecordHash must be a string';
  return null;
}

/** Returns a description of the first structural problem with a join request, or null. */
export function checkJoinRequestShape(body) {
  const problem = checkEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== JOIN_REQUEST) return `payload.type must be "${JOIN_REQUEST}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  const tail = checkTailFields(payload);
  if (tail) return tail;
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

/** Returns a description of the first structural problem with a held rows request, or null. */
export function checkHeldRowsShape(body) {
  const problem = checkEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== HELD_ROWS) return `payload.type must be "${HELD_ROWS}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  if (!HELD_ROW_TABLES.includes(payload.table)) return `payload.table must be one of ${HELD_ROW_TABLES.join(', ')}`;
  if (payload.afterTransactionId !== null && typeof payload.afterTransactionId !== 'string') {
    return 'payload.afterTransactionId must be a string or null';
  }
  if (!Number.isInteger(payload.limit) || payload.limit < 1) return 'payload.limit must be a positive integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

/** Returns a description of the first structural problem with a ready, or null. */
export function checkReadyShape(body) {
  const problem = checkEnvelope(body);
  if (problem) return problem;
  const { payload } = body;
  if (payload.type !== READY) return `payload.type must be "${READY}"`;
  if (!Number.isInteger(payload.validator) || payload.validator < 1) return 'payload.validator must be a positive integer';
  const tail = checkTailFields(payload);
  if (tail) return tail;
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

function checkJoinAnswerShape(receipt) {
  const problem = checkEnvelope(receipt);
  if (problem) return problem;
  const { payload } = receipt;
  if (payload.type !== JOIN_ANSWER) return `payload.type must be "${JOIN_ANSWER}"`;
  if (!STATES.includes(payload.state)) return `payload.state must be one of ${STATES.join(', ')}`;
  if (payload.reason !== undefined && typeof payload.reason !== 'string') return 'payload.reason must be a string when present';
  if (!Number.isInteger(payload.leader)) return 'payload.leader must be an integer';
  const tail = checkTailFields(payload);
  if (tail) return tail;
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

function checkHeldRowsListShape(receipt, table) {
  const problem = checkEnvelope(receipt);
  if (problem) return problem;
  const { payload } = receipt;
  if (payload.type !== HELD_ROWS_LIST) return `payload.type must be "${HELD_ROWS_LIST}"`;
  if (payload.table !== table) return `payload.table is ${JSON.stringify(payload.table)}, expected ${table}`;
  if (!Array.isArray(payload.rows)) return 'payload.rows must be an array';
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}

function checkReadyAcceptedShape(receipt) {
  const problem = checkEnvelope(receipt);
  if (problem) return problem;
  const { payload } = receipt;
  if (payload.type !== READY_ACCEPTED) return `payload.type must be "${READY_ACCEPTED}"`;
  if (!Number.isInteger(payload.validatorFrom)) return 'payload.validatorFrom must be an integer';
  if (!Number.isInteger(payload.validatorTo)) return 'payload.validatorTo must be an integer';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  return null;
}
