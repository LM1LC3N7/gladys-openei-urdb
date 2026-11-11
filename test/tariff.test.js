// -----------------------------------------------------------------------------
// The URDB record -> model, on real records (fixtures: PG&E E-TOU-C and E-1,
// APS R-3, read from URDB v7 on 2026-11-11) and on broken ones.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TariffError, cleanText, keptRecord, labelOf, parseTariff } from '../src/tariff.js';
import { E1, R3, TOU } from './helpers/world.js';

const clone = (value) => structuredClone(value);
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof TariffError, err?.stack);
    return err.code;
  }
  return 'none';
};

test('PG&E E-TOU-C: 4 periods, daily baseline tiers, fixed charge per day, nothing left out', () => {
  const m = parseTariff(TOU);
  assert.equal(m.label, '69de6fa62aa9e9994f0ed2bd');
  assert.equal(m.utility, 'Pacific Gas & Electric Co');
  assert.equal(m.periods.length, 4);
  assert.deepEqual(m.periods[0], [
    { upTo: 13.5, daily: true, price: 0.441 },
    { upTo: null, daily: true, price: 0.5224 },
  ]);
  assert.equal(m.hasDaily, true);
  assert.deepEqual(m.fixed, { amount: 0.79343, units: '$/day' });
  assert.deepEqual(m.notComputed, []);
  assert.equal(m.startdate, 1774598400 * 1000);
  assert.equal(m.enddate, null);
  // July, 16:00: the summer peak period.
  assert.equal(m.weekday[6][16], 0);
  assert.equal(m.weekend[0][3], 3);
});

test('PG&E E-1: three tiers (the last bound of URDB ignored: the last tier is open)', () => {
  const m = parseTariff(E1);
  assert.equal(m.periods[0].length, 3);
  assert.equal(m.periods[0][1].upTo, 28.4);
  assert.equal(m.periods[0][2].upTo, null);
});

test('APS R-3: rate + adjustment, monthly tiers, demand charges reported as not computed', () => {
  const m = parseTariff(R3);
  assert.equal(m.periods.length, 5);
  assert.ok(Math.abs(m.periods[1][0].price - (0.14227 + 0.029831)) < 1e-12);
  assert.equal(m.hasDaily, false);
  assert.deepEqual(m.notComputed, ['demand']);
});

test('what Gladys cannot price is listed: flat and coincident demand, the minimum bill', () => {
  const r = clone(TOU);
  r.flatdemandstructure = [[{ rate: 5 }]];
  r.coincidentratestructure = [[{ rate: 0, adj: 1 }]];
  r.mincharge = 10;
  r.demandratestructure = [[{ rate: 0 }]];
  assert.deepEqual(parseTariff(r).notComputed, ['flat_demand', 'coincident', 'min_charge']);
});

test('refused, never priced as something else', () => {
  const variants = {
    tier_unit: (r) => (r.energyratestructure[0][0].unit = 'kWh/kW'),
    rate_range: (r) => (r.energyratestructure[1][0].rate = 12),
    no_energy: (r) => delete r.energyratestructure,
    country: (r) => (r.country = 'CAN'),
    schedule: (r) => (r.energyweekdayschedule[3][5] = 4),
    format: (r) => (r.label = 'not-a-label'),
  };
  for (const [expected, change] of Object.entries(variants)) {
    const r = clone(TOU);
    change(r);
    assert.equal(
      code(() => parseTariff(r)),
      expected,
      expected,
    );
  }
  const negative = clone(TOU);
  negative.energyratestructure[0][0].adj = -0.5;
  assert.equal(
    code(() => parseTariff(negative)),
    'rate_range',
  );
  const fuel = clone(TOU);
  fuel.fueladjustmentsmonthly = Array(12).fill(-1);
  assert.equal(
    code(() => parseTariff(fuel)),
    'rate_range',
  );
  const decreasing = clone(E1);
  decreasing.energyratestructure[0][1].max = 7;
  assert.equal(
    code(() => parseTariff(decreasing)),
    'structure',
  );
  const hole = clone(E1);
  delete hole.energyratestructure[0][0].max;
  assert.equal(
    code(() => parseTariff(hole)),
    'structure',
  );
  const short = clone(TOU);
  short.energyweekendschedule = short.energyweekendschedule.slice(0, 11);
  assert.equal(
    code(() => parseTariff(short)),
    'schedule',
  );
  const text = clone(TOU);
  text.energyratestructure[0][0].rate = '0.44';
  assert.equal(
    code(() => parseTariff(text)),
    'structure',
  );
  for (const bad of [null, [], 'x', 42])
    assert.equal(
      code(() => parseTariff(bad)),
      'format',
    );
});

test('a tariff without a weekend schedule uses the weekday one; the fuel adjustment is kept', () => {
  const r = clone(R3);
  delete r.energyweekendschedule;
  r.fueladjustmentsmonthly = Array(12).fill(0.01);
  const m = parseTariff(r);
  assert.deepEqual(m.weekend, m.weekday);
  assert.equal(m.fuel[5], 0.01);
});

test('a yearly fixed charge keeps its unit; an unknown unit reads as monthly', () => {
  const r = clone(R3);
  r.fixedchargeunits = '$/year';
  assert.deepEqual(parseTariff(r).fixed, { amount: 0.458, units: '$/year' });
  r.fixedchargeunits = 'weird';
  assert.equal(parseTariff(r).fixed.units, '$/month');
});

test('labelOf: the 24 characters, or the URDB page address; anything else is refused', () => {
  const label = '69de6fa62aa9e9994f0ed2bd';
  assert.equal(labelOf(label), label);
  assert.equal(labelOf(` ${label.toUpperCase()} `), label);
  assert.equal(labelOf(`https://apps.openei.org/IURDB/rate/view/${label}`), label);
  assert.equal(labelOf(`https://apps.openei.org/USURDB/rate/view/${label}#3__Energy`), label);
  assert.equal(labelOf(`https://openei.org/apps/IURDB/rate/view/${label}`), label);
  for (const bad of [
    '',
    undefined,
    42,
    label.slice(1),
    `${label}0`,
    `http://apps.openei.org/IURDB/rate/view/${label}`,
    `https://evil.example/IURDB/rate/view/${label}`,
    `https://apps.openei.org.evil.example/IURDB/rate/view/${label}`,
    `${label}\n`.repeat(20),
  ]) {
    assert.equal(labelOf(bad), undefined, String(bad));
  }
});

test('cleanText: control characters and replacement characters out, bounded', () => {
  assert.equal(cleanText('If you\ufffdre\r\nlow\u2028income'), 'If you re low income');
  assert.equal(cleanText('x'.repeat(300)).length, 120);
  assert.equal(cleanText('  \n '), undefined);
  assert.equal(cleanText(7), undefined);
});

test('keptRecord keeps what the model reads, and parses back the same', () => {
  const kept = keptRecord(TOU);
  assert.ok(!('description' in kept) && !('source' in kept));
  assert.deepEqual(parseTariff(kept), parseTariff(TOU));
});
