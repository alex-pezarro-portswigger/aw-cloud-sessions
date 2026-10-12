import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCloudRuntime } from './lib/runtime.js';
import { createLaunchWatch, forgetCard, STORE } from './lib/sweep.js';
import { stateFactory } from './lib/state.js';
import { normalise } from './lib/links.js';

// Cloud sessions: a `cloud` runtime in the dispatch dialog. Dispatching with it
// runs `claude --cloud` (or the self-hosted `-p --environment` form) in the
// card's pane, which hands the task to a Claude Code cloud session; the
// launch-watch sweep then puts a ☁ link to that session on the card. Peer
// messages to the card are steered into the cloud session by id.
//
// Contract-dependent pieces (host API 1.19.0): the `runtimes` entry
// (lib/runtime.js), `links:write` (lib/sweep.js), and the client's function-form
// `hides` and `worktree` dispatch field (public/index.js).

// The loader resolves `client` inside this directory's public/ subdir, so the
// manifest has to say where it lives. (For an installed copy the loader
// overwrites it with the discovered path.)
export const dir = path.dirname(fileURLToPath(import.meta.url));

const launchWatch = createLaunchWatch();

export default {
  id: 'cloud',
  label: 'Cloud sessions',
  description: 'Adds a Cloud runtime to the dispatch dialog: the card\'s task runs in a Claude Code cloud session, and the card links to it.',
  help: 'Adds "☁ Cloud" to the dispatch dialog\'s runtime picker. A cloud card links to its session on claude.ai and can be sent peer messages, but it can\'t be resumed or forked, and its spend is never recorded. Turning this off keeps existing cards and their links; their ☁ chips and messaging come back when it is turned on again.',
  author: 'Alex Pezarro',
  dir,
  defaultEnabled: true,
  // Must equal package.json's wranglerExtension.requires.
  //   links:write   — the sweep attaches the ☁ link to the card.
  //   board:rebuild — so the chip shows without waiting for the next tick.
  //   sessions:read — only to prune records of cards that no longer exist.
  requires: ['links:write', 'board:rebuild', 'sessions:read'],
  // 1.19.0: the `runtimes` contribution, `links:write`, the `worktree` dispatch
  // field and the function form of `hides`. An older server ignores `runtimes`,
  // so only the range can say this won't work there.
  // 1.21.0: a list setting's per-item `pattern`.
  engines: { wranglerApi: '^1.21.0' },
  // The disclosure half of the dispatch-field veto: the worktree box is hidden
  // while Cloud is selected (the contribution's `hides` decides when).
  hideDispatchField: ['worktree'],
  settings: [
    {
      key: 'environments',
      type: 'list',
      label: 'Environments',
      help: 'The cloud environments the dispatch dialog offers. One per item: an env_… (Anthropic-hosted) or ccpool_… (self-hosted runner pool) id, optionally followed by a space and a label, e.g. "ccpool_01ab CI runners". When the list has valid items, a dispatch naming any other environment is refused.',
      maxItems: 50,
      pattern: '(env_|ccpool_)[A-Za-z0-9_-]+( .+)?',
    },
    {
      key: 'defaultEnvironment',
      type: 'text',
      label: 'Default environment',
      help: 'The environment preselected in the dialog, and the one used when a session is spawned without the dialog (spawn_session). Empty uses your account\'s default environment.',
      placeholder: 'env_… or ccpool_…',
      pattern: '(env_|ccpool_)[A-Za-z0-9_-]+',
    },
  ],
  runtimes: [createCloudRuntime()],
  hooks: { 'links.normalise': normalise },
  sweeps: [{ id: 'launch-watch', everyMs: 2000, run: launchWatch.run }],
  session: {
    onArchive: (payload) => forgetCard(payload),
    onPurge: (payload) => forgetCard(payload),
  },
  stores: { [STORE]: stateFactory },
  client: 'public/index.js',
};
