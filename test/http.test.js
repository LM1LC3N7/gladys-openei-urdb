// -----------------------------------------------------------------------------
// The one GET, against a real local HTTP server: the key in the header (never
// in the address), what is a refusal and what is not, the quota, the size and
// time bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FetchError, getJson, parseRetryAfter } from '../src/http.js';
import { USER_AGENT } from '../src/constants.js';

const KEY = 'TESTKEY0123456789abcdef';

async function server(t, handler) {
  const requests = [];
  const srv = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(resolve);
      }),
  );
  return { url: `http://127.0.0.1:${srv.address().port}/utility_rates?version=7`, requests };
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof FetchError, err?.stack);
    return err;
  }
  assert.fail('expected a FetchError');
};

test('a 200: the body, the quota left; the key only in X-Api-Key, our User-Agent', async (t) => {
  const s = await server(t, (req, res) =>
    send(res, 200, { items: [] }, { 'x-ratelimit-remaining': '7' }),
  );
  const answer = await getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 });
  assert.equal(answer.text, '{"items":[]}');
  assert.equal(answer.remaining, 7);
  assert.equal(s.requests[0].headers['x-api-key'], KEY);
  assert.equal(s.requests[0].headers['user-agent'], USER_AGENT);
  assert.equal(s.requests[0].headers.accept, 'application/json');
  assert.ok(!s.requests[0].url.includes(KEY));
});

test('403 with a key error of the gateway: a refusal; any other 403 or 401 is not', async (t) => {
  let body = { error: { code: 'API_KEY_INVALID', message: 'An invalid api_key was supplied' } };
  let status = 403;
  const s = await server(t, (req, res) => send(res, status, body));
  let err = await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }));
  assert.equal(err.code, 'refused');
  assert.equal(err.gateway, 'API_KEY_INVALID');
  assert.ok(!err.message.includes(KEY));
  body = { error: { code: 'API_KEY_DISABLED' } };
  assert.equal(
    (await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }))).code,
    'refused',
  );
  // A 403 of something else (a WAF, a forbidden route): not a refusal.
  body = '<html>Forbidden</html>';
  err = await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }));
  assert.equal(err.code, 'http');
  body = { error: { code: 'HTTPS_REQUIRED' } };
  assert.equal((await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }))).code, 'http');
  // A code that is not ours to trust (lowercase, injected text): ignored.
  body = { error: { code: 'API_KEY_INVALID\r\nX: y' } };
  assert.equal((await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }))).code, 'http');
  status = 401;
  body = {};
  assert.equal((await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }))).code, 'http');
});

test('429 or OVER_RATE_LIMIT: rate limited, with the Retry-After; 5xx: server', async (t) => {
  let reply = (res) =>
    send(res, 429, { error: { code: 'OVER_RATE_LIMIT' } }, { 'retry-after': '120' });
  const s = await server(t, (req, res) => reply(res));
  let err = await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }));
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.retryAfter, 120_000);
  reply = (res) => send(res, 403, { error: { code: 'OVER_RATE_LIMIT' } });
  err = await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }));
  assert.equal(err.code, 'rate_limited');
  reply = (res) => send(res, 503, 'down');
  err = await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }));
  assert.equal(err.code, 'server');
  reply = (res) => send(res, 302, '', { location: 'https://elsewhere.example/' });
  assert.equal(
    (await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000 }))).code,
    'redirect',
  );
});

test('an answer larger than the cap is cut before its end; an endless one too', async (t) => {
  let chunks = 0;
  const s = await server(t, (req, res) => {
    if (req.url.includes('declared')) {
      send(res, 200, 'x'.repeat(5000));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const timer = setInterval(() => {
      chunks += 1;
      if (!res.write('x'.repeat(1024))) return;
      if (chunks > 10_000) clearInterval(timer);
    }, 1);
    res.on('close', () => clearInterval(timer));
  });
  assert.equal(
    (await failure(getJson({ url: `${s.url}&declared=1`, apiKey: KEY, maxBytes: 1000 }))).code,
    'too_large',
  );
  assert.equal(
    (await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 8000 }))).code,
    'too_large',
  );
  assert.ok(chunks < 1000, `cut early (${chunks} chunks sent)`);
});

test('a server that never answers: a timeout; a stop: aborted; invalid UTF-8: encoding', async (t) => {
  const s = await server(t, (req, res) => {
    if (req.url.includes('bytes')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.from([0x7b, 0xff, 0x7d]));
    }
    // else: silent
  });
  assert.equal(
    (await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000, timeout: 100 }))).code,
    'timeout',
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  assert.equal(
    (await failure(getJson({ url: s.url, apiKey: KEY, maxBytes: 1000, signal: controller.signal })))
      .code,
    'aborted',
  );
  assert.equal(
    (await failure(getJson({ url: `${s.url}&bytes=1`, apiKey: KEY, maxBytes: 1000 }))).code,
    'encoding',
  );
});

test('a refused connection: network', async () => {
  const err = await failure(
    getJson({ url: 'http://127.0.0.1:1/utility_rates', apiKey: KEY, maxBytes: 1000 }),
  );
  assert.equal(err.code, 'network');
});

test('Retry-After: seconds or a date against the server Date', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(
    parseRetryAfter('Wed, 11 Nov 2026 01:00:00 GMT', Date.parse('Wed, 11 Nov 2026 00:59:00 GMT')),
    60_000,
  );
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
  assert.equal(parseRetryAfter('1.5'), undefined);
});
