// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a memory /data, a virtual
// clock and a fake URDB: the pace, the copy in /data, the delegated pricing
// through the real wiring, the quota, the refused key, the status.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { DAY, HOUR, MINUTE, TEMPLATE_KEYS } from '../src/constants.js';
import {
  E1,
  KEY,
  OTHER_KEY,
  R3,
  TOU,
  advance,
  connect,
  contract,
  fakeUrdb,
  halfHours,
  json,
  said,
  settle,
  setup,
  status,
} from './helpers/world.js';
import { testClock } from './helpers/clock.js';

const JULY = { starts_at: '2026-07-01T07:00:00.000Z', ends_at: '2026-08-01T07:00:00.000Z' };
const wireContract = (c) => ({
  id: c.id,
  template_key: c.template_key,
  inputs: c.inputs,
  currency: 'USD',
  timezone: c.timezone,
  billing_period_start_day: 1,
});
const priceRequest = (c = contract(), intervals = halfHours('2026-07-15T22:00:00Z', 4, 1)) => ({
  contract: wireContract(c),
  billing_period: JULY,
  cumulative_before: { day: 0, month: 0, billing_period: 0 },
  intervals,
});

/** Nothing secret anywhere: logs, /data, status, addresses. */
function assertNoKey(world, key = KEY) {
  const all = JSON.stringify([
    world.logger.lines,
    world.store.data,
    world.gladys.fake.connectionStatuses,
    world.urdb.calls.map((c) => c.url),
  ]);
  assert.ok(!all.includes(key), 'the key leaked');
}

test('no key: the status asks for it, nothing is sent; a malformed key is never sent', async (t) => {
  const w = setup({ config: {} });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(status(w.gladys).connected, false);
  assert.match(status(w.gladys).message.en, /Enter your free OpenEI API key/);
  assert.equal(w.urdb.count(), 0);
  await w.gladys.fake.configUpdated({ api_key: 'bad key\r\nX-Evil: 1' });
  await advance(w, 10);
  assert.match(status(w.gladys).message.fr, /n’a pas la forme attendue/);
  assert.equal(w.urdb.count(), 0);
  const ack = await w.gladys.fake.action('test_connection', {});
  assert.match(said(ack).en, /not in the expected form/);
  assert.equal(w.urdb.count(), 0);
});

