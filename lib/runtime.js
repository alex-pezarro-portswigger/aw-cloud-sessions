import { buildLaunch as buildCloudLaunch } from './command.js';
import { firstRefusal } from './preflight.js';
import { sendCloudMessage, resolveCloudSessionId } from './deliver.js';
import { resolveLaunchOptions, allowedEnvironmentIds } from './environments.js';
import { STORE } from './sweep.js';

// The `cloud` runtime entry for the manifest's `runtimes` contribution. THIS FILE
// IS THE CONTRACT GLUE: everything it calls is a plain library function, and
// every assumption about what core passes in is here.
//
// HOST API 1.19.0 runtime contract (core binds every fn with `{ ...args, host,
// settings }`, settings = host.settings.all()):
//   buildLaunch({ phase: 'dispatch', intent, cwd, sessionId, model, ext })
//     -> the full pane command string. Called at dispatch only; `sessionId` is
//        the card id.
//   preflight({ cwd, agent, workflow, worktree, ext })
//     -> refusal message string (shown as a toast) | null.
//   deliver({ entry, from, text })
//     -> { ok: true } | { ok: false, error }. `text` is already compose()-fenced;
//        `entry.sessionId` is the card id. Called by send_message before the
//        live-tmux check, so the held pane is never pasted into.
//   analyze({ entry, liveSid }) -> the empty-analysis object.
// `ext` is this extension's own slice of the dispatch bag (`{ environmentId,
// ref }` from the dialog), or null (spawn_session). When the extension is
// inactive core never reaches these functions.

// What `analyze` returns. It must be this object and not null: core's
// state-reader reads `(runtime.analyze ? await runtime.analyze(…) : null) ||
// <host transcript scan>`, where the `||` exists for devcontainer (whose analyze
// is null when the container is down and must fall back to the host). A cloud
// runtime returning null would fall through to that scan, and a cloud card has
// no conversation id, so the board would cost a transcript under the CARD id, or
// pick up the local `--cloud` client's own conversation and show its spend as
// this card's. A real object short-circuits the `||`. Same shape core's
// transcript analyze returns for a transcript that doesn't exist.
export const EMPTY_ANALYSIS = Object.freeze({ usd: null, subAgentUsd: 0, advisorUsd: 0, tokens: null, subAgents: Object.freeze([]) });

const settingsFrom = ({ settings, host }) => (settings && typeof settings === 'object'
  ? settings
  : (typeof host?.settings?.all === 'function' ? host.settings.all() : {}));

function storeOf(host) {
  const store = host?.stores?.[STORE];
  if (!store) throw new Error('The cloud extension\'s store is not available — is the extension active?');
  return store;
}

export function createCloudRuntime({
  buildLaunchImpl = buildCloudLaunch,
  preflightImpl = firstRefusal,
  sendImpl = sendCloudMessage,
} = {}) {
  return {
    id: 'cloud',
    label: '☁ Cloud',
    // buildLaunch requires resumable: false in 1.19.0 (D4): core refuses Resume
    // and Fork for this card before touching its pane.
    resumable: false,
    // Never reached, since resume is refused first; false is the safer default
    // should that ever change (D6).
    skipsHostResumeGuard: false,

    // Replaces the agent adapter's command outright: a cloud launch is a
    // different `claude` invocation, not a wrapper around the local one (no
    // --session-id, no --mcp-config, no memory injection: none of it reaches the
    // VM). Any phase but dispatch throws rather than falling through to the
    // create form, which would silently start (and pay for) a new cloud session.
    async buildLaunch({ phase = 'dispatch', intent, sessionId, ext, host, settings } = {}) {
      if (phase !== 'dispatch') {
        throw new Error(`The cloud runtime can't build a "${phase}" launch — cloud sessions can only be dispatched, not resumed or forked.`);
      }
      return buildLaunchImpl({ intent, sessionId, ext, settings: settingsFrom({ settings, host }), store: storeOf(host) });
    },

    // The first refusal, or null. Same rules for the dialog, schedules and
    // spawn_session, since all of them go through dispatch.
    async preflight({ cwd, agent, workflow, worktree, ext, host, settings } = {}) {
      const s = settingsFrom({ settings, host });
      const { environmentId, ref } = resolveLaunchOptions({ ext, settings: s });
      return preflightImpl({
        cwd,
        agent,
        workflow: Boolean(workflow),
        worktree: Boolean(worktree),
        environmentId,
        ref,
        allowedEnvironmentIds: allowedEnvironmentIds(s),
      });
    },

    // Peer messages: send_message to this card is steered into the cloud
    // session by id.
    async deliver({ entry, text, host } = {}) {
      const cloudSessionId = resolveCloudSessionId({ entry, store: host?.stores?.[STORE], host });
      const res = await sendImpl({ cloudSessionId, text });
      return res?.ok ? { ok: true } : { ok: false, error: res?.error || 'Delivering to the cloud session failed.' };
    },

    async analyze() {
      return { ...EMPTY_ANALYSIS, subAgents: [] };
    },
    // No readLive in v1: after the create client exits there is nothing local to
    // read, and the held pane is not the agent.
  };
}
