import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendCloudMessage, resolveCloudSessionId, DELIVER_TIMEOUT_MS } from '../lib/deliver.js';

// A `run` double standing in for the promisified execFile: records the argv and
// options it was handed and replays a canned result (or throws an execFile-shaped
// error, which carries the captured streams alongside the message).
function runner({ stdout = '{"is_error":false}', stderr = '', fail = null } = {}) {
  const calls = [];
  const run = async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (fail) {
      const err = new Error(fail.message || 'Command failed');
      err.stdout = fail.stdout ?? '';
      err.stderr = fail.stderr ?? '';
      if (fail.killed) { err.killed = true; err.signal = 'SIGTERM'; }
      throw err;
    }
    return { stdout, stderr };
  };
  return { run, calls };
}

test('sendCloudMessage runs the steer form through a login shell, env-stripped, quoted and time-bounded', async () => {
  const r = runner();
  const res = await sendCloudMessage({ cloudSessionId: 'session_abc123', text: "don't stop", run: r.run });
  assert.equal(res.ok, true);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].file, 'sh');
  assert.equal(r.calls[0].args[0], '-lc');
  const cmd = r.calls[0].args[1];
  assert.match(cmd, /^env -u CLAUDECODE /);
  assert.match(cmd, /claude -p 'don'\\''t stop' --cloud 'session_abc123' --output-format json$/);
  assert.equal(r.calls[0].opts.timeout, DELIVER_TIMEOUT_MS);
  assert.equal(DELIVER_TIMEOUT_MS, 90_000);
});

test('sendCloudMessage refuses before shelling out when the cloud id was never captured', async () => {
  const r = runner();
  const res = await sendCloudMessage({ cloudSessionId: null, text: 'hi', run: r.run });
  assert.equal(res.ok, false);
  assert.match(res.error, /no session id captured yet/);
  assert.match(res.error, /☁ link/);
  assert.equal(r.calls.length, 0);
});

test('sendCloudMessage refuses an id from the wrong namespace without shelling out', async () => {
  const r = runner();
  const res = await sendCloudMessage({ cloudSessionId: 's-1770000000000-ab12', text: 'hi', run: r.run });
  assert.equal(res.ok, false);
  assert.match(res.error, /session_… id/);
  assert.equal(r.calls.length, 0);
});

test('sendCloudMessage reports a non-zero exit using the CLI streams, not the spawn message', async () => {
  const r = runner({ fail: { message: 'Command failed: sh -lc …', stderr: 'Error: session not found' } });
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: r.run });
  assert.equal(res.ok, false);
  assert.equal(res.archived, false);
  assert.match(res.error, /session not found/);
  assert.doesNotMatch(res.error, /Command failed/);
});

test('sendCloudMessage falls back to the spawn message when the streams are empty', async () => {
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: runner({ fail: { message: 'spawn sh ENOENT' } }).run });
  assert.equal(res.ok, false);
  assert.match(res.error, /ENOENT/);
});

test('sendCloudMessage reports a timeout plainly', async () => {
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: runner({ fail: { killed: true } }).run, timeoutMs: 90_000 });
  assert.equal(res.ok, false);
  assert.match(res.error, /Timed out after 90 s/);
});

test('sendCloudMessage reads a JSON error result on a clean exit, and flags archived wording', async () => {
  const viaJson = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ stdout: '{"is_error":true,"result":"cloud session is archived"}' }).run,
  });
  assert.equal(viaJson.ok, false);
  assert.equal(viaJson.archived, true);
  assert.match(viaJson.error, /archived/);

  const viaStderr = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ fail: { stderr: 'This session has been ARCHIVED and cannot be resumed' } }).run,
  });
  assert.equal(viaStderr.archived, true);
});

test('sendCloudMessage treats a non-success JSON result as a failure, a success one as ok', async () => {
  const bad = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ stdout: '{"type":"result","subtype":"error_during_execution"}' }).run,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /error_during_execution/);

  const good = await sendCloudMessage({
    cloudSessionId: 'session_x', text: 'hi',
    run: runner({ stdout: '{"type":"result","subtype":"success","is_error":false,"session_id":"session_x"}' }).run,
  });
  assert.deepEqual(good, { ok: true });
});

test('sendCloudMessage treats an exit-0 non-JSON reply as accepted', async () => {
  const res = await sendCloudMessage({ cloudSessionId: 'session_x', text: 'hi', run: runner({ stdout: 'ok\n' }).run });
  assert.deepEqual(res, { ok: true });
});

test('resolveCloudSessionId: store first, then the entry\'s cloud link, then host.links.get', () => {
  const store = { get: (sid) => (sid === 's-1' ? { cloudSessionId: 'session_STORE' } : null) };
  const links = [{ type: 'pr', url: 'https://github.com/a/b/pull/1' }, { type: 'cloud', key: 'session_LINK', url: 'https://claude.ai/code/session_LINK' }];
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-1', links }, store }), 'session_STORE');
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-2', links }, store }), 'session_LINK');
  const host = { links: { get: (sid) => (sid === 's-3' ? links : []) } };
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-3' }, store, host }), 'session_LINK');
});

test('resolveCloudSessionId: a failed marker link or nothing at all is null', () => {
  const store = { get: () => null };
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-1', links: [{ type: 'cloud', key: 'failed' }] }, store }), null);
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-1' }, store }), null);
  assert.equal(resolveCloudSessionId({ entry: { sessionId: 's-1' }, store, host: { links: { get: () => { throw new Error('x'); } } } }), null);
  assert.equal(resolveCloudSessionId({}), null);
});
