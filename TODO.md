# TODO

## Before announcing

- [x] Review r1 (xhigh): REFUSÉ, 1 important + 8 minor, fixed.
- [ ] Review r2.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.
- [ ] A contract priced in a real Gladys 5.3 (the delegated path was only run
      against the SDK's fake Gladys).

## What Gladys cannot express (said in the docs and the status)

- Demand charges ($/kW: `demandratestructure`, `flatdemandstructure`,
  coincident demand, ratchets): the core has a `demand` component, but only
  in `rules` mode; a `delegated` template may only carry `fixed` components,
  and a delegated cost is per half hour, deterministic, without the peak of
  the rest of the period. Possible later: a "rules" export (the module turns
  a URDB tariff into a `tariff` JSON the user pastes in the contract JSON
  mode, demand included), or a core change letting a delegated template
  declare a `demand` component with an input.
- Minimum bill (`mincharge`), selling back (`sell`, net metering: production
  is out of the v1 contracts), holidays (URDB has none; a `holidays-us`
  calendar of another integration could be read if the core gave it to a
  delegated contract), taxes not in URDB.
- Tiers bounded in "kWh/kW" (per kW of demand): refused.
- The fixed charge is not taken from URDB into the contract: the user types it
  (the template `fixed` components read inputs; the module cannot set them).

## To watch on the real API

- [ ] Tier semantics: the `max` of URDB is read as a cumulative bound over the
      billing period ("kWh") or per day of the period ("kWh daily", times the
      days, as the PG&E baseline); with time of use, the tiers count every
      slot together (as NREL SAM does). A tariff whose tiers reset per period
      would be priced differently: none seen yet.
- [ ] `DEMO_KEY` had `X-RateLimit-Limit: 10` (per hour) on 2026-11-11; a
      personal key is said to be about 1,000. The quota at 0 pauses an hour.
- [ ] The key works in the `X-Api-Key` header of api.data.gov (checked with
      `DEMO_KEY` and an invalid key on 2026-11-11). A key from
      developer.nrel.gov should be accepted by the same gateway: not checked.
- [ ] `effective_on_date` of the search returns the tariffs in effect (checked
      for 85004); the sector filter, `approved=true`, 26 results at most.

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`). The
  code reads its version (User-Agent) from package.json at start.
- SDK `^0.16.0` (the latest published on the registry on 2026-11-11). No other
  runtime dependency.
- Manifest: `type: "provider"` (no device), `categories: ["energy"]`,
  `transports: ["cloud"]`, `gladys_version: ">=5.2.0"` (the first Gladys
  accepting `energy_contracts`, code-enforced by the store indexer: the
  ">=5.1.0" of the project rules is not enough here); no `keywords` /
  `countries` yet (to add when wanted: `US`).
- Delegated model (brief of lot 21): ~3,700 utilities and tens of thousands of
  tariffs do not fit 20 templates. Seven templates, one per US time zone
  (`America/New_York`, `Chicago`, `Denver`, `Phoenix`, `Los_Angeles`,
  `Anchorage`, `Pacific/Honolulu`), so that the contract timezone defaults to
  the right one; the pricing always reads the contract timezone. Template keys
  and `version: "1"` are forever.
- The label input accepts the 24 hexadecimal characters or a URDB page address
  (apps.openei.org or openei.org/apps, IURDB or USURDB, https only).
- One request at a time, 2 s apart; a tariff at most once a day; a failed read
  10 min doubled to 6 h; the copy in `/data` prices meanwhile. Pause: 429 /
  `OVER_RATE_LIMIT` / quota header at 0 = 1 h doubled, 5xx = 1 min doubled,
  Retry-After honoured, 1 min to 6 h, in `/data`.
- Refused key = a 401/403 whose gateway code is `API_KEY_INVALID`,
  `API_KEY_MISSING`, `API_KEY_DISABLED`, `API_KEY_UNAUTHORIZED` or
  `API_KEY_UNVERIFIED`; any other 401/403 is an ordinary failure. Kept in
  `/data` as a random salt + 8 bits of SHA-256(salt:key); a key saved in the
  form that differs from the one in memory always lifts it; the Test button
  sends even a refused key (once per click).
- `/data` unreadable or hanging: read again every 10 s on its own timer, one
  read at a time; meanwhile no automatic request (a refusal or a pause it
  holds is unknown) and nothing written. A file that is not ours is renamed
  aside, then the state starts empty.
- Rates checked at parse: rate + adj (+ monthly fuel adjustment) in
  [0, 10] $/kWh (the core refuses a cost above 10 USD per kWh), else the
  tariff is refused rather than clamped.
- Daily allowances ("kWh daily") are summed day by day, each day with the
  bound of the same tier in the period its month gives at the interval's hour
  (weekday schedule): a billing period across a change of season is prorated
  as utilities do (review r1 M1).
- The contract validity is read from Gladys (getEnergyContracts) for every
  price request of a tariff with daily bounds; the 10-min copy only serves
  the current price (review r1 I1).
- Status lists 5 tariffs at most (then "+N more"), 1,500 characters at most.
