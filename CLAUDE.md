# CLAUDE.md

Guidance for Claude Code (and any contributor) working in this repository.

## What this is

A Gladys Assistant **external integration** (Node 22+, ESM, no build step, one Docker container) of type
`provider`: energy contract templates (one per US time zone, `pricing_mode: delegated`) priced with any tariff
of the OpenEI **Utility Rate Database** (URDB API v7), read with the user's free OpenEI key. Read-only.
Unofficial. Demand charges and the minimum bill are NOT computed: say it, never fake it.

## Layout

```
index.js            SDK wiring only (handlers in src/wire.js)
src/app.js          the integration: contracts, tariff reads and their pace, /data, quota pause, refused key,
                    delegated pricing handlers, buttons, status
src/tariff.js       a URDB record -> the tariff model (checked, bounded), label parsing, cleaned texts
src/pricing.js      the delegated pricing and the current price (pure, deterministic)
src/time.js         local time of the contract timezone (Intl), days of a billing period
src/http.js         one GET to URDB (key in X-Api-Key, bounded, refusal told apart by the gateway code)
src/config.js       the form (one secret key)
src/store.js        /data (missing / read / unreadable told apart)
src/i18n.js         every text, en + fr
scripts/            cover generator, mutation check (mutants.json)
test/fixtures/      real URDB records (CC0)
```

## Rules that must hold

- The key never appears in logs, statuses, `/data`, error messages or an address; it is sent only to
  api.openei.org, in the `X-Api-Key` header.
- One request in flight, 2 s apart; a tariff read at most once a day; the attempt time in `/data` first.
- 429 / quota at 0 / 5xx: global pause 1 min to 6 h (Retry-After), in `/data`.
- A refused key (403 + `API_KEY_*` of the gateway) stops automatic requests until a new key or a successful Test.
- A cost is the energy only, finite, >= 0; anything that cannot be priced throws (never a zero, never a guess).
- Decisions on the monotonic clock (`dueAt(label, mono)`); the wall clock dates `/data` and the priced instant.

## Commands

```bash
npm ci
gi test / gi ci                      # on the VM (tests on Node 22 and 24, Docker, validator)
npm test                             # node --test --test-timeout=60000
npm run lint && npm run format:check
memcap node scripts/mutants.mjs      # mutation check, one mutant at a time
```