test('start: the tariff of the contract read once, the status names it with its dates', async (t) => {
  const w = setup();
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(w.urdb.count(TOU.label), 1);
  const call = w.urdb.calls[0];
  assert.equal(call.headers['X-Api-Key'], KEY);
  assert.equal(call.query.version, '7');
  assert.equal(call.query.detail, 'full');
  assert.ok(!call.url.includes(KEY));
  const s = status(w.gladys);
  assert.equal(s.connected, true);
  assert.match(s.message.en, /E-TOU-C Residential Time of Use Baseline Region P \(Pacific Gas/);
  assert.match(s.message.en, /in effect since 2026-03-27/);
  assert.match(s.message.en, /read 2026-11-11/);
  assert.match(s.message.en, /fixed charge 0\.79343 \$\/day: type it in the contract/);
  assert.match(s.message.fr, /en vigueur depuis 2026-03-27/);
  // In /data: the copy and its date, never the key.
  assert.equal(w.store.data.tariffs[TOU.label].record.label, TOU.label);
  assert.ok(!('description' in w.store.data.tariffs[TOU.label].record));
  assertNoKey(w);
});

test('a tariff with demand charges: the status says what Gladys does not compute', async (t) => {
  const w = setup({
    contracts: [
      contract({ label: R3.label, template: 'urdb-arizona', timezone: 'America/Phoenix' }),
    ],
  });
  t.after(() => w.app.stop());
  await connect(w);
  assert.match(status(w.gladys).message.en, /not computed by Gladys: demand charges/);
  assert.match(status(w.gladys).message.fr, /non calculé par Gladys : frais de puissance appelée/);
});

test('delegated pricing through the wiring: one cost per interval, from the copy held', async (t) => {
  const w = setup();
  t.after(() => w.app.stop());
  await connect(w);
  const ack = await w.gladys.fake.energyPrice(priceRequest());
  assert.equal(ack.success, true, JSON.stringify(ack));
  const costs = ack.data.costs;
  assert.equal(costs.length, 4);
  assert.ok(Math.abs(costs[0].cost - 0.318) < 1e-9);
  assert.ok(Math.abs(costs[2].cost - 0.441) < 1e-9);
  assert.equal(w.urdb.count(TOU.label), 1, 'priced from the copy, no new request');
});

test('a contract created after the start: its tariff read on demand, then held', async (t) => {
  const w = setup({ contracts: [] });
  t.after(() => w.app.stop());
  await connect(w);
  assert.match(status(w.gladys).message.en, /No energy contract uses an OpenEI URDB template yet/);
  const c = contract({ id: 'c-2', label: E1.label });
  w.gladys.fake.energyContracts = [c];
  const ack = await w.gladys.fake.energyPrice(
    priceRequest(c, halfHours('2026-07-10T07:00:00Z', 2, 1)),
  );
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.ok(Math.abs(ack.data.costs[0].cost - 0.32561) < 1e-9);
  await w.gladys.fake.energyPrice(priceRequest(c, halfHours('2026-07-10T08:00:00Z', 2, 1)));
  assert.equal(w.urdb.count(E1.label), 1);
  await settle(5);
  assert.match(status(w.gladys).message.en, /E-1 -Residential Service Baseline Region V/);
});

test('a contract with a bad label: a clear error, nothing sent, no cost', async (t) => {
  const w = setup({ contracts: [] });
  t.after(() => w.app.stop());
  await connect(w);
  const foreign = contract({ template: 'octopus-gb-electricity' });
  const notOurs = await w.gladys.fake.energyPrice(priceRequest(foreign));
  assert.equal(notOurs.success, false);
  assert.match(notOurs.error, /does not use an OpenEI URDB template/);
  assert.equal(w.urdb.count(), 0);
  const c = contract({ inputs: { tariff_label: 'my tariff' } });
  const ack = await w.gladys.fake.energyPrice(priceRequest(c));
  assert.equal(ack.success, false);
  assert.match(ack.error, /no valid URDB tariff label/);
  const unknown = contract({ label: '000000000000000000000000' });
  w.gladys.fake.energyContracts = [unknown];
  const ack2 = await w.gladys.fake.energyPrice(priceRequest(unknown));
  assert.equal(ack2.success, false);
  assert.match(ack2.error, /not_found/);
  await advance(w, MINUTE);
  assert.match(status(w.gladys).message.en, /label not found in URDB/);
  assert.equal(status(w.gladys).connected, false);
  // Not asked again before its retry delay.
  const before = w.urdb.count();
  await w.gladys.fake.energyPrice(priceRequest(unknown));
  assert.equal(w.urdb.count(), before);
});

test('a tariff with daily tiers prices with the contract validity read from Gladys', async (t) => {
  // Contract from July 21: 11 days of baseline (148.5 kWh).
  const c = contract({ validFrom: '2026-07-21' });
  const w = setup({ contracts: [c] });
  t.after(() => w.app.stop());
  await connect(w);
  const request = priceRequest(c, halfHours('2026-07-25T23:00:00Z', 1, 1));
  request.cumulative_before.billing_period = 148;
  const ack = await w.gladys.fake.energyPrice(request);
  assert.ok(Math.abs(ack.data.costs[0].cost - (0.5 * 0.441 + 0.5 * 0.5224)) < 1e-9);
  // Gladys cannot give the contracts: no cost (retried by Gladys), never a guess.
  const other = contract({ id: 'c-9', validFrom: '2026-07-21' });
  w.gladys.getEnergyContracts = async () => {
    throw new Error('down');
  };
  const failed = await w.gladys.fake.energyPrice(priceRequest(other));
  assert.equal(failed.success, false);
  assert.match(failed.error, /validity/);
});

test('the copy is read again after a day, never sooner, even across restarts', async (t) => {
  const store = createMemoryStore();
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const w = setup({ store, clock });
  await connect(w);
  assert.equal(w.urdb.count(TOU.label), 1);
  await advance(w, 6 * HOUR);
  assert.equal(w.urdb.count(TOU.label), 1);
  await w.app.stop();
  // Restart (same /data, same clock): the copy is used, not read again.
  const w2 = setup({ store, clock, urdb: w.urdb });
  t.after(() => w2.app.stop());
  await connect(w2);
  assert.equal(w.urdb.count(TOU.label), 1);
  const ack = await w2.gladys.fake.energyPrice(priceRequest());
  assert.equal(ack.success, true);
  assert.equal(w.urdb.count(TOU.label), 1);
  await advance(w2, 17 * HOUR);
  assert.equal(w.urdb.count(TOU.label), 1);
  await advance(w2, 2 * HOUR);
  assert.equal(w.urdb.count(TOU.label), 2);
});

test('OpenEI unreachable: the copy keeps pricing; retried 10 min later, doubled', async (t) => {
  const store = createMemoryStore();
  const urdb = fakeUrdb();
  const w = setup({ store, urdb });
  t.after(() => w.app.stop());
  await connect(w);
  await advance(w, DAY + MINUTE);
  assert.equal(urdb.count(TOU.label), 2);
  urdb.route = () => {
    throw new TypeError('fetch failed');
  };
  await advance(w, DAY + MINUTE);
  const n = urdb.count(TOU.label);
  const ack = await w.gladys.fake.energyPrice(priceRequest());
  assert.equal(ack.success, true, 'the copy held prices');
  // A copy held: the failed refresh is tried again a day later, not in a loop.
  await advance(w, 6 * HOUR);
  assert.equal(urdb.count(TOU.label), n);
  // Without a copy: 10 min, then 20 min.
  const w2 = setup({ contracts: [contract({ label: E1.label })], urdb });
  t.after(() => w2.app.stop());
  await connect(w2);
  const first = urdb.count(E1.label);
  assert.equal(first, 1);
  await advance(w2, 9 * MINUTE);
  assert.equal(urdb.count(E1.label), 1);
  await advance(w2, 2 * MINUTE);
  assert.equal(urdb.count(E1.label), 2);
  await advance(w2, 15 * MINUTE);
  assert.equal(urdb.count(E1.label), 2);
  await advance(w2, 10 * MINUTE);
  assert.equal(urdb.count(E1.label), 3);
  assert.equal(status(w2.gladys).connected, false);
  assert.match(status(w2.gladys).message.en, /OpenEI unreachable/);
});

test('refused key: no automatic request any more, kept across a restart, lifted by a new key', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const urdb = fakeUrdb({
    route: (call) =>
      call.headers['X-Api-Key'] === KEY
        ? json({ error: { code: 'API_KEY_INVALID' } }, { status: 403 })
        : undefined,
  });
  const w = setup({ store, clock, urdb });
  await connect(w);
  assert.equal(urdb.count(), 1);
  assert.equal(status(w.gladys).connected, false);
  assert.match(status(w.gladys).message.en, /refused the API key \(API_KEY_INVALID\)/);
  // No attempt at all (not even one stopped at the last moment).
  let attempts = 0;
  const readTariff = w.app.readTariff.bind(w.app);
  w.app.readTariff = (...args) => {
    attempts += 1;
    return readTariff(...args);
  };
  await advance(w, 3 * DAY);
  assert.equal(urdb.count(), 1, 'never sent again on its own');
  assert.equal(attempts, 0);
  // Gladys asks for a price: no request with the refused key.
  const ack = await w.gladys.fake.energyPrice(priceRequest(contract({ label: E1.label })));
  assert.equal(ack.success, false);
  assert.equal(urdb.count(), 1);
  // /data keeps a fingerprint, never the key.
  assert.equal(typeof store.data.refused.tag, 'number');
  assert.ok(store.data.refused.tag >= 0 && store.data.refused.tag < 256);
  assertNoKey(w);
  await w.app.stop();
  // Restart with the same key: still refused, nothing sent.
  const w2 = setup({ store, clock, urdb });
  await connect(w2);
  assert.equal(urdb.count(), 1);
  assert.match(status(w2.gladys).message.en, /refused/);
  // Saved again unchanged: still refused.
  await w2.gladys.fake.configUpdated({ api_key: KEY });
  await advance(w2, MINUTE);
  assert.equal(urdb.count(), 1);
  // A new key: tried at once.
  await w2.gladys.fake.configUpdated({ api_key: OTHER_KEY });
  await advance(w2, MINUTE);
  assert.equal(urdb.count(), 2);
  assert.equal(urdb.calls[1].headers['X-Api-Key'], OTHER_KEY);
  assert.equal(status(w2.gladys).connected, true);
  await advance(w2, 10);
  assert.equal(w2.store.data.refused, undefined);
  await w2.app.stop();
  assertNoKey(w2, OTHER_KEY);
});

