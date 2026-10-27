import {
  receiveAttachmentApproval,
  receiveProofOfAttachmentAcceptance,
} from '../attachments/attachments.service.js';
import {
  receiveFinalDeclaration,
  receiveOfficialList,
  receiveProofOfAcceptance,
  receiveReadyAnnouncement,
  receiveTransactionApproval,
  runLeader,
} from './validators.service.js';

/**
 * Route handlers for messages from other validators. HTTP in and out only;
 * the checking lives in validators.service.js, and in
 * attachments.service.js for the two attachment messages.
 */

/** POST /transaction-approval. Answers with a transaction approved receipt. */
export async function transactionApproval(req, res) {
  const result = await receiveTransactionApproval(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('correct');
  res.status(200).json(result.receipt);
}

/** POST /proof-of-acceptance. Answers with a transaction accepted receipt. */
export async function proofOfAcceptance(req, res) {
  const result = await receiveProofOfAcceptance(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('approved:', req.body.payload.transactionId);
  res.status(200).json(result.receipt);
  runLeader().catch(err => console.log(err));
}

/** POST /attachment-approval. Answers with an attachment approved receipt. */
export async function attachmentApproval(req, res) {
  const result = await receiveAttachmentApproval(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('correct');
  res.status(200).json(result.receipt);
}

/**
 * POST /proof-of-attachment-acceptance. Answers with an attachment accepted
 * receipt, then runLeader: the follow-up may have completed a transfer.
 */
export async function proofOfAttachmentAcceptance(req, res) {
  const result = await receiveProofOfAttachmentAcceptance(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('approved attachment:', req.body.payload.attachmentId);
  res.status(200).json(result.receipt);
  runLeader().catch((err) => console.log(err));
}

/** POST /ready-announcement. Answers with this validator's approved pending list. */
export async function readyAnnouncement(req, res) {
  const result = await receiveReadyAnnouncement(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('approved pending list sent:', result.receipt.payload.transactionIds.length);
  res.status(200).json(result.receipt);
}

/** POST /official-list. Writes, then answers with a written receipt. */
export async function officialList(req, res) {
  const result = await receiveOfficialList(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log('wrote:', result.written.length);
  res.status(200).json(result.receipt);
}

/**
 * POST /final-declaration. Answers 200 with no body, then runLeader: if this
 * validator is the next leader, it leads straight away.
 */
export async function finalDeclaration(req, res) {
  const result = await receiveFinalDeclaration(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  console.log(`validator ${result.nextLeader} is the leader`);
  res.sendStatus(200);
  runLeader().catch((err) => console.log(err));
}
