import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaunchWatch, forgetCard, STORE, DEADLINE_MS, ORPHAN_GRACE_MS } from '../lib/sweep.js';
import { createStateStore } from '../lib/state.js';

const CREATED_LOG = 'Created cloud session\nView: https://claude.ai/code/session_01AB\n';

// A fake host with just the surface the sweep uses, recording every call.
function fakeHost({ cards = ['s-1'], attachThrows = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cloud-sweep-')), 'state.json');
  const store = createStateStore({ file, now: () => 0 });
  const calls = { attach: [], rebuild: 0, log: [] };
  const live = new Set(cards);
  const host = {
    stores: { [STORE]: store },
    sessions: { get: (id) => (live.has(id) ? { sessionId: id, runtime: 'cloud' } : null) },
    links: {
      attach: (sid, link) => {
        calls.attach.push([sid, link]);
        if (attachThrows) throw new Error('links:write not granted');
      },
    },
    rebuild: () => { calls.rebuild += 1; },
    log: (m) => calls.log.push(m),
  };
  return { host, store, calls, live };
}

// A sweep over an in-memory log map, with a settable clock.
function watch(logs = {}, clock = { t: 1000 }, extra = {}) {
  const forgotten = [];
  const w = createLaunchWatch({
    readLog: async (file) => logs[file] ?? '',
    logPath: (cardId) => `/logs/${cardId}.log`,
    forget: (cardId, host) => { forgotten.push(cardId); host.stores[STORE].remove(cardId); },
    now: () => clock.t,
    ...extra,
  });
  return { w, clock, logs, forgotten };
}

const pending = (store, id = 's-1', startedAt = 1000) => store.put(id, { status: 'pending', environmentId: '', ref: '', startedAt });

test('pending + an empty log: nothing changes, nothing attached', async () => {
  const { host, store, calls } = fakeHost();
  pending(store);
  const { w } = watch();
  assert.deepEqual(await w.run({ host }), []);
  assert.equal(store.get('s-1').status, 'pending');
  assert.deepEqual(calls.attach, []);
  assert.equal(calls.rebuild, 0);
});

test('pending + an id in the log: created, link attached, board rebuilt', async () => {
  const { host, store, calls } = fakeHost();
  pending(store);
  const { w } = watch({ '/logs/s-1.log': CREATED_LOG });
  assert.deepEqual(await w.run({ host }), [{ cardId: 's-1', to: 'created' }]);
  const rec = store.get('s-1');
  assert.equal(rec.status, 'created');
  assert.equal(rec.cloudSessionId, 'session_01AB');
  assert.equal(rec.url, 'https://claude.ai/code/session_01AB');
  assert.deepEqual(calls.attach, [['s-1', { type: 'cloud', key: 'session_01AB', url: 'https://claude.ai/code/session_01AB' }]]);
  assert.equal(calls.rebuild, 1);
});

test('an id without a usable url attaches a key-only link', async () => {
  const { host, store, calls } = fakeHost();
  pending(store);
  const { w } = watch({ '/logs/s-1.log': '{"session_id":"session_ZZ9"}\n' });
  await w.run({ host });
  assert.deepEqual(calls.attach, [['s-1', { type: 'cloud', key: 'session_ZZ9' }]]);
  assert.equal(store.get('s-1').url, null);
});

test('idempotent: a created record is never rewritten or re-attached', async () => {
  const { host, store, calls } = fakeHost();
  pending(store);
  const { w, logs } = watch({ '/logs/s-1.log': CREATED_LOG });
  await w.run({ host });
  logs['/logs/s-1.log'] = '{"session_id":"session_OTHER"}\n';
  assert.deepEqual(await w.run({ host }), []);
  assert.equal(store.get('s-1').cloudSessionId, 'session_01AB');
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.rebuild, 1);
});

test('pending + a create error: failed, the failed marker attached, the error logged', async () => {
  const { host, store, calls } = fakeHost();
  pending(store);
  const { w } = watch({ '/logs/s-1.log': '{"ok":false,"error":"no GitHub remote was detected"}\n' });
  assert.deepEqual(await w.run({ host }), [{ cardId: 's-1', to: 'failed' }]);
  assert.equal(store.get('s-1').status, 'failed');
  assert.equal(store.get('s-1').error, 'no GitHub remote was detected');
  assert.deepEqual(calls.attach, [['s-1', { type: 'cloud', key: 'failed' }]]);
  assert.match(calls.log[0], /failed: no GitHub remote/);
  assert.equal(calls.rebuild, 1);
});

