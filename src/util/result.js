/**
 * What the account-level middleware and the reads feature return and send
 * (the keyholder's shape, copied). A service runs its route's checks in the
 * spec's order and returns either ok(status, body) or refuse(status, reason),
 * so a handler only has to log and answer. Reasons are the short lowercase
 * phrases of the spec, sent as { error: reason }. The submission routes
 * keep their own { ok, reason } shape and answerSubmission.
 */

/** A successful outcome: `body` is sent with `status`. */
export function ok(status, body) {
  return { ok: true, status, body };
}

/** A refusal: { error: reason } is sent with `status`. */
export function refuse(status, reason) {
  return { ok: false, status, reason };
}

/** Sends a service result. A refusal is logged the way every other route logs one. */
export function answer(res, result) {
  if (!result.ok) {
    console.log('failed:', result.reason);
    res.status(result.status).json({ error: result.reason });
    return;
  }
  res.status(result.status).json(result.body);
}
