import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEnvironmentId } from './environments.js';

const exec = promisify(execFile);

// Env vars that switch Claude Code onto a non-subscription credential. A cloud
// session authenticates as the *account*, not as this machine's env, so any of
// these means the local launch would authenticate one way and the VM another —
// which surfaces as an opaque failure inside the pane rather than here.
const AUTH_VARS = [
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY is set'],
  ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_BEDROCK is set'],
  ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_VERTEX is set'],
];

// A bare `ANTHROPIC_API_KEY=` (or `CLAUDE_CODE_USE_BEDROCK=0`) is how a wrapper
// script *unsets* one of these for a child, so emptiness/`0`/`false` must read as
// absent — treating them as present would refuse every launch from such a shell.
function truthyEnv(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

// At most one environment refusal: a malformed id is reported as malformed
// (the more fundamental mistake) and never also as "not in your list". An empty
// id means "use the default environment" and is always fine. The allow-list only
// applies when the extension settings actually configure one — an empty or
// missing list means any well-shaped id is acceptable.
function environmentIdRefusal(environmentId, allowedEnvironmentIds) {
  const id = String(environmentId || '').trim();
  if (!id) return null;
  // The whole id is checked, not just the prefix, so a bare `env_` or a pasted
  // id with a space in it is caught here rather than by the CLI.
  if (!isEnvironmentId(id)) {
    return {
      code: 'cloud-bad-environment',
      message: `"${id}" isn't a cloud environment id — Anthropic-hosted ids start with env_, self-hosted runner ids with ccpool_.`,
    };
  }
  if (Array.isArray(allowedEnvironmentIds) && allowedEnvironmentIds.length > 0) {
    const allowed = allowedEnvironmentIds.map((x) => String(x ?? '').trim());
    if (!allowed.includes(id)) {
      return {
        code: 'cloud-unknown-environment',
        message: `"${id}" isn't one of the environments configured in the Cloud sessions extension settings — pick one of those, or add it there first.`,
      };
    }
  }
  return null;
}

// The VM clones the repo from its GitHub remote, so an `origin` that isn't
// GitHub (a local path, a GitLab/Bitbucket URL) is as unusable as none at all.
// Matches both remote spellings: `https://github.com/o/r.git` and `git@github.com:o/r.git`.
function looksLikeGithubRemote(url) {
  return /(^|[@/.])github\.com([:/]|$)/i.test(String(url || '').trim());
}

// Run a git probe, resolving `null` on ANY failure instead of throwing: every
// caller below treats "couldn't tell" as "don't refuse on this ground", since a
// preflight that blows up on an unexpected git edge case is worse than one that
// lets the launch through to fail with git's own error.
async function gitOut(run, cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args]);
    return String(stdout ?? '');
  } catch {
    return null;
  }
}

// "Which repo is this?" — the top level of the work tree containing `cwd`, or
// null when it isn't inside one (or git couldn't say). Goes through the same
// injectable `run` as every other probe so tests never touch a real repo.
async function gitRepoRoot(cwd, run = exec) {
  const out = await gitOut(run, cwd, ['rev-parse', '--show-toplevel']);
  const root = out === null ? '' : out.trim();
  return root || null;
}

