// codex-run: run Codex tasks on the local Codex app-server daemon (threads stay visible in the Codex app).
// Runs in the foreground until the turn ends (callers get parallelism from background shells) and prints
// status/job/session/report. See HELP for usage.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Ajv from "ajv";
import { UsageError, ensureDaemon } from "./env.mjs";
import { ConnectionClosed, RpcError, control, listAll } from "./rpc.mjs";
import { SANDBOX_MODES, listRoles, loadRole } from "./roles.mjs";
import { run } from "./run.mjs";
import { installSignalHandlers } from "./signals.mjs";

// Replaced at build time with the package version
const VERSION = typeof __CODEX_RUN_VERSION__ === "string" ? __CODEX_RUN_VERSION__ : "dev";

const HELP = `usage: codex-run [--role ROLE] [-m MODEL] [-e EFFORT] [-s SANDBOX] [-t SECONDS] [--allow-subagents]
                 -C DIR [--schema FILE] [--json] TASK_FILE
       codex-run --resume THREAD -C DIR [--role ROLE] [-s SANDBOX] [--schema FILE] FOLLOW_UP_FILE
       codex-run --answer THREAD -C DIR [--role ROLE] [--schema FILE] ANSWER_FILE
       codex-run --attach THREAD -C DIR
       codex-run --review [--base BRANCH | --commit SHA] -C DIR [FOCUS_FILE]
       codex-run --models | --roles | --ps | --stop THREAD | --version | -h
       codex-run --install-skills [DIR] [--force]

Runs one Codex turn on the local app-server daemon and follows it to the end, then prints
status/job/session/report (or one JSON object with --json).

options:
  --role ROLE           role file: $CODEX_HOME/agents/ROLE.toml, else the bundled roles/ROLE.toml
                        (model, model_reasoning_effort, sandbox_mode, developer_instructions)
  -m, --model MODEL     override the role's model (new threads only)
  -e, --effort EFFORT   override the role's reasoning effort (new threads only)
  -s, --sandbox MODE    ${SANDBOX_MODES.join(" | ")}; overrides the role's sandbox_mode.
                        Without either, Codex's own config (or the resumed thread) decides
  -t, --timeout SECONDS interrupt the turn after this long (default 5400)
  --allow-subagents     let Codex spawn its own subagents (off by default)
  -C, --cd DIR          working directory
  --schema FILE         JSON Schema for the final message (turn outputSchema, validated locally too)
  --json                print one JSON object instead of key=value lines
  --resume THREAD       continue an existing thread with a new turn
  --answer THREAD       reply to status=question; THREAD is the question thread printed in that output
  --attach THREAD       follow the turn in progress on THREAD again without sending input
  --review              read-only built-in review, uncommitted changes by default
  --base BRANCH         review against a branch
  --commit SHA          review one commit
  --models              list models and their reasoning efforts
  --roles               list roles (user roles shadow bundled ones)
  --ps                  list threads with a turn in progress on the daemon
  --stop THREAD         interrupt the turn in progress on THREAD
  --version             print the codex-run version
  --install-skills [DIR]  copy the codex and codex-delegate skills into DIR (default ~/.claude/skills);
                        --force moves existing skills of the same name aside as <name>.bak-<timestamp>

environment:
  CODEX_HOME            Codex home (default ~/.codex)
  CODEX_RUN_HOME        job directory root (default $XDG_STATE_HOME/codex-run or ~/.local/state/codex-run)
  CODEX_RUN_JOB_TTL_DAYS  finished jobs older than this are pruned at start (default 7, 0 disables)
`;

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
        role: { type: "string" },
        model: { type: "string", short: "m" },
        effort: { type: "string", short: "e" },
        sandbox: { type: "string", short: "s" },
        timeout: { type: "string", short: "t" },
        "allow-subagents": { type: "boolean" },
        cd: { type: "string", short: "C" },
        schema: { type: "string" },
        json: { type: "boolean" },
        resume: { type: "string" },
        attach: { type: "string" },
        answer: { type: "string" },
        review: { type: "boolean" },
        base: { type: "string" },
        commit: { type: "string" },
        models: { type: "boolean" },
        roles: { type: "boolean" },
        ps: { type: "boolean" },
        stop: { type: "string" },
        "install-skills": { type: "boolean" },
        force: { type: "boolean" },
      },
    });
  } catch (e) {
    throw new UsageError(`${e.message} (see -h)`);
  }
  const o = parsed.values;
  if (parsed.positionals.length > 1) throw new UsageError(`unexpected arguments: ${parsed.positionals.slice(1).join(" ")}`);
  const a = {
    role: o.role, model: o.model, effort: o.effort, sandbox: o.sandbox, allowSubagents: Boolean(o["allow-subagents"]),
    dir: o.cd, schema: o.schema, json: Boolean(o.json), resume: o.resume, attach: o.attach, answer: o.answer,
    review: Boolean(o.review), base: o.base, commit: o.commit, task: parsed.positionals[0], timeout: 5400,
  };
  if (a.sandbox !== undefined && !SANDBOX_MODES.includes(a.sandbox)) throw new UsageError(`-s must be one of ${SANDBOX_MODES.join(" / ")}`);
  if (o.timeout !== undefined) {
    if (!/^\d+$/.test(o.timeout) || parseInt(o.timeout, 10) <= 0) throw new UsageError(`-t needs a positive number of seconds: ${o.timeout}`);
    a.timeout = parseInt(o.timeout, 10);
  }
  return { a, o };
}

