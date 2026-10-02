import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import manifest, { dir } from '../index.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('identity agrees with package.json, and requires is exactly the declared set', () => {
  assert.equal(manifest.id, 'cloud');
  assert.equal(pkg.wranglerExtension.id, 'cloud');
  assert.equal(manifest.label, pkg.wranglerExtension.label);
  assert.deepEqual(manifest.requires, pkg.wranglerExtension.requires);
  assert.deepEqual([...manifest.requires].sort(), ['board:rebuild', 'links:write', 'sessions:read']);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts.test, 'node --test');
});

test('no dependencies, so no lockfile is needed', () => {
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.equal(pkg[k], undefined, k);
  }
});

test('engines, defaults, veto disclosure and client path', () => {
  assert.equal(manifest.engines.wranglerApi, '^1.19.0');
  assert.equal(manifest.defaultEnabled, true);
  assert.deepEqual(manifest.hideDispatchField, ['worktree']);
  assert.equal(manifest.dir, dir);
  assert.equal(manifest.client, 'public/index.js');
  assert.ok(fs.existsSync(path.join(dir, manifest.client)));
});

test('settings: a list of environments and a patterned default', () => {
  const byKey = Object.fromEntries(manifest.settings.map((s) => [s.key, s]));
  assert.equal(byKey.environments.type, 'list');
  assert.equal(byKey.defaultEnvironment.type, 'text');
  // Core anchors a text pattern as ^(?:…)$.
  const re = new RegExp(`^(?:${byKey.defaultEnvironment.pattern})$`);
  assert.ok(re.test('env_01abc'));
  assert.ok(re.test('ccpool_9z'));
  assert.ok(!re.test('prod'));
  assert.ok(!re.test('env_'));
  for (const s of manifest.settings) {
    assert.match(s.key, /^[a-z][a-zA-Z0-9]*$/);
    assert.ok(s.label);
  }
});

test('runtimes: one buildLaunch runtime that is not resumable', () => {
  assert.equal(manifest.runtimes.length, 1);
  const [rt] = manifest.runtimes;
  assert.equal(rt.id, 'cloud');
  assert.ok(rt.label);
  assert.equal(typeof rt.buildLaunch, 'function');
  assert.equal(rt.wrapLaunch, undefined, 'exactly one of wrapLaunch/buildLaunch');
  assert.equal(rt.resumable, false, 'buildLaunch requires resumable: false (D4)');
  assert.equal(typeof rt.skipsHostResumeGuard, 'boolean');
  for (const k of ['preflight', 'deliver', 'analyze']) assert.equal(typeof rt[k], 'function', k);
  assert.equal(rt.readLive, undefined);
});

test('hooks, sweeps, session hooks and stores have the shapes the loader checks', () => {
  assert.deepEqual(Object.keys(manifest.hooks), ['links.normalise']);
  assert.equal(typeof manifest.hooks['links.normalise'], 'function');
  assert.deepEqual(manifest.sweeps.map((s) => [s.id, s.everyMs, typeof s.run]), [['launch-watch', 2000, 'function']]);
  assert.deepEqual(Object.keys(manifest.session).sort(), ['onArchive', 'onPurge']);
  assert.deepEqual(Object.keys(manifest.stores), ['cloud-sessions']);
  assert.equal(typeof manifest.stores['cloud-sessions'], 'function');
});

// Same rule core enforces on its own manifests: an extension imports only node
// built-ins and its own files, never the wrangler's server modules.
test('server-side code imports only node: built-ins and its own files', () => {
  const files = ['index.js', ...fs.readdirSync(path.join(root, 'lib')).map((f) => `lib/${f}`), ...fs.readdirSync(path.join(root, 'public')).map((f) => `public/${f}`)];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const [, spec] of src.matchAll(/\bfrom\s+'([^']+)'/g)) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${f} imports ${spec}`);
      if (f.startsWith('public/')) assert.ok(!spec.startsWith('node:') && !spec.startsWith('../'), `browser file ${f} imports ${spec}`);
    }
  }
});
