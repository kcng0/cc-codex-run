// Per-run job directories (task, events, report, commands) and age-based pruning.
import fs from "node:fs";
import path from "node:path";
import { UsageError, runHome } from "./env.mjs";

const DAY_MS = 86_400_000;
const PIN_TTL_DAYS = 90;
const jobsRoot = () => path.resolve(runHome(), "jobs");
const pinsRoot = () => path.resolve(runHome(), "threads");
const pinFile = (tid) => path.join(pinsRoot(), `${tid.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);

// The sandbox each thread last ran with, so a resume after the daemon reloaded the thread does not widen it
export function rememberSandbox(tid, sandbox) {
  fs.mkdirSync(pinsRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pinFile(tid), JSON.stringify({ sandbox }));
}

export function recallSandbox(tid) {
  try {
    return JSON.parse(fs.readFileSync(pinFile(tid), "utf8")).sandbox || null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function createJob() {
  fs.mkdirSync(jobsRoot(), { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(jobsRoot(), "job-"));
}

// A job given as printed (a path) or by its directory name
export function resolveJob(arg) {
  const dir = arg.includes("/") ? path.resolve(arg) : path.join(jobsRoot(), arg);
  if (!fs.existsSync(path.join(dir, "meta.json"))) throw new UsageError(`not a codex-run job directory: ${arg}`);
  return dir;
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

// Blocks until the job's client has written result.json, its client died without one, or seconds elapse.
// Only reads the job directory: never touches the turn on the daemon.
export async function waitJob(job, seconds, pollMs = 1000) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = readJson(path.join(job, "result.json"));
    if (result) return { result };
    const meta = readJson(path.join(job, "meta.json")) || {};
    if (meta.pid && !alive(meta.pid)) {
      // The client may have written result.json between the two reads
      const late = readJson(path.join(job, "result.json"));
      return late ? { result: late } : { orphaned: meta };
    }
    if (Date.now() >= deadline) return { running: meta };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Removes finished jobs older than CODEX_RUN_JOB_TTL_DAYS (default 7, 0 disables); jobs whose client is still alive
// and jobs holding a file this run reads (keep) are kept
export function pruneJobs({ keep = [], now = Date.now() } = {}) {
  if (fs.existsSync(pinsRoot())) {
    for (const name of fs.readdirSync(pinsRoot())) {
      const f = path.join(pinsRoot(), name);
      try {
        if (now - fs.statSync(f).mtimeMs > PIN_TTL_DAYS * DAY_MS) fs.rmSync(f, { force: true });
      } catch (e) {
        process.stderr.write(`codex-run: could not prune ${f}: ${e.message}\n`);
      }
    }
  }
  const ttl = Number(process.env.CODEX_RUN_JOB_TTL_DAYS ?? 7);
  if (!(ttl > 0) || !fs.existsSync(jobsRoot())) return;
  for (const name of fs.readdirSync(jobsRoot())) {
    if (!name.startsWith("job-")) continue;
    const dir = path.join(jobsRoot(), name);
    try {
      // keep holds real paths; compare against the job's real path so relative homes and symlinks match
      const real = fs.realpathSync(dir);
      if (keep.some((f) => f === real || f.startsWith(real + path.sep))) continue;
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
      } catch {}
      const last = meta.ended ? meta.ended * 1000 : fs.statSync(dir).mtimeMs;
      if (now - last < ttl * DAY_MS) continue;
      if (!meta.ended && meta.pid && alive(meta.pid)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      process.stderr.write(`codex-run: could not prune ${dir}: ${e.message}\n`);
    }
  }
}
