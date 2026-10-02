import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyEnvironmentId, buildCreateCommand, buildSteerCommand, assertNoPromptWithCloudDescription,
  wrapForPane, buildLaunch, HANDOFF_BANNER,
} from '../lib/command.js';
import { createStateStore } from '../lib/state.js';

// The `env -u …` prefix depends on the ambient env (every CLAUDE_CODE_* is
// stripped), so assert it separately and compare the `claude …` invocation
// byte-for-byte. The env vars are upper-case, so the first lower-case
// `claude ` is always the binary.
const invocation = (cmd) => cmd.slice(cmd.indexOf('claude '));
const assertCleanEnv = (cmd) => {
  assert.ok(cmd.startsWith('env -u '), `expected a cleanClaudeEnv prefix, got: ${cmd}`);
  assert.match(cmd, /(?:^|\s)-u CLAUDECODE(?:\s|$)/);
};

test('classifyEnvironmentId: env_ / ccpool_ / empty, and garbage throws', () => {
  assert.equal(classifyEnvironmentId('env_abc123'), 'anthropic');
  assert.equal(classifyEnvironmentId('ccpool_abc123'), 'self-hosted');
  assert.equal(classifyEnvironmentId(''), 'default');
  assert.equal(classifyEnvironmentId(null), 'default');
  assert.equal(classifyEnvironmentId(undefined), 'default');
  assert.equal(classifyEnvironmentId('   '), 'default');
  assert.throws(() => classifyEnvironmentId('env-abc'), /Unrecognised cloud environment id/);
  assert.throws(() => classifyEnvironmentId('pool_abc'), /Unrecognised cloud environment id/);
});

test('create: account default is the interactive --cloud form, no --settings, no -p', () => {
  const cmd = buildCreateCommand({ intent: 'fix the flaky test' });
  assertCleanEnv(cmd);
  assert.equal(invocation(cmd), "claude --cloud 'fix the flaky test'");
});

test('create: an env_ id adds the inline remote.defaultEnvironmentId settings', () => {
  const cmd = buildCreateCommand({ intent: 'fix the flaky test', environmentId: 'env_0123abc' });
  assertCleanEnv(cmd);
  assert.equal(
    invocation(cmd),
    `claude --cloud 'fix the flaky test' --settings '{"remote":{"defaultEnvironmentId":"env_0123abc"}}'`,
  );
});

test('create: a ccpool_ id is the -p/--environment/json form, with --ref when given', () => {
  const cmd = buildCreateCommand({ intent: 'fix the flaky test', environmentId: 'ccpool_9z', ref: 'main' });
  assertCleanEnv(cmd);
  assert.equal(
    invocation(cmd),
    "claude -p 'fix the flaky test' --environment 'ccpool_9z' --ref 'main' --output-format json",
  );
});

test('create: self-hosted without a ref omits --ref entirely', () => {
  const cmd = buildCreateCommand({ intent: 'go', environmentId: 'ccpool_9z' });
  assert.equal(invocation(cmd), "claude -p 'go' --environment 'ccpool_9z' --output-format json");
});

test('create: --ref is NEVER emitted on the anthropic/default form', () => {
  for (const environmentId of ['', 'env_0123abc']) {
    const cmd = buildCreateCommand({ intent: 'go', environmentId, ref: 'some-branch' });
    assert.ok(!cmd.includes('--ref'), `--ref leaked into the anthropic form: ${cmd}`);
    assert.ok(!cmd.includes('some-branch'));
  }
});

test('create: an intent is required, and a malformed environment id refuses', () => {
  assert.throws(() => buildCreateCommand({ intent: '   ' }), /needs an intent/);
  assert.throws(() => buildCreateCommand({}), /needs an intent/);
  assert.throws(() => buildCreateCommand({ intent: 'go', environmentId: 'nope_1' }), /Unrecognised cloud environment id/);
});

test('create: shell metacharacters in the intent are quoted, not interpreted', () => {
  const cmd = buildCreateCommand({ intent: "don't; rm -rf $HOME" });
  assert.equal(invocation(cmd), `claude --cloud 'don'\\''t; rm -rf $HOME'`);
});

