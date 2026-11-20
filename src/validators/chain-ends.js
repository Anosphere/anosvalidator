import { env } from '../config/env.js';
import { ownTail } from '../garlic-chain/replay.service.js';
import { isObject } from '../util/is-object.js';
import { getHealth } from './validators.client.js';
import { findCountedPeers } from './validators.queries.js';

/**
 * The look before a round (docs/schemas.md section 32).
 *
 * A validator that misses a write is one batch shorter than the others,
 * and it can still be counted. Two ways lead there. Its own batch failed
 * and it answered the official list with 200 and no ids: the leader logs
 * `validator N wrote 0` and goes on. Or the leader died while it handed
 * out the list, and only some validators got it. Such a validator keeps
 * the missed transactions as approved rows. Its next ready list still
 * names them, the next official list is the overlap of every ready list
 * and leaves them out, and so it writes the next batch onto its shorter
 * chain. From that moment it is on a chain of its own: its catch-up fails
 * on `recordHash does not chain on the previous link`, and only a wipe by
 * hand mends it. When a list reached only some validators, the same thing
 * splits the whole network in two. The self-check (self-check.js) finds a
 * validator that is behind and brings it back, after one to two minutes.
 * Nothing looked before the next write.
 *
 * So a leader looks at every counted validator's chain end, the position
 * and the record hash of its last link, before it sends anything, and
 * nothing is written while they differ.
 *
 * Most win: the chain end that more than half of the counted validators
 * hold is the network's. A look has one of five findings:
 *
 *   level          every chain end that was read is this validator's own
 *   othersDiffer   this validator is at the network's chain end, others are not
 *   leaderBehind   this validator is not: the network's chain end stands higher
 *   leaderApart    this validator is not: it is ahead, or on a chain that does not fit
 *   noMajority     no chain end is held by more than half of the counted validators
 *
 * The look compares chain ends only. A health page also carries `leader`
 * and `counted`, and the health check of a vote compares them
 * (src/votes/votes.messages.js checkReachable). The look does not. A new
 * leader starts its round the instant it gets the final declaration, and
 * another validator may get its copy a moment later and still name the old
 * leader. That is the fault the rig found in the self-check, two answers
 * from two moments, in another place (docs/schemas.md 31.4). A chain end
 * has no such moment: every validator that answered the official list had
 * committed its batch before it answered, and the final declaration goes
 * out after those answers. Inside the leader's own round nothing else
 * writes.
 *
 * A health page that cannot be read is not held against a validator. It
 * is not compared, and it counts for nobody when "more than half" is
 * worked out. The round's own steps meet that validator next, as before.
 * So a validator that is behind and whose health page cannot be read in
 * that moment is missed for that round.
 *
 * What the leader then does with a finding is settleChainEnds in
 * validators.service.js.
 */

/** What a look can find. */
export const LEVEL = 'level';
export const OTHERS_DIFFER = 'othersDiffer';
export const LEADER_BEHIND = 'leaderBehind';
export const LEADER_APART = 'leaderApart';
export const NO_MAJORITY = 'noMajority';

/**
 * One look: GET /health on every counted peer at once (validators.client.js
 * getHealth), this validator's own chain end (replay.service.js ownTail),
 * and the judgement of judgeChainEnds with `own` added to it.
 */
export async function lookAtChainEnds() {
  const peers = await findCountedPeers(env.validator.id);
  const own = await ownTail();
  const answers = await Promise.all(peers.map((peer) => getHealth(peer)));

  const ends = [];
  const unread = [];
  for (const [i, answer] of answers.entries()) {
    const chain = !answer.noAnswer && isObject(answer.body) ? answer.body.chain : null;
    if (isObject(chain) && Number.isInteger(chain.position) && typeof chain.recordHash === 'string') {
      ends.push({ id: peers[i].id, position: chain.position, recordHash: chain.recordHash });
    } else {
      unread.push(peers[i].id);
    }
  }
  return { ...judgeChainEnds({ ownId: env.validator.id, own, ends, unread }), own };
}

/**
 * Judges one look. `ownId` and `own` are this validator's id and chain end
 * ({ position, recordHash }), `ends` one { id, position, recordHash } per
 * counted peer whose health carried a chain, `unread` the ids of the
 * counted peers whose health did not. Returns { finding } and, unless the
 * finding is level, `line`, the groups in words; with othersDiffer `ids`,
 * the validators to name, ascending; with leaderBehind and leaderApart
 * `network`, the network's chain end.
 */
export function judgeChainEnds({ ownId, own, ends, unread }) {
  const isOwn = (end) => end.position === own.position && end.recordHash === own.recordHash;
  const differing = ends.filter((end) => !isOwn(end)).map((end) => end.id).sort((a, b) => a - b);
  if (differing.length === 0) return { finding: LEVEL };

  // The groups, one per chain end, this validator's own among them; the largest first, the higher position on a tie.
  const groups = new Map();
  for (const end of [{ id: ownId, ...own }, ...ends]) {
    const key = `${end.position}:${end.recordHash}`;
    if (!groups.has(key)) groups.set(key, { position: end.position, recordHash: end.recordHash, ids: [] });
    groups.get(key).ids.push(end.id);
  }
  const sorted = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length || b.position - a.position);
  for (const group of sorted) group.ids.sort((a, b) => a - b);

  const counted = ends.length + unread.length + 1;
  const largest = sorted[0];
  const majority = largest.ids.length * 2 > counted;
  const line = describeChainEnds({ sorted, majority, own, unread });
  const network = { position: largest.position, recordHash: largest.recordHash };

  if (!majority) return { finding: NO_MAJORITY, line };
  if (isOwn(largest)) return { finding: OTHERS_DIFFER, ids: differing, line };
  if (largest.position > own.position) return { finding: LEADER_BEHIND, network, line };
  return { finding: LEADER_APART, network, line };
}

/** The groups in words, for the log: a group of more than half as a count, every other group by its ids. */
function describeChainEnds({ sorted, majority, own, unread }) {
  const short = (recordHash) => (typeof recordHash === 'string' ? recordHash.slice(0, 8) : 'no link');
  const parts = sorted.map((group, i) => {
    const where = `at position ${group.position} (${short(group.recordHash)})`;
    if (majority && i === 0) return `${group.ids.length} validators ${where}`;
    return `validator${group.ids.length > 1 ? 's' : ''} ${group.ids.join(', ')} ${where}`;
  });
  parts.push(`own position ${own.position} (${short(own.recordHash)})`);
  if (unread.length > 0) {
    parts.push(`no chain end read from validator${unread.length > 1 ? 's' : ''} ${unread.join(', ')}`);
  }
  return parts.join('; ');
}
