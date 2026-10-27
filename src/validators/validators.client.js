/**
 * HTTP to the other validators. A message is one JSON body POSTed to the
 * same path on each validator, all in parallel, with the answers collected
 * in the same order as `validators`.
 *
 * No timeouts and no retries: written as if the network cannot fail. A
 * validator that is down makes the whole call reject, and the request that
 * triggered the send fails with it. Handling that comes later.
 */
export async function postToValidators(validators, path, body) {
  const json = JSON.stringify(body);
  return Promise.all(
    validators.map(async ({ id, url }) => {
      const response = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: json,
      });
      return { id, url, status: response.status, body: await response.text() };
    }),
  );
}
