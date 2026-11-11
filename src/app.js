// -----------------------------------------------------------------------------
// The integration itself: the energy contracts of Gladys that use an URDB
// template (delegated pricing) are priced from the URDB tariff whose label
// the user typed in the contract. index.js only wires the SDK handlers to it
// (src/wire.js). Read-only: only GET requests leave, to api.openei.org.
//
// The tariffs:
//   - read from URDB when a contract needs one and no copy is held, then at
//     most once a day each (REFRESH_EVERY), one request in flight, two
//     requests at least MIN_GAP apart; the attempt time goes to /data before
//     the request (the pace survives a restart);
//   - kept in /data with the date they were read: a restart, an outage of
//     OpenEI or a pause never stops the pricing of a tariff already read.
//
// The quota (api.data.gov: DEMO_KEY 10 requests an hour, a personal key
// about 1,000): a 429, an OVER_RATE_LIMIT or a quota header at 0 pauses every
// request (1 min to 6 h, Retry-After honoured, doubled, in /data); a 5xx
// pauses 1 min doubled. A refused key (403 with a key error of the gateway)
// stops every automatic request until another key is saved or the Test
// button succeeds; the refusal survives a restart as a salted fingerprint of
// 8 bits (never the key).
//
// Two clocks: `now` (wall clock) for /data, the dates shown and the instant
// priced; `monotonic` for the pace, the pauses and the waits. One clock read
// per decision.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  CHECK_EVERY,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  CONTRACTS_TTL,
  DATA_RETRY,
  LABEL_INPUT,
  MAX_TARIFFS,
  MINUTE,
  MIN_GAP,
  PAUSE_MAX,
  PAUSE_MIN,
  PAUSE_QUOTA,
  PAUSE_SERVER,
  PRICE_FETCH_WAIT,
  CURRENT_FETCH_WAIT,
  SECOND,
  TEST_REUSE,
  REFRESH_EVERY,
  REQUEST_TIMEOUT,
  RETRY_MAX,
  RETRY_MIN,
  SAVE_WAIT,
  SEARCH_LIMIT,
  SEARCH_MAX_BYTES,
  SECTORS,
  STOP_WAIT,
  TARIFF_MAX_BYTES,
  TEMPLATES,
  TEMPLATE_KEYS,
  URDB_URL,
  URDB_VERSION,
} from './constants.js';
import { FetchError, getJson } from './http.js';
import { FAILURES, NOT_COMPUTED, PROBLEMS, T, compose } from './i18n.js';
import { PricingError, currentPrice, priceIntervals } from './pricing.js';
import { createFileStore } from './store.js';
import { TariffError, cleanText, keptRecord, labelOf, parseTariff } from './tariff.js';
import { localParts, validTimezone } from './time.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const PAUSE_CODES = new Set(['rate_limited', 'server']);
const FORMAT_CODES = new Set(['not_state', 'too_large', 'not_file']);
/** The status lists this many tariffs at most. */
const STATUS_TARIFFS = 5;
/** The contracts are read again sooner after a failure. */
const CONTRACTS_RETRY = 5 * MINUTE;

/** 8 bits of a salted SHA-256 of the key: tells "the same key" at a restart, never the key. */
export function keyTag(salt, key) {
  return createHash('sha256').update(`${salt}:${key}`).digest()[0];
}

/** Marks a request that never left (a pause or a refusal met at the moment of sending). */
const notSent = (err) => Object.assign(err, { notSent: true });

/** An error that goes back to Gladys (its message is shown in the job): never the key. */
export class UrdbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UrdbError';
  }
}

