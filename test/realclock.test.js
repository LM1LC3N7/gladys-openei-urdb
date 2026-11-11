// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, sped
// up 3600 times: an hour is a second) and a real local HTTP server playing
// URDB: a tariff URDB does not know is asked at 0, 10 min later, then 20 min
// after (never sooner, never in a loop); the contracts are read every hour;
// one request at a time, the key never in the address; the timers bounded.
// The app is stopped in `t.after`: a failure never leaves the process alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { UrdbApp } from '../src/app.js';
import { HOUR, MINUTE } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';
import { KEY, TOU, contract, quiet } from './helpers/world.js';

const SPEED = 3600;
const UNKNOWN = '000000000000000000000000';

test('real clock x3600: retry after 10 then 20 min, contracts every hour, one request at a time', async (t) => {
  const clock = realClock({ speed: SPEED });
  let inFlight = 0;
  let overlap = false;
  const seen = [];
  const server = createServer((req, res) => {
    inFlight += 1;
    if (inFlight > 1) overlap = true;
    res.on('finish', () => {
      inFlight -= 1;
    });
    seen.push({ at: clock.monotonic(), url: req.url, key: req.headers['x-api-key'] });
    const label = new URL(req.url, 'http://x').searchParams.get('getpage');
    res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '900' });
    res.end(JSON.stringify({ items: label === TOU.label ? [TOU] : [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gladys = createFakeGladys({
    selector: 'openei-urdb',
    config: { api_key: KEY },
    energyContracts: [contract(), contract({ id: 'c-2', label: UNKNOWN })],
  });
  await gladys.connect();
  const app = new UrdbApp({
    gladys,
    logger: quiet(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    url: `http://127.0.0.1:${server.address().port}/utility_rates`,
    // 15 s of the source timeout are 4 ms at this speed: a local answer gets 0.5 s.
    requestTimeout: 30 * MINUTE,
  });
  const reads = { clock, calls: [] };
  const readTariff = app.readTariff.bind(app);
  app.readTariff = (label, ...rest) => {
    if (label === UNKNOWN) reads.calls.push({ at: clock.monotonic() });
    return readTariff(label, ...rest);
  };
  const contracts = spyOn(gladys, 'getEnergyContracts', clock);
  t.after(async () => {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await app.connected(() => gladys.getConfig());
  const [first, second] = await measurePeriod(reads, {
    count: 3,
    min: 10 * MINUTE,
    max: 40 * MINUTE,
  });
  assert.ok(first >= 10 * MINUTE && first < 15 * MINUTE, `first retry ${first}`);
  assert.ok(second >= 20 * MINUTE, `second retry ${second}`);
  // The contracts are read at each check (a local call): never in a loop.
  const elapsed = clock.monotonic() - contracts.calls[0].at;
  assert.ok(
    contracts.calls.length <= 3 + (2 * elapsed) / (10 * MINUTE),
    `${contracts.calls.length} reads`,
  );
  // With nothing failing any more, a check an hour (measured on the decisions).
  gladys.fake.energyContracts = [contract()];
  const later = { clock, calls: [] };
  const check = app.check.bind(app);
  app.check = (gen) => {
    later.calls.push({ at: clock.monotonic() });
    return check(gen);
  };
  const hourly = await measurePeriod(later, { count: 3, min: 0, max: 1.5 * HOUR });
  assert.ok(hourly[1] >= 0.9 * HOUR, `checks ${hourly}`);
  assert.equal(overlap, false, 'one request at a time');
  assert.equal(
    seen.filter((s) => s.url.includes(`getpage=${TOU.label}`)).length,
    1,
    JSON.stringify(seen.map((s) => [Math.round(s.at - seen[0].at), s.url.slice(-40)])),
  );
  assert.ok(seen.every((s) => s.key === KEY && !s.url.includes(KEY)));
  assert.ok(clock.timersSet <= 200, `${clock.timersSet} timers`);
});
