// Server half of the environment settings. The item parser itself lives in
// public/environments.js so the dialog and the server share one definition.
import { ENVIRONMENT_ID_RE, isEnvironmentId, parseEnvironmentItem, parseEnvironments } from '../public/environments.js';

export { ENVIRONMENT_ID_RE, isEnvironmentId, parseEnvironmentItem, parseEnvironments };

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// Which environment and ref a launch uses. The dialog's ext slice wins, then the
// `defaultEnvironment` setting, then '' (the account default).
//
// An ext slice that CARRIES `environmentId` wins even when it is '': that is the
// dialog's explicit "Account default" choice, and it must not be overridden by
// the setting the dialog merely preselected. A launch with no slice at all
// (spawn_session, or a dialog without the field) falls back to the setting.
// `ref` has no setting: it comes from the slice or is empty.
export function resolveLaunchOptions({ ext, settings } = {}) {
  const slice = ext && typeof ext === 'object' ? ext : null;
  const environmentId = slice && typeof slice.environmentId === 'string'
    ? slice.environmentId.trim()
    : str(settings?.defaultEnvironment);
  return { environmentId, ref: str(slice?.ref) };
}

// The ids a launch may name, or null when any well-formed id is allowed (no
// valid items configured). `defaultEnvironment` is always allowed alongside the
// list: the same human configured both, and refusing their own default would be
// a trap.
export function allowedEnvironmentIds(settings) {
  const { valid } = parseEnvironments(settings?.environments);
  if (valid.length === 0) return null;
  const ids = valid.map((e) => e.id);
  const def = str(settings?.defaultEnvironment);
  if (isEnvironmentId(def) && !ids.includes(def)) ids.push(def);
  return ids;
}
