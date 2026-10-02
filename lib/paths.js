import os from 'node:os';
import path from 'node:path';

// Where this extension keeps its files: <data>/aw-cloud-sessions/. `<data>` is
// the wrangler's own data dir, resolved the same way core's server/data-dir.js
// does (AW_DATA_DIR, else ~/.agent-wrangler), so a `run-dev` instance with its
// own AW_DATA_DIR keeps its cloud state isolated too. The extension can't import
// core, so the rule is restated here.

function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function dataDir(env = process.env) {
  return env.AW_DATA_DIR ? path.resolve(expandTilde(env.AW_DATA_DIR)) : path.join(os.homedir(), '.agent-wrangler');
}

export function extDir(env = process.env) {
  return path.join(dataDir(env), 'aw-cloud-sessions');
}

export function stateFile(env = process.env) {
  return path.join(extDir(env), 'state.json');
}

export function logsDir(env = process.env) {
  return path.join(extDir(env), 'logs');
}

// A card id becomes a file name, so it is held to a safe shape: anything with a
// separator or a dot-dot could write outside the logs dir.
const CARD_ID_RE = /^[A-Za-z0-9_-]+$/;

export function logPathFor(cardId, env = process.env) {
  if (typeof cardId !== 'string' || !CARD_ID_RE.test(cardId)) {
    throw new Error(`Not a usable card id for a cloud launch log: ${JSON.stringify(cardId)}`);
  }
  return path.join(logsDir(env), `${cardId}.log`);
}
