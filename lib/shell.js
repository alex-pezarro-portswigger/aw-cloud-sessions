// Shell helpers, ported from agent-wrangler's server/agents/claude.js. The
// extension may not import core modules (a manifest must stay independent of the
// server), so these are copies, kept byte-compatible with core's output.

// POSIX single-quote: wrap in '…' and turn each embedded ' into '\'' (close the
// span, an escaped quote, reopen). Safe for any byte string.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// The non-prefixed "you are inside Claude Code" markers. Every inherited
// CLAUDE_CODE_* is stripped as well, dynamically (below), so new ones are
// covered without this list going stale.
export const NESTED_CLAUDE_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_JOB_DIR',
];

// A wrangler first started from inside a Claude session keeps CLAUDECODE /
// CLAUDE_CODE_* in its env, and every pane or child it spawns inherits them. A
// `claude` started with those set believes it is nested, which changes how it
// behaves (CLI 2.1.169+ drops its transcript). Prefix the command with
// `env -u …` for the static list plus every CLAUDE_CODE_* in `env`.
//
// Returns a shell STRING: it has to run through a shell (a tmux pane, or
// `sh -lc`), never through execFile directly.
export function cleanClaudeEnv(cmd, env = process.env) {
  const dynamic = Object.keys(env || {}).filter((k) => k.startsWith('CLAUDE_CODE_'));
  const vars = [...new Set([...NESTED_CLAUDE_ENV, ...dynamic])];
  return `env ${vars.map((v) => `-u ${v}`).join(' ')} ${cmd}`;
}
