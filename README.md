# aw-cloud-sessions

An [Agent Wrangler](https://github.com/alex-pezarro-portswigger/agent-wrangler) extension
that adds a **☁ Cloud** runtime to the dispatch dialog's *Advanced options*. A card
dispatched with it runs in a Claude Code cloud session instead of on your machine, and
links to that session on claude.ai.

Requires an Agent Wrangler server serving host API **^1.19.0** (extension-contributed
runtimes and `links:write`). An older server refuses to load it. On **1.22.0** or later,
`spawn_session` also reports a failed create.

You also need a `claude` CLI on the wrangler's `PATH`, signed in with subscription (OAuth)
auth.

## Install

Settings → Extensions → Install, with this repo's URL or a local path/file URL to a
checkout. It asks for `links:write` (the ☁ link), `board:rebuild` (show the chip straight
away) and `sessions:read` (drop records for deleted cards).

## How it works

- Pick **☁ Cloud** as the runtime, then an environment (account default, or one from the
  settings) and, for a `ccpool_…` pool, a ref. The worktree box is hidden.
- The card's pane runs the create command under `script` and logs its output. The card
  gets a **☁ cloud** chip linking to the session, or **☁ failed** if the create errored.
  The pane then holds so the card isn't auto-archived.
- `spawn_session` with `runtime: "cloud"` uses the default environment. On host API 1.22+
  it waits up to 15 s and returns the create's outcome as `launch` (`wait: false` skips
  this). `list_sessions` shows `launch` on every cloud card.
- `send_message` to a cloud card steers the session with `claude -p … --cloud <session_…>`.
- Settings: **Environments** (`env_…`/`ccpool_…` ids, optionally followed by a label) and
  **Default environment**. If the list is set, other environments are refused. Until the
  settings page can edit lists, set it in `config.json` under
  `extensionSettings.cloud.environments`.
- State lives in `<AW_DATA_DIR>/aw-cloud-sessions/` (`state.json`, plus per-card logs
  pruned after a week), and is cleaned up on archive/purge.

| Environment | Command |
| --- | --- |
| Account default | `claude --cloud '<intent>'` |
| `env_…` | `claude --cloud '<intent>' --settings '{"remote":{"defaultEnvironmentId":"env_…"}}'` |
| `ccpool_…` | `claude -p '<intent>' --environment ccpool_… [--ref <branch>] --output-format json` |

## Refusals

A Cloud dispatch is refused when the agent is Codex; workflow mode is on; a worktree is
requested; `ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` is
set; the environment is invalid or not configured; the folder isn't a git repo with a
GitHub `origin`; or there are unpushed commits or uncommitted changes. The cloud VM only
sees GitHub, so it refuses rather than silently running without your local edits.

## Risks

- **`-p` with `--cloud '<description>'` can silently run locally.** Every command is
  checked so that combination is never built.
- **Spend is never recorded.** There's no local transcript, so cloud cards show no cost and
  are missing from every cost report, permanently.
- **No resume, fork or live status.** The ☁ link is the only handle once the create client
  exits.

## Tests

```
npm test
```

## License

MIT
