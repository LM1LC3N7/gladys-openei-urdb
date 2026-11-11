// -----------------------------------------------------------------------------
// The version and the User-Agent follow package.json at run time: a release
// that bumps package.json (and only it, with the lock and the manifest)
// never leaves the code behind.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('a bumped package.json is the version of the User-Agent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'urdb-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(new URL('../src/constants.js', import.meta.url), join(dir, 'src', 'constants.js'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  const c = await import(pathToFileURL(join(dir, 'src', 'constants.js')).href);
  assert.equal(c.VERSION, '9.8.7');
  assert.equal(
    c.USER_AGENT,
    'gladys-openei-urdb/9.8.7 (+https://github.com/LM1LC3N7/gladys-openei-urdb)',
  );
});

test('a package.json without a usable version: 0.0.0, never a crash', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'urdb-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(new URL('../src/constants.js', import.meta.url), join(dir, 'src', 'constants.js'));
  writeFileSync(join(dir, 'package.json'), '{"version":"1.0.0\\nX"}');
  const c = await import(pathToFileURL(join(dir, 'src', 'constants.js')).href);
  assert.equal(c.VERSION, '0.0.0');
});
