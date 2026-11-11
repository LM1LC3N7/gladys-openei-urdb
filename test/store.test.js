// -----------------------------------------------------------------------------
// /data on a real file: a file that cannot be read is never an empty state
// (it would be written over), a save goes through a temporary file.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/store.js';

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'urdb-store-'));
  t.after(() => {
    try {
      chmodSync(join(dir, 'state.json'), 0o600);
    } catch {
      // not there
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('no file: an empty state; a saved state reads back', async (t) => {
  const file = join(folder(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { ok: true, data: {} });
  await store.save({ v: 1, asked: { a: 5 } });
  assert.deepEqual(await store.load(), { ok: true, data: { v: 1, asked: { a: 5 } } });
});

test('a file that cannot be read (permissions) is not an empty state', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads anything');
  const file = join(folder(t), 'state.json');
  writeFileSync(file, '{"v":1}');
  chmodSync(file, 0o000);
  const loaded = await createFileStore(file).load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'EACCES');
});

test('JSON that is not an object (an array, a number, broken) is not a state', async (t) => {
  const file = join(folder(t), 'state.json');
  const store = createFileStore(file);
  for (const text of ['[1,2]', '42', '{', '']) {
    writeFileSync(file, text);
    assert.equal((await store.load()).ok, false, text);
  }
});

test('a save goes through a temporary file: a failed save leaves the old state whole', async (t) => {
  const dir = folder(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{"v":1,"keep":true}');
  mkdirSync(`${file}.tmp`);
  await assert.rejects(createFileStore(file).save({ v: 1, keep: false }));
  assert.equal(readFileSync(file, 'utf8'), '{"v":1,"keep":true}');
});
