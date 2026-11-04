# codex-run

[简体中文](README.zh-CN.md)

Claude Code skills and a CLI for handing work to [OpenAI Codex](https://github.com/openai/codex) from Claude Code.

Tasks run on the **local Codex app-server daemon**, the same one the Codex app uses. Every thread `codex-run` starts can be watched, resumed or taken over in the Codex app.

What it adds over calling `codex exec`:

- **Questions round-trip.** When Codex (or one of its subagents) asks something, the run exits with `status=question`. The turn keeps waiting on the daemon, and `--answer` sends the reply into that same turn.
- **Runs are auditable.** Each run records the commands Codex reported (with exit codes), the files it patched, the model and sandbox actually used, and the full event log.
- **Runs are recoverable.** If the client dies, `--attach` re-follows a running turn. `--stop` interrupts it. A model that is at capacity is retried on the same thread.

## Requirements

- Linux or macOS. Windows is not supported because the daemon listens on a Unix socket; use WSL.
- Node.js ≥ 20.
- Codex CLI ≥ 0.164.0, signed in (`codex login`). `codex-run` starts the daemon itself (`codex app-server daemon start`).

## Install

As a Claude Code plugin (recommended):

```
/plugin marketplace add kcng0/cc-codex-run
/plugin install codex-run@cc-codex-run
```

From npm, as a CLI plus skills copied into `~/.claude/skills`:

```bash
npm install -g cc-codex-run
codex-run --install-skills          # add --force to move existing codex/codex-delegate skills aside
```

With the [skills CLI](https://github.com/vercel-labs/skills), into the current project (`.claude/skills/`), or user-wide with `-g`:

```bash
npx skills@latest add kcng0/cc-codex-run -a claude-code -s '*'
```

The plugin namespaces its skills (`codex-run:codex`). The other two methods install plain `codex` and `codex-delegate` skills. If you already have a personal skill with one of those names in `~/.claude/skills`, it takes precedence over a project-level install, and a user-level install may replace it.

## Skills

- **`codex`** teaches Claude how to dispatch, answer, resume, attach to, stop and review with `codex-run`.
- **`codex-delegate`** is a delegation policy. By default Codex implements modules whose interface contract is fixed and does independent verification and pre-commit review; UI work stays with Claude. Your own CLAUDE.md can widen or narrow this.

## CLI

```bash
codex-run --role implement -C ~/repo task.md            # new thread
codex-run --resume <thread> -C ~/repo follow-up.md      # next turn on the same thread
codex-run --answer <question thread> -C ~/repo answer.md
codex-run --attach <thread> -C ~/repo
codex-run --review --base main -C ~/repo [focus.md]
codex-run --ps | --stop <thread> | --roles | --models
```

A run prints `key=value` lines (or one JSON object with `--json`): `status`, `job`, `session`, `model`, `sandbox`, `report` and `commands`, then changed files, questions, or the error. It exits 0 for `ok` and `question`, and 1 for any other status. Run `codex-run -h` for every option.

### Roles

A role is a Codex agent TOML file. `--role NAME` reads `$CODEX_HOME/agents/NAME.toml` first and falls back to the examples bundled in `plugin/skills/codex/roles/` (`implement`, `check`, `critic`, `explore`). The bundled roles set no model, so your Codex config decides.

To customize a role, create a file of the same name in `$CODEX_HOME/agents/`; it shadows the bundled one. New names work the same way. `codex-run --roles` shows every role and marks the bundled ones. Only these keys are read:

```toml
# ~/.codex/agents/implement.toml
description = "Implements one module within an explicit file ownership"
model = "gpt-6.1-sol"             # optional, from `codex-run --models`; omit to use your Codex config
model_reasoning_effort = "high"   # optional
sandbox_mode = "workspace-write"  # optional: read-only | workspace-write | danger-full-access
developer_instructions = """
...
"""
```

If you also register the same file as a Codex agent role (`[agents.<name>] config_file = ...` in `config.toml`), Codex's own subagents use it too, so its `sandbox_mode` and instructions apply to both.

### Sandbox and approvals

The sandbox comes from `-s` first, then the role's `sandbox_mode`. Without either, a new thread gets Codex's own config default. For each thread, `codex-run` records the sandbox it ran with (in `$CODEX_RUN_HOME/threads/`, kept 90 days). `--resume` without `-s` or a role reapplies it only when the daemon reports a wider sandbox (a thread reloaded from disk falls back to the config default), and never widens a narrower one. `--answer` and `--attach` reject `-s`, because the waiting turn keeps the sandbox it started with.

Approvals are always off (`approvalPolicy=never`) because nobody is there to approve. A command that needs to leave a restricted sandbox fails instead of prompting, so pick a sandbox wide enough for the task. `danger-full-access` gives Codex unrestricted access to your machine.

What the restricted sandboxes allow for shell commands (measured on Linux with Codex 0.164.0). Codex's built-in web search is not a shell command and works under `read-only` too.

| | read-only | workspace-write |
|---|---|---|
| read files | yes | yes |
| write in the `-C` dir and `/tmp` | no | yes |
| write elsewhere (`~/.cache`, `~/.npm`, `~/.cargo`, …) | no | no |
| write `.git` (commit, branch) | no | no |
| network, including localhost servers | no | only with `network_access = true` |
| talk to the Codex daemon | no | no |

So under `workspace-write` with Codex's defaults, installing dependencies, builds that keep a cache in your home directory (Go, Cargo, Playwright), starting a local server for an end-to-end check, and committing all fail. Either widen the sandbox in `~/.codex/config.toml`:

```toml
[sandbox_workspace_write]
network_access = true
writable_roots = ["/home/you/.cache"]   # optional: only to write outside the -C dir and /tmp; absolute paths
```

or pass `-s danger-full-access` for that task. `codex-run` carries these `[sandbox_workspace_write]` settings into every `workspace-write` turn it starts.

#### Roles that need MCP tools or script-running skills

Under `read-only` and `workspace-write`, two things a role may rely on fail:

- **MCP tools.** With approvals off, Codex rejects any MCP call that needs approval ("MCP tool call requires approval, but approval policy is never"). In Codex's default `auto` mode that is every tool not annotated read-only, so most servers (search, docs, code-context, browser) fail. `danger-full-access` calls them without approval.
- **Skills and CLIs run through the shell**, such as a docs lookup that calls a CLI over the network, or a skill script that writes a cache or temp file. They get the shell limits in the table above.

Codex has no global switch for MCP approval. It can only be set per server (`[mcp_servers.<id>] default_tools_approval_mode = "approve"`), and every server added later needs it too.

The recommended setup: give every role that needs MCP tools, script-running skills or the network `sandbox_mode = "danger-full-access"`, and keep the read-only boundary in its `developer_instructions` ("read-only: do not modify files"). That boundary is then enforced by the instructions, not by the sandbox. Keep `read-only` only for roles that just read files and run simple commands. Remember that a role file in `$CODEX_HOME/agents/` that is also registered in `config.toml` applies to Codex's own subagents too.

### Files and environment

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_HOME` | `~/.codex` | Codex home (roles in `agents/`) |
| `CODEX_RUN_HOME` | `$XDG_STATE_HOME/codex-run` or `~/.local/state/codex-run` | job directories in `jobs/` |
| `CODEX_RUN_JOB_TTL_DAYS` | `7` | finished jobs older than this are pruned at start; `0` disables |

Each job directory holds `task.md`, `report.md`, `meta.json`, `events.jsonl` and, when present, `commands.jsonl`, `questions.json` and `stderr.log`.

## Before you use it

- The `codex` skill pre-approves its own script (`allowed-tools`), so Claude can start Codex runs without a permission prompt. What Codex may then do is bounded only by the sandbox; choose roles and `-s` accordingly.
- Runs use your Codex account and count against its usage limits.
- Runs share the daemon with the Codex app: threads appear there, and the daemon keeps running after `codex-run` exits.
- Codex's own subagents are off unless you pass `--allow-subagents`.

## Limitations

- The app-server protocol is marked experimental by Codex. `codex-run` refuses versions older than 0.164.0, but newer versions may change it.
- `commands.jsonl` lists commands Codex reports as `commandExecution` items. Commands Codex runs through its code-mode `exec` tool are not reported by the daemon. "Changed files" covers apply_patch only; use `git status` for the real scope.
- Older Codex versions sometimes never sent `turn/completed` for a parent turn with subagents (not reproduced on 0.164.0). As a fallback, if the final answer exists, all subagents have ended and 5 s have passed quietly, `codex-run` reads the turn status back from the daemon. A finished turn or an idle thread ends the run with an `inferred=` line; a turn that is still active is followed further and never reported as done.

## Compared with openai/codex-plugin-cc

The official plugin also talks to the app-server, but through its own per-workspace broker. It offers rescue/review commands and a Stop-hook review gate. `codex-run` instead uses the shared Codex daemon, so there is no broker process to leak or kill, and focuses on question round-trips, re-attaching, and auditable run records.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
