// -----------------------------------------------------------------------------
// The only network access: one GET to the URDB API, bounded in time
// (REQUEST_TIMEOUT, from the first byte sent to the last byte read) and in
// size (cut as soon as the cap is passed, before the body is complete), with
// the module's User-Agent, an explicit Accept, the key in the X-Api-Key
// header (never in the address, so never in an error or a log), no redirect
// followed, no cookie. The body is decoded as strict UTF-8.
//
// The api.data.gov gateway in front of URDB answers a refused key with a 403
// and a JSON body `{ "error": { "code": "API_KEY_INVALID" } }`: that body is
// read (bounded) so that a refusal is told apart from any other 403.
// -----------------------------------------------------------------------------

import { ERROR_MAX_BYTES, REQUEST_TIMEOUT, USER_AGENT } from './constants.js';

export class FetchError extends Error {
  /**
   * @param {string} code 'network' | 'timeout' | 'http' | 'rate_limited' | 'server' |
   *   'redirect' | 'too_large' | 'encoding' | 'aborted' | 'refused'
   */
  constructor(code, { status, retryAfter, gateway } = {}) {
    super(`fetch failed: ${code}${status ? ` ${status}` : ''}`);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    /** The error code of the gateway (API_KEY_INVALID, OVER_RATE_LIMIT...), checked. */
    this.gateway = gateway;
  }
}

/** The gateway codes that mean "this key is not accepted": a refusal, nothing else is. */
export const REFUSAL_CODES = new Set([
  'API_KEY_INVALID',
  'API_KEY_MISSING',
  'API_KEY_DISABLED',
  'API_KEY_UNAUTHORIZED',
  'API_KEY_UNVERIFIED',
]);

/** `Retry-After` in ms (seconds or an HTTP date against the server `Date`), else undefined. */
export function parseRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{1,12}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isFinite(at) && Number.isFinite(serverDate)) return Math.max(0, at - serverDate);
  return undefined;
}

/** An integer header (X-RateLimit-Remaining), else undefined. */
function intHeader(value) {
  return typeof value === 'string' && /^\d{1,9}$/.test(value.trim())
    ? Number(value.trim())
    : undefined;
}

/** Reads at most `maxBytes` of a body; throws FetchError('too_large') beyond. */
async function readBounded(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FetchError('too_large');
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The gateway error code of a small JSON error body, checked (letters and _ only). */
function gatewayCode(bytes) {
  try {
    const code = JSON.parse(bytes.toString('utf8'))?.error?.code;
    return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GET `url` with the key. Resolves `{ text, date, remaining }` on a 200;
 * throws a FetchError otherwise. `date` is the server `Date` in epoch ms (NaN
 * when absent), `remaining` the X-RateLimit-Remaining of the gateway.
 * @param {{ url: string, apiKey: string, maxBytes: number, signal?: AbortSignal,
 *   fetchImpl?: typeof fetch, timeout?: number, timers?: object }} options
 */
export async function getJson({
  url,
  apiKey,
  maxBytes,
  signal,
  fetchImpl = fetch,
  timeout = REQUEST_TIMEOUT,
  timers = { setTimeout, clearTimeout },
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const fail = (err) => {
    if (err instanceof FetchError) return err;
    if (timedOut) return new FetchError('timeout');
    if (signal?.aborted) return new FetchError('aborted');
    return new FetchError('network');
  };
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Api-Key': apiKey },
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      throw fail(err);
    }
    const date = Date.parse(response.headers.get('date') ?? '');
    const remaining = intHeader(response.headers.get('x-ratelimit-remaining') ?? undefined);
    const status = response.status;
    if (status !== 200) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after') ?? undefined, date);
      let gateway;
      if (status === 401 || status === 403 || status === 429) {
        try {
          gateway = gatewayCode(await readBounded(response, ERROR_MAX_BYTES));
        } catch (err) {
          // An error body too large or cut: no code, the status alone decides.
          if (timedOut || signal?.aborted) throw fail(err);
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
      if (status === 429 || gateway === 'OVER_RATE_LIMIT') {
        throw new FetchError('rate_limited', { status, retryAfter, gateway });
      }
      if ((status === 401 || status === 403) && REFUSAL_CODES.has(gateway)) {
        throw new FetchError('refused', { status, gateway });
      }
      if (status >= 500 && status <= 599) throw new FetchError('server', { status, retryAfter });
      if (status >= 300 && status <= 399) throw new FetchError('redirect', { status });
      throw new FetchError('http', { status, gateway });
    }
    let bytes;
    try {
      bytes = await readBounded(response, maxBytes);
    } catch (err) {
      throw fail(err);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new FetchError('encoding');
    }
    return { text, date, remaining };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
