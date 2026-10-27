import { Router } from 'express';
import { checkDatabase } from './health.service.js';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
  const db = await checkDatabase();
  const healthy = db.status === 'ok';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    db,
  });
});
