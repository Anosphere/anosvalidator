import { env } from '../config/env.js';
import { findCountedPeers } from './validators.queries.js';

/**
 * The proof of acceptance, as the validator that took a submission sends it
 * (docs/schemas.md section 33).
 *
 * Why: the approvals come from the validators that were counted when they
 * were asked, and every receiver checks the proof against the validators it
 * counts when the proof arrives: one receipt from every counted validator,
 * no more and no fewer (validators.service.js receiveProofOfAcceptance,
 * checks 4 and 5). A vote that passes in between, an ignore vote or an
 * include vote, makes the two differ, and every receiver refuses the
 * proof. Nothing reacted to that. The transaction was never written, the
 * row here stayed approved, and since account_id is unique in every
 * holding table this validator then refused every later transaction of
 * that account.
 *
 * Three things end that, all on this side, with the messages that exist:
 *   1. right before a proof is built, the approvals are brought in line
 *      with the validators counted now (bringInLine);
 *   2. a proof that not every validator accepted goes once more, after
 *      SECOND_TRY_AFTER_MS, the approvals brought in line again. The proof
 *      of a vote reaches the validators at different moments, so in that
 *      moment no list of receipts is right for all of them;
 *   3. when every validator refused, the mark on the own row is taken back
 *      (takeMarkBack). The sweep (held-transactions/unapproved-sweep.js)
 *      then drops that row as it drops theirs, and the account can send
 *      again. Not for a follow-up, whose copies no sweep drops.
 */

/** How long this validator waits before it sends a proof a second time, in milliseconds. */
const SECOND_TRY_AFTER_MS = 1000;

/** How many times a validator that is counted now is asked for its approval, and the wait between two asks, in milliseconds. */
const ASKS = 5;
const ASK_AGAIN_AFTER_MS = 1000;

/** The status a validator answers when its own checks refuse a message. */
const REFUSED = 400;

/**
 * What an originator does once every approval is in (accounts, transfer,
 * fund and attachments). `transactionId` is the transaction's id as the
 * submitter sent it, for the log lines. `approvals` are the per-validator
 * results the originator goes on with (votes.messages.js settleNoAnswers),
 * every one approved.
 *   askApproval(peers)   sends the approval to these peers and resolves
 *                        with their results, as the first send did;
 *   markApproved()       marks the own row, or the own copy of a
 *                        follow-up, approved;
 *   sendProof(receipts)  sends the proof with these receipts to the
 *                        counted peers and resolves with one { id,
 *                        accepted, reason?, status?, noAnswer? } per peer;
 *   takeMarkBack()       takes the own mark back; a follow-up passes none.
 * Resolves with { approvals, approved: false } when a validator that is
 * counted now did not approve: nothing is marked and no proof is sent.
 * Otherwise with { approvals, approved: true, proof }: `approvals` as the
 * last proof carried them, `proof` one entry per validator the last proof
 * went to, an entry accepted when that validator accepted either proof.
 */
export async function proveAcceptance({ transactionId, approvals, askApproval, markApproved, sendProof, takeMarkBack }) {
  // 1. The approvals, in line with who is counted now.
  let current = await bringInLine(approvals, askApproval);
  if (!current.every((approval) => approval.approved)) return { approvals: current, approved: false };

  // The own row first, then the proof, as before.
  await markApproved();
  const first = await sendProof(current.map((approval) => approval.receipt));
  if (first.every((answer) => answer.accepted)) return { approvals: current, approved: true, proof: first };

  // 2. Not accepted by every validator: once more, a moment later.
  console.log(`the proof of ${transactionId} was not accepted by every validator; it goes once more`);
  await sleep(SECOND_TRY_AFTER_MS);
  const answers = [...first];
  let proof = first;
  const again = await bringInLine(current, askApproval);
  if (again.every((approval) => approval.approved)) {
    current = again;
    const second = await sendProof(current.map((approval) => approval.receipt));
    answers.push(...second);
    // A validator that accepted the first proof holds the row approved,
    // whatever it answers the second.
    const acceptedFirst = new Map(first.filter((answer) => answer.accepted).map((answer) => [answer.id, answer]));
    proof = second.map((answer) => (answer.accepted ? answer : acceptedFirst.get(answer.id) ?? answer));
  } else {
    for (const { id, reason } of again.filter((approval) => !approval.approved)) {
      console.log(`validator ${id} did not approve: ${reason}; the proof does not go again`);
    }
  }
  if (proof.every((answer) => answer.accepted)) return { approvals: current, approved: true, proof };

  // 3. Every validator refused: the own mark is taken back. An answer that
  // is no plain refusal, no answer at all or a status other than 400, may
  // come from a validator that did mark its row, so then the mark stays.
  if (takeMarkBack && answers.every((answer) => !answer.accepted && answer.status === REFUSED)) {
    await takeMarkBack();
    console.log(`no validator accepted the proof of ${transactionId}: the approval here is taken back`);
  } else {
    const ids = proof.filter((answer) => !answer.accepted).map((answer) => answer.id);
    console.log(`the proof of ${transactionId} is still not accepted by validator${ids.length > 1 ? 's' : ''} ${ids.join(', ')}: the approval here stays`);
  }
  return { approvals: current, approved: true, proof };
}

/**
 * The approvals brought in line with the validators counted now
 * (validators.queries.js findCountedPeers): the approval of a validator
 * that is not counted any more is left out, and a validator that is
 * counted now and has given no approval is asked for it (askApproval), its
 * result taking its place in id order. One line for each of them.
 *
 * A validator that was just voted back in answers 503 until it has taken
 * in the leader's waiting rows and counts itself (join.service.js). So one
 * that answers and does not approve is asked again after
 * ASK_AGAIN_AFTER_MS, the counted validators read again each time, ASKS
 * times at most. One that gives no answer at all is not waited for. What
 * is left without an approval then comes back as it answered last, and the
 * caller treats it as a refusal.
 */
async function bringInLine(approvals, askApproval) {
  let current = approvals;
  const told = new Set();
  for (let ask = 1; ; ask += 1) {
    const peers = await findCountedPeers(env.validator.id);
    const counted = new Set(peers.map((peer) => peer.id));
    for (const { id, approved } of current) {
      if (approved && !counted.has(id)) console.log(`validator ${id} is not counted any more: its approval is left out of the proof`);
    }
    const kept = current.filter((approval) => approval.approved && counted.has(approval.id));
    const have = new Set(kept.map((approval) => approval.id));
    const missing = peers.filter((peer) => !have.has(peer.id));
    if (missing.length === 0) return kept;

    for (const { id } of missing) {
      if (!told.has(id)) console.log(`validator ${id} is counted now: it is asked for its approval`);
      told.add(id);
    }
    const asked = await askApproval(missing);
    current = kept.concat(asked).sort((a, b) => a.id - b.id);
    const waiting = asked.filter((approval) => !approval.approved);
    if (waiting.length === 0 || waiting.some((approval) => approval.noAnswer) || ask === ASKS) return current;

    for (const { id, reason } of waiting) {
      console.log(`validator ${id} did not approve: ${reason}; it is asked once more`);
    }
    await sleep(ASK_AGAIN_AFTER_MS);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
