# Changelog

## Unreleased

- `--answer` no longer sends a second reply when the question was already answered (in the Codex app, by another client, or by an earlier `--answer`). It sends nothing, prints `not_sent=` and `prior_reply=` (the reply found on the thread), and follows the turn like `--attach`, or reports the turn that already finished.
- An async question stays recognized as unanswered when Codex keeps posting messages after asking it. Previously `--answer` waited for a blocking question first and `--attach` followed instead of returning `status=question`.

## 0.1.2 — 2026-11-04

- The `codex` skill calls its script as `node <path>`, so it works when an installer drops the executable bit (cc-switch installs from GitHub did, giving "Permission denied").

## 0.1.1 — 2026-11-04

- Published to npm as `cc-codex-run`. No code changes.

## 0.1.0 — 2026-11-04

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
