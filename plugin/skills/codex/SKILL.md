---
name: codex
description: Run tasks on OpenAI Codex through the local Codex app-server daemon — pick a role or model, run several in the background, answer Codex's questions, resume a thread by id, or run Codex's built-in review. Use whenever you need to call Codex.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/codex-run.mjs *)
---

# Calling Codex

Script: `node ${CLAUDE_SKILL_DIR}/scripts/codex-run.mjs` (always call it with `node` and this full path, since some installers drop the executable bit; `-h` lists options). Tasks run on the local Codex app-server daemon (started automatically). Thread names start with `[codex-run·<role>]`, and the user can watch or take over them in the Codex app.

## Dispatching

1. Write the task to a file. Codex cannot see this conversation, so the task must stand alone: goal, working directory, file ownership, known facts, constraints, a checkable definition of done, and what to do when information is missing (assume and report it, or stop and report blocked). Put one task in each run, and dispatch unrelated work separately.
2. Run it with Bash `run_in_background: true`:

   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/codex-run.mjs --role <role> -C <workdir> <task file>
   ```

   - **Roles** set the responsibilities and the default model, effort and sandbox. `--roles` lists them; roles in `$CODEX_HOME/agents/` shadow the bundled examples. If the task is clearly lighter or harder than the role's default, override with `-m`/`-e` (pick from `--models`). If results are weak, first tighten the task (definition of done, verification), then start a new thread with higher effort.
   - **Without a fitting role**, pass only `-m`/`-e`. The task file then has to state the definition of done and the report format (first line complete / partial / blocked).
   - **Timeout**: 5400 s by default; change it with `-t`.
   - **Sandbox**: `-s` wins, then the role's `sandbox_mode`. Without either, a new thread gets Codex's own config default, and `--resume` keeps the thread's current sandbox. If the daemon reports a wider sandbox than codex-run recorded for that thread (a thread reloaded from disk falls back to the config default), the recorded one is reapplied; a narrower one is never widened. `--answer`/`--attach` do not take `-s`, because the waiting turn keeps its sandbox. Approvals are always off (`approvalPolicy=never`), so a command that needs to leave a restricted sandbox fails with "Approval requests were disabled". Choose a sandbox wide enough for the task rather than expecting escalation. Under `read-only`, shell commands cannot write anywhere, not even `/tmp`. Under `workspace-write`, only the `-C` dir and `/tmp` are writable, `.git` is read-only (no commits), and the network, localhost included, is off unless the user enabled `network_access`. Pass `-s danger-full-access` when the task must install dependencies, start a local server, use caches in the home directory, or commit. Codex's built-in web search works in every sandbox. Outside `danger-full-access`, MCP tool calls fail with "MCP tool call requires approval" (Codex has no global switch for this), and skills that run scripts get the shell limits. A task that needs MCP tools, such skills or the network gets `-s danger-full-access` (or a role that has it); state any read-only requirement in the task file instead.
   - **Subagents**: Codex's own subagents are off by default because orchestration is yours. Add `--allow-subagents` only when the task really needs Codex to split it. If `turn/completed` is overdue (a final answer exists, all subagents ended, 5 s of quiet), the script reads the turn's status back from the daemon. A finished turn or an idle thread ends the run with an `inferred=` line; a turn still active keeps being followed.
   - **Structured results**: `--schema <JSON Schema file>` sets the turn's `outputSchema` and validates the final message locally. A message that is not JSON or does not match gives `status=failed`, and the schema's fields replace the first-line convention. For independent verification, use `${CLAUDE_SKILL_DIR}/schemas/check.json`. The schema is bound to the turn: after a question, answering with `--answer` keeps the same turn and the same schema, so do not re-run with `--resume` just to get structured output.
   - `--json` prints one JSON object instead of `key=value` lines.
3. **Do not poll.** When the completion notification arrives, read `status`, `session`, `model`, `sandbox` and `report`, then read the whole report (first line complete / partial / blocked, or the schema's `status` field).
   - `model` and `sandbox` are what the run actually used. If they differ from what you expected, find out why before trusting the result.
   - `commands=` points to the commands Codex reported (exit code, cwd, including subagents). Commands Codex runs through its code-mode `exec` tool are not reported there.
   - `--- changed files ---` lists files written through apply_patch only. Treat `git status` / diff as the real scope of changes.
   - Use these to check the report's claims about checks run and file ownership.
   - **partial / blocked** means there are open issues: if information is missing, provide it and resume; if it is a design decision, decide it yourself and resume; if it is outside the delegated scope, take it over or ask the user.
4. **`status=question`**: Codex asked something (an async question, or a blocking `request_user_input`). The turn is still waiting on the daemon; the client exited and printed the questions with their options. Options marked "free-form answer allowed" may be answered outside the list.
   - **You answer it, not the user**: decide whatever the task, docs, code or earlier decisions settle. Questions that belong to the user (product trade-offs, scope, irreversible effects) go to the user first. If the question points out a conflict between the task file and the docs, check which one is right and fix the task file.
   - **Sending the answer**: write the answer to a file and run the printed `--- answer ---` command in the background: `codex-run --answer <question thread> --role <same role> -C <same dir> [--schema <same schema>] <answer file>`.
     - If a subagent asked, the question thread is the subagent's (`question_thread=`); the run still follows the root turn and reports on `session`.
     - Write the answer itself (an option's label for a choice).
     - When several questions with ids are listed, write JSON `{"<question id>": "answer"}`. A malformed answer gives `status=failed` while Codex keeps waiting; fix the file and `--answer` again.
5. **Any other non-`ok` status**: diagnose from the printed error and `<job>/stderr.log` before re-dispatching; do not retry blindly. `disconnected` means the daemon connection dropped (for example a daemon update). The thread is kept, so continue it with `--resume`.
6. **Model at capacity**: the script handles `Selected model is at capacity` itself. After Codex's own retries inside the turn run out, the script backs off (60→300 s) and continues on the same thread and model until the timeout, noting each retry on stderr. Do not switch models or threads for this. If it is still at capacity at the timeout, `--resume` later with the same input.
7. **Job directories** are under `$CODEX_RUN_HOME/jobs` (default `~/.local/state/codex-run/jobs`). Finished jobs older than 7 days are pruned automatically. You may delete a job directory once you are done with it; leave other jobs alone, since they may belong to other sessions.

## Watching and stopping

- `--ps` lists threads with a turn in progress on the daemon (model, directory, parent for subagents). Use it as the truth for how many tasks are running.
- **Stop**: TaskStop on the background Bash is enough. On SIGTERM the script interrupts the turn on the daemon, including a turn whose start request was still in flight, and prints `status=interrupted`. If the client is already gone (killed, or left over from another session), use `--stop <thread>`. Ending only the client does not stop the turn.
- **Re-attach**: if the client exited while the turn is still running, run `--attach <thread> -C <same dir>` in the background. It sends no input and does not interrupt, and if the final answer was produced before you attached, it is read back. To replace a running client, `kill -KILL <old client pid>` first (SIGKILL skips the interrupt handler, so the turn is unaffected); do not use TaskStop for this.

## Parallel runs

- Several background calls in one message run in parallel. Their file ownership must not overlap. When changes would cross, give each task its own git worktree as `-C` and merge them yourself.
- Tell each task that other collaborators exist and must not have their changes reverted, and assign shared resources (ports, databases, whether dependencies may be installed).

## Resuming

By default every task gets a new thread. Resume only when the next turn depends on **the same task's** context in that thread: filling in what a partial / blocked report lacked, re-checking counterexamples it reported, discussing a disagreement about its result, or continuing after `disconnected` or a capacity timeout.

Start a new thread, and hand over the needed conclusions in the task file, when:
- it is a new task or goal (even with the same directory and role)
- the direction changed
- you need a different model or effort
- the thread has many turns whose history would bias a new judgment
- you need a judgment independent of earlier conclusions

When unsure, start a new thread.

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-run.mjs --resume <thread> --role <same role> -C <same dir> <follow-up file>
```

Resume by thread id (parallel runs make "last thread" ambiguous). The follow-up file holds only the new instructions.

A resumed thread keeps its model and effort and does not accept `-m`/`-e`. `--role` contributes its instructions and sandbox, never its default model. To switch models, start a new thread and hand over the earlier conclusions and open questions.

## Review

```bash
node ${CLAUDE_SKILL_DIR}/scripts/codex-run.mjs --review [--base <branch> | --commit <sha>] -C <repo> [focus file]
```

Runs Codex's built-in read-only review of git changes; uncommitted changes (including untracked files) by default. The optional focus file names the risks to look at. `--review` takes no `--role`, `--resume`, `-s` or `--schema`.

## Treating results

Codex is a colleague, not an authority. Treat the report as leads. Read the diff and confirm the behavior on the real entry point before delivering. Settle disagreements by resuming the thread: say you are Claude, which model you are, and give evidence. If you still disagree, hand it to the user.