test('a refusal in /data does not hold for another key typed while stopped', async (t) => {
  const store = createMemoryStore();
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const urdb = fakeUrdb({
    route: (call) =>
      call.headers['X-Api-Key'] === KEY
        ? json({ error: { code: 'API_KEY_INVALID' } }, { status: 403 })
        : undefined,
  });
  const w = setup({ store, clock, urdb });
  await connect(w);
  await w.app.stop();
  assert.ok(store.data.refused);
  // Restarted with another key (8-bit fingerprints: pick one that differs).
  const { keyTag } = await import('../src/app.js');
  let other = OTHER_KEY;
  for (let i = 0; keyTag(store.data.refused.salt, other) === store.data.refused.tag; i += 1) {
    other = `${OTHER_KEY.slice(0, -2)}${i}`;
  }
  const w2 = setup({ store, clock, urdb, config: { api_key: other } });
  t.after(() => w2.app.stop());
  await connect(w2);
  assert.equal(urdb.count(), 2);
  assert.equal(status(w2.gladys).connected, true);
});

test('a copy read 2 h before a restart (no attempt in /data): read again a day after, not before', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const store = createMemoryStore({
    tariffs: { [TOU.label]: { record: TOU, fetchedAt: clock.now() - 2 * HOUR } },
  });
  const w = setup({ store, clock });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(w.urdb.count(), 0);
  await advance(w, 21 * HOUR);
  assert.equal(w.urdb.count(), 0);
  await advance(w, 2 * HOUR);
  assert.equal(w.urdb.count(TOU.label), 1);
});

