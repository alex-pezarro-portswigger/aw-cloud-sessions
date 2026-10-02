import fs from 'node:fs';
import { shellQuote, cleanClaudeEnv } from './shell.js';
import { CLOUD_SESSION_ID_RE, pruneLogs } from './launch-log.js';
import { resolveLaunchOptions } from './environments.js';
import { logsDir, logPathFor } from './paths.js';

// Command building for the `cloud` runtime, ported from agent-wrangler #59's
// server/runtimes/cloud.js. The agent runs in a Claude-hosted (or self-hosted
// runner) VM; the local tmux pane only runs the `claude` client that creates it,
// then holds so the card stays put.
//
// TWO PERMANENT GAPS, not TODOs:
//  1. NO TRANSCRIPT, SO NO COST. The conversation lives in the VM and is never
//     written under ~/.claude/projects, so a cloud card's spend is absent from
//     the board, from usage-scan-cache.json (the long-term spend record) and from
//     every cost report, permanently. Don't estimate it: a made-up number would
//     poison rollups that are otherwise transcript-exact.
//  2. NO STATUS BEYOND "handed off". There is no hook status file and nothing
//     to scrape once the create client exits.

// `env_…` = an Anthropic-hosted environment, `ccpool_…` = a self-hosted runner
// pool, empty = the account default (Anthropic-hosted). Anything else THROWS
// rather than picking a launch form: the two forms are different `claude`
// invocations, so a mistyped id silently landing on the wrong one would either
// fail opaquely in the pane or create a session in the wrong place.
export function classifyEnvironmentId(id) {
  const v = String(id ?? '').trim();
  if (!v) return 'default';
  if (v.startsWith('env_')) return 'anthropic';
  if (v.startsWith('ccpool_')) return 'self-hosted';
  throw new Error(`Unrecognised cloud environment id "${v}" — expected an env_… (Anthropic-hosted) or ccpool_… (self-hosted) id.`);
}

// Collapse every single-quoted span so flag detection can't be fooled by flag-like
// text INSIDE a quoted argument (an intent of "retry with -p set" must not read as
// a `-p` flag). `shellQuote` escapes an embedded apostrophe as `'\''`, which ENDS
// one quoted span and starts another, so the escapes must be removed BEFORE the
// collapse, or an intent like `don't use -p here` leaves ` -p ` outside any span
// and the guard refuses a launch over a footgun that isn't there.
const stripQuoted = (cmd) => String(cmd || '').split(`'\\''`).join('').replace(/'[^']*'/g, "''");

