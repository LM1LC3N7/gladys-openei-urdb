// -----------------------------------------------------------------------------
// One URDB record (API v7, full detail) -> the tariff model the pricing reads.
// Pure, linear, bounded: a record from the network is never trusted.
//
// What the model keeps, from the URDB schema:
//   - energyratestructure: periods, each a list of tiers { max, unit, rate,
//     adj }. The price of a tier is rate + adj ($/kWh). `max` is the upper
//     bound of the tier, cumulative over the billing period; its unit is
//     "kWh" (a monthly bound) or "kWh daily" (a bound per day, times the days
//     of the billing period: the baseline allowances of California). The last
//     tier has no bound (a last bound given anyway is extended).
//   - energyweekdayschedule / energyweekendschedule: 12 months x 24 hours of
//     period indexes, in the local time of the utility.
//   - fueladjustmentsmonthly: $/kWh added per month.
//   - fixedchargefirstmeter + fixedchargeunits: the fixed charge, reported
//     only (the user types it in the contract: Gladys computes it).
//
// What Gladys cannot price in this delegated mode, reported and never priced
// as something else: demand charges (demandratestructure, flatdemandstructure,
// coincidentratestructure), the minimum bill (mincharge). What the module
// refuses (no cost rather than a wrong one): tiers bounded in kWh per kW of
// demand ("kWh/kW"), a rate below zero or above 10 $/kWh, a schedule that
// does not point to a period, a tariff without energy charge or outside the
// USA.
// -----------------------------------------------------------------------------

import { MAX_PRICE_PER_KWH } from './constants.js';

export class TariffError extends Error {
  /** @param {string} code a key of i18n PROBLEMS */
  constructor(code) {
    super(`unusable tariff: ${code}`);
    this.name = 'TariffError';
    this.code = code;
  }
}

/** A URDB label: 24 hexadecimal characters (the last segment of the rate page). */
export const LABEL = /^[0-9a-f]{24}$/;

const MAX_PERIODS = 48;
const MAX_TIERS = 24;
const MAX_TEXT = 120;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The label typed in a contract: the 24 hexadecimal characters, or a URDB page
 * address ending with them. Undefined when it is not one (never guessed).
 */
export function labelOf(input) {
  if (typeof input !== 'string') return undefined;
  const text = input.trim();
  if (text.length === 0 || text.length > 200) return undefined;
  const lower = text.toLowerCase();
  if (LABEL.test(lower)) return lower;
  const match =
    /^https:\/\/(?:apps\.)?openei\.org\/(?:iurdb\/rate\/view|apps\/iurdb\/rate\/view|apps\/usurdb\/rate\/view|usurdb\/rate\/view)\/([0-9a-f]{24})(?:[/?#].*)?$/.exec(
      lower,
    );
  return match ? match[1] : undefined;
}

/** A text from the source: control characters out, spaces folded, bounded. Undefined when empty. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\0-\x1f\x7f-\x9f\u2028\u2029\ufffd]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Epoch seconds -> ms, or null. */
function dateOf(value) {
  if (!Number.isInteger(value) || value < 0 || value > 4_102_444_800) return null;
  return value * 1000;
}

/** A charge structure that charges something (a rate or an adjustment above 0). */
function charges(structure) {
  if (!Array.isArray(structure)) return false;
  return structure
    .slice(0, MAX_PERIODS)
    .some(
      (period) =>
        Array.isArray(period) &&
        period
          .slice(0, MAX_TIERS)
          .some(
            (tier) =>
              isObject(tier) &&
              ((finite(tier.rate) && tier.rate > 0) || (finite(tier.adj) && tier.adj > 0)),
          ),
    );
}

/** 12 x 24 integers in [0, periods): else a TariffError. */
function schedule(grid, periods) {
  if (!Array.isArray(grid) || grid.length !== 12) throw new TariffError('schedule');
  return grid.map((month) => {
    if (!Array.isArray(month) || month.length !== 24) throw new TariffError('schedule');
    return month.map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= periods) {
        throw new TariffError('schedule');
      }
      return index;
    });
  });
}

/** One period: its tiers `{ upTo: number|null, daily: boolean, price }`, bounds increasing. */
function period(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > MAX_TIERS) {
    throw new TariffError('structure');
  }
  let previous = 0;
  return tiers.map((tier, index) => {
    if (!isObject(tier)) throw new TariffError('structure');
    const unit = tier.unit === undefined || tier.unit === null ? 'kWh' : tier.unit;
    if (unit !== 'kWh' && unit !== 'kWh daily') throw new TariffError('tier_unit');
    const hasRate = finite(tier.rate);
    const hasAdj = finite(tier.adj);
    if ((tier.rate !== undefined && !hasRate) || (tier.adj !== undefined && !hasAdj)) {
      throw new TariffError('structure');
    }
    if (!hasRate && !hasAdj) throw new TariffError('structure');
    const price = (hasRate ? tier.rate : 0) + (hasAdj ? tier.adj : 0);
    // Checked in [0, 10] with the fuel adjustment of each month (parseTariff).
    let upTo = null;
    const last = index === tiers.length - 1;
    if (tier.max !== undefined && tier.max !== null && !last) {
      if (!finite(tier.max) || tier.max <= previous) throw new TariffError('structure');
      upTo = tier.max;
      previous = tier.max;
    } else if (!last) {
      // A tier without a bound before the last one: the next ones are unreachable.
      throw new TariffError('structure');
    }
    return { upTo, daily: unit === 'kWh daily', price };
  });
}

