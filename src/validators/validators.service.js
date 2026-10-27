import { ACCOUNT_CREATION, verifyCreateAccount, writeApproved } from '../accounts/accounts.service.js';
import { env } from '../config/env.js';
import { decodeDigest, digestMatches } from '../crypto/hash.js';
import { findReadyAssistedIds } from '../assisted-transfers/assisted-transfers.queries.js';
import { findReadyEscrowIds } from '../escrow/escrow.queries.js';
import {
  FUND_PROPOSAL,
  TRANSFER_TO_FUND,
  findReadyProposalIds,
  verifyFundProposal,
  verifyTransferToFund,
} from '../fund/fund.service.js';
import { HELD_TABLES, PENDING, findHeld } from '../held-transactions/held-transactions.js';
import { findDueIds } from '../locked-transactions/locked-transactions.queries.js';
import { findApprovedIds } from '../pending/pending.queries.js';
import { isTransferType, verifyAnosTransfer } from '../transfer/transfer.service.js';
import { isObject } from '../util/is-object.js';
import {
  APPROVED_PENDING_LIST,
  FINAL_DECLARATION,
  OFFICIAL_LIST,
  PROOF_OF_ACCEPTANCE,
  READY_ANNOUNCEMENT,
  TRANSACTIONS_WRITTEN,
  TRANSACTION_APPROVAL,
  buildListReceipt,
  buildTransactionAccepted,
  buildTransactionApproved,
  checkApprovedReceipt,
  checkApprovedShape,
  sendFinalDeclaration,
  sendOfficialList,
  sendReadyAnnouncement,
} from './validators.messages.js';
import { findActiveValidator, findActiveValidators, findIsLeader, setLeader } from './validators.queries.js';
import { verifyPayloadSignature } from './validators.signing.js';

/**
 * The receiving side of validator-to-validator messages. The shapes are
 * documented where each message is built, in validators.messages.js.
 */

/**
 * Handles a transaction approval receipt from another validator. Checks, in
 * order:
 *   1. the shape of the receipt;
 *   2. originatingValidator is an active validator in this validator's own
 *      registry, and the signature verifies against that row's key. Keys
 *      inside the message are never used, so a message can only pass as
 *      validator N by being signed with N's private key;
 *   3. the embedded transaction passes exactly the checks the originating
 *      validator ran, picked by its transactionType (verifyTransaction,
 *      against this validator's own database);
 *   4. the receipt's transactionId is the transaction's own;
 *   5. the transaction goes into this validator's own copy of the holding
 *      table the check named (heldIn, through the registry in
 *      held-transactions.js), approved = false, exactly as the originating
 *      validator stored it.
 *
 * Returns { ok: true, receipt } with the signed transaction approved receipt
 * to answer with (validators.messages.js), or { ok: false, reason }.
 */