test('the Test button sends a refused key once and lifts the refusal when it works', async (t) => {
  let refuse = true;
  const urdb = fakeUrdb({
    route: () =>
      refuse ? json({ error: { code: 'API_KEY_INVALID' } }, { status: 403 }) : undefined,
  });
  const w = setup({ urdb });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(urdb.count(), 1);
  let ack = await w.gladys.fake.action('test_connection', {});
  assert.match(said(ack).en, /refused the API key/);
  assert.equal(urdb.count(), 2);
  refuse = false;
  ack = await w.gladys.fake.action('test_connection', {});
  assert.match(said(ack).en, /Key accepted/);
  assert.equal(urdb.count(), 3);
  await settle(5);
  assert.equal(status(w.gladys).connected, true);
  // Clicked again at once: nothing due, the key was just accepted: nothing sent.
  ack = await w.gladys.fake.action('test_connection', {});
  assert.match(said(ack).en, /nothing sent/);
  assert.equal(urdb.count(), 3);
});

test('a 403 that is not a key error is not a refusal: retried later', async (t) => {
  let forbid = true;
  const urdb = fakeUrdb({
    route: () => (forbid ? new Response('<html>Forbidden</html>', { status: 403 }) : undefined),
  });
  const w = setup({ urdb });
  t.after(() => w.app.stop());
  await connect(w);
  assert.doesNotMatch(status(w.gladys).message.en, /refused/);
  forbid = false;
  await advance(w, 11 * MINUTE);
  assert.equal(urdb.count(TOU.label), 2);
  assert.equal(status(w.gladys).connected, true);
});

test('429 with Retry-After: every request paused, in /data, honoured after a restart', async (t) => {
  const store = createMemoryStore();
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  let limited = true;
  const urdb = fakeUrdb({
    route: () =>
      limited
        ? json(
            { error: { code: 'OVER_RATE_LIMIT' } },
            { status: 429, headers: { 'retry-after': '7200' } },
          )
        : undefined,
  });
  const w = setup({
    store,
    clock,
    urdb,
    contracts: [contract(), contract({ id: 'c-2', label: E1.label })],
  });
  await connect(w);
  assert.equal(urdb.count(), 1, 'the second tariff is not asked during the pause');
  assert.match(status(w.gladys).message.en, /paused until 14:00 UTC/);
  assert.equal(status(w.gladys).connected, false);
  assert.equal(store.data.pause.code, 'rate_limited');
  // Gladys asks for a price of a tariff not held: refused at once, nothing sent.
  const ack = await w.gladys.fake.energyPrice(priceRequest());
  assert.equal(ack.success, false);
  assert.match(ack.error, /paused/);
  // Find and Test say the pause, send nothing.
  assert.match(
    said(await w.gladys.fake.action('find_tariffs', { zip: '85004' })).en,
    /paused until/,
  );
  assert.match(said(await w.gladys.fake.action('test_connection', {})).en, /paused until/);
  assert.equal(urdb.count(), 1);
  await w.app.stop();
  limited = false;
  const w2 = setup({ store, clock, urdb, contracts: w.gladys.fake.energyContracts });
  t.after(() => w2.app.stop());
  await connect(w2);
  await advance(w2, HOUR);
  assert.equal(urdb.count(), 1);
  await advance(w2, HOUR + MINUTE);
  assert.equal(urdb.count(), 3, 'both tariffs once the pause is over');
  assert.equal(status(w2.gladys).connected, true);
});