test('create: the env prefix strips the given env\'s CLAUDE_CODE_* vars', () => {
  const cmd = buildCreateCommand({ intent: 'go', env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
  assert.match(cmd, /-u CLAUDE_CODE_CHILD_SESSION claude --cloud 'go'$/);
});

test('guard: -p plus a --cloud DESCRIPTION throws (silent-local-run footgun)', () => {
  assert.throws(
    () => assertNoPromptWithCloudDescription("env -u CLAUDECODE claude -p 'do the thing' --cloud 'do the thing'"),
    /silently runs the prompt LOCALLY/,
  );
  assert.throws(
    () => assertNoPromptWithCloudDescription('claude --print --cloud make-me-a-sandwich'),
    /silently runs the prompt LOCALLY/,
  );
  assert.throws(
    () => assertNoPromptWithCloudDescription('claude -p hi --cloud=describe-me'),
    /silently runs the prompt LOCALLY/,
  );
});

test('guard: the real forms and a steer by session id do NOT trip it', () => {
  // Anthropic create: --cloud with a description but no -p.
  assertNoPromptWithCloudDescription(buildCreateCommand({ intent: 'do the thing' }));
  // Self-hosted create: -p but no --cloud at all.
  assertNoPromptWithCloudDescription(buildCreateCommand({ intent: 'do the thing', environmentId: 'ccpool_1' }));
  // Steering an existing session is legitimately -p + --cloud <session_…>.
  assertNoPromptWithCloudDescription("claude -p 'nudge' --cloud 'session_01ABC' --output-format json");
  assertNoPromptWithCloudDescription(buildSteerCommand({ cloudSessionId: 'session_01ABC', text: 'nudge' }));
});

test('guard: a flag-shaped intent inside quotes is not read as a -p flag', () => {
  const cmd = buildCreateCommand({ intent: 'retry the build with -p set and --print too' });
  assert.equal(invocation(cmd), "claude --cloud 'retry the build with -p set and --print too'");
});

// shellQuote escapes an apostrophe as `'\''`, which closes one quoted span and
// opens another, so a flag-shaped word AFTER an apostrophe used to land outside
// every span and refuse a perfectly ordinary intent.
test('guard: an apostrophe in the intent does not expose a later -p to the flag scan', () => {
  const cmd = buildCreateCommand({ intent: "don't run this with -p, or --print" });
  assert.equal(invocation(cmd), `claude --cloud 'don'\\''t run this with -p, or --print'`);
});

test('steer: byte-exact, quoted, and only for a session_ id', () => {
  const cmd = buildSteerCommand({ cloudSessionId: 'session_abc123', text: "don't stop" });
  assertCleanEnv(cmd);
  assert.equal(invocation(cmd), "claude -p 'don'\\''t stop' --cloud 'session_abc123' --output-format json");
  // A card id or a conversation uuid is a different namespace and must never
  // reach --cloud, where it would read as a description.
  for (const bad of ['s-1770000000000-ab12', '9f1c0b6e-1111-4222-8333-444455556666', '', undefined, 'session_a b']) {
    assert.throws(() => buildSteerCommand({ cloudSessionId: bad, text: 'hi' }), /without a session_… id/, String(bad));
  }
});

test('wrapForPane: darwin is BSD script with -F, then the held tail', () => {
  const out = wrapForPane({ cmd: "env -u CLAUDECODE claude --cloud 'go'", logPath: '/d/logs/s-1.log', platform: 'darwin' });
  assert.equal(
    out,
    "script -q -F '/d/logs/s-1.log' /bin/sh -c 'env -u CLAUDECODE claude --cloud '\\''go'\\'''"
      + "; printf '\\n%s\\n' '☁ Cloud session handed off. This pane only holds the card; archive the card to close it.'"
      + '; exec sleep 2147483647',
  );
});

test('wrapForPane: linux is util-linux script with -f -c, log last', () => {
  const out = wrapForPane({ cmd: "env -u CLAUDECODE claude --cloud 'go'", logPath: '/d/logs/s-1.log', platform: 'linux' });
  assert.equal(
    out,
    "script -q -f -c 'env -u CLAUDECODE claude --cloud '\\''go'\\''' '/d/logs/s-1.log'"
      + "; printf '\\n%s\\n' '☁ Cloud session handed off. This pane only holds the card; archive the card to close it.'"
      + '; exec sleep 2147483647',
  );
  assert.ok(out.includes(HANDOFF_BANNER));
});

test('wrapForPane: needs a command and a log path', () => {
  assert.throws(() => wrapForPane({ logPath: '/x' }), /needs a command/);
  assert.throws(() => wrapForPane({ cmd: 'x' }), /needs a log path/);
});

// buildLaunch writes under <AW_DATA_DIR>/aw-cloud-sessions, so each case gets its
// own temp data dir.
function launchFixture() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cloud-launch-'));
  const env = { AW_DATA_DIR: data };
  const store = createStateStore({ file: path.join(data, 'state.json'), now: () => 5000 });
  const logPath = path.join(data, 'aw-cloud-sessions', 'logs', 's-1.log');
  return { data, env, store, logPath };
}

test('buildLaunch: ext slice wins over the setting, and the record is pending', () => {
  const { env, store, logPath } = launchFixture();
  const out = buildLaunch({
    intent: 'go', sessionId: 's-1', ext: { environmentId: 'ccpool_ext', ref: 'dev' },
    settings: { defaultEnvironment: 'env_setting' }, store, env, platform: 'linux', now: () => 5000,
  });
  assert.ok(out.startsWith('script -q -f -c '));
  assert.match(out, /claude -p '\\''go'\\'' --environment '\\''ccpool_ext'\\'' --ref '\\''dev'\\'' --output-format json/);
  assert.ok(out.includes(`'${logPath}'`));
  assert.deepEqual(store.get('s-1'), {
    cardId: 's-1', status: 'pending', environmentId: 'ccpool_ext', ref: 'dev', startedAt: 5000, updatedAt: 5000,
  });
  assert.equal(fs.readFileSync(logPath, 'utf8'), '');
});

test('buildLaunch: no slice falls back to defaultEnvironment, then the account default', () => {
  const a = launchFixture();
  const withSetting = buildLaunch({
    intent: 'go', sessionId: 's-1', ext: null, settings: { defaultEnvironment: 'env_setting' },
    store: a.store, env: a.env, platform: 'darwin',
  });
  assert.match(withSetting, /defaultEnvironmentId/);
  assert.match(withSetting, /env_setting/);
  assert.equal(a.store.get('s-1').environmentId, 'env_setting');

  const b = launchFixture();
  const bare = buildLaunch({ intent: 'go', sessionId: 's-1', ext: null, settings: {}, store: b.store, env: b.env, platform: 'darwin' });
  assert.doesNotMatch(bare, /--settings|--environment/);
  assert.equal(b.store.get('s-1').environmentId, '');
});

test('buildLaunch: truncates a stale log and prunes week-old ones', () => {
  const { env, store, logPath } = launchFixture();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, 'old output session_STALE');
  const old = path.join(path.dirname(logPath), 's-old.log');
  fs.writeFileSync(old, 'x');
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
  buildLaunch({ intent: 'go', sessionId: 's-1', settings: {}, store, env });
  assert.equal(fs.readFileSync(logPath, 'utf8'), '');
  assert.equal(fs.existsSync(old), false);
});

test('buildLaunch: a bad intent or environment throws before anything is written', () => {
  const { env, store, data } = launchFixture();
  assert.throws(() => buildLaunch({ intent: '', sessionId: 's-1', settings: {}, store, env }), /needs an intent/);
  assert.throws(() => buildLaunch({ intent: 'go', sessionId: 's-1', ext: { environmentId: 'prod' }, settings: {}, store, env }), /Unrecognised/);
  assert.equal(store.get('s-1'), null);
  assert.equal(fs.existsSync(path.join(data, 'aw-cloud-sessions')), false);
});

test('buildLaunch: a card id that could escape the logs dir is refused', () => {
  const { env, store } = launchFixture();
  assert.throws(() => buildLaunch({ intent: 'go', sessionId: '../x', settings: {}, store, env }), /Not a usable card id/);
});
