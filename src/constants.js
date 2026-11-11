// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (manifest
// keys, template keys, input keys) is forever: never rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/**
 * The version of package.json (shipped in the image), read at start: the
 * Release workflow bumps package.json, the lock and the manifest, never this
 * file, so a hard-coded version would lag behind.
 */
function packageVersion() {
  try {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    return /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = packageVersion();
/** Honest User-Agent, in the name of the integration (never a browser's). */
export const USER_AGENT = `gladys-openei-urdb/${VERSION} (+https://github.com/LM1LC3N7/gladys-openei-urdb)`;

// --- The source ------------------------------------------------------------------------

/**
 * The Utility Rate Database (URDB) of OpenEI, version 7 of its API (NREL, data
 * under CC0). The key goes in the `X-Api-Key` header of the api.data.gov
 * gateway, never in the address.
 */
export const URDB_URL = 'https://api.openei.org/utility_rates';
export const URDB_VERSION = '7';

/** One tariff in full detail is 5-30 KB: anything above 512 KB is not one, cut before the end. */
export const TARIFF_MAX_BYTES = 512 * 1024;
/** A search (minimal detail, 25 tariffs at most) is a few tens of KB. */
export const SEARCH_MAX_BYTES = 256 * 1024;
/** An error body (403, 429) read for its code: a few hundred bytes. */
export const ERROR_MAX_BYTES = 4 * 1024;
/** From the first byte sent to the last byte read. */
export const REQUEST_TIMEOUT = 15_000;
/** Tariffs listed by the search button, at most. */
export const SEARCH_LIMIT = 25;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * A tariff is read again at most once a day (URDB records change a few times a
 * year): the stored copy prices meanwhile, and keeps pricing when the source
 * cannot be reached.
 */
export const REFRESH_EVERY = DAY;
/** After a failed read of one tariff (not a pause): 10 min, doubled up to 6 h. */
export const RETRY_MIN = 10 * MINUTE;
export const RETRY_MAX = 6 * HOUR;
/** The check of the contracts (a local call to Gladys, no request to URDB). */
export const CHECK_EVERY = HOUR;
/** The Test button sends nothing when the key was accepted this recently and nothing is due. */
export const TEST_REUSE = 10 * MINUTE;
/** Two requests to URDB never closer than this (one in flight at a time anyway). */
export const MIN_GAP = 2 * SECOND;

/** 429 / quota used up / 5xx: a pause of 1 min to 6 h, in /data. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** A 429 without Retry-After, or an hourly quota at 0: one hour, doubled. */
export const PAUSE_QUOTA = HOUR;
/** A 5xx, a timeout: 1 minute, doubled. */
export const PAUSE_SERVER = MINUTE;

/** getConfig() failing at a connection: 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** /data: one read or save awaited at most this long (a frozen mount never blocks). */
export const SAVE_WAIT = 2 * SECOND;
/** /data unreadable at start: read again on its own timer. */
export const DATA_RETRY = 10 * SECOND;
/** A read still running when the integration stops: awaited at most this long. */
export const STOP_WAIT = 3 * SECOND;
/** onEnergyPrice is awaited by Gladys under 30 s: a missing tariff is fetched under this. */
export const PRICE_FETCH_WAIT = 20 * SECOND;
/** onEnergyCurrent is awaited under 5 s: a missing tariff gets 3 s, then the answer is null. */
export const CURRENT_FETCH_WAIT = 3 * SECOND;
/** The list of the contracts (validity dates) is reused this long by the pricing. */
export const CONTRACTS_TTL = 10 * MINUTE;

/** /data is written under this size (its reading stops at 1 MB). */
export const MAX_STATE_WRITE = 900 * 1024;
/** Tariffs kept in /data at most (the oldest unused ones go first). */
export const MAX_TARIFFS = 40;

/** The core refuses a cost above 10 USD per kWh (hostile-payload bound): a rate above is a data error. */
export const MAX_PRICE_PER_KWH = 10;

// --- Manifest keys -------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', FIND: 'find_tariffs' };
export const SECTORS = ['Residential', 'Commercial', 'Industrial', 'Lighting'];

/** The input of every template carrying the URDB identifier of the tariff. */
export const LABEL_INPUT = 'tariff_label';

/**
 * One template per US time zone: the contract timezone (editable in the
 * wizard) defaults to the template's, and the URDB schedules are in the local
 * time of the utility. The pricing always reads the contract timezone.
 */
export const TEMPLATES = [
  { key: 'urdb-eastern', timezone: 'America/New_York', en: 'Eastern', fr: 'heure de l’Est' },
  { key: 'urdb-central', timezone: 'America/Chicago', en: 'Central', fr: 'heure du Centre' },
  {
    key: 'urdb-mountain',
    timezone: 'America/Denver',
    en: 'Mountain',
    fr: 'heure des Rocheuses',
  },
  {
    key: 'urdb-arizona',
    timezone: 'America/Phoenix',
    en: 'Arizona, no DST',
    fr: 'Arizona, sans heure d’été',
  },
  { key: 'urdb-pacific', timezone: 'America/Los_Angeles', en: 'Pacific', fr: 'heure du Pacifique' },
  { key: 'urdb-alaska', timezone: 'America/Anchorage', en: 'Alaska', fr: 'Alaska' },
  { key: 'urdb-hawaii', timezone: 'Pacific/Honolulu', en: 'Hawaii', fr: 'Hawaï' },
];
export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);
/** The template version: changed only when the way a tariff is priced changes. */
export const TEMPLATE_VERSION = '1';