test('the quota header at 0: an hour of pause before the next request', async (t) => {
  const urdb = fakeUrdb({
    route: (call) =>
      call.query.getpage === E1.label
        ? json({ items: [E1] }, { headers: { 'x-ratelimit-remaining': '0' } })
        : undefined,
  });
  // E1 sorts first: read, the quota at 0, TOU waits.
  const w = setup({ urdb, contracts: [contract(), contract({ id: 'c-2', label: E1.label })] });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(urdb.count(), 1);
  assert.equal(urdb.count(E1.label), 1);
  await advance(w, 59 * MINUTE);
  assert.equal(urdb.count(), 1);
  await advance(w, 2 * MINUTE + 10_000);
  assert.equal(urdb.count(TOU.label), 1);
});

test('5xx: a short pause (1 min, doubled), bounded to 6 h', async (t) => {
  const urdb = fakeUrdb({ route: () => new Response('down', { status: 503 }) });
  const w = setup({ urdb });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(urdb.count(), 1);
  await advance(w, 30_000);
  assert.equal(urdb.count(), 1);
  for (let i = 0; i < 30; i += 1) await advance(w, HOUR);
  const pause = w.store.data.pause;
  assert.ok(pause.until - w.clock.now() <= 6 * HOUR + 1000);
  assert.ok(urdb.count() < 20, `${urdb.count()} requests in 30 h`);
});

test('two requests never closer than 2 s, one in flight', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const times = [];
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const urdb = fakeUrdb({
    route: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      times.push(clock.monotonic());
      await settle(3);
      inFlight -= 1;
      return undefined;
    },
  });
  const w = setup({
    urdb,
    clock,
    minGap: 2000,
    contracts: [
      contract(),
      contract({ id: 'b', label: E1.label }),
      contract({ id: 'c', label: R3.label }),
    ],
  });
  t.after(() => w.app.stop());
  await w.gladys.connect();
  await settle(10);
  for (let i = 0; i < 10; i += 1) {
    await clock.advance(500);
    await settle(5);
  }
  assert.equal(urdb.count(), 3);
  assert.equal(peak, 1);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 2000);
});

test('getConfig failing in connected: retried, the status says it, then the start', async (t) => {
  const w = setup({ config: {} });
  t.after(() => w.app.stop());
  await connect(w);
  // A reconnection whose getConfig fails once.
  let fails = 1;
  const getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('busy');
    }
    return { api_key: KEY };
  };
  w.app.connected(getConfig);
  await settle(10);
  assert.match(status(w.gladys).message.en, /configuration could not be read/);
  assert.equal(w.urdb.count(), 0);
  await advance(w, 6000);
  assert.equal(w.urdb.count(TOU.label), 1);
  assert.equal(status(w.gladys).connected, true);
});

test('getEnergyContracts failing: said in the status, read again 5 min later', async (t) => {
  const w = setup();
  t.after(() => w.app.stop());
  let fails = 1;
  const real = w.gladys.getEnergyContracts.bind(w.gladys);
  w.gladys.getEnergyContracts = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('busy');
    }
    return real();
  };
  await connect(w);
  assert.match(status(w.gladys).message.en, /contracts could not be read/);
  assert.equal(w.urdb.count(), 0);
  await advance(w, 5 * MINUTE + 1000);
  assert.equal(w.urdb.count(TOU.label), 1);
  assert.equal(status(w.gladys).connected, true);
});

