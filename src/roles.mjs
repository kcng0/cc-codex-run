// Roles: Codex agent TOML files from $CODEX_HOME/agents, falling back to the examples bundled with the skill.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { codexHome, EX_CONFIG, UsageError } from "./env.mjs";

export const SANDBOX_MODES = ["danger-full-access", "workspace-write", "read-only"];

// The bundled script sits in <skill>/scripts/, roles in <skill>/roles/
const bundledDir = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "roles");
const userDir = () => path.join(codexHome(), "agents");

function readRole(file) {
  let c;
  try {
    c = parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`${file}: ${e.message}`, EX_CONFIG);
  }
  for (const k of ["model", "model_reasoning_effort", "sandbox_mode", "developer_instructions", "description"]) {
    if (c[k] !== undefined && typeof c[k] !== "string") throw new UsageError(`${file}: ${k} must be a string`, EX_CONFIG);
  }
  if (c.sandbox_mode !== undefined && !SANDBOX_MODES.includes(c.sandbox_mode)) {
    throw new UsageError(`${file}: sandbox_mode must be one of ${SANDBOX_MODES.join(" / ")}`, EX_CONFIG);
  }
  return { file, ...c };
}

export function loadRole(name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new UsageError(`invalid role name: ${name}`);
  for (const dir of [userDir(), bundledDir()]) {
    const f = path.join(dir, `${name}.toml`);
    if (fs.existsSync(f)) return readRole(f);
  }
  throw new UsageError(`role not found: ${name} (looked in ${userDir()} and ${bundledDir()}; --roles lists them)`);
}

// User roles shadow bundled roles of the same name
export function listRoles() {
  const seen = new Map();
  for (const [dir, bundled] of [[userDir(), false], [bundledDir(), true]]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".toml")).sort()) {
      const name = f.slice(0, -5);
      if (!seen.has(name)) seen.set(name, { ...readRole(path.join(dir, f)), name, bundled });
    }
  }
  return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
}
