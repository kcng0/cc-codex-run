# codex-run — agent notes

- Edit `src/`, never the generated `plugin/skills/codex/scripts/codex-run.mjs`; run `npm test` (rebuilds it) and commit the rebuilt bundle.
- `npm run check:bundle` must pass; `claude plugin validate .` must pass after manifest changes.
- Protocol facts come from `codex app-server generate-json-schema`, not memory; bump `MIN_APP_SERVER` (`src/env.mjs`) when relying on newer fields.
- Bug fixes in `src/run.mjs` get a regression test in `test/run.test.mjs` using the fake app-server in `test/harness.mjs`.
- User-facing behavior changes update `plugin/skills/codex/SKILL.md`, both READMEs and `CHANGELOG.md` in the same change.
- Layout, build, release: `CONTRIBUTING.md`.
