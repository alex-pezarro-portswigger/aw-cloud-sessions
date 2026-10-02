import fs from 'node:fs';
import path from 'node:path';
import { stateFile } from './paths.js';

// The extension's one store (`cloud-sessions`): a record per cloud card, keyed by
// the card id, persisted to <data>/aw-cloud-sessions/state.json.
//
// Record shape:
//   { cardId, status, environmentId, ref, startedAt, updatedAt,
//     cloudSessionId?, url?, error?, sawCreated? }
// `status` moves pending -> created | failed | unknown, once (the launch-watch
// sweep never rewrites a record that isn't pending). `cloudSessionId` is a THIRD
// id namespace beside the card id and a conversation id: it is only ever passed
// to `claude --cloud`, never to `--resume`.
//
// Synchronous on purpose: the file is tiny, it's written a handful of times per
// card, and a sync read-modify-write can't interleave with another one in the
// same process. Writes go through a temp file and a rename, so a crash mid-write
// leaves the previous file intact.

export const STATUSES = ['pending', 'created', 'failed', 'unknown'];

export function createStateStore({ file = stateFile(), fsImpl = fs, now = Date.now, log = () => {} } = {}) {
  let records = null;

  function load() {
    if (records) return records;
    records = new Map();
    let raw;
    try {
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`[cloud] could not read ${file}: ${err?.message || err}`);
      return records;
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [id, rec] of Object.entries(parsed?.records || {})) {
        if (rec && typeof rec === 'object') records.set(id, { ...rec, cardId: id });
      }
    } catch (err) {
      // A corrupt file starts the store empty rather than taking the extension
      // down. The next write replaces it.
      log(`[cloud] ignoring unreadable ${file}: ${err?.message || err}`);
    }
    return records;
  }

  function save() {
    const body = JSON.stringify({ version: 1, records: Object.fromEntries(load()) }, null, 2);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, body);
    fsImpl.renameSync(tmp, file);
  }

  const copy = (rec) => (rec ? { ...rec } : null);

  return {
    file,
    get(cardId) {
      return copy(load().get(cardId));
    },
    list() {
      return [...load().values()].map(copy);
    },
    pending() {
      return [...load().values()].filter((r) => r.status === 'pending').map(copy);
    },
    // Replace (or create) a card's record. A re-dispatch onto the same card id
    // can't happen, but if it ever did the new launch is the truth.
    put(cardId, record) {
      const rec = { ...record, cardId, updatedAt: now() };
      load().set(cardId, rec);
      save();
      return copy(rec);
    },
    // Merge into an existing record; null when there is none (it was pruned or
    // the card archived between the read and this write).
    update(cardId, patch) {
      const prev = load().get(cardId);
      if (!prev) return null;
      const rec = { ...prev, ...patch, cardId, updatedAt: now() };
      load().set(cardId, rec);
      save();
      return copy(rec);
    },
    remove(cardId) {
      if (!load().delete(cardId)) return false;
      save();
      return true;
    },
  };
}

// The manifest's store factory. It gets core's minimal `{ id, extId, settings,
// log }` bag; only `log` is used, since the file location comes from the data
// dir rather than a setting.
export function stateFactory({ log } = {}) {
  return createStateStore({ log: typeof log === 'function' ? log : () => {} });
}
