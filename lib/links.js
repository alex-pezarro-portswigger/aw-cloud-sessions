import { CLOUD_SESSION_ID_RE, claudeAiUrl } from './launch-log.js';

// The `cloud` board link: what a cloud card points at. Claimed through core's
// `links.normalise` hook, which `set_links` and (under `links:write`)
// `host.links.attach` both run, so an agent can't store a cloud link this
// extension wouldn't.
//
//   { type: 'cloud', key: 'session_…', url?: 'https://claude.ai/…' }  created
//   { type: 'cloud', key: 'failed' }                                    create failed
//
// `failed` is the one non-id key: the launch-watch sweep attaches it when the
// CLI printed its own create error, so the card shows "☁ failed" instead of
// nothing. The url ends up as an href, so it's held to https://claude.ai exactly.

export const LINK_TYPE = 'cloud';
export const FAILED_KEY = 'failed';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function normaliseCloudLink(link) {
  let key = str(link?.key);
  const rawUrl = str(link?.url);
  if (!key && !rawUrl) throw new Error('A cloud link needs a session_… key or a https://claude.ai url.');
  let url;
  if (rawUrl) {
    if (claudeAiUrl(rawUrl) !== rawUrl) throw new Error(`A cloud link url must be a https://claude.ai link (got "${rawUrl}").`);
    url = rawUrl;
  }
  if (key) {
    if (key !== FAILED_KEY && !CLOUD_SESSION_ID_RE.test(key)) {
      throw new Error(`A cloud link key must be a session_… id (got "${key}").`);
    }
  } else {
    // A url-only link names its session in the path; take the key from there so
    // the card's messages can still find it.
    key = url.match(/session_[A-Za-z0-9]+/)?.[0] || '';
  }
  const out = { type: LINK_TYPE };
  if (key) out.key = key;
  if (url) out.url = url;
  return out;
}

// The manifest hook: synchronous, undefined for any other type, throws on an
// invalid cloud link.
export function normalise({ link } = {}) {
  if (link?.type !== LINK_TYPE) return undefined;
  return normaliseCloudLink(link);
}
