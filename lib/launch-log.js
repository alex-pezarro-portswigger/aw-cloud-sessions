import fs from 'node:fs';
import path from 'node:path';

// Parsing (and pruning) of the create command's launch log.
//
// The create command runs in a tmux pane wrapped in `script`, which tees the
// pane's raw output into a log file:
//   macOS (BSD)        — `script -q -F <log> /bin/sh -c <cmd>`; `-q` means no
//                        header or footer at all.
//   Linux (util-linux) — `script -q -f -c <cmd> <log>`; `-q` only silences the
//                        "Script started, output log file is …" message on the
//                        TERMINAL — the log itself still gets a `Script started on
//                        …` header and a `Script done on …` footer (see
//                        stripScriptBanner below).
// A 2s sweep reads the log and runs it through `parseCloudLaunchLog`. The CLI prints
// the new session's `session_…` id and claude.ai URL and nothing else tells us, so
// this scrape is the only way a card learns them. Everything here is pure (the fs is
// injectable for pruning) so it is unit-testable with no tmux and no network.

// The id shape the CLI hands back — a THIRD id namespace alongside the card id and
// any local conversation id. Kept identical to the scrape regex in
// `parseCloudLaunchLog` so an id that can be parsed is always an id that can be
// re-used, and vice versa.
export const CLOUD_SESSION_ID_RE = /^session_[A-Za-z0-9]+$/;

// `script` records raw bytes, so the log carries the client's cursor/colour escapes.
// Strip CSI sequences, and turn carriage returns into newlines (both the CRLF that a
// tty's output translation produces and bare CRs used to redraw a line). OSC
// sequences are left alone ON PURPOSE: an OSC-8 hyperlink carries the URL we want
// inside itself, and the URL patterns below already stop at BEL/ESC, so the
// terminator never leaks into a match.
const stripAnsi = (s) => String(s || '').replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');

// util-linux `script` brackets the log with banner lines. Newer versions put the
// whole command line in the header, e.g.
//   Script started on 2026-10-02 12:00:00+01:00 [COMMAND="env -u CLAUDECODE claude --cloud '<intent>'" TERM="xterm-256color" …]
//   Script done on 2026-10-02 12:00:09+01:00 [COMMAND_EXIT_CODE="0"]
// and that echoed command contains the USER'S INTENT, which can say anything —
// including `session_…`, `Error: …` or a claude.ai URL. None of it may ever be
// scraped as the outcome of the create, so banner lines are dropped before parsing.
// The intent is single-quoted by the shell, so it can carry a raw newline that
// `script` writes unescaped: a header opened with ` [` that does not close with `]`
// on the same line swallows the following lines up to (and including) the one that
// does. Older util-linux headers have no bracketed part
// (`Script started on Fri 02 Oct 2026 12:00:00 BST`) and are a single line.
const BANNER_RE = /^(?:Script started on |Script done on )/;
function stripScriptBanner(lines) {
  const out = [];
  let inHeader = false;
  for (const line of lines) {
    const t = line.trim();
    if (inHeader) {
      if (t.endsWith(']')) inHeader = false;
      continue;
    }
    if (BANNER_RE.test(t)) {
      if (t.includes(' [') && !t.endsWith(']')) inHeader = true;
      continue;
    }
    out.push(line);
  }
  return out;
}

// A URL only counts if it is an `https://claude.ai/…` one: it ends up as an `href`
// on the card, so it gets the same "agent-provided text is untrusted" treatment as a
// PR link. Host match is exact — a lookalike subdomain is not ours to link to.
// Trailing punctuation is trimmed first so prose like "(see https://claude.ai/x)."
// yields the bare URL.
export function claudeAiUrl(candidate) {
  const s = String(candidate || '').trim().replace(/[)\].,;:'"]+$/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.hostname !== 'claude.ai') return null;
    return s;
  } catch {
    return null;
  }
}

const URL_IN_TEXT = /https:\/\/[^\s'"<>)\]\x07\x1B]+/;

// One parser for both launch forms, run over the whole log on every sweep.
//   cloudSessionId — the self-hosted `--output-format json` line's `session_id`
//     first (a structured field beats scraping), then the first `session_…` token
//     anywhere, which is what the interactive form's `Created cloud session` /
//     `View:` / `Resume with:` block gives us.
//   url — the `View:` line's URL, validated as above. Falls back to the JSON line's
//     `url`, then to any claude.ai URL in the text (a narrow pane can wrap the
//     `View:` label away from its URL).
//   sawCreated — distinguishes "created, but the id never made it into the log"
//     from "nothing happened at all", which the sweep needs to decide whether to
//     keep waiting or give up quietly.
//   createError — the CLI's own reason the CREATE failed outright (e.g. "no GitHub
//     remote was detected" for a self-hosted pool with no parseable git source).
//     Preferred source is the self-hosted `--output-format json` line's `error`
//     field (`{"ok":false,"error":"…"}`); a bare `Error: …` line (the interactive
//     form's own stderr text) is the fallback. Deliberately null whenever
//     `cloudSessionId` is set — a successful create must never also read as a
//     create error.
export function parseCloudLaunchLog(text) {
  const lines = stripScriptBanner(stripAnsi(text).split('\n'));
  const raw = lines.join('\n');
  let cloudSessionId = null;
  let jsonUrl = null;
  let jsonError = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const id = obj?.session_id ?? obj?.sessionId;
    if (typeof id === 'string' && CLOUD_SESSION_ID_RE.test(id.trim())) {
      cloudSessionId = id.trim();
      jsonUrl = claudeAiUrl(obj?.url);
      break;
    }
    if (!jsonError && obj?.ok === false && typeof obj?.error === 'string' && obj.error.trim()) {
      jsonError = obj.error.trim();
    }
  }
  if (!cloudSessionId) {
    const m = raw.match(/session_[A-Za-z0-9]+/);
    if (m) cloudSessionId = m[0];
  }
  let url = null;
  const viewLine = lines.find((l) => /(?:^|\s)View:/.test(l));
  if (viewLine) url = claudeAiUrl(viewLine.match(URL_IN_TEXT)?.[0]);
  if (!url) url = jsonUrl;
  if (!url) url = claudeAiUrl(raw.match(/https:\/\/claude\.ai\/[^\s'"<>)\]\x07\x1B]+/)?.[0]);
  const errorLine = raw.match(/^Error: (.+)$/m)?.[1]?.trim() || null;
  const createError = cloudSessionId ? null : (jsonError || errorLine);
  return {
    cloudSessionId,
    url,
    sawCreated: raw.includes('Created cloud session'),
    createError,
  };
}

// Keep the launch-logs dir from growing without bound: drop logs older than a week.
// Prune-on-write shape — no timer, no separate sweeper, and a dir that was never
// used costs nothing. Conservative even though the dir is ours: only regular files
// named `*.log` (lstat, so a symlink is never followed or removed). Best-effort and
// never throws: a prune failure must not stop a launch. Returns the number removed.
export function pruneLogs(dir, { maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now(), fsImpl = fs } = {}) {
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!String(name).endsWith('.log')) continue;
    const p = path.join(dir, String(name));
    try {
      const st = fsImpl.lstatSync(p);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        fsImpl.rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      /* raced with another prune, or not ours to delete */
    }
  }
  return removed;
}
