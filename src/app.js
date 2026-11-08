import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { accountsRouter } from './accounts/accounts.router.js';
import { assistedTransfersRouter } from './assisted-transfers/assisted-transfers.router.js';
import { escrowRouter } from './escrow/escrow.router.js';
import { fundRouter } from './fund/fund.router.js';
import { healthRouter } from './health/health.router.js';
import { transferRouter } from './transfer/transfer.router.js';
import { isCounted } from './validators/join.service.js';
import { validatorsRouter } from './validators/validators.router.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { readsRouter } from './reads/reads.router.js';

/** The POSTs a validator answers while it does not count itself: the proof of an include vote naming it, and the chunk read. */
const OPEN_WHILE_NOT_COUNTED = new Set(['/proof-of-ignore-vote', '/chain-links']);

/**
 * Builds and returns the Express application.
 * Kept separate from the server so it can be imported in tests
 * without opening a network port.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: env.webOrigins }));

  // While this validator does not count itself (src/validators/
  // join.service.js: every boot starts so, until the join loop finds it
  // counted), every POST but the two a joiner must answer is 503 "not
  // counted yet". GET /health always answers, `counted` in it.
  app.use((req, res, next) => {
    if (req.method === 'POST' && !isCounted() && !OPEN_WHILE_NOT_COUNTED.has(req.path)) {
      res.status(503).json({ error: 'not counted yet' });
      return;
    }
    next();
  });
  // A create-account submission is about 60 KB; a transaction approval
  // receipt wraps one, and a proof of acceptance will carry several.
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (req, res) => {
    res.type('text/plain').send('Hello, World!');
  });

  // Feature routers. Each feature folder owns its router, service, etc.
  app.use('/health', healthRouter);
  app.use(accountsRouter); // owns top-level paths such as /create-account
  app.use(transferRouter); // owns /anos-transfer
  app.use(fundRouter); // owns /transfer-to-fund, /fund-proposal and /guardian-vote
  app.use(assistedTransfersRouter); // owns /attestation, /assisted-transfer-cancel and /break-glass-cancel
  app.use(escrowRouter); // owns /escrow-signature
  app.use(readsRouter); // the account level: /get-account, /list-transactions, /list-escrows, /get-assisted-transfer and /get-locked-transfer; the attestor reads: /list-assisted-transfers and /list-disputed-escrows
  app.use(validatorsRouter); // validator-to-validator messages: /transaction-approval and the rest, the chunk read, the votes, the join

  // Order matters: these must come after every router.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
