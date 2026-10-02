import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvironmentItem, parseEnvironments, isEnvironmentId, resolveLaunchOptions, allowedEnvironmentIds,
} from '../lib/environments.js';

test('isEnvironmentId: env_/ccpool_ with a non-empty safe tail', () => {
  for (const ok of ['env_01abc', 'ccpool_9z', 'env_a-b_c']) assert.equal(isEnvironmentId(ok), true, ok);
  for (const bad of ['env_', 'ccpool_', 'env-abc', 'pool_1', 'env_a b', 'env_$x', '', null, 42]) {
    assert.equal(isEnvironmentId(bad), false, String(bad));
  }
});

test('parseEnvironmentItem: id alone, id plus label, and garbage', () => {
  assert.deepEqual(parseEnvironmentItem('env_01abc'), { id: 'env_01abc', label: 'env_01abc' });
  assert.deepEqual(parseEnvironmentItem('  ccpool_9z   CI runners  '), { id: 'ccpool_9z', label: 'CI runners' });
  assert.equal(parseEnvironmentItem('prod'), null);
  assert.equal(parseEnvironmentItem('prod env_01abc'), null);
  assert.equal(parseEnvironmentItem('   '), null);
  assert.equal(parseEnvironmentItem(undefined), null);
});

test('parseEnvironments: splits valid from invalid and dedupes by id', () => {
  const r = parseEnvironments(['env_a Staging', 'nope', 'ccpool_b', 'env_a Duplicate', '']);
  assert.deepEqual(r.valid, [{ id: 'env_a', label: 'Staging' }, { id: 'ccpool_b', label: 'ccpool_b' }]);
  assert.deepEqual(r.invalid, ['nope', '']);
  assert.deepEqual(parseEnvironments(undefined), { valid: [], invalid: [] });
  assert.deepEqual(parseEnvironments('env_a'), { valid: [], invalid: [] });
});

test('resolveLaunchOptions: ext over setting over account default', () => {
  const settings = { defaultEnvironment: 'env_setting' };
  assert.deepEqual(resolveLaunchOptions({ ext: { environmentId: 'ccpool_ext', ref: 'dev' }, settings }),
    { environmentId: 'ccpool_ext', ref: 'dev' });
  assert.deepEqual(resolveLaunchOptions({ ext: null, settings }), { environmentId: 'env_setting', ref: '' });
  assert.deepEqual(resolveLaunchOptions({ ext: { ref: ' main ' }, settings }), { environmentId: 'env_setting', ref: 'main' });
  assert.deepEqual(resolveLaunchOptions({ ext: null, settings: {} }), { environmentId: '', ref: '' });
  assert.deepEqual(resolveLaunchOptions({}), { environmentId: '', ref: '' });
});

test('resolveLaunchOptions: an explicit empty choice in the dialog means the account default', () => {
  assert.deepEqual(resolveLaunchOptions({ ext: { environmentId: '' }, settings: { defaultEnvironment: 'env_setting' } }),
    { environmentId: '', ref: '' });
});

test('allowedEnvironmentIds: null with no valid items, else the list plus the default', () => {
  assert.equal(allowedEnvironmentIds({}), null);
  assert.equal(allowedEnvironmentIds({ environments: ['junk'] }), null);
  assert.deepEqual(allowedEnvironmentIds({ environments: ['env_a x', 'ccpool_b'] }), ['env_a', 'ccpool_b']);
  assert.deepEqual(allowedEnvironmentIds({ environments: ['env_a'], defaultEnvironment: 'env_z' }), ['env_a', 'env_z']);
  assert.deepEqual(allowedEnvironmentIds({ environments: ['env_a'], defaultEnvironment: 'env_a' }), ['env_a']);
  assert.deepEqual(allowedEnvironmentIds({ environments: ['env_a'], defaultEnvironment: 'bogus' }), ['env_a']);
});
