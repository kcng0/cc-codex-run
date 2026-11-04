# Changelog

## 0.1.0 — unreleased

First public version, extracted from a private Claude Code skill.

- Runs Codex turns on the local app-server daemon; threads stay visible and resumable in the Codex app.
- Question round-trips (`status=question` / `--answer`), including questions asked by Codex subagents.
- `--attach`, `--stop`, `--ps`, `--review`, `--schema` (validated locally with Ajv), `--json`, `--install-skills`.
- Sandbox precedence: `-s`, then the role's `sandbox_mode`, then Codex's own config. No sandbox is forced by default. Each thread's sandbox is recorded; `--resume` reapplies it only when the daemon reports a wider one (a reloaded thread falls back to the config default), and never widens a narrower one. `--answer`/`--attach` reject `-s`: the waiting turn keeps its sandbox.
- Refuses app-servers older than 0.164.0.
- Fixes over the private version:
  - events from another turn on the same thread no longer end the run
  - a stop signal while `turn/start` is in flight now interrupts the new turn
  - `--attach` reads back a final answer produced before it attached
  - `--ps` lists every loaded thread instead of the first 100
  - an explicit `workspace-write` turn keeps `network_access`, `writable_roots` and the `/tmp` settings from `[sandbox_workspace_write]` instead of resetting them to the defaults
  - an overdue `turn/completed` is resolved by reading the turn status back from the daemon; a turn still active is never reported as done
