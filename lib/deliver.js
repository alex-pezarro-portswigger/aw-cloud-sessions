import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSteerCommand } from './command.js';
import { CLOUD_SESSION_ID_RE } from './launch-log.js';

const execFileAsync = promisify(execFile);

// Peer messages to a cloud card. A cloud card has no local agent to paste into
// (its pane only holds the card), so a message is handed to the cloud session
// through the CLI instead. Ported from agent-wrangler #59's server/cloud-steer.js.

// `claude -p … --cloud <id>` may block until the cloud turn finishes, and
// send_message waits on it; this bounds the wait.
export const DELIVER_TIMEOUT_MS = 90_000;

// -> { ok: true } | { ok: false, error, archived }
// `archived` is extra to the runtime contract's `{ ok: false, error }` and only
// informational: a best-effort, case-insensitive match on CLI wording nobody has
// probed (#59 open question 4). A miss just means a plain error.
export async function sendCloudMessage({
  cloudSessionId, text, run = execFileAsync, env = process.env, timeoutMs = DELIVER_TIMEOUT_MS,
} = {}) {
  if (!cloudSessionId) {
    // The id is scraped from the create log a few seconds after dispatch, so a
    // message aimed at a brand-new card can genuinely arrive before it.
    return failure('This cloud session has no session id captured yet — try again once the card shows its ☁ link.');
  }
  let cmd;
  try {
    cmd = buildSteerCommand({ cloudSessionId, text, env });
  } catch (err) {
    return failure(err?.message || String(err));
  }

  let stdout = '';
  try {
    // cleanClaudeEnv returns a shell STRING (`env -u CLAUDECODE … claude …`), so
    // it has to run through a shell: execFile would look for a binary literally
    // named "env -u …". `-l` so the login PATH finds `claude`.
    const res = await run('sh', ['-lc', cmd], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    stdout = String(res?.stdout ?? '');
  } catch (err) {
    if (err?.killed || err?.signal === 'SIGTERM') {
      return failure(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the cloud session to take the message.`);
    }
    // execFile rejects on a non-zero exit but still carries the captured
    // streams, and the CLI's refusal text (archived session, bad id, auth) is in
    // them: read those before falling back to the bare spawn error.
    const captured = [String(err?.stderr ?? ''), String(err?.stdout ?? '')].join('\n').trim();
    return failure(captured || err?.message || String(err));
  }

  const errText = errorTextFrom(stdout);
  if (errText) return failure(errText);
  // Exit 0 with unparseable stdout still means the CLI accepted the message; it
  // is in the cloud session's queue either way, so don't invent a failure.
  return { ok: true };
}

function failure(error) {
  return { ok: false, error, archived: /archiv/i.test(error) };
}

// `--output-format json` prints one result object; treat an explicit error shape
// as a failure and everything else as accepted.
function errorTextFrom(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const errored = parsed.is_error === true
    || Boolean(parsed.error)
    || (typeof parsed.subtype === 'string' && parsed.subtype !== 'success' && parsed.is_error !== false);
  if (!errored) return '';
  return String(parsed.error || parsed.result || parsed.message || parsed.subtype || 'cloud message failed');
}

const cloudKeyOf = (links) => (Array.isArray(links) ? links : [])
  .find((l) => l?.type === 'cloud' && CLOUD_SESSION_ID_RE.test(String(l.key || '')))?.key || null;

// Which cloud session a card's messages go to. The store (written by the
// launch-watch sweep) first; failing that, the card's own `cloud` link, which
// survives the store record being dropped (archive) or lost. `entry.links` is
// read when core hands over the raw entry, and `host.links.get` otherwise.
// `sessionId` is the card id when the caller knows it separately: a raw mapping
// entry doesn't necessarily carry its own key.
export function resolveCloudSessionId({ entry, sessionId, store, host } = {}) {
  const sid = sessionId || entry?.sessionId;
  const fromStore = sid ? store?.get?.(sid)?.cloudSessionId : null;
  if (fromStore && CLOUD_SESSION_ID_RE.test(fromStore)) return fromStore;
  const fromEntry = cloudKeyOf(entry?.links);
  if (fromEntry) return fromEntry;
  if (sid && typeof host?.links?.get === 'function') {
    try {
      return cloudKeyOf(host.links.get(sid));
    } catch {
      return null;
    }
  }
  return null;
}
