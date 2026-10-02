import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOUD_SESSION_ID_RE, claudeAiUrl, parseCloudLaunchLog, pruneLogs } from '../lib/launch-log.js';

const EMPTY = { cloudSessionId: null, url: null, sawCreated: false, createError: null };

const INTERACTIVE_LOG = [
  '',
  '  Created cloud session',
  '',
  '  View: https://claude.ai/code/session_01ABCdef',
  '  Resume with: claude --cloud session_01ABCdef',
  '',
].join('\n');

// What newer util-linux `script` writes around the output. The echoed COMMAND holds
// the user's intent, which here deliberately looks like every signal we scrape.
const UL_HEADER = `Script started on 2026-10-02 12:00:00+01:00 [COMMAND="env -u CLAUDECODE claude --cloud 'look at session_FAKE1 and Error: nope https://claude.ai/fake Created cloud session'" TERM="xterm-256color" TTY="/dev/pts/3" COLUMNS="120" LINES="40"]`;
const UL_FOOTER = 'Script done on 2026-10-02 12:00:09+01:00 [COMMAND_EXIT_CODE="0"]';

test('CLOUD_SESSION_ID_RE: session_ ids only', () => {
  assert.ok(CLOUD_SESSION_ID_RE.test('session_01ABCdef'));
  assert.ok(!CLOUD_SESSION_ID_RE.test('session_'));
  assert.ok(!CLOUD_SESSION_ID_RE.test('s-1770000000000-ab12'));
  assert.ok(!CLOUD_SESSION_ID_RE.test('session_01 x'));
});

test('claudeAiUrl: exact https claude.ai host, trailing punctuation trimmed', () => {
  assert.equal(claudeAiUrl('https://claude.ai/code/session_1'), 'https://claude.ai/code/session_1');
  assert.equal(claudeAiUrl(' https://claude.ai/code/session_1).'), 'https://claude.ai/code/session_1');
  assert.equal(claudeAiUrl('http://claude.ai/code/session_1'), null);
  assert.equal(claudeAiUrl('https://claude.ai.evil.example/x'), null);
  assert.equal(claudeAiUrl('https://evil.claude.ai/x'), null);
  assert.equal(claudeAiUrl('not a url'), null);
  assert.equal(claudeAiUrl(undefined), null);
});

test('parseCloudLaunchLog: the interactive Created/View/Resume block', () => {
  assert.deepEqual(parseCloudLaunchLog(INTERACTIVE_LOG), {
    cloudSessionId: 'session_01ABCdef',
    url: 'https://claude.ai/code/session_01ABCdef',
    sawCreated: true,
    createError: null,
  });
});

test('parseCloudLaunchLog: ANSI escapes in the script log do not hide the id or URL', () => {
  const noisy = '\x1B[2K\x1B[36m  Created cloud session\x1B[0m\r\n'
    + '\x1B[1m  View: https://claude.ai/code/session_01ABCdef\x1B[0m\r\n';
  const parsed = parseCloudLaunchLog(noisy);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, 'https://claude.ai/code/session_01ABCdef');
  assert.equal(parsed.sawCreated, true);
});

test('parseCloudLaunchLog: an OSC-8 hyperlink around the View URL still yields the bare URL', () => {
  const url = 'https://claude.ai/code/session_01ABCdef';
  const text = `Created cloud session\nView: \x1B]8;;${url}\x07${url}\x1B]8;;\x07\n`;
  assert.equal(parseCloudLaunchLog(text).url, url);
});

test('parseCloudLaunchLog: the self-hosted single JSON line', () => {
  const parsed = parseCloudLaunchLog('{"type":"result","session_id":"session_ZZ99","url":"https://claude.ai/code/session_ZZ99"}\n');
  assert.equal(parsed.cloudSessionId, 'session_ZZ99');
  assert.equal(parsed.url, 'https://claude.ai/code/session_ZZ99');
  assert.equal(parsed.sawCreated, false);
  assert.equal(parsed.createError, null);
});

test('parseCloudLaunchLog: a JSON line wins over a stray earlier session_ token', () => {
  const text = 'resuming session_OLD1 …\n{"session_id":"session_NEW2"}\n';
  assert.equal(parseCloudLaunchLog(text).cloudSessionId, 'session_NEW2');
});

test('parseCloudLaunchLog: a log with none of the markers is all-null/false', () => {
  assert.deepEqual(parseCloudLaunchLog('$ \nsome unrelated pane noise\n'), EMPTY);
  assert.deepEqual(parseCloudLaunchLog(''), EMPTY);
  assert.deepEqual(parseCloudLaunchLog(undefined), EMPTY);
});

test('parseCloudLaunchLog: a self-hosted create failure is read off the JSON error field', () => {
  const text = 'Error: The selected environment "ccpool_x" requires a git source, but no GitHub remote was detected in this directory. Check that `git remote get-url origin` returns a GitHub URL.\n'
    + '{"ok":false,"error":"The selected environment \\"ccpool_x\\" requires a git source, but no GitHub remote was detected in this directory. Check that `git remote get-url origin` returns a GitHub URL."}\n';
  const parsed = parseCloudLaunchLog(text);
  assert.equal(parsed.cloudSessionId, null);
  assert.equal(parsed.createError, 'The selected environment "ccpool_x" requires a git source, but no GitHub remote was detected in this directory. Check that `git remote get-url origin` returns a GitHub URL.');
});

