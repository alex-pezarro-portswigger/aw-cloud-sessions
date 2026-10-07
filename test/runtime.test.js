import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudRuntime, EMPTY_ANALYSIS } from '../lib/runtime.js';
import { STORE } from '../lib/sweep.js';

const memStore = (records = {}) => ({ get: (id) => records[id] ?? null, put: (id, r) => { records[id] = r; return r; } });

test('runtime shape: id, label, not resumable, no readLive, no wrapLaunch', () => {
  const rt = createCloudRuntime();
  assert.equal(rt.id, 'cloud');
  assert.equal(rt.label, '☁ Cloud');
  assert.equal(rt.resumable, false);
  assert.equal(rt.skipsHostResumeGuard, false);
  assert.equal(rt.readLive, undefined);
  assert.equal(rt.wrapLaunch, undefined);
  for (const k of ['buildLaunch', 'preflight', 'deliver', 'analyze', 'launchStatus']) assert.equal(typeof rt[k], 'function', k);
});

test('analyze returns the truthy empty-analysis object, never null', async () => {
  const rt = createCloudRuntime();
  const a = await rt.analyze({ entry: {}, liveSid: 'whatever' });
  assert.deepEqual(a, { usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: [] });
  a.subAgents.push('x');
  assert.deepEqual(EMPTY_ANALYSIS.subAgents, [], 'each call gets its own copy');
});

test('buildLaunch hands intent, card id, ext slice, settings and the store to the builder', async () => {
  const seen = [];
  const store = memStore();
  const rt = createCloudRuntime({ buildLaunchImpl: (args) => { seen.push(args); return 'PANE'; } });
  const host = { stores: { [STORE]: store } };
  const out = await rt.buildLaunch({
    phase: 'dispatch', intent: 'go', cwd: '/repo', sessionId: 's-1', model: 'opus',
    ext: { environmentId: 'env_a', ref: '' }, host, settings: { defaultEnvironment: 'env_b' },
  });
  assert.equal(out, 'PANE');
  assert.deepEqual(seen, [{ intent: 'go', sessionId: 's-1', ext: { environmentId: 'env_a', ref: '' }, settings: { defaultEnvironment: 'env_b' }, store }]);
});

test('buildLaunch falls back to host.settings.all() when the binding passes no settings', async () => {
  let got;
  const rt = createCloudRuntime({ buildLaunchImpl: (args) => { got = args.settings; return 'x'; } });
  await rt.buildLaunch({ intent: 'go', sessionId: 's-1', host: { stores: { [STORE]: memStore() }, settings: { all: () => ({ defaultEnvironment: 'env_h' }) } } });
  assert.deepEqual(got, { defaultEnvironment: 'env_h' });
});

