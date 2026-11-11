// -----------------------------------------------------------------------------
// The world of the app tests: the SDK's fake Gladys, a memory /data, a virtual
// clock and a fake URDB (a fetch that answers by query, records every call
// with its headers and can be made to fail, hang or answer late).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { UrdbApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import { wire } from '../../src/wire.js';
import { settle, testClock } from './clock.js';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

export const TOU = fixture('pge-e-tou-c');
export const E1 = fixture('pge-e1');
export const R3 = fixture('aps-r3');
export const SEARCH = fixture('search-85004');
export const KEY = 'TESTKEY0123456789abcdefABCDEF0123456789x';
export const OTHER_KEY = 'OTHERKEY0123456789abcdefABCDEF012345678y';

/** A contract of this integration, as getEnergyContracts gives it. */
export function contract({
  id = 'c-1',
  label = TOU.label,
  template = 'urdb-pacific',
  timezone = 'America/Los_Angeles',
  validFrom = '2026-01-01',
  validTo = null,
  inputs,
} = {}) {
  return {
    id,
    template_key: template,
    template_version: '1',
    pricing_mode: 'delegated',
    inputs: inputs ?? { tariff_label: label, fixed_charge_per_day: 0, fixed_charge_per_month: 0 },
    valid_from: validFrom,
    valid_to: validTo,
    timezone,
    currency: 'USD',
    billing_period_start_day: 1,
    status: 'active',
  };
}

export const json = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '900', ...headers },
  });

export const quiet = () => {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
};

/**
 * The fake URDB: `records` by label; `route(call)` may return a Response (or
 * a promise) to override. Every call: `{ url, query, headers }`.
 */
export function fakeUrdb({ records = [TOU, E1, R3], route } = {}) {
  const byLabel = new Map(records.map((r) => [r.label, r]));
  const urdb = {
    calls: [],
    route,
    fetch: async (url, init) => {
      const parsed = new URL(url);
      const call = {
        url: String(url),
        query: Object.fromEntries(parsed.searchParams),
        headers: init?.headers ?? {},
        signal: init?.signal,
      };
      urdb.calls.push(call);
      if (urdb.route) {
        // Like fetch: an abort rejects the request, even one that never answers.
        const aborted = new Promise((resolve, reject) => {
          if (call.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
          call.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
        const answer = await Promise.race([urdb.route(call), aborted]);
        if (answer) return answer;
      }
      if (call.query.getpage) {
        const record = byLabel.get(call.query.getpage);
        return json({ items: record ? [record] : [] });
      }
      return json(SEARCH);
    },
    count: (label) =>
      label ? urdb.calls.filter((c) => c.query.getpage === label).length : urdb.calls.length,
  };
  return urdb;
}

export function setup({
  config = { api_key: KEY },
  contracts = [contract()],
  store = createMemoryStore(),
  clock = testClock({ start: Date.UTC(2026, 10, 11, 12) }),
  urdb = fakeUrdb(),
  minGap = 0,
} = {}) {
  const gladys = createFakeGladys({ selector: 'openei-urdb', config, energyContracts: contracts });
  const logger = quiet();
  const app = new UrdbApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: urdb.fetch,
    minGap,
  });
  wire(gladys, app, logger);
  return { gladys, app, store, clock, urdb, logger };
}

/** Connects and lets the start and the first check run. */
export async function connect(world) {
  await world.gladys.connect();
  await settle(10);
  await world.app.idle();
  await world.clock.advance(10);
  await settle(10);
  await world.app.idle();
  await settle(5);
}

/** The text an action resolved (the SDK wraps it in `{ message }`). */
export const said = (ack) => ack.data?.message ?? ack.data;

export async function advance(world, ms) {
  await world.clock.advance(ms);
  await settle(5);
  await world.app.idle();
  await settle(5);
}

export const status = (gladys) => gladys.fake.connectionStatus;

/** Half hours from `startIso` (UTC), `n` of them, `kwh` each. */
export function halfHours(startIso, n, kwh = 0.5) {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({
    starts_at: new Date(start + i * 1_800_000).toISOString(),
    kwh,
    max_power_kw: kwh * 2,
  }));
}

export { settle };