// Every `--cloud <token>` value in a command, unquoted. Read off the RAW string
// (not `stripQuoted`) because the value we care about is itself quoted.
function cloudFlagValues(cmd) {
  const out = [];
  const re = /--cloud(?:=|\s+)(?:'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(String(cmd || '')))) out.push(m[1] ?? m[2] ?? '');
  return out;
}

// The footgun guard. `-p` (or `--print`) combined with `--cloud '<description>'`
// (a free-text intent rather than an existing `session_…` id) either errors out
// or SILENTLY RUNS THE PROMPT LOCALLY. The silent local run is the dangerous one:
// the pane looks busy, work happens on this machine against the real checkout,
// and the board shows a card that claims to be in the cloud and is not. So
// Anthropic-hosted creates are interactive-only (no `-p`), and `-p` belongs only
// to the self-hosted `--environment` form and to steering an EXISTING session by
// id. Every builder here runs this on its own output before returning, so a
// future edit to any branch can't bypass it.
export function assertNoPromptWithCloudDescription(cmd) {
  const bare = stripQuoted(cmd);
  const hasPrint = /(?:^|\s)(?:-p|--print)(?:[=\s]|$)/.test(bare);
  if (!hasPrint) return;
  const description = cloudFlagValues(cmd).find((v) => !CLOUD_SESSION_ID_RE.test(v));
  if (description === undefined) return;
  throw new Error(`Refusing to build a cloud command that combines -p/--print with --cloud "${description}": that either errors or silently runs the prompt LOCALLY, producing a card that claims to be cloud and is not.`);
}

// The command that CREATES a cloud session. Two forms, picked by the environment
// id's prefix (see classifyEnvironmentId):
//   anthropic/default: `claude --cloud '<intent>'`, plus the inline
//     `--settings {"remote":{"defaultEnvironmentId":"env_…"}}` when a specific
//     Anthropic environment was chosen. Interactive, so it needs a TTY, which is
//     why it runs in a real pane (under `script`) and never with `-p`.
//   self-hosted: `claude -p '<intent>' --environment ccpool_… [--ref <branch>]
//     --output-format json`.
// `--ref` is emitted ONLY on the self-hosted form: the CLI probe in #59
// established it there and nowhere else, and a flag the Anthropic form may not
// accept would dead-pane the launch.
export function buildCreateCommand({ intent, environmentId = '', ref = '', env = process.env } = {}) {
  const text = String(intent ?? '').trim();
  if (!text) throw new Error('A cloud session needs an intent — it is the prompt the cloud agent starts from.');
  const id = String(environmentId ?? '').trim();
  const kind = classifyEnvironmentId(id);
  const branch = String(ref ?? '').trim();
  let cmd;
  if (kind === 'self-hosted') {
    cmd = cleanClaudeEnv(`claude -p ${shellQuote(text)} --environment ${shellQuote(id)}`
      + (branch ? ` --ref ${shellQuote(branch)}` : '')
      + ' --output-format json', env);
  } else {
    cmd = cleanClaudeEnv(`claude --cloud ${shellQuote(text)}`
      + (kind === 'anthropic' ? ` --settings ${shellQuote(JSON.stringify({ remote: { defaultEnvironmentId: id } }))}` : ''), env);
  }
  assertNoPromptWithCloudDescription(cmd);
  return cmd;
}

// Steer an EXISTING cloud session: `claude -p <text> --cloud <session_…>
// --output-format json`. `-p` next to `--cloud` is only a footgun when --cloud
// carries a description; with a `session_…` id it is the documented steer form.
// The id is checked here so a card id or a conversation uuid (the other two id
// namespaces) can never reach `--cloud`, where it would read as a description.
export function buildSteerCommand({ cloudSessionId, text, env = process.env } = {}) {
  const id = String(cloudSessionId ?? '').trim();
  if (!CLOUD_SESSION_ID_RE.test(id)) {
    throw new Error(`Cannot message a cloud session without a session_… id (got ${id ? `"${id}"` : 'nothing'}).`);
  }
  const cmd = cleanClaudeEnv(`claude -p ${shellQuote(String(text ?? ''))} --cloud ${shellQuote(id)} --output-format json`, env);
  assertNoPromptWithCloudDescription(cmd);
  return cmd;
}

export const HANDOFF_BANNER = '☁ Cloud session handed off. This pane only holds the card; archive the card to close it.';

// Longest sleep both BSD and GNU `sleep` accept as a plain integer (~68 years).
const HOLD_SECONDS = 2147483647;

// The pane script. `script` gives the create client a real pty (the interactive
// form refuses without a TTY) while tee-ing its raw output to `logPath`, which
// the launch-watch sweep parses for the session id. Flushing per write (`-F`/`-f`)
// lets the sweep see the id before the client exits.
//
// After the client exits, the pane HOLDS: a banner, then `exec sleep`. Without
// that, a create client exiting 0 would leave a cleanly exited pane, which core
// archives automatically (D5), and the card would vanish seconds after dispatch.
// `;` rather than `&&`, so a failed create holds too and its error stays on
// screen. Archiving the card kills the pane as usual.
//
//   darwin (BSD script):  script -q -F <log> /bin/sh -c <cmd>
//   linux (util-linux):   script -q -f -c <cmd> <log>
// Any other platform gets the util-linux form.
export function wrapForPane({ cmd, logPath, platform = process.platform } = {}) {
  if (!cmd) throw new Error('wrapForPane needs a command');
  if (!logPath) throw new Error('wrapForPane needs a log path');
  const recorded = platform === 'darwin'
    ? `script -q -F ${shellQuote(logPath)} /bin/sh -c ${shellQuote(cmd)}`
    : `script -q -f -c ${shellQuote(cmd)} ${shellQuote(logPath)}`;
  return `${recorded}; printf '\\n%s\\n' ${shellQuote(HANDOFF_BANNER)}; exec sleep ${HOLD_SECONDS}`;
}

// The runtime's buildLaunch, minus the contract glue (lib/runtime.js). Builds
// and validates the create command FIRST, so a bad intent or environment throws
// before anything is written. Then: truncates this card's log, prunes week-old
// logs, and records the card as `pending` for the launch-watch sweep. Those are
// the only side effects; if dispatch fails after this returns, the sweep expires
// the orphaned record.
export function buildLaunch({
  intent, sessionId, ext, settings, store,
  env = process.env, platform = process.platform, now = Date.now, fsImpl = fs,
} = {}) {
  const { environmentId, ref } = resolveLaunchOptions({ ext, settings });
  const cmd = buildCreateCommand({ intent, environmentId, ref, env });
  const logPath = logPathFor(sessionId, env);
  const dir = logsDir(env);
  fsImpl.mkdirSync(dir, { recursive: true });
  pruneLogs(dir, { now: now(), fsImpl });
  fsImpl.writeFileSync(logPath, '');
  store.put(sessionId, { status: 'pending', environmentId, ref, startedAt: now() });
  return wrapForPane({ cmd, logPath, platform });
}