test('buildLaunch refuses any phase but dispatch, and needs the store', async () => {
  const rt = createCloudRuntime({ buildLaunchImpl: () => 'x' });
  const host = { stores: { [STORE]: memStore() } };
  for (const phase of ['resume', 'fork']) {
    await assert.rejects(rt.buildLaunch({ phase, intent: 'go', sessionId: 's-1', host }), /can't build a "\w+" launch/);
  }
  await assert.rejects(rt.buildLaunch({ intent: 'go', sessionId: 's-1', host: { stores: {} } }), /store is not available/);
});

test('buildLaunch passes a null ext slice through (spawn_session)', async () => {
  const rt = createCloudRuntime({
    buildLaunchImpl: (args) => `built:${args.intent}:${args.ext?.environmentId ?? 'none'}`,
  });
  assert.equal(await rt.buildLaunch({ intent: 'go', sessionId: 's-1', ext: null, host: { stores: { [STORE]: memStore() } }, settings: {} }), 'built:go:none');
});

test('preflight resolves the environment the launch would use and passes the widened bag through', async () => {
  const calls = [];
  const rt = createCloudRuntime({ preflightImpl: async (opts) => { calls.push(opts); return null; } });
  const settings = { defaultEnvironment: 'env_def', environments: ['env_a A', 'ccpool_b'] };
  assert.equal(await rt.preflight({ cwd: '/repo', agent: 'claude', workflow: false, worktree: true, ext: null, settings }), null);
  assert.deepEqual(calls[0], {
    cwd: '/repo', agent: 'claude', workflow: false, worktree: true,
    environmentId: 'env_def', ref: '', allowedEnvironmentIds: ['env_a', 'ccpool_b', 'env_def'],
  });
  await rt.preflight({ cwd: '/repo', ext: { environmentId: 'ccpool_b', ref: 'dev' }, settings });
  assert.equal(calls[1].environmentId, 'ccpool_b');
  assert.equal(calls[1].ref, 'dev');
  assert.equal(calls[1].workflow, false);
  assert.equal(calls[1].worktree, false);
});

test('preflight returns the refusal message from the real preflight', async () => {
  const rt = createCloudRuntime();
  const msg = await rt.preflight({ cwd: '/repo', agent: 'codex', settings: {} });
  assert.match(msg, /Claude-only/);
  assert.match(await rt.preflight({ cwd: '/repo', agent: 'claude', worktree: true, settings: {} }), /worktree/);
  assert.match(await rt.preflight({ cwd: '/repo', ext: { environmentId: 'env_zzz' }, settings: { environments: ['env_a'] } }), /isn't one of the environments configured/);
});

test('deliver: the store id is used and the result is narrowed to the contract shape', async () => {
  const sent = [];
  const rt = createCloudRuntime({ sendImpl: async (a) => { sent.push(a); return { ok: true }; } });
  const host = { stores: { [STORE]: memStore({ 's-1': { cloudSessionId: 'session_S' } }) } };
  assert.deepEqual(await rt.deliver({ entry: { sessionId: 's-1' }, from: 's-0', text: 'BEGIN\nhi\nEND', host }), { ok: true });
  assert.deepEqual(sent, [{ cloudSessionId: 'session_S', text: 'BEGIN\nhi\nEND' }]);
});

test('deliver: falls back to the card link, and a failure keeps only ok and error', async () => {
  const rt = createCloudRuntime({ sendImpl: async ({ cloudSessionId }) => ({ ok: false, error: `nope ${cloudSessionId}`, archived: false }) });
  const host = { stores: { [STORE]: memStore() } };
  const res = await rt.deliver({ entry: { sessionId: 's-2', links: [{ type: 'cloud', key: 'session_L' }] }, text: 'x', host });
  assert.deepEqual(res, { ok: false, error: 'nope session_L' });
});

test('deliver: no id anywhere is the real "try again" failure', async () => {
  const rt = createCloudRuntime();
  const res = await rt.deliver({ entry: { sessionId: 's-1' }, text: 'x', host: { stores: { [STORE]: memStore() } } });
  assert.equal(res.ok, false);
  assert.match(res.error, /try again once the card shows its ☁ link/);
});

test('launchStatus answers from a settled record', async () => {
  const records = {
    a: { status: 'created', url: 'https://claude.ai/code/session_a' },
    b: { status: 'created' },
    c: { status: 'failed', error: 'no GitHub remote was detected' },
    d: { status: 'failed' },
    e: { status: 'unknown' },
  };
  const rt = createCloudRuntime({ readLogImpl: () => { throw new Error('a settled record must not read the log'); } });
  const host = { stores: { [STORE]: memStore(records) } };
  const ask = (id) => rt.launchStatus({ entry: { sessionId: id }, host });
  assert.deepEqual(await ask('a'), { state: 'ok', url: 'https://claude.ai/code/session_a' });
  assert.deepEqual(await ask('b'), { state: 'ok' });
  assert.deepEqual(await ask('c'), { state: 'failed', error: 'no GitHub remote was detected' });
  assert.deepEqual(await ask('d'), { state: 'failed', error: 'Creating the cloud session failed.' });
  assert.deepEqual(await ask('e'), { state: 'unknown' });
});

test('launchStatus reads a pending card\'s log without waiting for the sweep', async () => {
  const logs = {
    ok: '{"ok":true,"session_id":"session_01X","url":"https://claude.ai/code/session_01X"}\r\n',
    bad: '{"ok":false,"error":"no GitHub remote was detected"}\n',
    early: '',
  };
  const records = { ok: { status: 'pending' }, bad: { status: 'pending' }, early: { status: 'pending' } };
  const rt = createCloudRuntime({ readLogImpl: async (id) => logs[id] });
  const host = { stores: { [STORE]: memStore(records) } };
  const ask = (id) => rt.launchStatus({ entry: { sessionId: id }, host });
  assert.deepEqual(await ask('ok'), { state: 'ok', url: 'https://claude.ai/code/session_01X' });
  assert.deepEqual(await ask('bad'), { state: 'failed', error: 'no GitHub remote was detected' });
  assert.deepEqual(await ask('early'), { state: 'pending' });
  assert.deepEqual(records.bad, { status: 'pending' }, 'the record is left for the sweep');
});

test('launchStatus is null for a card the extension has no record of', async () => {
  const rt = createCloudRuntime();
  assert.equal(await rt.launchStatus({ entry: { sessionId: 'zz' }, host: { stores: { [STORE]: memStore() } } }), null);
  assert.equal(await rt.launchStatus({ entry: {}, host: { stores: { [STORE]: memStore() } } }), null);
  assert.equal(await rt.launchStatus({ entry: { sessionId: 'zz' }, host: {} }), null);
});
