// Paths, Codex daemon discovery and version gate.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

export const EX_USAGE = 64, EX_UNAVAILABLE = 69, EX_CONFIG = 78;
// Oldest app-server whose protocol this client is written against (daemon, subAgentActivity, turn/steer, outputSchema)
export const MIN_APP_SERVER = "0.164.0";

export class UsageError extends Error {
  constructor(msg, code = EX_USAGE) { super(msg); this.exitCode = code; }
}

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// [sandbox_workspace_write] from $CODEX_HOME/config.toml as protocol fields. An explicit workspaceWrite sandboxPolicy
// on turn/start replaces the config's values, so they are carried over (network access, extra writable roots, /tmp)
const WORKSPACE_WRITE_KEYS = {
  network_access: "networkAccess", writable_roots: "writableRoots",
  exclude_tmpdir_env_var: "excludeTmpdirEnvVar", exclude_slash_tmp: "excludeSlashTmp",
};
export function workspaceWriteConfig() {
  const f = path.join(codexHome(), "config.toml");
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  let cfg;
  try {
    cfg = parse(text);
  } catch (e) {
    throw new UsageError(`${f}: ${e.message}`, EX_CONFIG);
  }
  const out = {};
  for (const [k, v] of Object.entries(cfg.sandbox_workspace_write || {})) if (k in WORKSPACE_WRITE_KEYS) out[WORKSPACE_WRITE_KEYS[k]] = v;
  return out;
}

// Job directories live under CODEX_RUN_HOME (default $XDG_STATE_HOME/codex-run or ~/.local/state/codex-run)
export function runHome() {
  if (process.env.CODEX_RUN_HOME) return process.env.CODEX_RUN_HOME;
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "codex-run");
}

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function codex(args, timeout) {
  const r = spawnSync("codex", args, { encoding: "utf8", timeout });
  if (r.error?.code === "ENOENT") {
    throw new UsageError("Codex CLI not found on PATH. Install it (npm i -g @openai/codex) and sign in with `codex login`.", EX_UNAVAILABLE);
  }
  return r;
}

// Starts the daemon if needed and returns its control socket; refuses app-servers older than MIN_APP_SERVER
export function ensureDaemon() {
  if (process.platform === "win32") {
    throw new UsageError("codex-run needs the Codex app-server daemon on a Unix domain socket; Windows is not supported (use WSL).", EX_UNAVAILABLE);
  }
  // `daemon start` is a no-op when already running; `daemon version` is the source of truth
  codex(["app-server", "daemon", "start"], 120_000);
  const r = codex(["app-server", "daemon", "version"], 60_000);
  let info = {};
  try {
    info = JSON.parse(r.stdout);
  } catch {}
  if (info?.status !== "running" || !info.socketPath) {
    const log = path.join(codexHome(), "app-server-control", "app-server.log");
    const tail = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trimEnd().split("\n").slice(-15) : [];
    throw new UsageError("Codex app-server daemon is not running.\n" +
      `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() +
      (tail.length ? `\n--- ${log} (tail) ---\n${tail.join("\n")}` : ""), EX_UNAVAILABLE);
  }
  const version = info.appServerVersion || info.cliVersion;
  if (!version || compareVersions(version, MIN_APP_SERVER) < 0) {
    throw new UsageError(`Codex app-server ${version || "(unknown version)"} is older than the required ${MIN_APP_SERVER}. ` +
      "Upgrade the Codex CLI, then run `codex app-server daemon update`.", EX_UNAVAILABLE);
  }
  return { sock: info.socketPath, version };
}
