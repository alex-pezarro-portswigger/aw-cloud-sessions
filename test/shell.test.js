import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, cleanClaudeEnv, NESTED_CLAUDE_ENV } from '../lib/shell.js';

test('shellQuote wraps in single quotes and escapes embedded apostrophes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("don't"), `'don'\\''t'`);
  assert.equal(shellQuote('$HOME; rm -rf /'), "'$HOME; rm -rf /'");
  assert.equal(shellQuote(''), "''");
  assert.equal(shellQuote(42), "'42'");
});

test('cleanClaudeEnv strips the static markers even from an empty env', () => {
  const cmd = cleanClaudeEnv('claude --version', {});
  assert.equal(cmd, `env ${NESTED_CLAUDE_ENV.map((v) => `-u ${v}`).join(' ')} claude --version`);
});

test('cleanClaudeEnv also strips every inherited CLAUDE_CODE_* var, once', () => {
  const cmd = cleanClaudeEnv('claude', {
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'x', // already in the static list: not repeated
    CLAUDE_CONFIG_DIR: '/x', // not CLAUDE_CODE_*: kept
    PATH: '/bin',
  });
  assert.match(cmd, /-u CLAUDE_CODE_CHILD_SESSION /);
  assert.equal(cmd.match(/-u CLAUDE_CODE_SESSION_ID /g).length, 1);
  assert.doesNotMatch(cmd, /-u (CLAUDE_CONFIG_DIR|PATH) /);
  assert.ok(cmd.endsWith(' claude'));
});

test('cleanClaudeEnv defaults to process.env', () => {
  assert.match(cleanClaudeEnv('x'), /^env -u CLAUDECODE /);
});
