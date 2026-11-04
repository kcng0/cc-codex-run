# Contributing

## Layout

| Path | What |
|---|---|
| `src/` | CLI source (`cli.mjs` entry, `run.mjs` turn state machine, `rpc.mjs` WebSocket JSON-RPC, `roles.mjs`, `jobs.mjs`, `env.mjs`, `turns.mjs`) |
| `plugin/` | the Claude Code plugin: `.claude-plugin/plugin.json`, `skills/codex`, `skills/codex-delegate` |
| `plugin/skills/codex/scripts/codex-run.mjs` | **generated** single-file bundle of `src/` (committed: plugin installs have no build step; also the npm `bin`) |
| `plugin/skills/codex/scripts/THIRD_PARTY_LICENSES.md` | **generated** with the bundle: licenses of the npm packages it contains |
| `.claude-plugin/marketplace.json` | marketplace manifest pointing at `./plugin` |
| `test/` | `node:test` suites; `harness.mjs` runs the built script against a scripted fake app-server, and `fixtures/codex` is a fake Codex CLI |

## Build and test

```bash
npm ci
npm test                # builds the bundle, then runs test/*.test.mjs
npm run check:bundle    # fails if the committed bundle or plugin.json differs from a fresh build
claude plugin validate .
```

Commit the rebuilt bundle with every change to `src/`.

Runtime dependencies (`ws`, `smol-toml`, `ajv`) are bundled, so they are `devDependencies`. The published package has no dependencies.

## Protocol

The app-server protocol for the installed Codex version can be dumped with:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
```

When you rely on a new method or field, check it against that schema and raise `MIN_APP_SERVER` in `src/env.mjs` if older versions lack it.

`codex app-server proxy` only relays raw bytes to the same WebSocket socket, so it does not replace the WebSocket client.

## Release

1. Bump `version` in `package.json` and run `npm run build`; the build syncs `plugin/.claude-plugin/plugin.json`.
2. Update `CHANGELOG.md`.
3. Run `npm test`, `npm run check:bundle` and `claude plugin validate .`.
4. Commit, tag `vX.Y.Z`, and push the commit and the tag. Plugin users get the update through `/plugin update` because the plugin version changed.
5. Pushing the tag runs `.github/workflows/publish.yml`, which checks that the tag matches `package.json`, runs the tests and publishes to npm through trusted publishing (no npm token in the repository). To publish an existing tag again, run the workflow manually with that tag.
6. Create the GitHub release from that version's CHANGELOG section: `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>`.
