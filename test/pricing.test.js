// -----------------------------------------------------------------------------
// The delegated pricing on real tariffs: periods by month and hour in the
// utility's local time (changes of time included), tiers on the billing
// period, daily bounds times the days of the period and of the contract,
// determinism, current price and its next change.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PricingError, currentPrice, priceIntervals, tieredCost } from '../src/pricing.js';
import { parseTariff } from '../src/tariff.js';
import { daysInPeriod, localParts } from '../src/time.js';
import { E1, R3, TOU, halfHours } from './helpers/world.js';

const LA = 'America/Los_Angeles';
const JULY = { starts_at: '2026-07-01T07:00:00.000Z', ends_at: '2026-08-01T07:00:00.000Z' };
const tou = parseTariff(TOU);
const e1 = parseTariff(E1);
const r3 = parseTariff(R3);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const price = (model, intervals, options = {}) =>
  priceIntervals(model, {
    timezone: LA,
    billingPeriod: JULY,
    cumulativeBefore: { day: 0, month: 0, billing_period: 0 },
    intervals,
    validity: { validFrom: '2026-01-01', validTo: null },
    ...options,
  });

test('E-TOU-C in July: off-peak 15:00, peak 16:00-21:00 (Pacific time), baseline tier', () => {
  // 2026-07-15 15:00 PDT = 22:00 UTC; 16:00 PDT = 23:00 UTC.
  const costs = price(tou, halfHours('2026-07-15T22:00:00Z', 4, 1));
  near(costs[0].cost, 0.318);
  near(costs[2].cost, 0.441);
  assert.equal(costs[0].label, 'URDB P2 T1');
  assert.equal(costs[2].label, 'URDB P1 T1');
});

test('the same instant in winter: the winter periods', () => {
  // 2026-01-15 16:00 PST = 00:00 UTC on the 16th.
  const costs = price(tou, halfHours('2026-01-16T00:00:00Z', 1, 1), {
    billingPeriod: { starts_at: '2026-01-01T08:00:00Z', ends_at: '2026-02-01T08:00:00Z' },
  });
  near(costs[0].cost, 0.31617);
});

test('a daily bound times the days of the billing period: an interval straddling it is split', () => {
  // 13.5 kWh a day x 31 days = 418.5 kWh; 418 before, 1 kWh at peak: 0.5 at 0.441, 0.5 at 0.5224.
  const costs = price(tou, halfHours('2026-07-15T23:00:00Z', 1, 1), {
    cumulativeBefore: { billing_period: 418 },
  });
  near(costs[0].cost, 0.5 * 0.441 + 0.5 * 0.5224);
  assert.equal(costs[0].label, 'URDB P1 T2');
});

test('the days counted are those of the contract inside the period (a contract starting mid-period)', () => {
  // From July 21: 11 days, 148.5 kWh of baseline.
  const costs = price(tou, halfHours('2026-07-25T23:00:00Z', 1, 1), {
    cumulativeBefore: { billing_period: 148 },
    validity: { validFrom: '2026-07-21', validTo: null },
  });
  near(costs[0].cost, 0.5 * 0.441 + 0.5 * 0.5224);
  assert.equal(
    daysInPeriod(Date.parse(JULY.starts_at), Date.parse(JULY.ends_at), LA, {
      validFrom: '2026-07-21',
      validTo: '2026-07-25',
    }),
    5,
  );
});

test('a tariff with daily bounds without the contract validity: no cost, never a guess', () => {
  assert.throws(
    () => price(tou, halfHours('2026-07-15T23:00:00Z', 1), { billingPeriod: undefined }),
    PricingError,
  );
  assert.throws(
    () =>
      price(tou, halfHours('2026-07-15T23:00:00Z', 1), {
        validity: { validFrom: '2026-09-01', validTo: null },
      }),
    PricingError,
  );
});

test('monthly tiers accumulate over the request, in time order whatever the order received', () => {
  // E-1 region V, July: 7.1 x 31 = 220.1 kWh at 0.32561, then 0.40702.
  const intervals = halfHours('2026-07-10T07:00:00Z', 4, 1);
  const forward = price(e1, intervals, { cumulativeBefore: { billing_period: 218.6 } });
  near(forward[0].cost, 0.32561);
  near(forward[1].cost, 0.5 * 0.32561 + 0.5 * 0.40702);
  near(forward[2].cost, 0.40702);
  const backward = price(e1, intervals.slice().reverse(), {
    cumulativeBefore: { billing_period: 218.6 },
  });
  assert.deepEqual(backward.slice().reverse(), forward);
  // A retry of the same request gives the same answer.
  assert.deepEqual(price(e1, intervals, { cumulativeBefore: { billing_period: 218.6 } }), forward);
});

