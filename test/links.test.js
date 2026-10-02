import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalise, normaliseCloudLink } from '../lib/links.js';

test('normalise ignores every other link type', () => {
  assert.equal(normalise({ link: { type: 'pr', url: 'https://github.com/a/b/pull/1' } }), undefined);
  assert.equal(normalise({ link: { type: 'jira', key: 'X-1' } }), undefined);
  assert.equal(normalise({ link: null }), undefined);
  assert.equal(normalise({}), undefined);
});

test('normalise keeps a session key and a claude.ai url, trimmed, and nothing else', () => {
  assert.deepEqual(
    normalise({ link: { type: 'cloud', key: ' session_01AB ', url: ' https://claude.ai/code/session_01AB ', extra: 'x' } }),
    { type: 'cloud', key: 'session_01AB', url: 'https://claude.ai/code/session_01AB' },
  );
  assert.deepEqual(normalise({ link: { type: 'cloud', key: 'session_01AB' } }), { type: 'cloud', key: 'session_01AB' });
});

test('a url-only link takes its key from the url when it names a session', () => {
  assert.deepEqual(normaliseCloudLink({ url: 'https://claude.ai/code/session_ZZ9' }),
    { type: 'cloud', key: 'session_ZZ9', url: 'https://claude.ai/code/session_ZZ9' });
  assert.deepEqual(normaliseCloudLink({ url: 'https://claude.ai/code' }), { type: 'cloud', url: 'https://claude.ai/code' });
});

test('the failed marker is accepted', () => {
  assert.deepEqual(normalise({ link: { type: 'cloud', key: 'failed' } }), { type: 'cloud', key: 'failed' });
});

test('anything else of type cloud throws', () => {
  const bad = [
    {},
    { key: '' },
    { key: 's-1770000000000-ab12' },
    { key: '9f1c0b6e-1111-4222-8333-444455556666' },
    { key: 'session_01AB', url: 'http://claude.ai/code/session_01AB' },
    { key: 'session_01AB', url: 'https://claude.ai.evil.example/x' },
    { url: 'javascript:alert(1)' },
    { url: 'https://claude.ai/x)' },
  ];
  for (const link of bad) {
    assert.throws(() => normalise({ link: { type: 'cloud', ...link } }), /cloud link/, JSON.stringify(link));
  }
});
