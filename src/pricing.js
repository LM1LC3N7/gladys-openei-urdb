// -----------------------------------------------------------------------------
// The delegated pricing: one cost per 30-minute interval sent by Gladys, from
// the tariff model (src/tariff.js) and the state the core sends. Pure and
// deterministic: the same request always gets the same answer (Gladys retries
// a failed run and re-sends a billing period for a recalculation).
//
// For an interval starting at `starts_at`, in the contract timezone:
//   - the period is the schedule cell of its month and hour (the weekend
//     schedule on Saturday and Sunday; URDB has no holiday: a public holiday
//     is priced like the other days of its week);
//   - the tiers are judged on the kWh of the billing period before the
//     interval (`cumulative_before.billing_period`, then the intervals of the
//     request in order): the interval is split pro rata of its kWh across the
//     tiers it straddles. A "kWh daily" bound is summed over the days of the
//     billing period intersected with the contract validity, each day with
//     the bound of its own season;
//   - the fuel adjustment of the month is added per kWh.
// The cost is the energy only: the fixed charge is a component of the
// contract that Gladys computes itself; demand charges and the minimum bill
// are not computed (said in the status and the docs).
// -----------------------------------------------------------------------------

import { localParts, periodDays, validTimezone } from './time.js';

export class PricingError extends Error {
  constructor(code) {
    super(`cannot price: ${code}`);
    this.name = 'PricingError';
    this.code = code;
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/** At most what Gladys sends in one request (31 days of half hours), with a margin. */
const MAX_INTERVALS = 2000;

/** The period index of a local instant. */
function periodAt(model, local) {
  const grid = local.weekday === 0 || local.weekday === 6 ? model.weekend : model.weekday;
  return grid[local.month - 1][local.hour];
}

/**
 * The upper bound of each tier (Infinity for the last one), for an interval
 * in period `p` at local hour `hour`. A "kWh daily" bound is summed day by
 * day over the billing period (`days`: the month of each day counted): each
 * day brings the bound of its own season (the period the weekday schedule
 * gives at that hour in that day's month, same tier), as a utility prorates a
 * baseline allowance across a change of season.
 */
export function boundsOf(model, p, hour, days) {
  const tiers = model.periods[p];
  return tiers.map((tier, i) => {
    if (i === tiers.length - 1 || tier.upTo === null) return Infinity;
    if (!tier.daily) return tier.upTo;
    let sum = 0;
    for (const month of days) {
      const other = model.periods[model.weekday[month - 1][hour]][i];
      sum += other && other.daily && other.upTo !== null ? other.upTo : tier.upTo;
    }
    return sum;
  });
}

/**
 * The cost of `kwh` consumed when `before` kWh of the billing period are
 * already counted, the tiers ending at `bounds`: `{ cost, tier }` (the index
 * of the tier priced last).
 */
export function tieredCost(tiers, kwh, before, bounds) {
  let remaining = kwh;
  let position = before;
  let cost = 0;
  let { tier } = marginalPrice(tiers, before, bounds);
  for (let i = 0; i < tiers.length && remaining > 0; i += 1) {
    const last = i === tiers.length - 1;
    const part = last ? remaining : Math.min(remaining, Math.max(0, bounds[i] - position));
    if (part > 0) {
      cost += part * tiers[i].price;
      position += part;
      remaining -= part;
      tier = i;
    }
  }
  return { cost, tier };
}

/** The marginal price at `before` kWh of the billing period: `{ price, tier }`. */
export function marginalPrice(tiers, before, bounds) {
  for (let i = 0; i < tiers.length; i += 1) {
    if (i === tiers.length - 1 || before < bounds[i]) return { price: tiers[i].price, tier: i };
  }
  return { price: tiers[tiers.length - 1].price, tier: tiers.length - 1 };
}

/** The bounds of the tiers, computed once per period and hour for one request. */
function boundsCache(model, days) {
  const cache = new Map();
  return (p, hour) => {
    const key = p * 24 + hour;
    let bounds = cache.get(key);
    if (!bounds) {
      bounds = boundsOf(model, p, hour, days);
      cache.set(key, bounds);
    }
    return bounds;
  };
}

const labelOf = (period, tier, tiers) =>
  tiers > 1 ? `URDB P${period + 1} T${tier + 1}` : `URDB P${period + 1}`;

/**
 * The days of the billing period counted for a "kWh daily" bound, or a
 * PricingError (unknown validity: never a guess).
 */
export function billingDays(billingPeriod, timezone, validity) {
  const start = Date.parse(billingPeriod?.starts_at);
  const end = Date.parse(billingPeriod?.ends_at);
  if (!finite(start) || !finite(end) || end <= start || end - start > 32 * 86_400_000) {
    throw new PricingError('billing_period');
  }
  const days = periodDays(start, end, timezone, validity);
  if (!(days.length >= 1)) throw new PricingError('billing_period');
  return days;
}

/**
 * The costs of `intervals` (`[{ starts_at, kwh }]`), in the order received.
 * `validity` ({ validFrom, validTo }) is needed only by a tariff with daily
 * bounds. Throws a PricingError: Gladys then writes no cost for these
 * intervals and asks again at its next run.
 */
export function priceIntervals(
  model,
  { timezone, billingPeriod, cumulativeBefore, intervals, validity },
) {
  if (!validTimezone(timezone)) throw new PricingError('timezone');
  if (!Array.isArray(intervals) || intervals.length > MAX_INTERVALS) {
    throw new PricingError('intervals');
  }
  const before = cumulativeBefore?.billing_period;
  if (!finite(before) || before < 0) throw new PricingError('cumulative');
  const bounds = boundsCache(
    model,
    model.hasDaily ? billingDays(billingPeriod, timezone, validity) : [],
  );
  const parsed = intervals.map((interval, index) => {
    const at = Date.parse(interval?.starts_at);
    const kwh = interval?.kwh;
    if (!finite(at) || !finite(kwh)) throw new PricingError('intervals');
    return { index, at, kwh: Math.max(0, kwh), starts_at: interval.starts_at };
  });
  const ordered = parsed.slice().sort((a, b) => a.at - b.at || a.index - b.index);
  const costs = new Array(parsed.length);
  let cumulative = before;
  for (const one of ordered) {
    const local = localParts(one.at, timezone);
    const p = periodAt(model, local);
    const tiers = model.periods[p];
    const { cost, tier } = tieredCost(tiers, one.kwh, cumulative, bounds(p, local.hour));
    const fuel = model.fuel ? model.fuel[local.month - 1] * one.kwh : 0;
    cumulative += one.kwh;
    const total = cost + fuel;
    if (!finite(total) || total < 0) throw new PricingError('cost');
    costs[one.index] = {
      starts_at: one.starts_at,
      cost: Math.round(total * 1e8) / 1e8,
      label: labelOf(p, tier, tiers.length),
    };
  }
  return costs;
}

/** The unit price ($/kWh) at a local instant for `before` kWh already counted. */
function unitPrice(model, local, before, bounds) {
  const p = periodAt(model, local);
  const tiers = model.periods[p];
  const { price, tier } = marginalPrice(tiers, before, bounds(p, local.hour));
  const fuel = model.fuel ? model.fuel[local.month - 1] : 0;
  return { price: Math.round((price + fuel) * 1e6) / 1e6, label: labelOf(p, tier, tiers.length) };
}

/** The local hour starts after `at` are looked at up to this horizon for the next change. */
const HORIZON_HOURS = 8 * 24;

/**
 * The current price: `{ price, valid_until, next_price, label, next_label }`,
 * the change searched hour by hour on the local clock (a tier change caused
 * by the consumption to come cannot be known: the price is the one of the
 * kWh already counted).
 */
export function currentPrice(model, { timezone, billingPeriod, cumulative, at, validity }) {
  if (!validTimezone(timezone)) throw new PricingError('timezone');
  const before = cumulative?.billing_period;
  if (!finite(before) || before < 0) throw new PricingError('cumulative');
  const bounds = boundsCache(
    model,
    model.hasDaily ? billingDays(billingPeriod, timezone, validity) : [],
  );
  const now = unitPrice(model, localParts(at, timezone), before, bounds);
  const end = Date.parse(billingPeriod?.ends_at);
  // The next whole hour (the US zones change on whole hours), then hour by hour.
  let next = Math.floor(at / 3_600_000) * 3_600_000 + 3_600_000;
  for (let i = 0; i < HORIZON_HOURS; i += 1, next += 3_600_000) {
    // A new billing period starts its tiers again: its first price is unknown here.
    if (finite(end) && next >= end) {
      return { price: now.price, valid_until: new Date(end).toISOString(), label: now.label };
    }
    const then = unitPrice(model, localParts(next, timezone), before, bounds);
    if (then.price !== now.price || then.label !== now.label) {
      return {
        price: now.price,
        valid_until: new Date(next).toISOString(),
        next_price: then.price,
        label: now.label,
        next_label: then.label,
      };
    }
  }
  return { price: now.price, label: now.label };
}