export class UrdbApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'openei-urdb' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    url = URDB_URL,
    minGap = MIN_GAP,
    requestTimeout = REQUEST_TIMEOUT,
  }) {
    this.minGap = minGap;
    this.requestTimeout = requestTimeout;
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.config = normalizeConfig();
    this.running = false;
    this.run = 0;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = undefined;
    this.checkTimer = undefined;
    this.checking = undefined;
    this.dataTimer = undefined;
    this.loading = undefined;
    this.lastStatus = undefined;
    /** label -> { record, model, fetchedAt (wall) } */
    this.tariffs = new Map();
    /** label -> { at (wall), mono, failures, retryMono, problem } */
    this.asked = new Map();
    /** label -> the promise of its read running (one per label). */
    this.pending = new Map();
    /** The requests one after the other (one in flight). */
    this.chain = Promise.resolve();
    this.lastRequestMono = undefined;
    this.abort = undefined;
    this.pause = undefined;
    this.refused = undefined;
    /** { list, mono } of getEnergyContracts, or { failed: true, mono } */
    this.contracts = undefined;
    this.loaded = false;
    this.dataUnreadable = false;
    /** The last 200 of OpenEI: { mono, at }. */
    this.lastOk = undefined;
    this.gapTimer = undefined;
    this.gapWake = undefined;
    this.saving = Promise.resolve();
    this.saveAgain = false;
  }

  // --- /data --------------------------------------------------------------------------

  /** Awaits `promise` at most SAVE_WAIT; `fallback` after (the work goes on in the background). */
  async bounded(promise, fallback, wait = SAVE_WAIT) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(() => resolve(fallback), wait);
        }),
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /**
   * Reads /data once, bounded in time. A file that is not ours is set aside
   * (renamed, never overwritten) and the state starts empty; a /data that
   * fails or hangs is read again on its own timer (DATA_RETRY), one read at
   * a time, and nothing is written to it meanwhile.
   */
  async load() {
    if (this.loaded || !this.running) return;
    // One read at a time: a read still hanging is awaited again, never doubled.
    if (!this.loading) {
      const run = Promise.resolve()
        .then(() => this.store.load())
        .catch(() => ({ ok: false, code: 'error' }));
      this.loading = run;
      run.finally(() => {
        if (this.loading === run) this.loading = undefined;
      });
    }
    const loaded = await this.bounded(this.loading, { ok: false, code: 'timeout' });
    if (this.loaded || !this.running) return;
    if (loaded?.ok) {
      this.loaded = true;
      this.dataUnreadable = false;
      this.restore(loaded.data);
      return;
    }
    if (FORMAT_CODES.has(loaded?.code)) {
      const aside = await this.bounded(
        Promise.resolve()
          .then(() => this.store.setAside(this.now()))
          .then(
            () => true,
            () => false,
          ),
        false,
      );
      if (aside) {
        this.logger.warn('/data was not a state of this integration: set aside');
        this.loaded = true;
        this.dataUnreadable = false;
        return;
      }
    }
    this.dataUnreadable = true;
    this.logger.warn(`/data could not be read (${loaded?.code ?? 'error'}): read again soon`);
    this.armDataTimer();
  }

  armDataTimer() {
    if (this.dataTimer !== undefined || !this.running) return;
    this.dataTimer = this.timers.setTimeout(() => {
      this.dataTimer = undefined;
      if (!this.running || this.loaded) return undefined;
      return this.load().then(async () => {
        if (this.loaded) {
          await this.updateStatus();
          await this.saveState();
          // What waited for /data (the check, its requests) runs now.
          this.scheduleCheck(0);
        }
      });
    }, DATA_RETRY);
  }

  /** What /data held, checked entry by entry, merged with what was learnt meanwhile. */
  restore(data) {
    const at = this.now();
    const mono = this.monotonic();
    const tariffs = isObject(data.tariffs) ? data.tariffs : {};
    for (const [label, entry] of Object.entries(tariffs).slice(0, MAX_TARIFFS)) {
      if (this.tariffs.has(label) || !isObject(entry) || !isObject(entry.record)) continue;
      try {
        const model = parseTariff(entry.record);
        if (model.label !== label) continue;
        // A date in the future is not trusted: the copy is read again.
        const fetchedAt = finite(entry.fetchedAt) && entry.fetchedAt <= at ? entry.fetchedAt : 0;
        const fetchedMono = fetchedAt > 0 ? mono - (at - fetchedAt) : -Infinity;
        this.tariffs.set(label, {
          record: keptRecord(entry.record),
          model,
          fetchedAt,
          fetchedMono,
        });
      } catch {
        // A copy that no longer parses is read again from the source.
      }
    }
    const asked = isObject(data.asked) ? data.asked : {};
    for (const [label, entry] of Object.entries(asked).slice(0, MAX_TARIFFS)) {
      if (this.asked.has(label) || !labelOf(label) || !isObject(entry) || !finite(entry.at))
        continue;
      const wall = Math.min(entry.at, at);
      const failures = Number.isInteger(entry.failures)
        ? Math.min(Math.max(entry.failures, 0), 16)
        : 0;
      const one = { at: wall, mono: mono - (at - wall), failures, retryMono: undefined };
      if (failures > 0) one.retryMono = one.mono + this.retryDelay(failures);
      this.asked.set(label, one);
    }
    const pause = data.pause;
    if (
      !this.pause &&
      isObject(pause) &&
      finite(pause.until) &&
      Number.isInteger(pause.count) &&
      pause.count >= 1 &&
      PAUSE_CODES.has(pause.code)
    ) {
      const left = Math.min(Math.max(0, pause.until - at), PAUSE_MAX);
      if (left > 0) {
        this.pause = {
          until: at + left,
          due: mono + left,
          count: Math.min(pause.count, 16),
          code: pause.code,
        };
      }
    }
    const refused = data.refused;
    if (
      !this.refused &&
      isObject(refused) &&
      typeof refused.salt === 'string' &&
      /^[0-9a-f]{16,64}$/.test(refused.salt) &&
      Number.isInteger(refused.tag) &&
      typeof refused.gateway === 'string' &&
      /^[A-Z_]{1,40}$/.test(refused.gateway) &&
      this.config.apiKey &&
      keyTag(refused.salt, this.config.apiKey) === refused.tag
    ) {
      this.refused = { salt: refused.salt, tag: refused.tag, gateway: refused.gateway };
    }
  }

  /** What /data keeps: never the key, only its refusal fingerprint. */
  snapshot() {
    const inUse = this.labelsInUse();
    const labels = [...this.tariffs.keys()]
      .sort(
        (a, b) =>
          Number(inUse.has(b)) - Number(inUse.has(a)) ||
          this.tariffs.get(b).fetchedAt - this.tariffs.get(a).fetchedAt,
      )
      .slice(0, MAX_TARIFFS);
    const tariffs = {};
    for (const label of labels) {
      const entry = this.tariffs.get(label);
      tariffs[label] = { record: entry.record, fetchedAt: entry.fetchedAt };
    }
    const asked = {};
    for (const [label, entry] of [...this.asked.entries()].slice(-MAX_TARIFFS)) {
      asked[label] = { at: entry.at, failures: entry.failures };
    }
    return {
      v: 1,
      tariffs,
      asked,
      pause: this.pause
        ? { until: this.pause.until, count: this.pause.count, code: this.pause.code }
        : undefined,
      refused: this.refused
        ? { salt: this.refused.salt, tag: this.refused.tag, gateway: this.refused.gateway }
        : undefined,
    };
  }

  /**
   * Writes /data, bounded: one save at a time, the last state wins. Never
   * while /data is unread (an unreadable file is never overwritten).
   * Resolves true when written.
   */
  saveState() {
    if (!this.loaded) return Promise.resolve(false);
    const job = this.saving.then(() =>
      this.bounded(
        Promise.resolve()
          .then(() => this.store.save(this.snapshot()))
          .then(
            () => true,
            (err) => {
              this.logger.warn(`/data could not be written (${err?.code ?? err?.name ?? 'error'})`);
              return false;
            },
          ),
        false,
      ),
    );
    this.saving = job.catch(() => false);
    return job;
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.lastStatus = undefined;
    this.contracts = undefined;
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      await this.saveState();
    });
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`The configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      const busy = this.checking;
      this.doStop();
      if (busy) {
        await this.bounded(
          busy.catch(() => {}),
          undefined,
          STOP_WAIT,
        );
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the check running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.configRun;
    await this.checking;
    await this.chain;
    await this.saving;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    const previous = this.config.apiKey;
    this.config = normalizeConfig(raw);
    // Another key: the refusal of the old one no longer holds (a new key is always tried).
    if (this.refused && this.config.apiKey !== previous) this.refused = undefined;
    this.running = true;
    this.run += 1;
    await this.load();
    await this.updateStatus();
    this.scheduleCheck(0);
  }

  doStop() {
    this.running = false;
    this.run += 1;
    if (this.checkTimer !== undefined) {
      this.timers.clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
    }
    if (this.dataTimer !== undefined) {
      this.timers.clearTimeout(this.dataTimer);
      this.dataTimer = undefined;
    }
    if (this.gapTimer !== undefined) {
      this.timers.clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
      this.gapWake?.();
    }
    this.abort?.abort();
    this.abort = undefined;
  }

  // --- The periodic check -------------------------------------------------------------

  scheduleCheck(delay) {
    if (!this.running) return;
    if (this.checkTimer !== undefined) this.timers.clearTimeout(this.checkTimer);
    const gen = this.run;
    this.checkTimer = this.timers.setTimeout(
      () => {
        this.checkTimer = undefined;
        if (gen !== this.run || !this.running) return undefined;
        if (this.checking) return undefined;
        const tracked = this.check(gen).finally(() => {
          if (this.checking === tracked) this.checking = undefined;
        });
        this.checking = tracked;
        return tracked;
      },
      // Rounded up: a timer never fires before the instant it waits for.
      Math.max(0, Math.ceil(delay)),
    );
  }

  /**
   * The contracts of Gladys, then the tariffs they need that are due, one
   * after the other; the status; /data. Re-armed: CHECK_EVERY, sooner when a
   * tariff becomes due (its retry or its daily refresh) or a pause ends.
   */
  async check(gen) {
    let next = CHECK_EVERY;
    try {
      const ok = await this.readContracts();
      if (gen !== this.run) return;
      if (!ok) next = CONTRACTS_RETRY;
      for (const label of [...this.labelsInUse()].sort()) {
        if (gen !== this.run) return;
        const mono = this.monotonic();
        if (this.blocked(mono) || mono < this.dueAt(label, mono)) continue;
        await this.readTariff(label, gen).catch(() => {});
      }
      if (gen !== this.run) return;
      await this.updateStatus();
      await this.saveState();
      // One clock read: the next tariff due, or the end of the pause; nothing
      // sooner while no request may leave (no key, key refused, /data unread).
      const mono = this.monotonic();
      const labels = this.labelsInUse();
      if (labels.size > 0 && this.config.apiKey && !this.refused && this.loaded) {
        let soonest = Infinity;
        for (const label of labels) soonest = Math.min(soonest, this.dueAt(label, mono));
        if (this.pausedAt(mono)) soonest = Math.max(soonest, this.pause.due);
        next = Math.min(next, Math.max(MIN_GAP, soonest - mono));
      }
    } catch (err) {
      this.logger.error(`Check failed (${err?.name ?? 'Error'})`);
    } finally {
      if (gen === this.run) this.scheduleCheck(next);
    }
  }

  /** The contracts of this integration (getEnergyContracts); false when Gladys did not answer. */
  async readContracts() {
    try {
      const list = await this.gladys.getEnergyContracts();
      this.contracts = {
        list: Array.isArray(list) ? list.slice(0, 500) : [],
        mono: this.monotonic(),
      };
      return true;
    } catch (err) {
      this.logger.warn(`The contracts could not be read (${err?.name ?? 'Error'})`);
      this.contracts = { ...(this.contracts ?? { list: [] }), failed: true };
      return false;
    }
  }

  /** Our contracts: template of this integration, label read (or not). */
  ourContracts() {
    return (this.contracts?.list ?? []).filter(
      (c) => isObject(c) && TEMPLATE_KEYS.includes(c.template_key),
    );
  }

  /** The labels the contracts use (valid ones only). */
  labelsInUse() {
    const labels = new Set();
    for (const contract of this.ourContracts()) {
      const label = labelOf(contract.inputs?.[LABEL_INPUT]);
      if (label) labels.add(label);
    }
    return labels;
  }

  /**
   * No automatic request: no key, a key refused, a pause running, /data not
   * read yet (a refusal or a pause it holds is not known: never sent blind).
   */
  blocked(mono) {
    if (!this.config.apiKey || this.refused || !this.loaded) return true;
    return this.pausedAt(mono);
  }

  pausedAt(mono) {
    return Boolean(this.pause && mono < this.pause.due);
  }

  /**
   * When `label` may be read again (monotonic, from the clock read `mono` of
   * the decision): a copy held, a day after it was read and after it was last
   * asked; a failed read, after its retry delay; else at once.
   */
  dueAt(label, mono) {
    const asked = this.asked.get(label);
    const entry = this.tariffs.get(label);
    let at = -Infinity;
    if (entry) {
      at = entry.fetchedMono + REFRESH_EVERY;
      if (asked) at = Math.max(at, asked.mono + REFRESH_EVERY);
    }
    if (asked?.retryMono !== undefined) at = Math.max(at, asked.retryMono);
    return Math.min(at, mono + REFRESH_EVERY);
  }

  retryDelay(failures) {
    return Math.min(RETRY_MIN * 2 ** Math.max(0, failures - 1), RETRY_MAX);
  }

  // --- One request ----------------------------------------------------------------

  /**
   * Sends one request in its turn (one in flight, MIN_GAP between two),
   * checking the pause and the refusal at the moment it leaves.
   * `force` (the Test button) sends even with a refused key.
   */
  request(params, { maxBytes, force = false, gen = this.run } = {}) {
    const job = this.chain.then(async () => {
      if (gen !== this.run || !this.running) throw new FetchError('aborted');
      if (this.lastRequestMono !== undefined) {
        const wait = this.lastRequestMono + this.minGap - this.monotonic();
        if (wait > 0) {
          // Cancelled by a stop: no timer left behind.
          await new Promise((resolve) => {
            this.gapWake = resolve;
            this.gapTimer = this.timers.setTimeout(() => {
              this.gapTimer = undefined;
              resolve();
            }, wait);
          });
          this.gapWake = undefined;
        }
      }
      if (gen !== this.run || !this.running) throw new FetchError('aborted');
      const mono = this.monotonic();
      // Not sent: a pause or a refusal that came meanwhile (never counted as a failure).
      if (!this.config.apiKey) throw new UrdbError('no key');
      if (this.pausedAt(mono)) throw notSent(new FetchError('rate_limited'));
      if (this.refused && !force) {
        throw notSent(new FetchError('refused', { gateway: this.refused.gateway }));
      }
      this.lastRequestMono = mono;
      const query = new URLSearchParams({ version: URDB_VERSION, format: 'json', ...params });
      const abort = new AbortController();
      this.abort = abort;
      const key = this.config.apiKey;
      try {
        const answer = await getJson({
          url: `${this.url}?${query}`,
          apiKey: key,
          maxBytes,
          signal: abort.signal,
          fetchImpl: this.fetchImpl,
          timers: this.timers,
          timeout: this.requestTimeout,
        });
        if (gen !== this.run) throw new FetchError('aborted');
        this.answered(answer, key);
        return answer;
      } catch (err) {
        if (gen === this.run) this.failedRequest(err, key);
        throw err;
      } finally {
        if (this.abort === abort) this.abort = undefined;
      }
    });
    this.chain = job.catch(() => {});
    return job;
  }

  /** A 200: the key works (its refusal goes), the pause ends; a quota at 0 pauses an hour. */
  answered(answer, key) {
    if (this.refused && key === this.config.apiKey) this.refused = undefined;
    const mono = this.monotonic();
    this.lastOk = { mono, at: this.now() };
    if (answer.remaining === 0) {
      this.setPause('rate_limited', undefined, mono);
    } else {
      this.pause = undefined;
    }
  }

  failedRequest(err, key) {
    const mono = this.monotonic();
    if (!(err instanceof FetchError)) return;
    if (err.code === 'refused') {
      if (key !== this.config.apiKey) return;
      const salt = randomBytes(16).toString('hex');
      this.refused = { salt, tag: keyTag(salt, key), gateway: err.gateway ?? 'API_KEY_INVALID' };
      this.logger.warn(`OpenEI refused the API key (${this.refused.gateway})`);
    } else if (err.code === 'rate_limited' && err.status !== undefined) {
      this.setPause('rate_limited', err.retryAfter, mono);
    } else if (err.code === 'server') {
      this.setPause('server', err.retryAfter, mono);
    }
  }

  /** A pause of every request: Retry-After when given, else doubled; 1 min to 6 h. */
  setPause(code, retryAfter, mono) {
    const count = Math.min((this.pause?.count ?? 0) + 1, 16);
    const base = code === 'server' ? PAUSE_SERVER : PAUSE_QUOTA;
    const wanted = finite(retryAfter) ? retryAfter : base * 2 ** (count - 1);
    const length = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, wanted));
    this.pause = { until: this.now() + length, due: mono + length, count, code };
    this.logger.warn(`OpenEI paused for ${Math.round(length / 60000)} min (${code})`);
  }

  /**
   * Reads one tariff (one read per label at a time): its copy and the date,
   * or its problem. Resolves the entry; throws a FetchError, a TariffError or
   * an UrdbError.
   */
  readTariff(label, gen = this.run, { force = false } = {}) {
    const running = this.pending.get(label);
    if (running) return running;
    const job = this.doReadTariff(label, gen, force);
    this.pending.set(label, job);
    job
      .finally(() => {
        if (this.pending.get(label) === job) this.pending.delete(label);
      })
      .catch(() => {});
    return job;
  }

  async doReadTariff(label, gen, force) {
    const previous = this.asked.get(label);
    const one = {
      at: this.now(),
      mono: this.monotonic(),
      failures: previous?.failures ?? 0,
      retryMono: previous?.retryMono,
      problem: previous?.problem,
    };
    this.asked.set(label, one);
    // Asked: the time goes to /data before the request (bounded).
    await this.saveState();
    let answer;
    try {
      answer = await this.request(
        { getpage: label, detail: 'full' },
        { maxBytes: TARIFF_MAX_BYTES, force, gen },
      );
    } catch (err) {
      if (
        (err instanceof FetchError && err.code === 'aborted') ||
        err?.notSent ||
        err instanceof UrdbError ||
        (err instanceof FetchError && err.code === 'refused')
      ) {
        // Stopped before an answer, never sent, or the key refused (the key is
        // blamed, not the tariff: another key tries it at once): not counted.
        if (previous) this.asked.set(label, previous);
        else this.asked.delete(label);
        throw err;
      }
      this.failedTariff(one, err instanceof FetchError ? err.code : 'network');
      throw err;
    }
    let record;
    try {
      const body = JSON.parse(answer.text);
      if (!isObject(body) || !Array.isArray(body.items)) throw new TariffError('format');
      record = body.items.find((item) => isObject(item) && item.label === label);
      if (!record) {
        throw new TariffError(body.items.length === 0 ? 'not_found' : 'format');
      }
      const model = parseTariff(record);
      const entry = {
        record: keptRecord(record),
        model,
        fetchedAt: this.now(),
        fetchedMono: this.monotonic(),
      };
      this.tariffs.set(label, entry);
      one.failures = 0;
      one.retryMono = undefined;
      one.problem = undefined;
      return entry;
    } catch (err) {
      const code = err instanceof TariffError ? err.code : 'format';
      // A copy held stays in use when the new answer cannot be read.
      this.failedTariff(one, code);
      throw err instanceof TariffError ? err : new TariffError('format');
    }
  }

  failedTariff(one, code) {
    one.failures = Math.min(one.failures + 1, 16);
    one.retryMono = one.mono + this.retryDelay(one.failures);
    one.problem = code;
  }

  // --- Delegated pricing ----------------------------------------------------------

  /** The tariff of a contract: held, else read now (bounded); a clear error otherwise. */
  async tariffFor(contract, { wait = PRICE_FETCH_WAIT } = {}) {
    if (!isObject(contract) || !TEMPLATE_KEYS.includes(contract.template_key)) {
      throw new UrdbError('This contract does not use an OpenEI URDB template');
    }
    const label = labelOf(contract.inputs?.[LABEL_INPUT]);
    if (!label) {
      throw new UrdbError('The contract has no valid URDB tariff label');
    }
    const held = this.tariffs.get(label);
    if (held) return held;
    if (!this.running) throw new UrdbError('The integration is not started');
    if (!this.loaded) throw new UrdbError('/data not read yet');
    const mono = this.monotonic();
    if (!this.config.apiKey) throw new UrdbError('No OpenEI API key');
    if (this.refused) throw new UrdbError('The OpenEI API key was refused');
    if (this.pausedAt(mono)) throw new UrdbError('OpenEI paused (quota or server error)');
    const retry = this.asked.get(label)?.retryMono;
    if (retry !== undefined && mono < retry) {
      throw new UrdbError(`Tariff ${label} could not be read (${this.asked.get(label).problem})`);
    }
    const timedOut = Symbol('timeout');
    const read = this.readTariff(label).then(
      (entry) => entry,
      (err) => {
        throw new UrdbError(
          `Tariff ${label} could not be read (${err?.code ?? 'error'})`.slice(0, 200),
        );
      },
    );
    // A new label: the contracts are read again, then the status says it.
    read
      .catch(() => {})
      .then(async () => {
        await this.readContracts();
        await this.updateStatus();
        await this.saveState();
      })
      .catch(() => {});
    // The current price never waits (5 s): the read goes on in the background.
    if (wait <= 0) throw new UrdbError(`Tariff ${label} not read yet`);
    const entry = await this.bounded(read, timedOut, wait);
    if (entry === timedOut) throw new UrdbError(`Tariff ${label} not read in time`);
    return entry;
  }

  /** The validity of a contract ({ validFrom, validTo }), from getEnergyContracts (reused 10 min). */
  async validityOf(contractId, { wait = SAVE_WAIT * 2 } = {}) {
    const find = () => (this.contracts?.list ?? []).find((c) => isObject(c) && c.id === contractId);
    let contract =
      this.contracts &&
      !this.contracts.failed &&
      this.monotonic() - this.contracts.mono < CONTRACTS_TTL
        ? find()
        : undefined;
    if (!contract) {
      const ok = await this.bounded(this.readContracts(), false, wait);
      contract = ok ? find() : undefined;
    }
    if (!contract || typeof contract.valid_from !== 'string') {
      throw new UrdbError('The contract validity could not be read from Gladys');
    }
    return {
      validFrom: contract.valid_from,
      validTo: typeof contract.valid_to === 'string' ? contract.valid_to : null,
    };
  }

  /** onEnergyPrice: one cost per interval, or a throw (Gladys then retries later). */
  async energyPrice({ contract, billing_period, cumulative_before, intervals } = {}) {
    if (!Array.isArray(intervals) || intervals.length === 0) return [];
    if (!validTimezone(contract?.timezone)) {
      throw new UrdbError('The contract timezone is not a known IANA timezone');
    }
    const entry = await this.tariffFor(contract);
    const validity = entry.model.hasDaily ? await this.validityOf(contract.id) : undefined;
    try {
      return priceIntervals(entry.model, {
        timezone: contract.timezone,
        billingPeriod: billing_period,
        cumulativeBefore: cumulative_before,
        intervals,
        validity,
      });
    } catch (err) {
      if (err instanceof PricingError) throw new UrdbError(`Cannot price: ${err.code}`);
      throw err;
    }
  }

  /** onEnergyCurrent: under 5 s, from the copy held or read within 3 s (null otherwise). */
  async energyCurrent({ contract, billing_period, cumulative } = {}) {
    let entry;
    try {
      // Gladys waits 5 s and keeps the answer 5 min: a tariff read in 3 s is used now.
      entry = await this.tariffFor(contract, { wait: CURRENT_FETCH_WAIT });
    } catch {
      return { price: null };
    }
    if (!entry || !validTimezone(contract.timezone)) return { price: null };
    try {
      const validity = entry.model.hasDaily
        ? await this.validityOf(contract.id, { wait: SECOND })
        : undefined;
      return currentPrice(entry.model, {
        timezone: contract.timezone,
        billingPeriod: billing_period,
        cumulative,
        at: this.now(),
        validity,
      });
    } catch {
      return { price: null };
    }
  }

  // --- Buttons --------------------------------------------------------------------

  /**
   * Test: one request per click at most, and none when nothing is due and the
   * key was accepted less than TEST_REUSE ago (never faster than the pace).
   * With a refused key, the request is sent anyway: its success lifts the
   * refusal. The other tariffs due are read by the check that follows.
   */
  async testConnection() {
    if (!this.config.apiKey) return this.config.keyProblem === 'format' ? T.badKey : T.noKey;
    if (!this.running) return T.starting;
    if (this.pausedAt(this.monotonic())) return T.paused(this.pause.until);
    await this.bounded(this.readContracts(), false, 3000);
    const labels = [...this.labelsInUse()].sort();
    const mono = this.monotonic();
    const due = labels.filter((label) => mono >= this.dueAt(label, mono));
    if (
      !this.refused &&
      due.length === 0 &&
      this.lastOk !== undefined &&
      mono - this.lastOk.mono < TEST_REUSE
    ) {
      await this.updateStatus();
      return T.test.recent(this.lastOk.at, labels.length);
    }
    try {
      if (labels.length === 0) {
        await this.request(
          { sector: 'Residential', detail: 'minimal', limit: '1' },
          { maxBytes: SEARCH_MAX_BYTES, force: true },
        );
      } else {
        try {
          await this.readTariff(due[0] ?? labels[0], this.run, { force: true });
        } catch (err) {
          // A tariff that cannot be used: said in the status, the key still works.
          if (!(err instanceof TariffError)) throw err;
        }
      }
    } catch (err) {
      await this.updateStatus();
      await this.saveState();
      if (err instanceof FetchError && err.code === 'refused') return T.test.refused(err.gateway);
      if (err instanceof FetchError && err.code === 'rate_limited' && this.pause) {
        return T.paused(this.pause.until);
      }
      return T.test.failed(FAILURES[err?.code] ?? FAILURES.network);
    }
    await this.updateStatus();
    await this.saveState();
    if (due.length > 1) this.scheduleCheck(0);
    return T.test.ok(labels.length);
  }

  /** Find tariffs: the approved tariffs in effect around a ZIP code (one request per click). */
  async findTariffs(fields = {}) {
    const zip = typeof fields.zip === 'string' ? fields.zip.trim() : String(fields.zip ?? '');
    if (!/^\d{5}$/.test(zip)) return T.find.badZip;
    const sector = SECTORS.includes(fields.sector) ? fields.sector : 'Residential';
    if (!this.config.apiKey) return this.config.keyProblem === 'format' ? T.badKey : T.noKey;
    if (this.refused) return T.refused(this.refused.gateway);
    if (this.pausedAt(this.monotonic())) return T.paused(this.pause.until);
    let answer;
    try {
      answer = await this.request(
        {
          address: zip,
          sector,
          approved: 'true',
          effective_on_date: String(Math.floor(this.now() / 1000)),
          detail: 'minimal',
          limit: String(SEARCH_LIMIT + 1),
        },
        { maxBytes: SEARCH_MAX_BYTES },
      );
    } catch (err) {
      await this.updateStatus();
      await this.saveState();
      if (err instanceof FetchError && err.code === 'refused') return T.refused(err.gateway);
      if (err instanceof FetchError && err.code === 'rate_limited' && this.pause) {
        return T.paused(this.pause.until);
      }
      return T.find.failed(FAILURES[err?.code] ?? FAILURES.network);
    }
    let items;
    try {
      const body = JSON.parse(answer.text);
      items = Array.isArray(body?.items) ? body.items : undefined;
    } catch {
      items = undefined;
    }
    if (!items) return T.find.failed(FAILURES.encoding);
    const rows = [];
    for (const item of items) {
      if (!isObject(item) || typeof item.label !== 'string') continue;
      const label = item.label.toLowerCase();
      if (!/^[0-9a-f]{24}$/.test(label)) continue;
      if (Number.isInteger(item.enddate) && item.enddate * 1000 <= this.now()) continue;
      const since = Number.isInteger(item.startdate)
        ? new Date(item.startdate * 1000).toISOString().slice(0, 10)
        : '?';
      rows.push(
        `${label} ${cleanText(item.utility, 40) ?? '?'}: ${cleanText(item.name, 70) ?? '?'} (${since})`,
      );
    }
    if (rows.length === 0) return T.find.none(zip);
    const more = rows.length > SEARCH_LIMIT;
    const shown = rows.slice(0, SEARCH_LIMIT);
    return compose(T.find.header(shown.length, zip, more), shown.join(' | '));
  }

  // --- Status -------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`The status could not be sent (${err?.name ?? 'Error'})`);
    }
  }

  /** The timezone a tariff's dates are shown in: the first contract using it. */
  zoneOf(label) {
    for (const contract of this.ourContracts()) {
      if (labelOf(contract.inputs?.[LABEL_INPUT]) === label && validTimezone(contract.timezone)) {
        return contract.timezone;
      }
    }
    const template = TEMPLATES.find((t) => t.key === this.ourContracts()[0]?.template_key);
    return template?.timezone ?? 'America/New_York';
  }

  /** One line per tariff in use: name, utility, dates, what is not computed. */
  tariffLine(label) {
    const entry = this.tariffs.get(label);
    const problem = this.asked.get(label)?.problem;
    if (!entry) {
      const why = problem ? (PROBLEMS[problem] ?? FAILURES[problem] ?? PROBLEMS.format) : T.waiting;
      return compose(label, T.colon, why);
    }
    const m = entry.model;
    const zone = this.zoneOf(label);
    const parts = [`${m.name} (${m.utility})`];
    if (m.startdate !== null) {
      parts.push(', ', T.since, ` ${localParts(m.startdate, zone).date}`);
    }
    if (m.enddate !== null) parts.push(', ', T.ended, ` ${localParts(m.enddate, zone).date}`);
    parts.push(', ', T.read, ` ${new Date(entry.fetchedAt).toISOString().slice(0, 10)}`);
    if (problem) parts.push(' (', PROBLEMS[problem] ?? FAILURES[problem] ?? PROBLEMS.format, ')');
    if (m.notComputed.length > 0) {
      parts.push(T.semicolon, T.notComputed, T.colon);
      m.notComputed.forEach((code, i) => {
        if (i > 0) parts.push(', ');
        parts.push(NOT_COMPUTED[code]);
      });
    }
    if (m.fixed) {
      // A yearly charge is shown per month: the contract takes a day or a month.
      const yearly = m.fixed.units === '$/year';
      const amount = yearly ? Math.round((m.fixed.amount / 12) * 10000) / 10000 : m.fixed.amount;
      parts.push(T.semicolon, T.fixed(amount, yearly ? '$/month' : m.fixed.units));
    }
    return compose(...parts);
  }

  /** The status from the state: never the key, bounded. */
  computeStatus() {
    if (!this.config.apiKey) {
      return {
        connected: false,
        message: this.config.keyProblem === 'format' ? T.badKey : T.noKey,
      };
    }
    const tail = this.dataUnreadable ? [T.dataUnreadable] : [];
    if (this.refused) {
      return { connected: false, message: compose(T.refused(this.refused.gateway), ...tail) };
    }
    const mono = this.monotonic();
    const head = [];
    let connected = true;
    if (this.pausedAt(mono)) {
      connected = false;
      head.push(T.paused(this.pause.until), ' ');
    }
    if (this.contracts?.failed) {
      connected = false;
      head.push(T.contractsUnread, ' ');
    }
    const labels = [...this.labelsInUse()].sort();
    if (labels.length === 0) {
      if (!this.contracts) return { connected, message: compose(T.starting, ...tail) };
      if (this.contracts.failed) return { connected, message: compose(...head, ...tail) };
      return { connected, message: compose(...head, T.noContract, ...tail) };
    }
    const lines = [];
    for (const label of labels.slice(0, STATUS_TARIFFS)) {
      if (!this.tariffs.has(label)) connected = false;
      lines.push(this.tariffLine(label));
    }
    for (const label of labels.slice(STATUS_TARIFFS)) {
      if (!this.tariffs.has(label)) connected = false;
    }
    const body = [];
    lines.forEach((line, i) => {
      if (i > 0) body.push(' | ');
      body.push(line);
    });
    if (labels.length > STATUS_TARIFFS) body.push(T.more(labels.length - STATUS_TARIFFS));
    const message = compose(...head, ...body, ...tail);
    for (const lang of ['en', 'fr']) {
      if (message[lang].length > 1500) message[lang] = `${message[lang].slice(0, 1499)}…`;
    }
    return { connected, message };
  }

  async updateStatus() {
    if (!this.running) return;
    const { connected, message } = this.computeStatus();
    await this.setStatus(connected, message);
  }
}