test('past the deadline: unknown, logged once, and the message says whether a create was seen', async () => {
  const { host, store, calls } = fakeHost({ cards: ['s-1', 's-2'] });
  pending(store, 's-1');
  pending(store, 's-2');
  const { w, clock } = watch({ '/logs/s-2.log': '  Created cloud session\n' });
  await w.run({ host }); // records sawCreated on s-2 while still pending
  assert.equal(store.get('s-2').sawCreated, true);
  assert.equal(store.get('s-2').status, 'pending');

  clock.t = 1000 + DEADLINE_MS + 1;
  const out = await w.run({ host });
  assert.deepEqual(out.sort((a, b) => a.cardId.localeCompare(b.cardId)), [
    { cardId: 's-1', to: 'unknown' }, { cardId: 's-2', to: 'unknown' },
  ]);
  assert.equal(calls.log.length, 2);
  assert.ok(calls.log.some((m) => /s-1: no cloud session id/.test(m)));
  assert.ok(calls.log.some((m) => /s-2: the CLI said "Created cloud session"/.test(m)));
  assert.equal(store.get('s-2').sawCreated, true);

  // Logged once: a further pass leaves unknown records alone.
  clock.t += 10_000;
  assert.deepEqual(await w.run({ host }), []);
  assert.equal(calls.log.length, 2);
  assert.deepEqual(calls.attach, []);
  assert.equal(calls.rebuild, 0, 'an unknown outcome attaches nothing, so nothing to rebuild');
});

test('a card that no longer exists is pruned, but only after the grace period', async () => {
  const { host, store } = fakeHost({ cards: [] });
  pending(store);
  const { w, clock, forgotten } = watch({ '/logs/s-1.log': CREATED_LOG });
  // Fresh record, card not saved yet (dispatch is still running): left alone,
  // and the id it found is still recorded.
  clock.t = 1000 + ORPHAN_GRACE_MS - 1;
  assert.deepEqual(await w.run({ host }), [{ cardId: 's-1', to: 'created' }]);
  clock.t = 1000 + ORPHAN_GRACE_MS + 1;
  assert.deepEqual(await w.run({ host }), [{ cardId: 's-1', to: 'pruned' }]);
  assert.deepEqual(forgotten, ['s-1']);
  assert.equal(store.get('s-1'), null);
});

test('without sessions:read nothing is pruned', async () => {
  const { host, store } = fakeHost({ cards: [] });
  delete host.sessions;
  store.put('s-1', { status: 'created', startedAt: 0 });
  const { w, clock } = watch();
  clock.t = 10 * ORPHAN_GRACE_MS;
  assert.deepEqual(await w.run({ host }), []);
  assert.equal(store.get('s-1').status, 'created');
});

test('an attach failure is logged and the record still moves to created', async () => {
  const { host, store, calls } = fakeHost({ attachThrows: true });
  pending(store);
  const { w } = watch({ '/logs/s-1.log': CREATED_LOG });
  await w.run({ host });
  assert.equal(store.get('s-1').status, 'created');
  assert.match(calls.log[0], /could not attach the cloud link to s-1: links:write not granted/);
});

test('a pass that is still running is not re-entered', async () => {
  const { host, store } = fakeHost();
  pending(store);
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = createLaunchWatch({ readLog: async () => { await gate; return CREATED_LOG; }, logPath: (c) => c, now: () => 1000 });
  const first = w.run({ host });
  assert.deepEqual(await w.run({ host }), []);
  release();
  assert.deepEqual(await first, [{ cardId: 's-1', to: 'created' }]);
});

test('a missing store or host is a no-op', async () => {
  const { w } = watch();
  assert.deepEqual(await w.run({}), []);
  assert.deepEqual(await w.run({ host: { stores: {} } }), []);
});

test('one bad record does not stop the others', async () => {
  const { host, store, calls } = fakeHost({ cards: ['s-1', 's-2'] });
  pending(store, 's-1');
  pending(store, 's-2');
  const { w } = watch({}, { t: 1000 }, {
    readLog: async (file) => {
      if (file.includes('s-1')) throw new Error('disk on fire');
      return CREATED_LOG;
    },
  });
  assert.deepEqual(await w.run({ host }), [{ cardId: 's-2', to: 'created' }]);
  assert.match(calls.log[0], /launch-watch failed for s-1: disk on fire/);
});

test('forgetCard drops the record and deletes the log', () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cloud-forget-'));
  const env = { AW_DATA_DIR: data };
  const log = path.join(data, 'aw-cloud-sessions', 'logs', 's-1.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'x');
  const { host, store } = fakeHost();
  pending(store);
  forgetCard({ sessionId: 's-1', host }, { env });
  assert.equal(store.get('s-1'), null);
  assert.equal(fs.existsSync(log), false);
  // An odd id or a missing store doesn't throw.
  forgetCard({ sessionId: '../x', host: {} }, { env });
});