test('/data unreadable: nothing sent on its own, nothing written; read again every 10 s', async (t) => {
  const store = createMemoryStore({ refused: undefined });
  store.broken = true;
  const w = setup({ store });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(w.urdb.count(), 0, 'a refusal or a pause it holds is unknown: never sent blind');
  assert.match(status(w.gladys).message.en, /\/data cannot be read/);
  assert.equal(store.saves, 0);
  const ack = await w.gladys.fake.energyPrice(priceRequest());
  assert.equal(ack.success, false);
  store.broken = false;
  await advance(w, 10_000);
  await advance(w, 10);
  assert.equal(w.urdb.count(TOU.label), 1);
  assert.ok(store.saves > 0);
  assert.equal(status(w.gladys).connected, true);
});

test('/data that never answers: one read at a time, the start never blocked', async (t) => {
  const store = createMemoryStore();
  let release;
  store.loadHold = new Promise((resolve) => (release = resolve));
  let loads = 0;
  const load = store.load.bind(store);
  store.load = () => {
    loads += 1;
    return load();
  };
  const w = setup({ store });
  t.after(() => w.app.stop());
  await w.gladys.connect();
  await advance(w, 3000);
  assert.match(status(w.gladys).message.en, /\/data cannot be read/);
  await advance(w, 30_000);
  assert.equal(loads, 1, 'the hanging read is awaited again, never doubled');
  release();
  store.loadHold = undefined;
  await advance(w, 10_000);
  await advance(w, 10);
  assert.equal(w.urdb.count(TOU.label), 1);
});

test('a file that is not ours is set aside, never overwritten', async (t) => {
  const store = createMemoryStore();
  store.load = async () => ({ ok: false, code: 'not_state' });
  const w = setup({ store });
  t.after(() => w.app.stop());
  await connect(w);
  assert.equal(store.asides, 1);
  assert.equal(w.urdb.count(TOU.label), 1);
});

test('a copy in /data that no longer parses, or dated in the future, is read again', async (t) => {
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const broken = structuredClone(TOU);
  broken.energyratestructure = 'x';
  const store = createMemoryStore({
    tariffs: {
      [TOU.label]: { record: broken, fetchedAt: clock.now() },
      [E1.label]: { record: E1, fetchedAt: clock.now() + DAY },
    },
    asked: { [TOU.label]: { at: clock.now() + 3 * DAY, failures: 0 } },
    pause: { until: clock.now() + 365 * DAY, count: 1, code: 'rate_limited' },
  });
  const w = setup({
    store,
    clock,
    contracts: [contract(), contract({ id: 'b', label: E1.label })],
  });
  t.after(() => w.app.stop());
  await connect(w);
  // The pause from /data is capped to 6 h; then both are read.
  assert.equal(w.urdb.count(), 0);
  await advance(w, 6 * HOUR + MINUTE);
  assert.equal(w.urdb.count(E1.label), 1);
  assert.equal(w.urdb.count(TOU.label), 1);
});

test('energyCurrent: the price now from the copy, null without one (under 5 s)', async (t) => {
  const clock = testClock({ start: Date.parse('2026-07-15T21:10:00Z') });
  const w = setup({ clock });
  t.after(() => w.app.stop());
  await connect(w);
  const c = contract();
  const ack = await w.gladys.fake.energyCurrent({
    contract: wireContract(c),
    billing_period: JULY,
    cumulative: { day: 0, month: 0, billing_period: 10 },
    max_power_kw: 1,
  });
  assert.equal(ack.success, true, JSON.stringify(ack));
  assert.equal(ack.data.price, 0.318);
  assert.equal(ack.data.next_price, 0.441);
  const none = await w.gladys.fake.energyCurrent({
    contract: wireContract(contract({ label: '111111111111111111111111' })),
    billing_period: JULY,
    cumulative: { billing_period: 0 },
    max_power_kw: 1,
  });
  assert.equal(none.success, true);
  assert.equal(none.data.price, null);
  // A tariff not held yet but read in time: priced at once (Gladys keeps the answer 5 min).
  const fresh = contract({ id: 'c-5', label: E1.label });
  w.gladys.fake.energyContracts = [c, fresh];
  const late = await w.gladys.fake.energyCurrent({
    contract: wireContract(fresh),
    billing_period: JULY,
    cumulative: { billing_period: 0 },
    max_power_kw: 1,
  });
  assert.equal(late.data.price, 0.32561);
});