/**
 * The model of a URDB record, or a TariffError. `notComputed` lists what the
 * tariff charges that Gladys does not price here (said in the status).
 */
export function parseTariff(record) {
  if (!isObject(record)) throw new TariffError('format');
  const label = typeof record.label === 'string' ? record.label.toLowerCase() : '';
  if (!LABEL.test(label)) throw new TariffError('format');
  if (record.country !== undefined && record.country !== null && record.country !== 'USA') {
    throw new TariffError('country');
  }
  const structure = record.energyratestructure;
  if (!Array.isArray(structure) || structure.length === 0) throw new TariffError('no_energy');
  if (structure.length > MAX_PERIODS) throw new TariffError('structure');
  const periods = structure.map(period);
  const weekday = schedule(record.energyweekdayschedule, periods.length);
  const weekend =
    record.energyweekendschedule === undefined || record.energyweekendschedule === null
      ? weekday
      : schedule(record.energyweekendschedule, periods.length);
  let fuel = null;
  if (record.fueladjustmentsmonthly !== undefined && record.fueladjustmentsmonthly !== null) {
    const list = record.fueladjustmentsmonthly;
    if (!Array.isArray(list) || list.length !== 12 || !list.every(finite)) {
      throw new TariffError('structure');
    }
    fuel = list.slice();
  }
  // The price of every tier, fuel adjustment of each month included, stays in [0, 10].
  for (let month = 0; month < 12; month += 1) {
    const adj = fuel ? fuel[month] : 0;
    for (const tiers of periods) {
      for (const tier of tiers) {
        const total = tier.price + adj;
        if (total < 0 || total > MAX_PRICE_PER_KWH) throw new TariffError('rate_range');
      }
    }
  }
  const notComputed = [];
  if (charges(record.demandratestructure)) notComputed.push('demand');
  if (charges(record.flatdemandstructure)) notComputed.push('flat_demand');
  if (charges(record.coincidentratestructure)) notComputed.push('coincident');
  if (finite(record.mincharge) && record.mincharge > 0) notComputed.push('min_charge');
  let fixed = null;
  if (finite(record.fixedchargefirstmeter) && record.fixedchargefirstmeter > 0) {
    // An unknown unit is said as such, never guessed (the user types the amount).
    const units = ['$/day', '$/month', '$/year'].includes(record.fixedchargeunits)
      ? record.fixedchargeunits
      : 'unknown';
    fixed = { amount: record.fixedchargefirstmeter, units };
  }
  return {
    label,
    name: cleanText(record.name) ?? label,
    utility: cleanText(record.utility) ?? '?',
    sector: cleanText(record.sector, 20),
    approved: record.approved === true,
    startdate: dateOf(record.startdate),
    enddate: dateOf(record.enddate),
    periods,
    weekday,
    weekend,
    fuel,
    hasDaily: periods.some((tiers) => tiers.some((tier) => tier.daily)),
    fixed,
    notComputed,
  };
}

/**
 * The fields of a record the model reads (what /data keeps): parsed again at
 * load, so that a stored copy is checked like a fresh one.
 */
export const KEPT_FIELDS = [
  'label',
  'name',
  'utility',
  'sector',
  'approved',
  'country',
  'startdate',
  'enddate',
  'energyratestructure',
  'energyweekdayschedule',
  'energyweekendschedule',
  'fueladjustmentsmonthly',
  'demandratestructure',
  'flatdemandstructure',
  'coincidentratestructure',
  'mincharge',
  'fixedchargefirstmeter',
  'fixedchargeunits',
];

const FLAG_FIELDS = new Set([
  'demandratestructure',
  'flatdemandstructure',
  'coincidentratestructure',
]);

/**
 * The fields kept in /data. The demand structures (possibly large, never
 * priced) are kept only as "charges something": one tier of rate 1, or out.
 */
export function keptRecord(record) {
  const kept = {};
  for (const key of KEPT_FIELDS) {
    if (record[key] === undefined) continue;
    if (FLAG_FIELDS.has(key)) {
      if (charges(record[key])) kept[key] = [[{ rate: 1 }]];
    } else {
      kept[key] = record[key];
    }
  }
  return kept;
}