// Can this cwd become a cloud session, and if not, why? All git/env probing, no
// tmux and no Agent Wrangler import — a leaf, so the extension's launch path and
// any settings/validation UI share one answer.
//
// Everything is a refusal: the cloud VM clones the *pushed* branch, so anything
// local it would silently miss (uncommitted edits, unpushed commits) blocks the
// launch and tells the human to commit or push first. Refusal order is
// deliberate, cheapest-and-most-actionable first (agent, then flags, then this
// machine's env, then the id we were handed, and only then git): callers show
// the FIRST refusal, so "cloud is Claude-only" must never be buried behind a git
// probe about a repo the user was never going to use.
//
// `run` (a promisified execFile) and `repoRoot` are injectable because the tests
// must not touch a real repo. `repoRoot` defaults to a local probe that goes
// through the same `run`, so injecting `run` alone is enough to fake a repo.
//
// `ref` is accepted but not probed: it's the branch the VM checks out, resolved
// against the *remote* at clone time. Validating it here would mean a network
// round trip per launch, and a ref that exists locally but was never pushed
// would still pass. The dirty/unpushed refusals below are the honest local
// signal about what the VM will actually see.
export async function cloudPreflight({
  cwd,
  agent = 'claude',
  workflow = false,
  worktree = false,
  environmentId = '',
  ref = '',
  allowedEnvironmentIds = null,
  env = process.env,
  run = exec,
  repoRoot = (dir) => gitRepoRoot(dir, run),
} = {}) {
  const refusals = [];

  if (agent === 'codex') {
    refusals.push({
      code: 'cloud-codex',
      message: 'Cloud sessions are Claude-only — Codex has no cloud runtime. Pick Claude, or run this locally.',
    });
  }

  if (workflow) {
    refusals.push({
      code: 'cloud-workflow',
      message: 'Autopilot workflows can\'t run in the cloud — the issue-to-pr skill is loaded with --plugin-dir, which only exists on this machine.',
    });
  }

  if (worktree) {
    refusals.push({
      code: 'cloud-worktree',
      message: 'Cloud sessions can\'t use a worktree — the cloud VM clones the pushed branch itself, so a local worktree would never be seen. Turn off the worktree option.',
    });
  }

  for (const [name, phrase] of AUTH_VARS) {
    if (truthyEnv(env?.[name])) {
      refusals.push({
        code: 'cloud-auth',
        message: `${phrase} in the launch environment — cloud sessions need subscription (OAuth) auth, not an API key or a Bedrock/Vertex credential.`,
      });
      break;
    }
  }

  const badId = environmentIdRefusal(environmentId, allowedEnvironmentIds);
  if (badId) refusals.push(badId);

  const folder = String(cwd || '').trim();
  const root = folder ? await repoRoot(folder) : null;
  if (!root) {
    refusals.push({
      code: 'cloud-not-git',
      message: folder
        ? `${folder} isn't a git repository — a cloud session works from a pushed GitHub repo.`
        : 'No folder selected — a cloud session works from a pushed GitHub repo.',
    });
    // Every remaining probe is a `git -C` call in a repo we just proved isn't
    // one; there is nothing further to learn.
    return { refusals };
  }

  const origin = await gitOut(run, folder, ['remote', 'get-url', 'origin']);
  if (!origin || !looksLikeGithubRemote(origin)) {
    refusals.push({
      code: 'cloud-no-origin',
      message: origin
        ? `origin (${origin.trim()}) isn't a GitHub remote — the cloud VM clones from GitHub.`
        : 'This repo has no GitHub `origin` remote — the cloud VM clones from the remote, so there\'d be nothing to check out.',
    });
  }

  // `@{u}..HEAD` errors out when the branch has no upstream (a never-pushed
  // branch, or a detached HEAD). That's not a refusal of its own — the missing
  // upstream tells us nothing about what the VM will see beyond what the
  // no-origin or dirty-tree refusals already say.
  const ahead = await gitOut(run, folder, ['rev-list', '--count', '@{u}..HEAD']);
  const aheadCount = ahead === null ? 0 : Number.parseInt(ahead.trim(), 10) || 0;
  if (aheadCount > 0) {
    refusals.push({
      code: 'cloud-unpushed',
      message: `${aheadCount} commit${aheadCount === 1 ? '' : 's'} not pushed to the remote — the cloud session clones the pushed branch, so it wouldn't see ${aheadCount === 1 ? 'it' : 'them'}. Push first.`,
    });
  }

  const status = await gitOut(run, folder, ['status', '--porcelain']);
  if (status && status.trim()) {
    refusals.push({
      code: 'cloud-dirty',
      message: 'Uncommitted local changes — the cloud session works from the pushed branch, so your working-tree edits would be invisible to it. Commit (and push) or stash them first.',
    });
  }

  return { refusals };
}

// The one thing most callers want: the sentence to show, or null to go ahead.
export async function firstRefusal(opts) {
  const { refusals } = await cloudPreflight(opts);
  return refusals.length > 0 ? refusals[0].message : null;
}