test('Find tariffs: the ZIP checked, the tariffs in effect listed with their label', async (t) => {
  const w = setup({ contracts: [] });
  t.after(() => w.app.stop());
  await connect(w);
  let ack = await w.gladys.fake.action('find_tariffs', { zip: '850' });
  assert.match(said(ack).en, /5-digit/);
  assert.equal(w.urdb.count(), 0);
  ack = await w.gladys.fake.action('find_tariffs', { zip: ' 85004 ', sector: 'Residential' });
  assert.equal(w.urdb.count(), 1);
  const q = w.urdb.calls[0].query;
  assert.equal(q.address, '85004');
  assert.equal(q.sector, 'Residential');
  assert.equal(q.approved, 'true');
  assert.equal(q.detail, 'minimal');
  assert.match(said(ack).en, /12 tariff\(s\) in effect for 85004/);
  assert.match(
    said(ack).en,
    /69a718961822c9da260daf1b Arizona Public Service Co: Time-of-Use 4pm-7pm Weekdays with Demand Charge \(R-3\) \(2026-02-01\)/,
  );
  assert.ok(!/\ufffd/.test(said(ack).en));
  w.urdb.route = () => json({ items: [] });
  ack = await w.gladys.fake.action('find_tariffs', { zip: '99999', sector: 'Industrial' });
  assert.match(said(ack).fr, /Aucun tarif approuvé/);
  w.urdb.route = () => new Response('not json', { status: 200 });
  ack = await w.gladys.fake.action('find_tariffs', { zip: '99999' });
  assert.match(said(ack).en, /Search failed/);
});

test('stop: no timer nor request left behind', async () => {
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const urdb = fakeUrdb({ route: () => new Promise(() => {}) });
  const w = setup({ clock, urdb });
  await w.gladys.connect();
  await settle(10);
  await clock.advance(10);
  await settle(10);
  assert.equal(urdb.count(), 1, 'a request hangs');
  await w.gladys.fake.shutdown();
  await settle(10);
  assert.equal(clock.pending, 0, 'no timer pending after stop');
  assert.ok(urdb.calls[0].signal.aborted, 'the request in flight was aborted');
  const n = urdb.count();
  await clock.advance(3 * DAY);
  assert.equal(urdb.count(), n);
});

test('the templates of the manifest are the ones the code prices', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(
    readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    manifest.energy_contracts.templates.map((t) => t.key),
    TEMPLATE_KEYS,
  );
});

test('a request that meets a pause on its turn is not sent and not counted as a failure', async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const urdb = fakeUrdb({
    route: async (call) => {
      if (call.query.getpage === E1.label) {
        await gate;
        return json({ error: { code: 'OVER_RATE_LIMIT' } }, { status: 429 });
      }
      return undefined;
    },
  });
  const w = setup({ urdb, contracts: [contract({ label: E1.label })] });
  t.after(async () => {
    release();
    await w.app.stop();
  });
  await w.gladys.connect();
  await settle(10);
  await w.clock.advance(10);
  await settle(10);
  assert.equal(urdb.count(E1.label), 1, 'E1 in flight');
  // Gladys asks for another tariff meanwhile: queued behind E1.
  const other = contract({ id: 'c-3', label: R3.label, timezone: 'America/Phoenix' });
  const priced = w.gladys.fake.energyPrice(priceRequest(other));
  await settle(10);
  release();
  const ack = await priced;
  assert.equal(ack.success, false);
  assert.equal(urdb.count(R3.label), 0, 'never sent during the pause');
  assert.equal(w.app.asked.get(R3.label), undefined, 'no attempt recorded');
});

test('stop while a request waits for its turn: no timer left, nothing sent after', async () => {
  const clock = testClock({ start: Date.UTC(2026, 10, 11, 12) });
  const w = setup({
    clock,
    minGap: 2000,
    contracts: [contract(), contract({ id: 'b', label: E1.label })],
  });
  await w.gladys.connect();
  await settle(10);
  await clock.advance(10);
  await settle(10);
  assert.equal(w.urdb.count(), 1, 'the second waits 2 s');
  await w.gladys.fake.shutdown();
  await settle(10);
  assert.equal(clock.pending, 0, 'the wait was cancelled');
  await clock.advance(DAY);
  assert.equal(w.urdb.count(), 1);
});
