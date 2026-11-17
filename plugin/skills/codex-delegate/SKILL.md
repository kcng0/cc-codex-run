---
name: codex-delegate
description: Policy for handing implementation, independent verification and pre-commit review to Codex — what each task must contain and how to weigh what comes back. Use before dispatching any of these to Codex, including when the user has already asked for it, and when deciding whether a piece of work should go to Codex.
---

# Handing work to Codex

All three cases dispatch through the `codex` skill.

## Scope

By default Codex takes:

- **Implementation of self-contained modules whose interface contract is already fixed**, typically backend modules (routes, services, data access, CLIs). Work whose correctness depends on look and feel, such as UI, stays with you.
- **Independent verification** and **pre-commit review**.

The user's or project's instructions override this scope. When they widen it (for example, "Codex may do frontend work") or narrow it, follow them.

## Implementation

1. Before dispatching, write these into the task file:
   - the interface contract (routes, signatures, data shapes, error semantics)
   - file ownership
   - the real entry point that exercises the module
   - shared resources: ports, databases, whether dependencies may be installed

   If you cannot fill these in, do the work yourself or ask the user.
2. Use the `implement` role. Dispatch independent modules in parallel in one message, and keep working on other independent things.
3. When results come back, read the diff, trigger the real entry point once yourself, then integrate.

## Independent verification

Use it when the user asks, or when the change is high-risk: schema or data migrations, authentication or permission checks, money or billing calculations, concurrency/locking/idempotency, or incompatible changes to an external API. Ordinary changes do not need it.

1. Write into the task file:
   - the working directory
   - the scope of the change (files or diff)
   - the expected behavior
   - the real entry point, and what the verifier may use to trigger it: a sandbox wide enough, the database, ports, starting a server

   Fill in anything missing before dispatching. Describe the change by its contract and expected behavior. Leave out the author's report and reasoning, any claim that it already passes, and your own verdict, so the verifier forms its own view.
2. Pick the verifier by who wrote the change. Independence comes mostly from a fresh context and from exercising the real entry point against expected values sourced outside the code. A verifier from a different provider than the author shares fewer blind spots; another model from the same provider adds little.
   - **Claude wrote it** (you or your subagents): use Codex's `check` role on its default model, with `--schema <codex skill dir>/schemas/check.json` (the schema the `codex` skill ships), so the result comes back as structured counterexamples.
   - **Codex wrote it**: dispatch a fresh Claude subagent, not a fork, since a fork carries your context. Its prompt is the task file plus the `developer_instructions` from `<codex skill dir>/roles/check.toml`, and it reports the fields of `<codex skill dir>/schemas/check.json`. If you cannot start a subagent, use Codex's `check` role on its default model. A new thread gives an independent view; resuming the author's thread is cheaper and already knows the code but carries the author's reasoning and blind spots. The more the change depends on independent judgement, the more a new thread is worth.
3. Weigh each counterexample before acting on it. A concrete input, an `expected_source` outside the code under test and an obvious fix are enough: just fix it. Check it yourself first when something looks off: the expected value is inferred rather than sourced, the input is not reachable from the real entry point, it contradicts what you know about the code, or the fix would change a contract or design. If it does not hold, take your evidence back to the verifier (for Codex, the `codex` skill's "Treating results").
4. A clean result is only as strong as its `coverage`. If `not_covered` includes the risky part of the change, extend the verification or tell the user.
5. After fixing, continue the same verifier to re-verify: the Codex thread by id, or the same subagent. If counterexamples are still open after two rounds, hand them to the user.

## Pre-commit review

1. Run it when the user asks, or before committing or merging a batch of non-trivial changes. Use the `codex` skill's Review section: the default for uncommitted changes, `--base <branch>` for a branch. Put known risk areas in the focus file.
2. Review is read-only and runs no code. To find counterexamples by actually exercising the change, use independent verification instead.
3. Go through each finding: fix the ones that clearly hold, check doubtful ones against the code before deciding, and tell the user which you dismissed and why.
