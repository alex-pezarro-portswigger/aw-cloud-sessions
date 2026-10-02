// Parsing the `environments` setting. Shared by BOTH halves: the browser imports
// it from here (only public/ is served) and the server re-exports it through
// lib/environments.js, so the dialog and the preflight can never disagree about
// which items are valid.
//
// Each list item is one environment id, optionally followed by a space and a
// human label:
//   env_01abc            Anthropic-hosted environment, shown as its id
//   ccpool_9z  CI pool   self-hosted runner pool, shown as "CI pool"
// A `list` setting item takes no `pattern`, so validity is decided here. An
// invalid item is skipped in the dialog and refused if it is ever chosen.

export const ENVIRONMENT_ID_RE = /^(env_|ccpool_)[A-Za-z0-9_-]+$/;

export function isEnvironmentId(id) {
  return typeof id === 'string' && ENVIRONMENT_ID_RE.test(id);
}

// One item -> { id, label } or null when the id part isn't a well-formed
// env_…/ccpool_… id. The label falls back to the id.
export function parseEnvironmentItem(item) {
  if (typeof item !== 'string') return null;
  const trimmed = item.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  const id = m[1];
  if (!isEnvironmentId(id)) return null;
  const label = (m[2] || '').trim() || id;
  return { id, label };
}

// The whole setting -> { valid: [{ id, label }], invalid: [item] }. A repeated
// id keeps its first entry, so the dialog never shows two options with one value.
export function parseEnvironments(list) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const parsed = parseEnvironmentItem(item);
    if (!parsed) {
      invalid.push(item);
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    valid.push(parsed);
  }
  return { valid, invalid };
}