test('parseCloudLaunchLog: a bare Error: line is the fallback when there is no JSON line', () => {
  const parsed = parseCloudLaunchLog('Error: Could not create a cloud environment.\n');
  assert.equal(parsed.createError, 'Could not create a cloud environment.');
});

test('parseCloudLaunchLog: a successful create with an incidental Error: line never sets createError', () => {
  const text = 'Error: retrying after a transient hiccup\n{"session_id":"session_01ABCdef","url":"https://claude.ai/code/session_01ABCdef"}\n';
  const parsed = parseCloudLaunchLog(text);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.createError, null);
});

test('parseCloudLaunchLog: a non-claude.ai (or non-https) View URL is dropped, not stored', () => {
  const evil = 'Created cloud session\nView: https://claude.ai.evil.example/code/session_01ABCdef\n';
  const parsed = parseCloudLaunchLog(evil);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, null);
  assert.equal(parseCloudLaunchLog('View: http://claude.ai/code/session_01ABCdef\n').url, null);
  assert.equal(parseCloudLaunchLog('View: javascript:alert(1) session_01ABCdef\n').url, null);
});

test('parseCloudLaunchLog: util-linux header/footer around a real create — the echoed intent is never scraped', () => {
  const text = [UL_HEADER, INTERACTIVE_LOG, UL_FOOTER, ''].join('\n');
  assert.deepEqual(parseCloudLaunchLog(text), {
    cloudSessionId: 'session_01ABCdef',
    url: 'https://claude.ai/code/session_01ABCdef',
    sawCreated: true,
    createError: null,
  });
});

test('parseCloudLaunchLog: util-linux header/footer around NO output is all-null/false', () => {
  assert.deepEqual(parseCloudLaunchLog(`${UL_HEADER}\n${UL_FOOTER}\n`), EMPTY);
  // The header alone (create still running, footer not written yet) too.
  assert.deepEqual(parseCloudLaunchLog(`${UL_HEADER}\n`), EMPTY);
});

test('parseCloudLaunchLog: a multi-line intent inside the header COMMAND is still skipped', () => {
  const header = `Script started on 2026-10-02 12:00:00+01:00 [COMMAND="env -u CLAUDECODE claude --cloud 'first line\nError: nope session_FAKE2\nhttps://claude.ai/fake2'" TERM="xterm-256color"]`;
  assert.deepEqual(parseCloudLaunchLog(`${header}\n${UL_FOOTER}\n`), EMPTY);
  const parsed = parseCloudLaunchLog(`${header}\n${INTERACTIVE_LOG}\n${UL_FOOTER}\n`);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, 'https://claude.ai/code/session_01ABCdef');
});

test('parseCloudLaunchLog: an older util-linux header without COMMAND is ignored', () => {
  const text = `Script started on Fri 02 Oct 2026 12:00:00 BST\n${INTERACTIVE_LOG}\nScript done on Fri 02 Oct 2026 12:00:09 BST\n`;
  const parsed = parseCloudLaunchLog(text);
  assert.equal(parsed.cloudSessionId, 'session_01ABCdef');
  assert.equal(parsed.url, 'https://claude.ai/code/session_01ABCdef');
  assert.equal(parsed.createError, null);
  assert.deepEqual(parseCloudLaunchLog('Script started on Fri 02 Oct 2026 12:00:00 BST\n'), EMPTY);
});

test('parseCloudLaunchLog: CRLF line endings from script work, banner lines included', () => {
  const text = [UL_HEADER, ...INTERACTIVE_LOG.split('\n'), UL_FOOTER, ''].join('\r\n');
  assert.deepEqual(parseCloudLaunchLog(text), {
    cloudSessionId: 'session_01ABCdef',
    url: 'https://claude.ai/code/session_01ABCdef',
    sawCreated: true,
    createError: null,
  });
  assert.equal(parseCloudLaunchLog('Error: Could not create a cloud environment.\r\n').createError, 'Could not create a cloud environment.');
});

test('pruneLogs: removes only old regular *.log files and returns the count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-cloud-launch-log-'));
  try {
    const now = Date.now();
    const old = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
    const write = (name, mtimeSec) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      fs.utimesSync(p, mtimeSec, mtimeSec);
      return p;
    };
    const oldLog = write('old.log', old);
    const newLog = write('new.log', now / 1000);
    const oldOther = write('old.txt', old);
    const oldDir = path.join(dir, 'dir.log');
    fs.mkdirSync(oldDir);
    fs.utimesSync(oldDir, old, old);

    assert.equal(pruneLogs(dir, { now }), 1);
    assert.equal(fs.existsSync(oldLog), false);
    assert.equal(fs.existsSync(newLog), true);
    assert.equal(fs.existsSync(oldOther), true);
    assert.equal(fs.existsSync(oldDir), true);
    // Idempotent: nothing left to prune.
    assert.equal(pruneLogs(dir, { now }), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneLogs: a missing dir returns 0, and fs errors never throw', () => {
  assert.equal(pruneLogs(path.join(os.tmpdir(), 'aw-cloud-definitely-missing-dir-xyz')), 0);
  const boom = () => { throw new Error('boom'); };
  const fsImpl = { readdirSync: () => ['a.log'], lstatSync: boom, rmSync: boom };
  assert.equal(pruneLogs('/nowhere', { fsImpl }), 0);
});
