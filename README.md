# aw-cloud-sessions

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension (id `cloud`)
that adds a **☁ Cloud** runtime to the dispatch dialog. Dispatching a card with it hands the task to a
Claude Code cloud session instead of running Claude on your machine. The card then links to the session
on claude.ai, and other sessions can send it peer messages.

Needs Agent Wrangler host API `^1.19.0` (extension-contributed runtimes and `links:write`). An older
wrangler won't load it.

## Install

Settings → Extensions → install by git URL:

```
https://github.com/alex-pezarro-portswigger/aw-cloud-sessions
```

The consent dialog lists three capabilities:

- `links:write` attaches the ☁ link to the card.
- `board:rebuild` makes the chip show straight away.
- `sessions:read` is only used to drop records for cards that no longer exist.

There are no dependencies, so there's no lockfile and no `npm ci`.

You also need a `claude` CLI on the wrangler's `PATH` that can create cloud sessions, signed in with
subscription (OAuth) auth.

## Use

In the dispatch dialog, open **Advanced options** and set **Runtime** to **☁ Cloud**. Two fields appear:

- **Cloud environment**: "Account default", plus the environments from the extension's settings. The
  default environment setting is preselected.
- **Cloud ref**: the branch a self-hosted pool checks out. It only shows for a `ccpool_…` environment.

The worktree box is hidden while Cloud is selected, and the dispatch is sent with `worktree: false`.

The card's pane runs the create command under `script`, which gives the client a real terminal and
records its output. Within a few seconds the card gets a **☁ cloud** chip linking to the session on
claude.ai. If the CLI reports that the create failed, the chip reads **☁ failed** and the error goes
to the wrangler log. After the client exits, the pane prints a short banner and holds, so the card isn't
auto-archived. Archive the card to close the pane.

`spawn_session` with `runtime: "cloud"` has no dialog, so it uses the **Default environment** setting
and no ref.

On wrangler host API 1.22.0 or later, `spawn_session` waits up to 15 s for the create's outcome. If the
CLI reports an error, the tool returns that error, along with the new card's id, instead of a success.
Otherwise the result carries `launch: { state: "ok", url }`, or `"pending"` if the create is still going.
`list_sessions` reports the same `launch` on every cloud card. Pass `wait: false` to skip the wait. On
an older wrangler the extension still loads, but `spawn_session` can't report a failed create.

### Launch forms

| Environment | Command |
| --- | --- |
| Account default | `claude --cloud '<intent>'` |
| `env_…` (Anthropic-hosted) | `claude --cloud '<intent>' --settings '{"remote":{"defaultEnvironmentId":"env_…"}}'` |
| `ccpool_…` (self-hosted pool) | `claude -p '<intent>' --environment ccpool_… [--ref <branch>] --output-format json` |

Every command is checked so that `-p` is never combined with `--cloud '<description>'`. That
combination can quietly run the prompt locally while the card says it's in the cloud.

## Settings

| Setting | What it does |
| --- | --- |
| **Environments** (list) | The environments the dialog offers. Each item is an `env_…` or `ccpool_…` id, optionally followed by a space and a label, e.g. `ccpool_01ab CI runners`. Invalid items are skipped. If the list has any valid items, a dispatch that names an environment not on it (or not the default) is refused. |
| **Default environment** (text) | Preselected in the dialog and used by `spawn_session`. Empty uses your account's default environment. |

Settings → Extensions only shows a count for list settings. Until it can edit them, set the list in the
wrangler's `config.json` under `extensionSettings.cloud.environments`:

```json
{ "extensionSettings": { "cloud": { "environments": ["env_01abc Staging", "ccpool_9z CI runners"], "defaultEnvironment": "env_01abc" } } }
```

## Refusals

A Cloud dispatch is refused, with the reason shown as an error, when:

1. The agent is Codex. Cloud sessions are Claude-only.
2. Workflow (autopilot) mode is on. Its skill is loaded from this machine with `--plugin-dir`.
3. A worktree is requested, for example `spawn_session` with `worktree: true`. The VM clones the branch
   itself.
4. `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is set in the wrangler's
   environment. Cloud sessions need subscription auth.
5. The environment id isn't `env_…`/`ccpool_…`, or isn't one of the configured environments.
6. The folder isn't a git repo, or no folder is selected.
7. `origin` is missing or isn't a GitHub remote.
8. There are commits that haven't been pushed. Push first.
9. The working tree has uncommitted changes. Commit and push, or stash, first.

The cloud VM only sees what's on GitHub, so 8 and 9 refuse rather than warn. A session that silently
runs without your local edits is the failure this avoids. A branch with no upstream isn't refused on
those grounds.

## What a cloud card can't do

- **Resume and Fork are refused.** The runtime is `resumable: false`. There is no local conversation to
  resume, so the ☁ link is the handle. Turning the extension off doesn't change that: Resume then says
  the card needs the `cloud` extension.
- **Its spend is never recorded.** The conversation lives in the cloud VM, so there's no transcript
  under `~/.claude/projects`. The card shows no cost. The spend is also missing from
  `usage-scan-cache.json` and every cost report, permanently: it can't be backfilled. Nothing estimates
  it, because a made-up number would corrupt totals that are otherwise exact.
- **No live status.** Once the create client exits there's nothing local to watch, so the card doesn't
  show working, idle or needs-you. The held pane may be idle-suspended. That's fine, because the ☁ link
  is still there.

## Peer messages

`send_message` to a cloud card runs `claude -p '<message>' --cloud <session_…> --output-format json`
and waits up to 90 seconds. The session id comes from the extension's store, or from the card's ☁ link.
A message sent before the card has its link fails with "try again once the card shows its ☁ link".

## Files

Everything lives under `<data>/aw-cloud-sessions/`, where `<data>` is `AW_DATA_DIR` or
`~/.agent-wrangler`:

- `state.json` holds one record per cloud card: status, environment, ref and the `session_…` id.
- `logs/<card id>.log` holds the create command's output. Logs older than a week are pruned on each
  launch.

Archiving or purging a card removes its record and log. The ☁ link stays on the card. Uninstalling the
extension doesn't delete this directory.

## Development

```
npm test
```

The libraries under `lib/` are pure, with their side effects injectable, and are tested with `node --test`:

| File | What it does |
| --- | --- |
| `lib/command.js` | Create and steer commands, the `-p`/`--cloud` guard, the `script` pane wrapper, `buildLaunch` |
| `lib/preflight.js` | The refusals above |
| `lib/launch-log.js` | Parses the create log, including util-linux `script` headers |
| `lib/sweep.js` | The 2 s launch-watch sweep and archive/purge cleanup |
| `lib/deliver.js` | Peer-message delivery |
| `lib/links.js` | The `cloud` link type (`links.normalise`) |
| `lib/state.js`, `lib/paths.js` | The store and file locations |
| `lib/environments.js`, `public/environments.js` | The environments setting, shared with the browser |
| `lib/runtime.js` | The runtime entry, and every assumption about what core passes to it |
| `public/index.js` | The dialog field and the chip |

For a dev instance, clone into `<AW_DATA_DIR>/extensions/cloud/` and restart the wrangler.