function validateRun(a) {
  if (!a.dir || !fs.existsSync(a.dir) || !fs.statSync(a.dir).isDirectory()) {
    throw new UsageError(`-C is missing or not a directory: ${a.dir === undefined ? "(none)" : a.dir}`);
  }
  a.dir = path.resolve(a.dir);
  if (a.task && !(fs.existsSync(a.task) && fs.statSync(a.task).isFile())) throw new UsageError(`task file not found: ${a.task}`);
  if (a.attach) {
    if (a.answer || a.resume || a.review || a.task) throw new UsageError("--attach takes only a thread id: no task file, --answer, --resume or --review");
    a.answer = a.attach;
  }
  if (!a.task && !a.review && !a.attach) throw new UsageError("missing task file");
  if (a.review && (a.resume || a.sandbox || a.role)) throw new UsageError("--review does not take --resume, -s or --role");
  if ((a.base || a.commit) && !a.review) throw new UsageError("--base/--commit only apply to --review");
  if (a.base && a.commit) throw new UsageError("--base and --commit are mutually exclusive");
  if (a.answer && (a.resume || a.review)) throw new UsageError("--answer cannot be combined with --resume/--review");
  if (a.answer && a.sandbox) {
    throw new UsageError("--answer/--attach do not take -s: the waiting turn keeps the sandbox it started with");
  }
  if ((a.resume || a.answer) && (a.model || a.effort)) {
    throw new UsageError("--resume/--answer keep the thread's model and effort and do not take -m/-e; start a new thread to switch models");
  }
  if (a.schema && a.review) throw new UsageError("--schema does not apply to --review (review/start has no outputSchema)");
}

function loadSchema(file) {
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`--schema: cannot read ${file}: ${e.message}`);
  }
  try {
    const ajv = new Ajv({ strict: false, allErrors: true });
    const check = ajv.compile(schema);
    // Returns null when the value matches, else a readable list of violations
    return { schema, validate: (v) => (check(v) ? null : ajv.errorsText(check.errors)) };
  } catch (e) {
    throw new UsageError(`--schema: ${file} is not a valid JSON Schema: ${e.message}`);
  }
}

const show = (v) => (v === null || v === undefined ? "-" : String(v));

function formatText(r) {
  const out = [`status=${r.status}`, `job=${r.job}`, `session=${r.session}`, `model=${show(r.model)} ${show(r.effort)}`,
    `sandbox=${show(r.sandbox)}`, `report=${r.report}`];
  if (r.commands) {
    out.push(r.commands.count ? `commands=${r.commands.file} (${r.commands.count}, ${r.commands.failed} non-zero or unfinished)` : "commands=0");
  }
  if (r.inferred) {
    out.push(`inferred=turn/completed not received; read back from the daemon: turn ${r.inferred.turnStatus}, thread ${r.inferred.threadStatus}`);
  }
  for (const title of r.answered) out.push(`answered=${Array.from(title).slice(0, 200).join("")}`);
  if (r.notSent) {
    out.push(`not_sent=no question is waiting on ${r.notSent.thread}; the answer file was not sent; the turn was followed as with --attach, or read back if it had finished`);
    if (r.notSent.reply !== null) out.push(`prior_reply=${Array.from(r.notSent.reply.replace(/\s+/g, " ").trim()).slice(0, 200).join("")}`);
  }
  if (r.touched.length) out.push(`--- changed files (${r.touched.length}) ---`, ...r.touched);
  if (r.status === "question") {
    if (r.questionThread) out.push(`question_thread=${r.questionThread} (asked by a subagent)`);
    const multi = r.questions.length > 1 && r.questions.every((q) => q.id);
    r.questions.forEach((q, k) => {
      out.push(`--- question ${k + 1}${multi ? ` (id: ${q.id})` : ""} ---`, q.title || "");
      for (const opt of q.options || []) out.push(`  - ${typeof opt === "string" ? opt : JSON.stringify(opt)}`);
      if (q.allowOther) out.push("  - (free-form answer allowed)");
    });
    out.push("--- answer ---", r.answerCommand);
    if (multi) out.push(`answer file as JSON: {${r.questions.map((q) => `"${q.id}": "answer"`).join(", ")}}`);
  } else if (r.status !== "ok") {
    out.push("--- error ---", r.error);
  }
  return out.join("\n");
}