export async function receiveTransactionApproval(body) {
  const problem = checkApprovalShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;

  // 2. Who sent it, and did they really.
  const sender = await findActiveValidator(payload.originatingValidator);
  if (!sender) {
    return { ok: false, reason: `originatingValidator ${payload.originatingValidator} is not an active validator` };
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  // 3. The transaction itself, same checks as the originating validator.
  const transaction = await verifyTransaction(payload.transaction);
  if (!transaction.ok) return { ok: false, reason: `transaction: ${transaction.reason}` };

  // 4. The receipt talks about the transaction it carries.
  if (!digestMatches(payload.transactionId, transaction.transactionId)) {
    return { ok: false, reason: 'payload.transactionId is not the id of payload.transaction' };
  }

  // 5. Store it, in the holding table the check named. The constraints are
  // the backstop for a race, as on the originating validator.
  const table = HELD_TABLES[transaction.heldIn];
  const stored = await table.insert({ ...transaction, ogTransaction: payload.transaction });
  if (!stored.inserted) {
    return { ok: false, reason: `transaction: ${table.conflictReasons[stored.conflict]}` };
  }

  return {
    ok: true,
    receipt: buildTransactionApproved({
      transactionId: payload.transactionId,
      validatorTo: payload.originatingValidator,
    }),
  };
}

/**
 * Runs on a submission the checks the originating validator ran, picked by
 * its transactionType: verifyCreateAccount (accounts.service.js) for an
 * account creation, verifyAnosTransfer (transfer.service.js) for any of the
 * five transfer types, verifyTransferToFund and verifyFundProposal
 * (fund.service.js) for a transfer to the fund and a fund proposal. All
 * answer { ok: true, accountId, transactionId, heldIn, ... } or { ok: false,
 * reason }: heldIn names the holding table the transaction waits in, with
 * whatever else that table's row needs (futureDate, accountIdTo,
 * voteClosesAt, proposerWeight). An account creation always waits in
 * pending, so its heldIn is added here. Any other type is refused here,
 * before any check.
 */
async function verifyTransaction(transaction) {
  const transactionType = isObject(transaction.payload) ? transaction.payload.transactionType : undefined;
  if (transactionType === ACCOUNT_CREATION) {
    const result = await verifyCreateAccount(transaction);
    return result.ok ? { ...result, heldIn: PENDING } : result;
  }
  if (isTransferType(transactionType)) return verifyAnosTransfer(transaction);
  if (transactionType === TRANSFER_TO_FUND) return verifyTransferToFund(transaction);
  if (transactionType === FUND_PROPOSAL) return verifyFundProposal(transaction);
  return {
    ok: false,
    reason: `payload.transactionType ${JSON.stringify(transactionType)} is not a transaction type this validator knows`,
  };
}

/**
 * Handles a proof of transaction acceptance from the originating validator.
 * Checks, in order:
 *   1. the shape of the proof;
 *   2. originatingValidator is an active validator here, and the signature
 *      verifies against that row's key;
 *   3. this validator holds the transaction, in one of the five holding
 *      tables (held-transactions.js findHeld), not yet approved;
 *   4. every receipt is a transaction approved receipt genuinely signed by an
 *      active validator other than the originating one, addressed to the
 *      originating validator, for this transaction, with no validator twice;
 *   5. there is a receipt from every active validator other than the
 *      originating one.
 * The registry is read once, up front; 2, 4 and 5 all work from that one
 * snapshot. If all of it holds, this validator's row, in whichever table
 * holds the transaction, is marked approved.
 *
 * Returns { ok: true, receipt } with the signed transaction accepted receipt
 * to answer with (validators.messages.js), or { ok: false, reason }.
 */
export async function receiveProofOfAcceptance(body) {
  const problem = checkProofShape(body);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;

  // 2. Who sent it, and did they really.
  const validators = await findActiveValidators();
  const sender = validators.get(payload.originatingValidator);
  if (!sender) {
    return { ok: false, reason: `originatingValidator ${payload.originatingValidator} is not an active validator` };
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  // 3. A transaction we know and have not approved yet, in whichever
  // holding table has it.
  const transactionId = decodeDigest(payload.transactionId);
  if (!transactionId) return { ok: false, reason: 'payload.transactionId is not a SHA-256 digest' };
  const held = await findHeld(transactionId);
  if (!held) return { ok: false, reason: 'no held transaction with this transactionId' };
  if (held.approved) return { ok: false, reason: 'this transaction is already approved' };

  // 4. Each receipt, and who it is from.
  const seen = new Set();
  for (const [i, receipt] of payload.receipts.entries()) {
    const shape = checkApprovedShape(receipt);
    if (shape) return { ok: false, reason: `receipts[${i}]: ${shape}` };

    const from = validators.get(receipt.payload.validatorFrom);
    if (!from) {
      return { ok: false, reason: `receipts[${i}]: validatorFrom ${receipt.payload.validatorFrom} is not an active validator` };
    }
    if (from.id === payload.originatingValidator) {
      return { ok: false, reason: `receipts[${i}]: a receipt from the originating validator itself` };
    }
    if (seen.has(from.id)) {
      return { ok: false, reason: `receipts[${i}]: a second receipt from validator ${from.id}` };
    }
    const bad = checkApprovedReceipt(receipt, { from, to: payload.originatingValidator, transactionId });
    if (bad) return { ok: false, reason: `receipts[${i}]: ${bad}` };

    seen.add(from.id);
  }

  // 5. Nobody missing.
  const missing = [...validators.keys()].filter((id) => id !== payload.originatingValidator && !seen.has(id));
  if (missing.length > 0) {
    return { ok: false, reason: `no receipt from validator${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` };
  }

  // Approved, in the table that holds it. The mark is false only if another
  // request got here first.
  const marked = await HELD_TABLES[held.table].markApproved(transactionId);
  if (!marked) {
    return { ok: false, reason: 'this transaction is already approved' };
  }
  return {
    ok: true,
    receipt: buildTransactionAccepted({
      transactionId: payload.transactionId,
      validatorTo: payload.originatingValidator,
    }),
  };
}

/** Returns a description of the first structural problem with an approval receipt, or null. */
function checkApprovalShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== TRANSACTION_APPROVAL) return `payload.type must be "${TRANSACTION_APPROVAL}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!isObject(payload.transaction)) return 'payload.transaction must be an object';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/** Returns a description of the first structural problem with a proof of acceptance, or null. */
function checkProofShape(body) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== PROOF_OF_ACCEPTANCE) return `payload.type must be "${PROOF_OF_ACCEPTANCE}"`;
  if (!Number.isInteger(payload.originatingValidator) || payload.originatingValidator < 1) {
    return 'payload.originatingValidator must be a positive integer';
  }
  if (typeof payload.transactionId !== 'string') return 'payload.transactionId must be a string';
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (!Array.isArray(payload.receipts)) return 'payload.receipts must be an array';
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}

/**
 * The ids of every transaction this validator is ready to write, as hex in
 * id order, from the five holding tables: its approved pending transactions;
 * its approved locked transactions whose future_date has passed; its
 * approved assisted transfers with both attestations approved and no
 * cancellation present; its approved escrow transfers with no cancel
 * signature and either the success signature approved or the dispute
 * approved and two approved verdicts saying success; and its approved fund
 * proposals whose vote has closed and passed the tally. Building the list
 * also archives the closed proposals whose vote failed (fund.service.js
 * findReadyProposalIds). To the leader round every holding table is another
 * pending table: a ready transaction is listed, ordered and written with
 * the rest (accounts.service.js writeApproved). One that becomes ready
 * between rounds waits for the next one. The hex ids are all the same
 * length, so their string order is their byte order.
 */
async function findReadyIds() {
  return [
    ...(await findApprovedIds()),
    ...(await findDueIds()),
    ...(await findReadyAssistedIds()),
    ...(await findReadyEscrowIds()),
    ...(await findReadyProposalIds()),
  ].sort();
}

/** True while this validator is in the middle of a round (runLeader). */
let leading = false;

/**
 * What every validator does after approving a transaction: if it is the
 * leader, and holds approved pending transactions, it leads one round of
 * writing (leadRound); otherwise nothing, and the next approval asks again.
 * The handlers call it fire-and-forget after answering, and the final
 * declaration's handler too, so the next leader starts at once. A round
 * already running makes a second call return at once.
 */
export async function runLeader() {
  if (leading) return;
  leading = true;
  try {
    await leadRound();
  } finally {
    leading = false;
  }
}

/**
 * One round, written as if nothing can fail:
 *   1. the ready announcement goes to every other validator; each answers
 *      with its approved pending list (findReadyIds: approved pending
 *      transactions and due locked ones), in id order;
 *   2. the official list is the ids every one of those lists and this one
 *      holds, in id order;
 *   3. the official list goes to every other validator; each writes what it
 *      holds of it and answers with the ids it wrote; this validator writes
 *      its own;
 *   4. this validator's own registry moves is_leader to the next active
 *      validator by id (wrapping round), so an announcement from the new
 *      leader is never refused here; then the final declaration naming it
 *      goes to every other validator.
 * A list or receipt that fails its check ends the round there.
 */
async function leadRound() {
  if (!(await findIsLeader(env.validator.id))) return;
  const own = await findReadyIds();
  if (own.length === 0) return;

  // 1. Everyone's approved pending list.
  const lists = await sendReadyAnnouncement();
  for (const { id, reason } of lists) {
    if (reason) {
      console.log(`validator ${id} sent no approved pending list: ${reason}`);
      return;
    }
  }

  // 2. The ids every list holds, this one included, are the official list.
  let official = own;
  for (const { transactionIds } of lists) {
    official = official.filter((id) => transactionIds.includes(id));
  }
  console.log(`official list: ${official.length}`);

  // 3. Everyone writes, this validator included.
  const receipts = await sendOfficialList(official);
  const written = await writeApproved(official);
  console.log(`wrote ${written.length}`);
  for (const { id, reason, transactionIds } of receipts) {
    if (reason) {
      console.log(`validator ${id} did not write: ${reason}`);
      return;
    }
    console.log(`validator ${id} wrote ${transactionIds.length}`);
  }

  // 4. Finished; hand over.
  const ids = [...(await findActiveValidators()).keys()];
  const nextLeader = ids[(ids.indexOf(env.validator.id) + 1) % ids.length];
  await setLeader(nextLeader);
  const answers = await sendFinalDeclaration({ transactionIds: official, nextLeader });
  for (const { id, status } of answers) {
    console.log(`validator ${id} answered the final declaration ${status}`);
  }
  console.log(`validator ${nextLeader} is the leader`);
}

/**
 * Handles the leader's ready announcement. Checks it as a leader call
 * (checkLeaderCall) and answers with this validator's approved pending
 * list (findReadyIds, due locked transactions included), in id order.
 * Returns { ok: true, receipt } or { ok: false, reason }.
 */
export async function receiveReadyAnnouncement(body) {
  const checked = await checkLeaderCall(body, READY_ANNOUNCEMENT);
  if (!checked.ok) return checked;

  return {
    ok: true,
    receipt: buildListReceipt(APPROVED_PENDING_LIST, {
      transactionIds: await findReadyIds(),
      validatorTo: checked.payload.leader,
    }),
  };
}

/**
 * Handles the leader's official list. Checks it as a leader call, writes
 * what this validator holds of the list (accounts.service.js writeApproved,
 * which also deletes those pending and locked rows) and answers with the ids
 * written.
 * Returns { ok: true, written, receipt } or { ok: false, reason }.
 */
export async function receiveOfficialList(body) {
  const checked = await checkLeaderCall(body, OFFICIAL_LIST);
  if (!checked.ok) return checked;

  const written = await writeApproved(checked.payload.transactionIds);
  return {
    ok: true,
    written,
    receipt: buildListReceipt(TRANSACTIONS_WRITTEN, {
      transactionIds: written,
      validatorTo: checked.payload.leader,
    }),
  };
}

/**
 * Handles the leader's final declaration. Checks it as a leader call and
 * that nextLeader is an active validator, then moves is_leader to nextLeader
 * in this validator's own registry. Nothing to answer with; the handler
 * answers 200. Returns { ok: true, nextLeader } or { ok: false, reason }.
 */
export async function receiveFinalDeclaration(body) {
  const checked = await checkLeaderCall(body, FINAL_DECLARATION);
  if (!checked.ok) return checked;

  const { nextLeader } = checked.payload;
  if (!(await findActiveValidator(nextLeader))) {
    return { ok: false, reason: `nextLeader ${nextLeader} is not an active validator` };
  }
  await setLeader(nextLeader);
  return { ok: true, nextLeader };
}

/**
 * The checks every leader call gets, in order: the shape for `type`; `leader`
 * is an active validator, and the leader, per this validator's own registry;
 * the signature verifies against that row's key. Returns { ok: true, payload }
 * or { ok: false, reason }.
 */
async function checkLeaderCall(body, type) {
  const problem = checkLeaderCallShape(body, type);
  if (problem) return { ok: false, reason: problem };

  const { payload, signature } = body;
  const sender = await findActiveValidator(payload.leader);
  if (!sender) return { ok: false, reason: `leader ${payload.leader} is not an active validator` };
  if (!(await findIsLeader(payload.leader))) {
    return { ok: false, reason: `validator ${payload.leader} is not the leader` };
  }
  const badSignature = verifyPayloadSignature(payload, signature, sender);
  if (badSignature) return { ok: false, reason: badSignature };

  return { ok: true, payload };
}

/** Returns a description of the first structural problem with a leader call of `type`, or null. */
function checkLeaderCallShape(body, type) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (!isObject(body.payload)) return 'payload must be an object';
  if (!isObject(body.signature)) return 'signature must be an object';

  const { payload, signature } = body;
  if (payload.type !== type) return `payload.type must be "${type}"`;
  if (!Number.isInteger(payload.leader) || payload.leader < 1) {
    return 'payload.leader must be a positive integer';
  }
  if (typeof payload.sentAt !== 'string') return 'payload.sentAt must be a string';
  if (type !== READY_ANNOUNCEMENT) {
    if (!Array.isArray(payload.transactionIds) || !payload.transactionIds.every((id) => decodeDigest(id))) {
      return 'payload.transactionIds must be an array of SHA-256 digests';
    }
  }
  if (type === FINAL_DECLARATION && (!Number.isInteger(payload.nextLeader) || payload.nextLeader < 1)) {
    return 'payload.nextLeader must be a positive integer';
  }
  if (typeof signature.key !== 'string') return 'signature.key must be a string';
  return null;
}
