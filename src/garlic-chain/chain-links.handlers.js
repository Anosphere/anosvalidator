import { receiveChainLinks } from './chain-links.service.js';

/**
 * The route handler of the chain chunk read, POST /chain-links (mounted by
 * validators/validators.router.js). HTTP in and out only; the checking and
 * the read live in chain-links.service.js.
 */

/** POST /chain-links. Answers with a chain links list. */
export async function chainLinks(req, res) {
  const result = await receiveChainLinks(req.body);

  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(400).json({ error: result.reason });
    return;
  }

  const { payload } = result.receipt;
  console.log(`chain links: ${payload.links.length} after ${payload.afterPosition} for validator ${payload.validatorTo}`);
  res.status(200).json(result.receipt);
}
