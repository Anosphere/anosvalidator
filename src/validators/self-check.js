import { env } from '../config/env.js';
import { ownTail, sweepHealth } from '../garlic-chain/replay.service.js';
import { isCounted, setCounted, startJoinLoop } from './join.service.js';
import { findLeaderId } from './validators.queries.js';
import { isBusy } from './validators.service.js';

/**
 * The self-check (docs/schemas.md section 31).
 *
 * A validator that the others voted out is told nothing: the proof of an
 * ignore vote goes to the counted validators only. Without this check it
 * would find out only when a wallet sends a transaction through it and the
 * others refuse (join.service.js noticeIgnoredAnswers), and that
 * transaction would fail. A validator that missed a write, or the hand-over
 * of the lead, would not find out at all.
 *
 * So once a minute a counted validator reads every other validator's
 * health (src/garlic-chain/replay.service.js sweepHealth, the sweep of the
 * catch-up pass) and compares itself with what most of them say. Three
 * findings count:
 *
 *   most list it as ignored            ignored by the network
 *   most are at a higher position      behind the network (position P, the network's Q)
 *   most name another leader           names leader X, the network names Y
 *
 * One finding is logged and remembered. A check that finds one right after
 * a check that found one, of whatever kind, makes the validator stop
 * counting itself and join again (join.service.js startJoinLoop): the join
 * loop catches up, brings the waiting rows in line and has it counted
 * again, through an include vote when it was voted out.
 *
 * The check does nothing while the validator is not counted, nothing while
 * it holds the busy flag (a round, a vote or a join it leads), nothing
 * without a majority, and nothing when it is ahead of the others: a
 * validator that is ahead waits for a person, as before.
 *
 * The others are read first and the own tables after, and the look at the
 * others takes time: as long as the slowest health answer, up to the call
 * timeout. A round that ends meanwhile writes a link and hands the lead
 * on. So the own leader is read before the look as well, and "another
 * leader" is a finding only when the own leader stood still during the
 * look. Otherwise two healthy answers from different moments would differ,
 * and two such moments a minute apart would take a healthy validator out
 * of the count (docs/schemas.md 31.4; seen on the rig). A validator that
 * really missed a hand-over keeps its old leader, so it is still found.
 *
 * The first check runs one interval after the start, not at once: a start
 * is a join, and the join loop has just compared the same things.
 */

/** How often the check runs, in milliseconds. */
const SELF_CHECK_EVERY_MS = 60_000;

let timer = null;

/** What the check before this one found, or null when it found nothing or did not run to its end. */
let lastFinding = null;

/**
 * One check. It never throws: an error is logged as `self-check failed:
 * <message>` and changes nothing, and the next check tries again.
 */
export async function selfCheck() {
  try {
    // 1. Only a counted validator checks itself, and not in the middle of
    // a round, a vote or a join it leads.
    if (!isCounted() || isBusy()) {
      lastFinding = null;
      return;
    }

    // 2. What most of the others say. The own leader is read before the
    // look and again after it (step 3): the look takes up to the call
    // timeout, and a round that ends meanwhile hands the lead on.
    const leaderBefore = await findLeaderId();
    const sweep = await sweepHealth();
    if (!sweep.majority) {
      lastFinding = null;
      return;
    }

    // 3. The finding, the first that holds.
    const own = await ownTail();
    let finding = null;
    if (own.position > sweep.tail.position) {
      // Ahead of the others: no finding, whatever else differs.
    } else if (sweep.ignored !== null && sweep.ignored.includes(env.validator.id)) {
      finding = 'ignored by the network';
    } else if (sweep.tail.position > own.position) {
      finding = `behind the network (position ${own.position}, the network's ${sweep.tail.position})`;
    } else if (sweep.leader !== null) {
      // An own leader that moved during the look says nothing: the two
      // answers are from different moments. One that stood still and is
      // not the network's is the finding.
      const leaderId = await findLeaderId();
      if (leaderId === leaderBefore && sweep.leader !== leaderId) {
        finding = `names leader ${leaderId}, the network names ${sweep.leader}`;
      }
    }

    // 4. The sweep takes up to the call timeout: not counted or busy by now
    // means the finding is about a moment that has passed.
    if (!isCounted() || isBusy()) {
      lastFinding = null;
      return;
    }

    // 5. Nothing found.
    if (finding === null) {
      lastFinding = null;
      return;
    }

    // 6. The first finding is remembered.
    if (lastFinding === null) {
      lastFinding = finding;
      console.log(`self-check: ${finding}`);
      return;
    }

    // 7. Two in a row, of whatever kind: join again.
    console.log(`self-check: ${finding}, twice in a row; joining again`);
    lastFinding = null;
    setCounted(false);
    startJoinLoop();
  } catch (err) {
    console.log(`self-check failed: ${err.message}`);
  }
}

/** Starts the check: every SELF_CHECK_EVERY_MS, the first time one interval from now. Starting it twice does nothing. */
export function startSelfCheck() {
  if (timer !== null) return;
  timer = setInterval(selfCheck, SELF_CHECK_EVERY_MS);
  timer.unref();
}

/** Stops the check; a check already running finishes on its own. */
export function stopSelfCheck() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
