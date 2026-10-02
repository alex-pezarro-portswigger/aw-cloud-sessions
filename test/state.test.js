import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore, stateFactory } from '../lib/state.js';
import { dataDir, extDir, stateFile, logsDir, logPathFor } from '../lib/paths.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cloud-state-')), 'nested', 'state.json');

test('paths: AW_DATA_DIR wins (with ~ expanded), else ~/.agent-wrangler', () => {
  assert.equal(dataDir({ AW_DATA_DIR: '/x/data' }), '/x/data');
  assert.equal(dataDir({ AW_DATA_DIR: '~/dev-aw' }), path.join(os.homedir(), 'dev-aw'));
  assert.equal(dataDir({}), path.join(os.homedir(), '.agent-wrangler'));
  const env = { AW_DATA_DIR: '/d' };
  assert.equal(extDir(env), '/d/aw-cloud-sessions');
  assert.equal(stateFile(env), '/d/aw-cloud-sessions/state.json');
  assert.equal(logsDir(env), '/d/aw-cloud-sessions/logs');
  assert.equal(logPathFor('s-177-ab12', env), '/d/aw-cloud-sessions/logs/s-177-ab12.log');
});

test('paths: a card id that could escape the logs dir is refused', () => {
  for (const bad of ['../x', 'a/b', '', '.', 'a.b', null, undefined]) {
    assert.throws(() => logPathFor(bad, { AW_DATA_DIR: '/d' }), /Not a usable card id/, String(bad));
  }
});

test('store: put/get/update/remove persist across instances', () => {
  const file = tmpFile();
  let t = 1000;
  const a = createStateStore({ file, now: () => t });
  assert.equal(a.get('s-1'), null);
  a.put('s-1', { status: 'pending', environmentId: 'env_x', ref: '', startedAt: 1000 });
  t = 2000;
  const updated = a.update('s-1', { status: 'created', cloudSessionId: 'session_A' });
  assert.equal(updated.status, 'created');
  assert.equal(updated.updatedAt, 2000);

  const b = createStateStore({ file });
  assert.deepEqual(b.get('s-1'), {
    cardId: 's-1', status: 'created', environmentId: 'env_x', ref: '', startedAt: 1000,
    cloudSessionId: 'session_A', updatedAt: 2000,
  });
  assert.equal(b.remove('s-1'), true);
  assert.equal(b.remove('s-1'), false);
  assert.equal(createStateStore({ file }).get('s-1'), null);
});

test('store: update of a missing record is a no-op returning null', () => {
  const s = createStateStore({ file: tmpFile() });
  assert.equal(s.update('nope', { status: 'created' }), null);
  assert.deepEqual(s.list(), []);
});

test('store: pending() lists only pending records, and returns copies', () => {
  const s = createStateStore({ file: tmpFile() });
  s.put('a', { status: 'pending' });
  s.put('b', { status: 'created' });
  s.put('c', { status: 'pending' });
  assert.deepEqual(s.pending().map((r) => r.cardId).sort(), ['a', 'c']);
  const got = s.get('a');
  got.status = 'mutated';
  assert.equal(s.get('a').status, 'pending');
});

test('store: a corrupt file starts empty, logs, and is replaced on the next write', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const logs = [];
  const s = createStateStore({ file, log: (m) => logs.push(m) });
  assert.deepEqual(s.list(), []);
  assert.match(logs[0], /ignoring unreadable/);
  s.put('a', { status: 'pending' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).records.a.status, 'pending');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temp file left behind');
});

test('stateFactory builds a store from the minimal factory bag', () => {
  const s = stateFactory({ id: 'cloud-sessions', extId: 'cloud', settings: {}, log: () => {} });
  for (const k of ['get', 'list', 'pending', 'put', 'update', 'remove']) assert.equal(typeof s[k], 'function');
});
