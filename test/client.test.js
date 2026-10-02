import { test } from 'node:test';
import assert from 'node:assert/strict';
import client, { chip, environmentOptions, createDispatchField } from '../public/index.js';

// Just enough DOM for the contribution: elements that hold children, a <select>
// that drops a value with no matching option, and change listeners. No jsdom,
// matching Agent Wrangler's own public/ tests.
function stubElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    children: [],
    hidden: false,
    listeners: {},
    append(...kids) { this.children.push(...kids); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of this.listeners[type] || []) fn(); },
  };
  if (tag === 'select') {
    let value = '';
    Object.defineProperty(el, 'value', {
      get: () => value,
      set: (v) => { value = el.children.some((o) => o.value === v) ? v : (el.children[0]?.value ?? ''); },
    });
    el.replaceChildren = (...kids) => {
      el.children = kids;
      if (!kids.some((o) => o.value === value)) value = kids[0]?.value ?? '';
    };
  } else {
    el.value = '';
  }
  return el;
}
globalThis.document = { createElement: stubElement };

// The browser-side copy of slots.js's SAFE_ICON check, so a chip icon the board
// would silently drop fails here instead.
const SAFE_ICON_RE = /^<svg(?:\s+[A-Za-z-]+="[^"<>]*")*\s*>(?:<path(?:\s+[A-Za-z-]+="[^"<>]*")*\s*\/>)+<\/svg>$/;

function mounted(settings = {}) {
  const c = createDispatchField();
  const host = stubElement('div');
  c.mount(host, { settings: () => ({ ...settings }) });
  const [envRow, refRow] = host.children;
  return { c, host, select: envRow.children[1], ref: refRow.children[1], refRow };
}
const ctx = (runtime) => ({ mode: 'launch', draft: { agent: 'claude', runtime }, agents: [] });

test('register: one dispatch.field at advanced and one link.chip', () => {
  const regs = [];
  client.register({ register: (slot, c) => regs.push([slot, c]) });
  assert.deepEqual(regs.map(([s, c]) => [s, c.id]), [['dispatch.field', 'cloud-options'], ['link.chip', 'cloud']]);
  assert.equal(regs[0][1].at, 'advanced');
});

test('hides the worktree box only while Cloud is the runtime', () => {
  const { c } = mounted();
  assert.equal(typeof c.hides, 'function');
  assert.deepEqual(c.hides({ runtime: 'cloud' }), ['worktree']);
  assert.deepEqual(c.hides({ runtime: undefined }), []);
  assert.deepEqual(c.hides({ runtime: 'devcontainer' }), []);
  assert.deepEqual(c.hides(undefined), []);
});

test('shown only for Cloud; fields and ext are empty otherwise', () => {
  const { c, host } = mounted();
  assert.equal(host.hidden, true, 'hidden until the first update says Cloud');
  c.update(host, ctx(undefined));
  assert.equal(host.hidden, true);
  assert.deepEqual(c.fields(host, ctx(undefined)), {});
  assert.equal(c.ext(host, ctx(undefined)), undefined);
  c.update(host, ctx('cloud'));
  assert.equal(host.hidden, false);
  assert.deepEqual(c.fields(host, ctx('cloud')), { worktree: false });
  assert.deepEqual(c.ext(host, ctx('cloud')), { environmentId: '', ref: '' });
  c.update(host, ctx('devcontainer'));
  assert.equal(host.hidden, true);
  assert.deepEqual(c.fields(host, ctx('devcontainer')), {});
  assert.equal(c.ext(host, ctx('devcontainer')), undefined);
});

test('options: Account default, the valid configured items, and the default preselected', () => {
  const { c, host, select } = mounted({ environments: ['env_a Staging', 'junk', 'ccpool_b CI'], defaultEnvironment: 'ccpool_b' });
  c.update(host, ctx('cloud'));
  assert.deepEqual(select.children.map((o) => [o.value, o.textContent]), [
    ['', 'Account default'], ['env_a', 'Staging'], ['ccpool_b', 'CI'],
  ]);
  assert.equal(select.value, 'ccpool_b');
});

test('a pick survives later updates; the explicit Account default is sent as an empty id', () => {
  const { c, host, select } = mounted({ environments: ['env_a', 'env_b'], defaultEnvironment: 'env_b' });
  c.update(host, ctx('cloud'));
  select.value = 'env_a';
  c.update(host, ctx('cloud'));
  assert.equal(select.value, 'env_a');
  select.value = '';
  c.update(host, ctx('cloud'));
  assert.deepEqual(c.ext(host, ctx('cloud')), { environmentId: '', ref: '' });
});

test('the ref row shows only for a self-hosted pool, and ext carries the trimmed ref', () => {
  const { c, host, select, ref, refRow } = mounted({ environments: ['env_a', 'ccpool_b'] });
  c.update(host, ctx('cloud'));
  assert.equal(refRow.hidden, true);
  select.value = 'ccpool_b';
  select.dispatch('change');
  assert.equal(refRow.hidden, false);
  ref.value = '  feature/x ';
  assert.deepEqual(c.ext(host, ctx('cloud')), { environmentId: 'ccpool_b', ref: 'feature/x' });
});

test('environmentOptions adds a default that is not in the list, and skips a bad one', () => {
  assert.deepEqual(environmentOptions({ environments: ['env_a'], defaultEnvironment: 'env_z' }).map((o) => o.value), ['', 'env_a', 'env_z']);
  assert.deepEqual(environmentOptions({ defaultEnvironment: 'nope' }).map((o) => o.value), ['']);
  assert.deepEqual(environmentOptions(undefined).map((o) => o.value), ['']);
});

test('unmount clears state so a stale element is never read', () => {
  const { c, host } = mounted();
  c.update(host, ctx('cloud'));
  c.unmount(host);
  assert.equal(c.ext(host, ctx('cloud')), undefined);
});

test('chip: a created link links to claude.ai with a safe icon', () => {
  const got = chip({ type: 'cloud', key: 'session_01AB', url: 'https://claude.ai/code/session_01AB' });
  assert.equal(got.label, 'cloud'); // the icon is the cloud; a ☁ in the label too drew two
  assert.equal(got.href, 'https://claude.ai/code/session_01AB');
  assert.match(got.icon, SAFE_ICON_RE);
});

test('chip: failed marker, key-only link, a non-claude url, and other types', () => {
  assert.equal(chip({ type: 'cloud', key: 'failed' }).label, 'failed');
  assert.equal(chip({ type: 'cloud', key: 'failed' }).href, undefined);
  assert.deepEqual(chip({ type: 'cloud', key: 'session_X' }).href, '');
  assert.equal(chip({ type: 'cloud', key: 'session_X', url: 'https://evil.example/' }).href, '');
  assert.equal(chip({ type: 'jira', key: 'X-1' }), null);
  assert.equal(chip(null), null);
});