test('APS R-3: weekday on-peak 16:00-19:00, weekend off-peak, Arizona without changes of time', () => {
  const AZ = 'America/Phoenix';
  const period = { starts_at: '2026-07-01T07:00:00Z', ends_at: '2026-08-01T07:00:00Z' };
  // Wednesday 2026-07-15 16:00 MST = 23:00 UTC; Saturday 2026-07-18 same hour.
  const weekday = price(r3, halfHours('2026-07-15T23:00:00Z', 1, 1), {
    timezone: AZ,
    billingPeriod: period,
  });
  const weekend = price(r3, halfHours('2026-07-18T23:00:00Z', 1, 1), {
    timezone: AZ,
    billingPeriod: period,
  });
  // Sunday 2026-07-19: the weekend schedule too.
  const sunday = price(r3, halfHours('2026-07-19T23:00:00Z', 1, 1), {
    timezone: AZ,
    billingPeriod: period,
  });
  near(sunday[0].cost, 0.05943 + 0.029831);
  near(weekday[0].cost, 0.14227 + 0.029831);
  near(weekend[0].cost, 0.05943 + 0.029831);
  // January: 16:00 MST is still 23:00 UTC (no DST): winter weekday period 4.
  const winter = price(r3, halfHours('2026-01-14T23:00:00Z', 1, 1), {
    timezone: AZ,
    billingPeriod: { starts_at: '2026-01-01T07:00:00Z', ends_at: '2026-02-01T07:00:00Z' },
  });
  near(winter[0].cost, 0.09932 + 0.029831);
});

test('changes of time: spring forward and fall back follow the local hour', () => {
  // 2026-03-08: 02:00 PST -> 03:00 PDT. 09:30 UTC = 01:30 PST, 10:00 UTC = 03:00 PDT.
  assert.equal(localParts(Date.parse('2026-03-08T09:30:00Z'), LA).hour, 1);
  assert.equal(localParts(Date.parse('2026-03-08T10:00:00Z'), LA).hour, 3);
  // 2026-11-01: 01:00-02:00 happens twice (08:00 and 09:00 UTC): both are hour 1.
  assert.equal(localParts(Date.parse('2026-11-01T08:30:00Z'), LA).hour, 1);
  assert.equal(localParts(Date.parse('2026-11-01T09:30:00Z'), LA).hour, 1);
  // The 25-hour day of November has 50 half hours, all priced, 16:00-21:00 local at peak.
  const day = halfHours('2026-11-01T07:00:00Z', 50, 1);
  const costs = price(tou, day, {
    billingPeriod: { starts_at: '2026-11-01T07:00:00Z', ends_at: '2026-12-01T08:00:00Z' },
  });
  assert.equal(costs.length, 50);
  const peaks = costs.filter((c) => c.label === 'URDB P3 T1').length;
  assert.equal(peaks, 10, '5 hours of winter peak, on the local clock');
  // November 2026: 30 local days although it lasts 30 days and 1 hour.
  assert.equal(
    daysInPeriod(Date.parse('2026-11-01T07:00:00Z'), Date.parse('2026-12-01T08:00:00Z'), LA),
    30,
  );
});

test('east and west of UTC at midnight: the local month decides the season', () => {
  // 2026-06-01 03:00 UTC is still May 31 in New York (23:00) and in Los Angeles (20:00).
  assert.equal(localParts(Date.parse('2026-06-01T03:00:00Z'), 'America/New_York').month, 5);
  assert.equal(
    localParts(Date.parse('2026-06-01T03:00:00Z'), 'Pacific/Honolulu').date,
    '2026-05-31',
  );
  // A UTC+ zone (a contract set elsewhere by mistake) reads June.
  assert.equal(localParts(Date.parse('2026-05-31T23:00:00Z'), 'Asia/Tokyo').month, 6);
  const may = price(tou, halfHours('2026-06-01T03:00:00Z', 1, 1), {
    billingPeriod: { starts_at: '2026-05-01T07:00:00Z', ends_at: '2026-06-01T07:00:00Z' },
  });
  // May 31 20:00 PDT: winter peak (period 3) at 0.31617.
  near(may[0].cost, 0.31617);
});

