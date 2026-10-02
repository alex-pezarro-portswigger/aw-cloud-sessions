import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { parseCloudLaunchLog } from './launch-log.js';
import { logPathFor } from './paths.js';
import { LINK_TYPE, FAILED_KEY } from './links.js';

// The launch-watch sweep: every 2 s, learn each new cloud card's `session_…` id
// and claude.ai URL from its create log, and put them on the card as a `cloud`
// link. The CLI prints them and nothing else tells us.
//
// HOST CONTRACT used here (keep this list in step with index.js):
//   host.stores['cloud-sessions']        own store (always present)
//   host.sessions.get(cardId) -> card|null   `sessions:read`
//   host.links.attach(cardId, link)      `links:write` (1.19.0); synchronous,
//                                        upserts and rebuilds the board itself
//   host.rebuild()                       `board:rebuild`; redundant now that
//                                        attach rebuilds, kept as a cheap no-harm
//                                        refresh after a transition
//   host.log(msg)                        always present
//
// Per record:
//   - card gone for longer than the grace period: drop the record and its log.
//     (A pending record is written by buildLaunch BEFORE dispatch saves the
//     card, so a brand-new record is never pruned; one whose dispatch failed
//     afterwards is, which is how orphans expire.)
//   - not pending: left alone. A record is never rewritten once it has an
//     outcome, so a re-run can't flip a created card back or re-attach links.
//   - id found: -> created, attach { type: 'cloud', key, url }.
//   - create error found: -> failed, attach the `failed` marker, log the error.
//   - past the deadline: -> unknown, logged once, noting whether the CLI ever
//     said "Created cloud session" (if it did, the session exists on claude.ai
//     and only its id never reached the log).

export const STORE = 'cloud-sessions';
export const DEADLINE_MS = 120_000;
export const ORPHAN_GRACE_MS = 30_000;

async function readLogFile(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return ''; // not written yet, or already pruned: just try again next tick
  }
}

function attach(host, cardId, link) {
  try {
    host.links.attach(cardId, link);
    return true;
  } catch (err) {
    host.log?.(`could not attach the cloud link to ${cardId}: ${err?.message || err}`);
    return false;
  }
}

export function removeLog(cardId, { env = process.env, fsImpl = fs } = {}) {
  try {
    fsImpl.rmSync(logPathFor(cardId, env), { force: true });
  } catch {
    /* an unusable id has no log; anything else is best-effort */
  }
}

// Archive and purge both forget a card: its record and its log. Its `cloud` link
// stays on the card, which is what keeps the ☁ chip on an archived card.
export function forgetCard({ sessionId, host }, { env = process.env, fsImpl = fs } = {}) {
  host?.stores?.[STORE]?.remove(sessionId);
  removeLog(sessionId, { env, fsImpl });
}

export function createLaunchWatch({
  readLog = readLogFile,
  logPath = (cardId) => logPathFor(cardId),
  forget = (cardId, host) => forgetCard({ sessionId: cardId, host }),
  now = Date.now,
  deadlineMs = DEADLINE_MS,
  orphanGraceMs = ORPHAN_GRACE_MS,
} = {}) {
  let running = false;

  async function sweepOne(host, store, rec, t) {
    const { cardId } = rec;
    const age = t - (Number(rec.startedAt) || 0);
    if (typeof host.sessions?.get === 'function' && !host.sessions.get(cardId) && age > orphanGraceMs) {
      forget(cardId, host);
      return { cardId, to: 'pruned' };
    }
    if (rec.status !== 'pending') return null;

    let file;
    try {
      file = logPath(cardId);
    } catch (err) {
      store.update(cardId, { status: 'unknown', error: err?.message || String(err) });
      return { cardId, to: 'unknown' };
    }
    const parsed = parseCloudLaunchLog(await readLog(file));
    const sawCreated = Boolean(rec.sawCreated || parsed.sawCreated);

    if (parsed.cloudSessionId) {
      if (!store.update(cardId, { status: 'created', cloudSessionId: parsed.cloudSessionId, url: parsed.url || null, sawCreated })) return null;
      const link = { type: LINK_TYPE, key: parsed.cloudSessionId };
      if (parsed.url) link.url = parsed.url;
      attach(host, cardId, link);
      return { cardId, to: 'created', changed: true };
    }
    if (parsed.createError) {
      if (!store.update(cardId, { status: 'failed', error: parsed.createError, sawCreated })) return null;
      host.log?.(`creating the cloud session for ${cardId} failed: ${parsed.createError}`);
      attach(host, cardId, { type: LINK_TYPE, key: FAILED_KEY });
      return { cardId, to: 'failed', changed: true };
    }
    if (age > deadlineMs) {
      if (!store.update(cardId, { status: 'unknown', sawCreated })) return null;
      host.log?.(sawCreated
        ? `${cardId}: the CLI said "Created cloud session" but no session_… id reached the log within ${Math.round(deadlineMs / 1000)} s; find the session on claude.ai.`
        : `${cardId}: no cloud session id or create error within ${Math.round(deadlineMs / 1000)} s; check the card's pane.`);
      return { cardId, to: 'unknown' };
    }
    if (sawCreated && !rec.sawCreated) store.update(cardId, { sawCreated: true });
    return null;
  }

  // The sweep's `run({ host })`. Re-entrancy guarded: core starts it on a plain
  // interval, and a slow disk must not let two passes race on one record.
  // Resolves with the transitions it made, for tests.
  async function run({ host } = {}) {
    if (running) return [];
    const store = host?.stores?.[STORE];
    if (!store) return [];
    running = true;
    const out = [];
    try {
      const t = now();
      for (const rec of store.list()) {
        try {
          const r = await sweepOne(host, store, rec, t);
          if (r) out.push(r);
        } catch (err) {
          host.log?.(`launch-watch failed for ${rec.cardId}: ${err?.message || err}`);
        }
      }
      if (out.some((r) => r.changed)) {
        try {
          host.rebuild?.();
        } catch (err) {
          host.log?.(`rebuild failed: ${err?.message || err}`);
        }
      }
    } finally {
      running = false;
    }
    return out.map(({ cardId, to }) => ({ cardId, to }));
  }

  return { run };
}
