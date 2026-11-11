// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. When the Gladys
// clone of the development machine is there, the manifest also goes through
// the core validator itself (energy contracts, tariff grammar, inputs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIONS,
  LABEL_INPUT,
  SECTORS,
  TEMPLATES,
  TEMPLATE_VERSION,
  USER_AGENT,
  VERSION,
} from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const wiring = read('src/wire.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics; one semver version in 4 places (and the User-Agent), never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'provider');
  assert.ok(manifest.name.length <= 30, 'the store caps the name at 30 characters');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-openei-urdb:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.ok(
    USER_AGENT.startsWith(`gladys-openei-urdb/${pkg.version} (+https://github.com/LM1LC3N7/`),
  );
  assert.equal(pkg.name, 'gladys-openei-urdb');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\./);
  assert.deepEqual(manifest.categories, ['energy']);
  assert.deepEqual(manifest.transports, ['cloud']);
  // energy_contracts needs Gladys 5.2.0 (code-enforced by the store indexer).
  assert.equal(manifest.gladys_version, '>=5.2.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-openei-urdb\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /^Unofficial/);
  assert.match(manifest.description.fr, /^Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say how it was tested, what is not computed, where the data come from', () => {
  const fr = read('docs/fr.md');
  const en = read('docs/en.md');
  assert.match(fr, /jamais testée avec un vrai Gladys/);
  assert.match(en, /never tested with a real Gladys/);
  assert.match(fr, /DEMO_KEY/);
  assert.match(en, /DEMO_KEY/);
  for (const doc of [fr, en]) {
    assert.match(doc, /\$\/kW/);
    assert.match(doc, /CC0/);
  }
  assert.match(fr, /[Ff]rais de puissance/);
  assert.match(en, /[Dd]emand charges/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Utility Rate Database/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /CC0/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration: one secret key, no default, described as Gladys keeps it', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'api_key']);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(fields.api_key.type, 'secret');
  assert.ok(!('default' in fields.api_key), 'never a default for a secret');
  assert.equal(fields.api_key.required, true);
  assert.match(
    fields.api_key.description.en,
    /Kept by Gladys in its database, never shown again, sent only to api\.openei\.org/,
  );
  assert.match(
    fields.api_key.description.fr,
    /Gardée par Gladys dans sa base, jamais réaffichée, envoyée seulement à api\.openei\.org/,
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the buttons match the handlers; the sector options match the code', () => {
  const actions = Object.fromEntries(manifest.actions.map((a) => [a.key, a]));
  assert.deepEqual(Object.keys(actions).sort(), Object.values(ACTIONS).sort());
  for (const key of Object.values(ACTIONS)) {
    assert.ok(wiring.includes(`ACTIONS.${key === ACTIONS.TEST ? 'TEST' : 'FIND'}`));
    assert.ok(actions[key].timeout_seconds >= 5 && actions[key].timeout_seconds <= 120);
  }
  const sector = actions[ACTIONS.FIND].fields.find((f) => f.key === 'sector');
  assert.deepEqual(
    sector.options.map((o) => o.value),
    SECTORS,
  );
  assert.ok(
    sector.options.every((o) => typeof o.label.en === 'string' && o.label.en.trim() === o.label.en),
  );
  assert.ok(wiring.includes('onEnergyPrice') && wiring.includes('onEnergyCurrent'));
  // A provider: no device, so no supported_options to publish.
  assert.ok(!('widgets' in manifest) && !('scene_triggers' in manifest));
});

test('the templates: one per US timezone, delegated, USD, the label input and the fixed charges', () => {
  const templates = manifest.energy_contracts.templates;
  assert.ok(templates.length <= 20);
  assert.ok(!('calendars' in manifest.energy_contracts));
  assert.deepEqual(
    templates.map((t) => [t.key, t.timezone]),
    TEMPLATES.map((t) => [t.key, t.timezone]),
  );
  for (const template of templates) {
    assert.equal(template.pricing_mode, 'delegated');
    assert.equal(template.country, 'US');
    assert.equal(template.currency, 'USD');
    assert.equal(template.version, TEMPLATE_VERSION);
    assert.ok(template.name.en.length <= 64 && template.name.fr.length <= 64);
    assert.ok(template.description.en.length <= 512 && template.description.fr.length <= 512);
    const inputs = Object.fromEntries(template.inputs.map((i) => [i.key, i]));
    assert.deepEqual(Object.keys(inputs), [
      LABEL_INPUT,
      'fixed_charge_per_day',
      'fixed_charge_per_month',
    ]);
    assert.equal(inputs[LABEL_INPUT].type, 'string');
    assert.equal(inputs[LABEL_INPUT].required, true);
    for (const input of template.inputs) {
      assert.ok(input.label.en.length <= 64 && input.label.fr.length <= 64, input.key);
      assert.ok(
        input.description.en.length <= 256 && input.description.fr.length <= 256,
        input.key,
      );
      if (input.unit) assert.ok(input.unit.length <= 16);
    }
    assert.deepEqual(
      template.tariff.components.map((c) => [c.kind, c.per, c.amount]),
      [
        ['fixed', 'day', '{{input:fixed_charge_per_day}}'],
        ['fixed', 'month', '{{input:fixed_charge_per_month}}'],
      ],
    );
  }
});

test('the image ships the code, the manifest, the licence and the notices; never the tests', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /COPY src \.\/src/);
  assert.doesNotMatch(dockerfile, /COPY test/);
  assert.match(dockerfile, /USER node/);
  assert.ok(existsSync(new URL('../LICENSE', import.meta.url)));
  const licence = read('LICENSE');
  assert.match(licence, /Apache License/);
  assert.doesNotMatch(licence, /Copyright \d{4} [A-Z][a-z]+ [A-Z]/, 'no personal name');
});

// The core validator of the development machine (absent in the GitHub CI). It
// is run in a child process in a temporary folder: requiring the core opens a
// DuckDB file in the current folder, never in the repository.
const core = join(
  homedir(),
  'code/Gladys/server/lib/external-integration/externalIntegration.validateManifest.js',
);
function coreVerdict(t, candidate) {
  const dir = mkdtempSync(join(tmpdir(), 'urdb-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { validateManifest } = require(${JSON.stringify(core)});
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
      try {
        validateManifest(JSON.parse(input));
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, why: String(err.properties ?? err.message) }));
      }
      process.exit(0);
    });`;
  const run = spawnSync(process.execPath, ['-e', script], {
    cwd: dir,
    input: JSON.stringify(candidate),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('{"ok"')));
}

test(
  'the Gladys core validator accepts the manifest',
  { skip: !existsSync(core) && 'no Gladys clone' },
  (t) => {
    assert.deepEqual(coreVerdict(t, manifest), { ok: true });
    // And it would refuse a tariff the core cannot take (the check is real).
    const broken = structuredClone(manifest);
    broken.energy_contracts.templates[0].tariff.components.push({
      key: 'energy',
      kind: 'consumption',
      fallback: { price: 0.1 },
    });
    const verdict = coreVerdict(t, broken);
    assert.equal(verdict.ok, false);
    assert.match(verdict.why, /delegated template only carries fixed components/);
  },
);