async function listModels() {
  const { sock } = ensureDaemon();
  const models = await control(sock, VERSION, (cl) => listAll(cl, "model/list", {}));
  for (const m of models.filter((x) => !x.hidden)) {
    const efforts = (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort).join(" ");
    console.log(m.id, "|", efforts, "|", m.description ?? "");
  }
}

async function listRunning() {
  const { sock } = ensureDaemon();
  const rows = await control(sock, VERSION, async (cl) => {
    const ids = await listAll(cl, "thread/loaded/list", {});
    const threads = [];
    for (const id of ids) threads.push((await cl.call("thread/read", { threadId: typeof id === "string" ? id : id.id, includeTurns: false })).thread);
    return threads.filter((t) => t.status?.type === "active");
  });
  for (const t of rows) {
    const parent = t.parentThreadId ? ` (subagent of ${t.parentThreadId})` : "";
    console.log(t.id, "|", show(t.model), show(t.reasoningEffort), "|", show(t.cwd), "|", Array.from(t.name || "").slice(0, 70).join("") + parent);
  }
  if (!rows.length) console.log("no thread has a turn in progress");
}

async function stopThread(tid) {
  const { sock } = ensureDaemon();
  const ids = await control(sock, VERSION, async (cl) => {
    const turns = (await cl.call("thread/read", { threadId: tid, includeTurns: true })).thread.turns || [];
    const live = turns.filter((t) => t.status === "inProgress").map((t) => t.id);
    for (const turnId of live) await cl.call("turn/interrupt", { threadId: tid, turnId });
    return live;
  });
  console.log(ids.length ? `interrupted ${ids.length} turn(s) on ${tid}` : `no turn in progress on ${tid}`);
}

// The bundled script lives in <skills>/codex/scripts/, so the shipped skills are two levels up
function installSkills(dest, force) {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const target = path.resolve(dest || path.join(os.homedir(), ".claude", "skills"));
  const names = ["codex", "codex-delegate"].filter((n) => fs.existsSync(path.join(src, n, "SKILL.md")));
  if (names.length !== 2) throw new UsageError(`bundled skills not found next to this script (${src})`);
  const clashes = names.filter((n) => fs.existsSync(path.join(target, n)));
  if (clashes.length && !force) {
    throw new UsageError(`already exists in ${target}: ${clashes.join(", ")} (re-run with --force to move them aside)`);
  }
  // Compare real paths: the target (or a skill in it) may be a symlink to this copy, e.g. /var -> /private/var on macOS
  const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
  if (names.some((n) => real(path.join(src, n)) === real(path.join(target, n)))) {
    throw new UsageError(`${target} is where this script is installed; run --install-skills from another copy`);
  }
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  // Copy next to the destination first, so a failed copy never leaves the existing install moved away
  const staged = names.map((n) => {
    const tmp = path.join(target, `.${n}.installing-${process.pid}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(path.join(src, n), tmp, { recursive: true });
    return [n, tmp];
  });
  for (const [n, tmp] of staged) {
    const to = path.join(target, n);
    if (fs.existsSync(to)) {
      fs.renameSync(to, `${to}.bak-${stamp}`);
      console.log(`moved existing ${to} to ${to}.bak-${stamp}`);
    }
    fs.renameSync(tmp, to);
    console.log(`installed ${to}`);
  }
}

export async function main(argv) {
  const { a, o } = parseCli(argv);
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { console.log(VERSION); return 0; }
  if (o.roles) {
    for (const r of listRoles()) {
      console.log(r.name, "|", r.model ?? "(config)", r.model_reasoning_effort ?? "", "|", r.sandbox_mode ?? "(config)", "|",
        (r.description ?? "") + (r.bundled ? " [bundled]" : ""));
    }
    return 0;
  }
  if (o["install-skills"]) { installSkills(a.task, Boolean(o.force)); return 0; }
  if (o.models) { await listModels(); return 0; }
  if (o.ps) { await listRunning(); return 0; }
  if (o.stop) { await stopThread(o.stop); return 0; }
  validateRun(a);
  const role = a.role !== undefined ? loadRole(a.role) : null;
  const { schema = null, validate = null } = a.schema ? loadSchema(a.schema) : {};
  installSignalHandlers();
  const r = await run(a, { role, schema, validate, version: VERSION });
  process.stdout.write((a.json ? JSON.stringify(r) : formatText(r)) + "\n");
  return r.status === "ok" || r.status === "question" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.stdout.write("", () => process.exit(code)),
  (e) => {
    const known = e instanceof UsageError || e instanceof RpcError || e instanceof ConnectionClosed || e?.code;
    process.stderr.write(`codex-run: ${known ? e.message : (e?.stack || e)}\n`);
    process.exit(e?.exitCode ?? 1);
  },
);
