# gladys-openei-urdb

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**US electricity tariffs**: the energy contracts of Gladys priced with any
tariff of the OpenEI **Utility Rate Database** (URDB, about 3,700 US
utilities): time of use, seasons, tiers per billing period (daily baseline
allowances included). Contract templates in Gladys "delegated" mode, the
user's free OpenEI key. Read-only. Not affiliated with OpenEI, NREL or any
utility.

**Demand charges ($/kW) and the minimum bill are not computed**: the status
and the docs say so for each tariff.

Tried against the real URDB API v7 on 2026-11-11 (`DEMO_KEY`, three real
tariffs kept as test fixtures) and in a Gladys 5.3 sandbox (a delegated
contract and its current price); never used yet in a real Gladys install.
Reports are welcome.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Open points: [TODO.md](TODO.md).
- Security: [SECURITY.md](SECURITY.md).

## How it works

- `type: provider`, no device: seven templates (`urdb-eastern`, `-central`,
  `-mountain`, `-arizona`, `-pacific`, `-alaska`, `-hawaii`, one per US time
  zone, the contract timezone editable), `pricing_mode: delegated`, input
  `tariff_label` (the 24 characters of the URDB label, or the page address)
  and two `fixed` components (per day, per month) typed by the user, which
  Gladys computes itself.
- `onEnergyPrice`: one cost per 30-minute interval from the URDB schedule
  (12 months x 24 hours, weekday / weekend) in the contract timezone, the
  tiers judged on `cumulative_before.billing_period` plus the intervals of the
  request in order ("kWh daily" bounds x the days of the billing period inside
  the contract validity, from `getEnergyContracts`), rate + adj + monthly fuel
  adjustment. Deterministic. Anything that cannot be priced throws (Gladys
  stores no cost and retries), never a zero.
- `onEnergyCurrent`: the price of the current slot for the kWh counted, its
  end on the local clock and the next price; `null` without a tariff read.
- Each tariff is read (`getpage`, full detail) when a contract needs it, then
  at most once a day, kept in `/data` with its date; one request at a time,
  2 s apart, 15 s and 512 KB at most, the key in `X-Api-Key` only, honest
  User-Agent.
- 429, `OVER_RATE_LIMIT` or `X-RateLimit-Remaining: 0`: global pause 1 h
  doubled (`Retry-After` honoured), 5xx 1 min doubled, 1 min to 6 h, in
  `/data`. A key refused by the api.data.gov gateway (403 + `API_KEY_*`)
  stops automatic requests until a new key or a successful Test; a salted
  8-bit fingerprint in `/data`, never the key.
- Buttons: **Test** (one request per click at most) and **Find tariffs** (the
  approved tariffs in effect for a ZIP code, one request per click).

## Development

```bash
npm ci
npm test                         # node --test --test-timeout=60000
npm run lint && npm run format:check
memcap node scripts/mutants.mjs  # mutation check of the guards, one at a time
node scripts/cover.mjs cover.png # regenerate the cover
```

Licensed under the Apache License 2.0. Tariff data: OpenEI URDB, CC0 (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