test('the fuel adjustment of the month is added per kWh', () => {
  const r = structuredClone(R3);
  r.fueladjustmentsmonthly = [0, 0, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, 0];
  const costs = price(parseTariff(r), halfHours('2026-07-15T23:00:00Z', 1, 2), {
    timezone: 'America/Phoenix',
  });
  near(costs[0].cost, 2 * (0.14227 + 0.029831 + 0.02));
});

test('hostile or unusable requests: a throw, never a silent zero', () => {
  const one = halfHours('2026-07-15T23:00:00Z', 1);
  assert.throws(() => price(r3, one, { timezone: 'Mars/Base' }), PricingError);
  assert.throws(() => price(r3, one, { cumulativeBefore: {} }), PricingError);
  assert.throws(() => price(r3, one, { cumulativeBefore: { billing_period: -1 } }), PricingError);
  assert.throws(() => price(r3, [{ starts_at: 'nope', kwh: 1 }]), PricingError);
  assert.throws(() => price(r3, [{ starts_at: one[0].starts_at, kwh: NaN }]), PricingError);
  assert.throws(() => price(r3, halfHours('2026-07-01T07:00:00Z', 2001)), PricingError);
  // A negative reading (never sent for a consumption) costs nothing and counts nothing.
  const costs = price(r3, [{ starts_at: one[0].starts_at, kwh: -3 }]);
  assert.equal(costs[0].cost, 0);
  // ...and never brings the next interval back to a lower tier.
  const after = price(
    e1,
    [
      { starts_at: '2026-07-10T07:00:00Z', kwh: -3 },
      { starts_at: '2026-07-10T07:30:00Z', kwh: 1 },
    ],
    { cumulativeBefore: { billing_period: 221 } },
  );
  near(after[1].cost, 0.40702);
  // Empty interval: no cost, the tier of the position.
  assert.equal(price(e1, halfHours('2026-07-10T07:00:00Z', 1, 0))[0].cost, 0);
});

test('tieredCost: the label of the last share, the marginal tier for nothing consumed', () => {
  const tiers = [
    { upTo: 10, daily: false, price: 1 },
    { upTo: 20, daily: false, price: 2 },
    { upTo: null, daily: false, price: 3 },
  ];
  assert.deepEqual(tieredCost(tiers, 25, 0, 1), { cost: 10 + 20 + 15, tier: 2 });
  assert.deepEqual(tieredCost(tiers, 0, 15, 1), { cost: 0, tier: 1 });
  assert.deepEqual(tieredCost(tiers, 5, 30, 1), { cost: 15, tier: 2 });
});

test('current price: the price now, its end on the local clock, the next one', () => {
  const at = Date.parse('2026-07-15T21:10:00Z'); // 14:10 PDT, off-peak until 16:00.
  const now = currentPrice(tou, {
    timezone: LA,
    billingPeriod: JULY,
    cumulative: { billing_period: 10 },
    at,
    validity: { validFrom: '2026-01-01', validTo: null },
  });
  assert.equal(now.price, 0.318);
  assert.equal(now.valid_until, '2026-07-15T23:00:00.000Z');
  assert.equal(now.next_price, 0.441);
  // Above the baseline: the second tier.
  const above = currentPrice(tou, {
    timezone: LA,
    billingPeriod: JULY,
    cumulative: { billing_period: 500 },
    at,
    validity: { validFrom: '2026-01-01', validTo: null },
  });
  assert.equal(above.price, 0.3994);
  // A flat tariff: no change before the end of the billing period, which ends the validity.
  const flat = currentPrice(e1, {
    timezone: LA,
    billingPeriod: JULY,
    cumulative: { billing_period: 0 },
    at: Date.parse('2026-07-30T12:00:00Z'),
    validity: { validFrom: '2026-01-01', validTo: null },
  });
  assert.equal(flat.price, 0.32561);
  assert.equal(flat.valid_until, JULY.ends_at);
  assert.equal(flat.next_price, undefined);
  assert.throws(
    () => currentPrice(r3, { timezone: LA, billingPeriod: JULY, cumulative: {}, at }),
    PricingError,
  );
});
