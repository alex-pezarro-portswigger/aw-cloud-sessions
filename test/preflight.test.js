import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudPreflight, firstRefusal } from '../lib/preflight.js';

// A fake promisified execFile. `out` maps a git subcommand (the argv joined after
// the `-C <cwd>` pair) to stdout, or to an Error to simulate git exiting non-zero
// — which is how "no upstream" and "no origin remote" actually present.
function fakeRun(out = {}, calls = []) {
  return async (bin, args) => {
    assert.equal(bin, 'git');
    assert.equal(args[0], '-C');
    const key = args.slice(2).join(' ');
    calls.push(key);
    const v = out[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected git probe: ${key}`);
    return { stdout: v, stderr: '' };
  };
}

// A clean, pushed, GitHub-remote repo — the baseline every case perturbs.
const CLEAN = {
  'remote get-url origin': 'git@github.com:acme/widgets.git\n',
  'rev-list --count @{u}..HEAD': '0\n',
  'status --porcelain': '',
};

const repoRoot = async () => '/repo';

function pf(over = {}) {
  return cloudPreflight({
    cwd: '/repo',
    env: {},
    run: fakeRun(CLEAN),
    repoRoot,
    ...over,
  });
}

const codes = (list) => list.map((r) => r.code);

test('cloudPreflight: a clean pushed GitHub repo has no refusals', async () => {
  const r = await pf();
  assert.deepEqual(r, { refusals: [] });
});

test('cloudPreflight: codex is refused, and refused FIRST so it is what a caller shows', async () => {
  const r = await pf({ agent: 'codex', cwd: '/not-a-repo', repoRoot: async () => null });
  assert.deepEqual(codes(r.refusals), ['cloud-codex', 'cloud-not-git']);
  assert.match(r.refusals[0].message, /Claude-only/);
});

test('cloudPreflight: a workflow launch is refused (the skill rides --plugin-dir)', async () => {
  const r = await pf({ workflow: true });
  assert.deepEqual(codes(r.refusals), ['cloud-workflow']);
  assert.match(r.refusals[0].message, /--plugin-dir/);
});

test('cloudPreflight: a worktree launch is refused', async () => {
  const r = await pf({ worktree: true });
  assert.deepEqual(codes(r.refusals), ['cloud-worktree']);
  assert.match(r.refusals[0].message, /worktree/);
});

test('cloudPreflight: the worktree refusal comes right after workflow', async () => {
  const r = await pf({ worktree: true, workflow: true, env: { ANTHROPIC_API_KEY: 'sk-x' } });
  assert.deepEqual(codes(r.refusals), ['cloud-workflow', 'cloud-worktree', 'cloud-auth']);
});

for (const v of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
  test(`cloudPreflight: ${v} in the launch env is refused`, async () => {
    const r = await pf({ env: { [v]: '1' } });
    assert.deepEqual(codes(r.refusals), ['cloud-auth']);
    assert.match(r.refusals[0].message, new RegExp(v));
  });
}

test('cloudPreflight: two auth vars at once still yield exactly one auth refusal', async () => {
  const r = await pf({ env: { ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_USE_VERTEX: '1' } });
  assert.deepEqual(codes(r.refusals), ['cloud-auth']);
});

test('cloudPreflight: an emptied/zeroed auth var reads as absent, not as set', async () => {
  const r = await pf({ env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' } });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: a malformed environmentId is refused; env_/ccpool_/empty are not', async () => {
  const bad = await pf({ environmentId: 'prod' });
  assert.deepEqual(codes(bad.refusals), ['cloud-bad-environment']);
  assert.match(bad.refusals[0].message, /env_/);
  for (const id of ['env_abc123', 'ccpool_abc123', '', '  ']) {
    const r = await pf({ environmentId: id });
    assert.deepEqual(r.refusals, [], `expected ${JSON.stringify(id)} to be accepted`);
  }
});

test('cloudPreflight: a bare prefix or an id with a space is refused as malformed', async () => {
  for (const id of ['env_', 'ccpool_', 'env_a b']) {
    const r = await pf({ environmentId: id });
    assert.deepEqual(codes(r.refusals), ['cloud-bad-environment'], `expected ${JSON.stringify(id)} to be refused`);
  }
});

test('cloudPreflight: an id not in allowedEnvironmentIds is refused', async () => {
  const r = await pf({ environmentId: 'env_other', allowedEnvironmentIds: ['env_one', 'env_two'] });
  assert.deepEqual(codes(r.refusals), ['cloud-unknown-environment']);
  assert.match(r.refusals[0].message, /Cloud sessions extension settings/);
});

test('cloudPreflight: an id in allowedEnvironmentIds is accepted', async () => {
  const r = await pf({ environmentId: 'env_two', allowedEnvironmentIds: ['env_one', 'env_two'] });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: an empty or null allow-list accepts any well-shaped id', async () => {
  for (const allowedEnvironmentIds of [[], null, undefined]) {
    const r = await pf({ environmentId: 'ccpool_anything', allowedEnvironmentIds });
    assert.deepEqual(r.refusals, [], `expected acceptance with ${JSON.stringify(allowedEnvironmentIds)}`);
  }
});

test('cloudPreflight: an empty environmentId is accepted even with an allow-list', async () => {
  const r = await pf({ environmentId: '', allowedEnvironmentIds: ['env_one'] });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: a malformed id that is also not in the list yields only the bad-shape refusal', async () => {
  const r = await pf({ environmentId: 'prod', allowedEnvironmentIds: ['env_one'] });
  assert.deepEqual(codes(r.refusals), ['cloud-bad-environment']);
});

test('cloudPreflight: a non-repo cwd is refused and no git probe is attempted', async () => {
  const calls = [];
  const r = await pf({ repoRoot: async () => null, run: fakeRun({}, calls) });
  assert.deepEqual(r, { refusals: [r.refusals[0]] });
  assert.deepEqual(codes(r.refusals), ['cloud-not-git']);
  assert.deepEqual(calls, []);
});

test('cloudPreflight: an empty cwd is refused without even asking for a repo root', async () => {
  let asked = 0;
  const r = await cloudPreflight({ cwd: '', env: {}, run: fakeRun({}), repoRoot: async () => { asked += 1; return '/repo'; } });
  assert.deepEqual(codes(r.refusals), ['cloud-not-git']);
  assert.equal(asked, 0);
  assert.match(r.refusals[0].message, /No folder selected/);
});

test('cloudPreflight: the default repoRoot asks git for --show-toplevel through the injected run', async () => {
  const calls = [];
  const r = await cloudPreflight({
    cwd: '/repo',
    env: {},
    run: fakeRun({ ...CLEAN, 'rev-parse --show-toplevel': '/repo\n' }, calls),
  });
  assert.deepEqual(r.refusals, []);
  assert.equal(calls[0], 'rev-parse --show-toplevel');
});

test('cloudPreflight: the default repoRoot failing reads as not-a-git-repo', async () => {
  for (const answer of [new Error('not a git repository'), '', '  \n']) {
    const calls = [];
    const r = await cloudPreflight({
      cwd: '/somewhere',
      env: {},
      run: fakeRun({ 'rev-parse --show-toplevel': answer }, calls),
    });
    assert.deepEqual(codes(r.refusals), ['cloud-not-git']);
    assert.match(r.refusals[0].message, /\/somewhere isn't a git repository/);
    assert.deepEqual(calls, ['rev-parse --show-toplevel']);
  }
});

test('cloudPreflight: a repo with no origin remote is refused', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': new Error('no such remote') }) });
  assert.deepEqual(codes(r.refusals), ['cloud-no-origin']);
});

test('cloudPreflight: a non-GitHub origin is refused as firmly as none', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': 'git@gitlab.com:acme/widgets.git\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-no-origin']);
  assert.match(r.refusals[0].message, /gitlab\.com/);
});

test('cloudPreflight: an https GitHub origin is accepted', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'remote get-url origin': 'https://github.com/acme/widgets.git\n' }) });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: unpushed commits are refused, with the count in the message', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'rev-list --count @{u}..HEAD': '3\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-unpushed']);
  assert.match(r.refusals[0].message, /3 commits/);
  assert.match(r.refusals[0].message, /[Pp]ush first/);
});

test('cloudPreflight: a branch with no upstream is NOT refused for unpushed commits', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'rev-list --count @{u}..HEAD': new Error('no upstream configured') }) });
  assert.deepEqual(r.refusals, []);
});

test('cloudPreflight: a dirty working tree is refused (the VM only sees the pushed branch)', async () => {
  const r = await pf({ run: fakeRun({ ...CLEAN, 'status --porcelain': ' M server/index.js\n?? scratch.txt\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-dirty']);
  assert.match(r.refusals[0].message, /commit|stash/i);
});

test('cloudPreflight: unpushed and dirty stack as two independent refusals, unpushed first', async () => {
  const r = await pf({
    run: fakeRun({
      ...CLEAN,
      'rev-list --count @{u}..HEAD': '1\n',
      'status --porcelain': ' M a.js\n',
    }),
  });
  assert.deepEqual(codes(r.refusals), ['cloud-unpushed', 'cloud-dirty']);
  assert.match(r.refusals[0].message, /1 commit /);
});

test('cloudPreflight: flag and git refusals coexist — workflow comes before dirty', async () => {
  const r = await pf({ workflow: true, run: fakeRun({ ...CLEAN, 'status --porcelain': ' M a.js\n' }) });
  assert.deepEqual(codes(r.refusals), ['cloud-workflow', 'cloud-dirty']);
});

test('cloudPreflight: env/flag refusals precede git ones in a fully-broken case', async () => {
  const r = await pf({
    agent: 'codex',
    workflow: true,
    worktree: true,
    environmentId: 'nope',
    env: { ANTHROPIC_API_KEY: 'sk-x' },
    run: fakeRun({
      ...CLEAN,
      'remote get-url origin': new Error('no such remote'),
      'rev-list --count @{u}..HEAD': '2\n',
      'status --porcelain': ' M a.js\n',
    }),
  });
  assert.deepEqual(codes(r.refusals), [
    'cloud-codex', 'cloud-workflow', 'cloud-worktree', 'cloud-auth', 'cloud-bad-environment',
    'cloud-no-origin', 'cloud-unpushed', 'cloud-dirty',
  ]);
});

test('cloudPreflight: every refusal carries a human message', async () => {
  const r = await pf({
    agent: 'codex',
    workflow: true,
    worktree: true,
    environmentId: 'env_unlisted',
    allowedEnvironmentIds: ['env_one'],
    env: { ANTHROPIC_API_KEY: 'sk-x' },
    run: fakeRun({
      ...CLEAN,
      'remote get-url origin': 'git@gitlab.com:acme/widgets.git\n',
      'rev-list --count @{u}..HEAD': '2\n',
      'status --porcelain': ' M a.js\n',
    }),
  });
  assert.equal(r.refusals.length, 8);
  for (const item of r.refusals) {
    assert.equal(typeof item.code, 'string');
    assert.ok(item.code.length > 0);
    assert.ok(item.message.length > 20, `too terse: ${item.message}`);
  }
});

test('cloudPreflight: `ref` is accepted and never probed against git', async () => {
  const calls = [];
  const r = await pf({ ref: 'feature/x', run: fakeRun(CLEAN, calls) });
  assert.deepEqual(r.refusals, []);
  assert.ok(!calls.some((c) => c.includes('feature/x')));
});

test('firstRefusal: returns the first refusal message', async () => {
  const msg = await firstRefusal({
    cwd: '/repo',
    env: {},
    run: fakeRun({ ...CLEAN, 'status --porcelain': ' M a.js\n' }),
    repoRoot,
    workflow: true,
  });
  assert.match(msg, /--plugin-dir/);
});

test('firstRefusal: returns null when nothing is refused', async () => {
  const msg = await firstRefusal({ cwd: '/repo', env: {}, run: fakeRun(CLEAN), repoRoot });
  assert.equal(msg, null);
});
