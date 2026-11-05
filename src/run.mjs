// One codex-run invocation: start/resume/answer/attach/review a turn on the daemon and follow it to the end.
import fs from "node:fs";
import path from "node:path";
import { ensureDaemon, workspaceWriteConfig } from "./env.mjs";
import { createJob, pruneJobs, recallSandbox, rememberSandbox } from "./jobs.mjs";
import { ConnectionClosed, RpcError, TimeoutError, USER_INPUT, connect, control } from "./rpc.mjs";
import { Stopped, currentStop, sleep } from "./signals.mjs";
import {
  AnswerError, eventTurnId, lastQuestion, reportFromTurn, reviewTarget, userInputAnswers, userInputQuestions, userMessageText,
} from "./turns.mjs";

const SANDBOX_POLICY = {
  "danger-full-access": { type: "dangerFullAccess" },
  "workspace-write": { type: "workspaceWrite" },
  "read-only": { type: "readOnly" },
};
const SANDBOX_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
const SANDBOX_MODE = Object.fromEntries(Object.entries(SANDBOX_POLICY).map(([mode, p]) => [p.type, mode]));
// Codex retries overloads inside the turn; once those are exhausted the turn fails and is continued on the same thread
const OVERLOADED = new Set(["serverOverloaded", "server_overloaded"]);
const RETRY_BACKOFF = [60, 120, 240, 300];
const RESUME_AFTER_OVERLOAD = "(codex-run) The previous turn stopped because the model was at capacity. Continue the original task from where it stopped and finish with the report it asked for.";
// Older daemons sometimes never sent turn/completed for a parent turn with subagents. Once a final answer exists,
// all subagents ended and the root has been quiet this long, the turn's status is read back from the daemon:
// a finished turn (or an idle thread) ends the run, a still-active one is checked again after the same interval
const COMPLETION_CHECK_MS = 5000;
// After thread/resume the daemon re-sends a pending blocking question; wait this long for it
const USER_INPUT_WAIT_MS = 3000;
const PARENT_DEPTH_LIMIT = 16;
const LIMIT_STATUS = /^(timeout|stalled)\(/;

// POSIX shell quoting for commands printed for the caller to run
const shq = (v) => (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
const cut = (s, n) => Array.from(s).slice(0, n).join("");

// Model/effort/sandbox/instructions from flags and role. Resumed threads keep their model and effort.
// The sandbox from -s or the role applies to every turn; without either, new threads get Codex's config default
// and resumed threads the sandbox codex-run last recorded for them
export function settings(a, role) {
  const resuming = Boolean(a.resume || a.answer);
  return {
    model: a.model || (!resuming && role?.model) || null,
    effort: a.effort || (!resuming && role?.model_reasoning_effort) || null,
    sandbox: a.sandbox || role?.sandbox_mode || null,
    instr: role?.developer_instructions || null,
  };
}

// Walks parentThreadId up to the root thread (subagent questions are answered on their own thread, followed on the root)
async function rootOf(cl, id) {
  let cur = id;
  for (let depth = 0; depth < PARENT_DEPTH_LIMIT; depth++) {
    const t = (await cl.call("thread/read", { threadId: cur, includeTurns: false })).thread;
    if (!t.parentThreadId) return cur;
    cur = t.parentThreadId;
  }
  throw new RpcError(`thread ${id}: parent chain deeper than ${PARENT_DEPTH_LIMIT}`);
}

const allTurns = async (cl, threadId) => (await cl.call("thread/read", { threadId, includeTurns: true })).thread.turns || [];
const inProgress = (t) => t.status === "inProgress";

async function takeUserInputRequest(cl, threadId, turnId, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const k = cl.pending.findIndex((m) => m.method === USER_INPUT && m.params?.threadId === threadId && m.params?.turnId === turnId);
    if (k >= 0) return cl.pending.splice(k, 1)[0];
    if (Date.now() >= deadline) return null;
    try {
      cl.pending.push(await cl.recv(deadline - Date.now()));
    } catch (e) {
      if (e instanceof TimeoutError) return null;
      throw e;
    }
  }
}

export async function run(a, { role, schema, validate, version }) {
  const s = settings(a, role);
  const { sock } = ensureDaemon();
  const text = a.task ? fs.readFileSync(a.task, "utf8") : "";
  pruneJobs({ keep: [a.task, a.schema].filter(Boolean).map((f) => fs.realpathSync(f)) });
  const job = createJob();
  if (a.task) fs.writeFileSync(`${job}/task.md`, text);
  const meta = {
    pid: process.pid, role: a.role ?? null, model: s.model, effort: s.effort, sandbox: s.sandbox, cwd: a.dir,
    mode: a.review ? "review" : a.resume ? "resume" : a.attach ? "attach" : a.answer ? "answer" : "new",
    started: Math.floor(Date.now() / 1000), retries: 0, timeout: a.timeout, idle: a.idle,
  };
  if (a.schema) meta.schema = path.resolve(a.schema);
  const eventsFd = fs.openSync(`${job}/events.jsonl`, "w");
  let tid = "", status = "failed", report = "", err = "";
  let questions = [], questionThread = null;
  let cl = null, turn = null, lastTurnId = null;
  // -t caps the run's wall-clock time; --idle interrupts sooner a turn that has stopped producing events
  const deadline = Date.now() + a.timeout * 1000;
  let lastEvent = { at: Date.now(), method: "(start)" };
  // Threads of this run: the root plus subagent threads it spawned (files and commands are collected from all)
  const threads = new Set();
  const touched = new Set();
  const commands = [];
  const pendingCollab = new Set();
  const activeSubTurns = new Set();
  let finalSeen = false, reviewSeen = false, inferAt = null;

  const follow = (id) => { turn = { id }; lastTurnId = id; lastEvent = { at: Date.now(), method: "(turn followed)" }; };
  // Requests that create a turn wait for their response even after a stop signal, so the turn id is known and
  // the stop handler can interrupt it instead of leaving it running on the daemon
  const startTurn = async (method, params, pick) => {
    follow(pick(await cl.call(method, params, { interruptible: false })));
    if (currentStop()) throw currentStop();
  };
  const limitHit = () => {
    if (Date.now() >= deadline) return "timeout";
    if (Date.now() - lastEvent.at >= a.idle * 1000) return "stalled";
    return null;
  };
  const limitStatus = (hit) => (hit === "timeout" ? `timeout(${a.timeout}s)` : `stalled(${a.idle}s)`);
  const limitError = (hit) => (hit === "timeout"
    ? `wall-clock limit of ${a.timeout}s (-t) reached`
    : `no event from the turn for ${a.idle}s (--idle); last: ${lastEvent.method} at ${new Date(lastEvent.at).toISOString()}`);
  const interrupt = async (hit) => {
    await cl.call("turn/interrupt", { threadId: tid, turnId: turn.id });
    turn = null;
    status = limitStatus(hit);
    err = `${limitError(hit)}; the turn was interrupted and the thread kept (--resume ${tid} to continue)`;
  };
  const asQuestion = (qs, body, threadId) => {
    questions = qs; report = body; status = "question"; questionThread = threadId; turn = null;
  };

  try {
    cl = await connect(sock, eventsFd, true, version);
    const config = { "agents.enabled": a.allowSubagents };
    if (s.effort) config.model_reasoning_effort = s.effort;
    // --answer/--attach may name a subagent thread; the run follows the root thread's turn
    const target = a.resume || a.answer || null;
    if (target) tid = a.answer ? await rootOf(cl, target) : target;
    const common = { cwd: a.dir, approvalPolicy: "never", config };
    if (s.sandbox && !a.answer) common.sandbox = s.sandbox;
    if (s.model) common.model = s.model;
    if (s.instr) common.developerInstructions = s.instr;
    let opened;
    if (target) {
      opened = await cl.call("thread/resume", { threadId: tid, ...common });
      if (target !== tid) await cl.call("thread/resume", { threadId: target });
    } else {
      opened = await cl.call("thread/start", common);
      tid = opened.thread.id;
      const label = a.review ? "review" : (a.role || s.model || "codex");
      const first = text.split("\n").map((l) => l.trim()).find(Boolean) || "uncommitted changes";
      await cl.call("thread/name/set", { threadId: tid, name: `[codex-run·${label}] ${cut(first, 60)}` });
    }
    threads.add(tid);
    if (target) threads.add(target);
    const reported = SANDBOX_MODE[opened.sandbox?.type] || null;
    // Sandbox for a new turn: -s or the role; otherwise, on an existing thread, the recorded sandbox when the daemon
    // reports a wider one (a thread reloaded from disk falls back to Codex's config). Never widens what it reports
    let turnSandbox = s.sandbox;
    if (!turnSandbox && target) {
      const pinned = recallSandbox(tid);
      if (pinned && reported && SANDBOX_RANK[reported] > SANDBOX_RANK[pinned]) turnSandbox = pinned;
    }
    // A loaded thread ignores overrides passed to thread/resume, so sandbox, model and effort also go on turn/start
    const overrides = {};
    if (s.model) overrides.model = s.model;
    if (s.effort) overrides.effort = s.effort;
    if (turnSandbox) {
      overrides.sandboxPolicy = turnSandbox === "workspace-write"
        ? { ...SANDBOX_POLICY[turnSandbox], ...workspaceWriteConfig() } : SANDBOX_POLICY[turnSandbox];
    }
    if (schema) overrides.outputSchema = schema;
    // Answering into a live turn changes nothing about its sandbox: report what the daemon says
    meta.sandbox = reported || opened.sandbox?.type || null;
    Object.assign(meta, {
      thread: tid,
      model: s.model || opened.model || opened.thread.model || null,
      effort: s.effort || opened.reasoningEffort || opened.thread.reasoningEffort || null,
    });
    fs.writeFileSync(`${job}/meta.json`, JSON.stringify(meta));
    const newTurn = async (method, params) => {
      await startTurn(method, params, (r) => r.turn.id);
      const used = turnSandbox || reported;
      if (used) { meta.sandbox = used; rememberSandbox(tid, used); }
    };

    let turns = [], live = [], qLive = [], asked = null, userInputReq = null;
    if (a.answer) {
      turns = await allTurns(cl, tid);
      live = turns.filter(inProgress);
      if (live.length) {
        follow(live.at(-1).id);
        // Re-attaching: recover the subagent threads this turn already spawned
        for (const it of live.at(-1).items || []) {
          if (it.type === "subAgentActivity" && it.agentThreadId) {
            threads.add(it.agentThreadId);
            if (it.kind === "started") activeSubTurns.add(it.agentThreadId);
            else if (it.kind === "completed" || it.kind === "interrupted") activeSubTurns.delete(it.agentThreadId);
          } else if (it.type === "collabAgentToolCall") {
            for (const t of it.receiverThreadIds || []) threads.add(t);
            if (it.status === "inProgress") pendingCollab.add(it.id);
            else pendingCollab.delete(it.id);
          }
        }
      }
      const qTurns = target === tid ? turns : await allTurns(cl, target);
      qLive = qTurns.filter(inProgress);
      asked = lastQuestion(qTurns);
      // A live turn without an unanswered async question may be blocked on request_user_input: wait for the re-sent request
      if (!a.attach && qLive.length && !(asked && !asked.reply)) {
        const wait = Math.min(USER_INPUT_WAIT_MS, Math.max(0, deadline - Date.now()));
        userInputReq = await takeUserInputRequest(cl, target, qLive.at(-1).id, wait);
      }
    }
    const expired = !a.attach && Date.now() >= deadline;

    if (expired && turn) {
      await interrupt("timeout");
    } else if (expired) {
      status = limitStatus("timeout");
      err = limitError("timeout");
    } else if (a.review) {
      await newTurn("review/start", { threadId: tid, target: reviewTarget(a, text) });
    } else if (a.attach) {
      if (!live.length) throw new RpcError(`thread ${tid} has no turn in progress; nothing to attach to`);
      // Questions asked while no client was connected are not re-sent: hand an unanswered one to the caller
      const q = lastQuestion([live.at(-1)]);
      if (q && !q.reply) asQuestion(q.question.questions, q.question.text || "", tid);
    } else if (userInputReq) {
      const answers = userInputAnswers(userInputReq, text);
      meta.answered = userInputQuestions(userInputReq).map((x) => x.title || "");
      cl.send({ jsonrpc: "2.0", id: userInputReq.id, result: { answers } });
      if (!live.length) follow(userInputReq.params.turnId);
    } else if (a.answer && !(asked && !asked.reply)) {
      // Nothing is waiting: the question was answered elsewhere (the Codex app, another client, an earlier --answer).
      // Sending this answer too would reach Codex as a second reply, so nothing is sent and the turn is followed
      // like --attach; a finished turn is reported as it ended
      meta.notSent = { thread: target, reply: asked?.reply ? userMessageText(asked.reply) : null };
      if (!live.length) {
        const last = turns.at(-1);
        if (!last) throw new RpcError(`thread ${tid} has no turns; nothing was asked`);
        lastTurnId = last.id;
        status = last.status === "completed" ? "ok" : String(last.status);
        err = last.error?.message || "";
      }
    } else if (qLive.length) {
      meta.answered = asked.question.questions.map((x) => x.title || "");
      // The asking turn is still waiting: the answer is steered into that turn instead of starting a new one
      const steered = await cl.call("turn/steer", {
        threadId: target, input: [{ type: "text", text }], expectedTurnId: qLive.at(-1).id,
      });
      if (!live.length) follow(steered.turnId);
    } else {
      if (asked) meta.answered = asked.question.questions.map((x) => x.title || "");
      await newTurn("turn/start", { threadId: tid, input: [{ type: "text", text }], ...overrides });
    }

    while (turn && status !== "question" && !LIMIT_STATUS.test(status)) {
      const hit = limitHit();
      if (hit) { await interrupt(hit); break; }
      let m;
      try {
        const due = [deadline, lastEvent.at + a.idle * 1000, inferAt ?? Infinity];
        m = await cl.nextNotification(Math.min(...due) - Date.now());
      } catch (e) {
        if (!(e instanceof TimeoutError)) throw e;
        m = null;
      }
      if (m === null) {
        if (inferAt !== null && Date.now() >= inferAt) {
          inferAt = null;
          if (finalSeen && !pendingCollab.size && !activeSubTurns.size) {
            // turn/completed is overdue: ask the daemon instead of guessing
            const th = (await cl.call("thread/read", { threadId: tid, includeTurns: true })).thread;
            const ts = (th.turns || []).find((x) => x.id === turn.id)?.status ?? "unknown";
            const terminal = ts !== "inProgress" && ts !== "unknown";
            if (terminal || th.status?.type === "idle") {
              meta.inferred = { turnStatus: ts, threadStatus: th.status?.type ?? "unknown" };
              const t = (th.turns || []).find((x) => x.id === turn.id);
              status = !terminal || ts === "completed" ? "ok" : ts;
              if (status !== "ok") err = t?.error?.message || `turn ${ts}`;
              turn = null;
              break;
            }
            // Still active on the daemon: keep following and look again later
            inferAt = Date.now() + COMPLETION_CHECK_MS;
          }
        }
        continue;
      }
      const par = m.params || {};
      const asking = (m.method === USER_INPUT && "id" in m) ||
        (m.method === "item/completed" && par.item?.type === "agentMessage" && par.item.questions?.length);
      // A subagent this client has not seen spawn (e.g. nested, or before --attach) is recognized by its parent chain
      if (asking && par.threadId && !threads.has(par.threadId) && (await rootOf(cl, par.threadId).catch(() => null)) === tid) {
        threads.add(par.threadId);
      }
      if (m.method === USER_INPUT && "id" in m) {
        if (!threads.has(par.threadId)) {
          cl.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "codex-run does not handle questions from other threads" } });
          continue;
        }
        // Another turn on the root thread (another client's) is not this run's question; leave it unanswered
        if (par.threadId === tid && par.turnId !== turn.id) continue;
        // Blocking question: left unanswered on the daemon; --answer <question thread> reconnects and replies
        const qs = userInputQuestions(m);
        asQuestion(qs, qs.map((q) => q.title).join("\n"), par.threadId);
        meta.request = { id: m.id, threadId: par.threadId, turnId: par.turnId, itemId: par.itemId };
        break;
      }
      if (!threads.has(par.threadId)) continue;
      const root = par.threadId === tid;
      // Events of other turns on the root thread (an earlier or concurrent turn) are not this run's
      const evTurn = eventTurnId(m);
      if (root && evTurn !== null && evTurn !== turn.id) continue;
      const meth = m.method;
      lastEvent = { at: Date.now(), method: meth };
      const item = par.item || {};
      if (root) inferAt = null;
      if (meth === "item/completed" && item.type === "commandExecution") {
        commands.push({ exitCode: item.exitCode ?? null, status: item.status, durationMs: item.durationMs ?? null, cwd: item.cwd,
          command: item.command, ...(root ? {} : { thread: par.threadId }) });
      } else if (meth === "item/completed" && item.type === "fileChange" && item.status === "completed") {
        for (const c of item.changes || []) if (c.path) touched.add(c.path);
      } else if (meth === "item/completed" && item.type === "subAgentActivity") {
        // Since 0.164 subagent spawn/finish is reported as subAgentActivity; nested ones appear on their parent's thread
        threads.add(item.agentThreadId);
        if (item.kind === "started") activeSubTurns.add(item.agentThreadId);
        else if (item.kind === "completed" || item.kind === "interrupted") activeSubTurns.delete(item.agentThreadId);
      } else if ((meth === "item/started" || meth === "item/completed") && item.type === "collabAgentToolCall") {
        for (const t of item.receiverThreadIds || []) threads.add(t);
        if (meth === "item/started" || item.status === "inProgress") pendingCollab.add(item.id);
        else pendingCollab.delete(item.id);
      } else if (meth === "turn/started" && !root) {
        activeSubTurns.add(par.threadId);
      } else if (meth === "turn/completed" && !root) {
        activeSubTurns.delete(par.threadId);
      }
      if (meth === "item/completed" && item.type === "agentMessage" && item.questions?.length) {
        // Codex asks the user ("Codex has a question"): the turn waits on the daemon; --answer replies later
        asQuestion(item.questions, item.text || "", par.threadId);
        break;
      }
      if (!root) {
        if (finalSeen && !pendingCollab.size && !activeSubTurns.size && inferAt === null) inferAt = Date.now() + COMPLETION_CHECK_MS;
        continue;
      }
      if (meth === "item/completed" && item.type === "agentMessage" && !reviewSeen) {
        // commentary narrates progress and is not the report; once a final_answer exists only that counts.
        // An empty phase means the model did not label the message, so it stays a candidate
        if (item.phase === "final_answer") { report = item.text || ""; finalSeen = true; }
        else if (item.phase !== "commentary" && !finalSeen) report = item.text || "";
      } else if (meth === "item/completed" && item.type === "exitedReviewMode") {
        report = item.review || "";
        reviewSeen = true;
      } else if (meth === "turn/completed") {
        const t = par.turn;
        status = t.status === "completed" ? "ok" : String(t.status);
        const error = t.error || {};
        err = error.message || "";
        const wait = RETRY_BACKOFF[Math.min(meta.retries, RETRY_BACKOFF.length - 1)];
        if (status === "failed" && OVERLOADED.has(error.codexErrorInfo) && !a.review && Date.now() + wait * 1000 < deadline) {
          meta.retries += 1;
          process.stderr.write(`codex-run: model at capacity; continuing on the same thread and model in ${wait}s (retry ${meta.retries})\n`);
          turn = null;
          await sleep(wait * 1000);
          report = ""; err = ""; finalSeen = false;
          await startTurn("turn/start", { threadId: tid, input: [{ type: "text", text: RESUME_AFTER_OVERLOAD }], ...overrides }, (r) => r.turn.id);
          continue;
        }
        turn = null;
        break;
      }
      if (finalSeen && !pendingCollab.size && !activeSubTurns.size && inferAt === null) inferAt = Date.now() + COMPLETION_CHECK_MS;
    }
    // The final message may predate this client (--attach, --answer after the answer was consumed): read it back
    if (status === "ok" && !report && lastTurnId) {
      const t = ((await cl.call("thread/read", { threadId: tid, includeTurns: true })).thread.turns || []).find((x) => x.id === lastTurnId);
      report = reportFromTurn(t);
    }
  } catch (e) {
    if (e instanceof Stopped) {
      status = "interrupted";
      err = `client received ${e.message}`;
      if (turn !== null) {
        const turnId = turn.id;
        try {
          await control(sock, version, (c) => c.call("turn/interrupt", { threadId: tid, turnId }), eventsFd);
          err += "; interrupted the turn on the daemon";
        } catch (e2) {
          err += `; failed to interrupt the turn on the daemon: ${e2.message} (use codex-run --stop ${tid})`;
        }
      }
    } else if (e instanceof ConnectionClosed) {
      status = "disconnected";
      err = `app-server connection lost: ${e.message} (the thread is kept on the daemon; --resume it or open it in the Codex app)`;
    } else {
      status = "failed";
      err = e instanceof RpcError || e instanceof AnswerError || e.code ? e.message : (e.stack || String(e));
    }
  } finally {
    cl?.close();
    fs.closeSync(eventsFd);
  }

  if (report) fs.writeFileSync(`${job}/report.md`, report);
  if (status === "ok" && !report) { status = "failed"; err = "turn completed without a final message"; }
  if (status === "ok" && validate) {
    let parsed, bad = null;
    try {
      parsed = JSON.parse(report);
    } catch (e) {
      bad = `final message is not valid JSON: ${e.message}`;
    }
    const violations = bad ? null : validate(parsed);
    if (violations) bad = `final message does not match --schema: ${violations}`;
    if (bad) { status = "failed"; err = bad; }
  }
  if (err) fs.writeFileSync(`${job}/stderr.log`, err + "\n");
  if (questions.length) fs.writeFileSync(`${job}/questions.json`, JSON.stringify(questions, null, 1));
  if (commands.length) fs.writeFileSync(`${job}/commands.jsonl`, commands.map((c) => JSON.stringify(c)).join("\n") + "\n");
  Object.assign(meta, { status, ended: Math.floor(Date.now() / 1000) });
  fs.writeFileSync(`${job}/meta.json`, JSON.stringify(meta));

  const failedCommands = commands.filter((c) => c.exitCode !== 0).length;
  const answerThread = questionThread || tid;
  return {
    status, job, session: tid, model: meta.model, effort: meta.effort, sandbox: meta.sandbox,
    report: `${job}/report.md`, error: status === "ok" || status === "question" ? null : err,
    commands: a.review ? null : { file: commands.length ? `${job}/commands.jsonl` : null, count: commands.length, failed: failedCommands },
    touched: [...touched], answered: meta.answered || [], notSent: meta.notSent || null, inferred: meta.inferred || null,
    questions: status === "question" ? questions : [],
    questionThread: status === "question" && answerThread !== tid ? answerThread : null,
    answerCommand: status === "question"
      ? [shq(process.argv[1] ? path.resolve(process.argv[1]) : "codex-run"), "--answer", answerThread,
        ...(a.role ? ["--role", shq(a.role)] : []), "-C", shq(a.dir), ...(meta.schema ? ["--schema", shq(meta.schema)] : []),
        "<answer file>"].join(" ")
      : null,
  };
}
