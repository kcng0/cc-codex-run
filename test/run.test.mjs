// End-to-end tests of the built script against a scripted fake app-server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { agentMessage, fakeServer, runCli, thread, tmpdir } from "./harness.mjs";

let dir, task;
before(() => {
  dir = tmpdir();
  task = path.join(dir, "task.md");
  fs.writeFileSync(task, "do the thing\n");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const opened = (id, extra = {}) => ({ thread: thread(id), model: "m-1", reasoningEffort: "low", sandbox: { type: "workspaceWrite" }, ...extra });
const report = (fields) => fs.readFileSync(fields.report, "utf8");

test("events of another turn on the same thread are ignored (stale turn/completed)", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T2" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("old report") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
      p.notify("item/completed", { threadId: "R", turnId: "T2", item: agentMessage("new report") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T2", status: "completed" } });
    }
  });
  const r = await runCli(["-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.equal(report(r.fields), "new report");
});

test("a stop signal while turn/start is pending still interrupts the new turn", async () => {
  let child;
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      child.kill("SIGTERM");
      setTimeout(() => p.respond(m.id, { turn: { id: "T1" } }), 300);
    }
    if (m.method === "turn/interrupt") p.respond(m.id, {});
  });
  const r = await runCli(["-C", dir, task], { dir, sock: srv.sock, onSpawn: (c) => (child = c) });
  await srv.close();
  assert.equal(r.fields.status, "interrupted", r.stdout + r.stderr);
  assert.deepEqual(srv.calls("turn/interrupt").map((m) => m.params), [{ threadId: "R", turnId: "T1" }]);
});

test("--attach reads back a final answer produced before it attached", async () => {
  const final = agentMessage("done before attach");
  let reads = 0;
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/resume") return p.respond(m.id, opened("R"));
    if (m.method === "thread/read" && m.params.includeTurns) {
      reads += 1;
      const status = reads === 1 ? "inProgress" : "completed";
      p.respond(m.id, { thread: thread("R", { turns: [{ id: "T1", status, items: [final] }] }) });
      if (reads === 1) setTimeout(() => p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } }), 50);
      return;
    }
    if (m.method === "thread/read") return p.respond(m.id, { thread: thread("R") });
  });
  const r = await runCli(["--attach", "R", "-C", dir], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.equal(report(r.fields), "done before attach");
});

test("a subagent's blocking question is answered on the subagent thread and the root turn is followed", async () => {
  const question = { questions: [{ id: "q1", header: "Pick", question: "Which DB?", options: [{ label: "pg" }, { label: "sqlite" }] }] };
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: { type: "subAgentActivity", id: "a", kind: "started", agentThreadId: "S" } });
      p.request(900, "item/tool/requestUserInput", { threadId: "S", turnId: "TS", itemId: "i", ...question });
    }
  });
  const asked = await runCli(["--allow-subagents", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(asked.fields.status, "question", asked.stdout + asked.stderr);
  assert.equal(asked.fields.session, "R");
  assert.match(asked.fields.question_thread, /^S /);
  assert.match(asked.stdout, /codex-run\.mjs --answer S /);

  let answered = null;
  const srv2 = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) {
      return p.respond(m.id, { thread: thread(m.params.threadId, m.params.threadId === "S" ? { parentThreadId: "R" } : {}) });
    }
    if (m.method === "thread/resume") {
      p.respond(m.id, opened(m.params.threadId));
      if (m.params.threadId === "S") p.request(901, "item/tool/requestUserInput", { threadId: "S", turnId: "TS", itemId: "i", ...question });
      return;
    }
    if (m.method === "thread/read") {
      const turnId = m.params.threadId === "S" ? "TS" : "T1";
      return p.respond(m.id, { thread: thread(m.params.threadId, { turns: [{ id: turnId, status: "inProgress", items: [] }] }) });
    }
    if (m.id === 901 && m.result) {
      answered = m.result;
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("root finished") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
    }
  });
  const answer = path.join(dir, "answer.md");
  fs.writeFileSync(answer, "sqlite\n");
  const r = await runCli(["--answer", "S", "-C", dir, answer], { dir, sock: srv2.sock });
  await srv2.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.equal(r.fields.session, "R");
  assert.deepEqual(answered, { answers: { q1: { answers: ["sqlite"] } } });
  assert.equal(report(r.fields), "root finished");
});

const asyncQuestion = { ...agentMessage("need input", "final_answer"), delivery: "async", questions: [{ title: "Keep it?", options: ["keep", "change"] }] };
const userMessage = (text) => ({ type: "userMessage", id: `u-${Math.random()}`, content: [{ type: "text", text }] });

test("--answer to an async question already answered elsewhere sends nothing and follows the turn", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) return p.respond(m.id, { thread: thread("R") });
    if (m.method === "thread/resume") return p.respond(m.id, opened("R"));
    if (m.method === "thread/read") {
      const items = [userMessage("task"), asyncQuestion, userMessage("keep\n"), agentMessage("still working", "commentary")];
      p.respond(m.id, { thread: thread("R", { turns: [{ id: "T1", status: "inProgress", items }] }) });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("kept it") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
    }
  });
  const answer = path.join(dir, "answer-twice.md");
  fs.writeFileSync(answer, "change\n");
  const r = await runCli(["--answer", "R", "-C", dir, answer], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.deepEqual([...srv.calls("turn/steer"), ...srv.calls("turn/start")], []);
  assert.match(r.fields.not_sent, /^no question is waiting on R/);
  assert.equal(r.fields.prior_reply, "keep");
  assert.equal(report(r.fields), "kept it");
});

test("--answer after the answered turn finished reports that turn instead of starting a new one", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) return p.respond(m.id, { thread: thread("R") });
    if (m.method === "thread/resume") return p.respond(m.id, opened("R"));
    if (m.method === "thread/read") {
      const turns = [{ id: "T1", status: "completed", items: [userMessage("task"), asyncQuestion] },
        { id: "T2", status: "completed", items: [userMessage("keep"), agentMessage("kept it")] }];
      p.respond(m.id, { thread: thread("R", { turns }) });
    }
  });
  const answer = path.join(dir, "answer-late.md");
  fs.writeFileSync(answer, "change\n");
  const r = await runCli(["--answer", "R", "-C", dir, answer], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.deepEqual([...srv.calls("turn/steer"), ...srv.calls("turn/start")], []);
  assert.equal(r.fields.prior_reply, "keep");
  assert.equal(report(r.fields), "kept it");
});

test("--schema rejects a final message that is valid JSON but does not match the schema", async () => {
  const schema = path.join(dir, "schema.json");
  fs.writeFileSync(schema, JSON.stringify({ type: "object", required: ["status"], properties: { status: { enum: ["complete"] } } }));
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage('{"status":"maybe"}') });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
    }
  });
  const r = await runCli(["--schema", schema, "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.code, 1);
  assert.equal(r.fields.status, "failed");
  assert.match(r.stdout, /does not match --schema/);
  assert.deepEqual(srv.calls("turn/start")[0].params.outputSchema.required, ["status"]);
});

test("sandbox: role sandbox_mode applies, -s overrides it, and neither leaves Codex config in charge", async () => {
  const agents = path.join(dir, "codex-home", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "ro.toml"), 'model = "m-2"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nbe careful\n"""\n[agents]\nenabled = false\n');
  const sent = [];
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R", { sandbox: m.params.sandbox ? { type: "readOnly" } : { type: "workspaceWrite" } }));
    if (m.method === "turn/start") {
      sent.push(m.params.sandboxPolicy ?? null);
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("ok") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
    }
  });
  const role = await runCli(["--role", "ro", "-C", dir, task], { dir, sock: srv.sock });
  const override = await runCli(["--role", "ro", "-s", "workspace-write", "-C", dir, task], { dir, sock: srv.sock });
  const none = await runCli(["-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  const starts = srv.calls("thread/start").map((m) => m.params);
  assert.equal(starts[0].sandbox, "read-only");
  assert.equal(starts[0].model, "m-2");
  assert.equal(starts[0].developerInstructions, "be careful\n");
  assert.equal(starts[1].sandbox, "workspace-write");
  assert.equal("sandbox" in starts[2], false);
  assert.deepEqual(sent, [{ type: "readOnly" }, { type: "workspaceWrite" }, null]);
  assert.equal(role.fields.sandbox, "read-only");
  assert.equal(override.fields.sandbox, "workspace-write");
  assert.equal(none.fields.sandbox, "workspace-write");
});

test("an explicit workspace-write turn keeps the network access and writable roots from Codex's config", async () => {
  const home = path.join(dir, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  const cfg = path.join(home, "config.toml");
  fs.writeFileSync(cfg, 'sandbox_mode = "danger-full-access"\n[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = ["/var/cache/x"]\n');
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("WW", { sandbox: { type: "workspaceWrite" } }));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "WW", turnId: "T1", item: agentMessage("ok") });
      p.notify("turn/completed", { threadId: "WW", turn: { id: "T1", status: "completed" } });
    }
  });
  try {
    const r = await runCli(["-s", "workspace-write", "-C", dir, task], { dir, sock: srv.sock });
    assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
    assert.deepEqual(srv.calls("turn/start")[0].params.sandboxPolicy,
      { type: "workspaceWrite", networkAccess: true, writableRoots: ["/var/cache/x"] });
  } finally {
    await srv.close();
    fs.rmSync(cfg);
  }
});

test("an app-server older than the supported minimum is refused before connecting", async () => {
  const r = await runCli(["-C", dir, task], { dir, sock: path.join(dir, "none.sock"), env: { FAKE_CODEX_VERSION: "0.150.2" } });
  assert.equal(r.code, 69);
  assert.match(r.stderr, /0\.150\.2 is older than the required 0\.164\.0/);
});

test("--resume without -s or a role reapplies the sandbox the thread last ran with", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("PIN", { sandbox: { type: "readOnly" } }));
    // A reloaded thread reports Codex's config default, not what it ran with before
    if (m.method === "thread/resume") return p.respond(m.id, opened("PIN", { sandbox: { type: "dangerFullAccess" } }));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: `T${m.id}` } });
      p.notify("item/completed", { threadId: "PIN", turnId: `T${m.id}`, item: agentMessage("ok") });
      p.notify("turn/completed", { threadId: "PIN", turn: { id: `T${m.id}`, status: "completed" } });
    }
  });
  await runCli(["-s", "read-only", "-C", dir, task], { dir, sock: srv.sock });
  const r = await runCli(["--resume", "PIN", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.deepEqual(srv.calls("turn/start").at(-1).params.sandboxPolicy, { type: "readOnly" });
  assert.equal(r.fields.sandbox, "read-only");
});

test("--resume never widens a sandbox the daemon reports narrower than the recorded one", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("NARROW", { sandbox: { type: "dangerFullAccess" } }));
    // Tightened elsewhere (e.g. in the Codex app) after codex-run recorded danger-full-access
    if (m.method === "thread/resume") return p.respond(m.id, opened("NARROW", { sandbox: { type: "readOnly" } }));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: `T${m.id}` } });
      p.notify("item/completed", { threadId: "NARROW", turnId: `T${m.id}`, item: agentMessage("ok") });
      p.notify("turn/completed", { threadId: "NARROW", turn: { id: `T${m.id}`, status: "completed" } });
    }
  });
  await runCli(["-s", "danger-full-access", "-C", dir, task], { dir, sock: srv.sock });
  const r = await runCli(["--resume", "NARROW", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.equal("sandboxPolicy" in srv.calls("turn/start").at(-1).params, false);
  assert.equal(r.fields.sandbox, "read-only");
});

test("a stop signal while --answer waits for the re-sent question interrupts the followed turn", async () => {
  let child;
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) return p.respond(m.id, { thread: thread("R") });
    if (m.method === "thread/resume") return p.respond(m.id, opened("R"));
    if (m.method === "thread/read") {
      p.respond(m.id, { thread: thread("R", { turns: [{ id: "T1", status: "inProgress", items: [] }] }) });
      setTimeout(() => child.kill("SIGTERM"), 100);
      return;
    }
    if (m.method === "turn/interrupt") p.respond(m.id, {});
  });
  const answer = path.join(dir, "answer-stop.md");
  fs.writeFileSync(answer, "yes\n");
  const r = await runCli(["--answer", "R", "-C", dir, answer], { dir, sock: srv.sock, onSpawn: (c) => (child = c) });
  await srv.close();
  assert.equal(r.fields.status, "interrupted", r.stdout + r.stderr);
  assert.deepEqual(srv.calls("turn/interrupt").map((m) => m.params), [{ threadId: "R", turnId: "T1" }]);
});

test("an inferred completion whose turn the daemon reports as failed is not ok", async () => {
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("final") });
    }
    if (m.method === "thread/read") {
      p.respond(m.id, { thread: thread("R", { turns: [{ id: "T1", status: "failed", error: { message: "boom" }, items: [] }] }) });
    }
  });
  const r = await runCli(["--allow-subagents", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.code, 1);
  assert.equal(r.fields.status, "failed", r.stdout + r.stderr);
  assert.match(r.stdout, /boom/);
});

test("--install-skills refuses to replace the copy it runs from", async () => {
  const dest = path.join(dir, "skills");
  const first = await runCli(["--install-skills", dest], { dir });
  assert.equal(first.code, 0, first.stderr);
  const own = path.join(dest, "codex", "scripts", "codex-run.mjs");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [own, "--install-skills", dest, "--force"], { encoding: "utf8" });
  assert.equal(r.status, 64, r.stdout + r.stderr);
  // The same directory reached through a symlink (like ~/.claude/skills -> elsewhere, or /var on macOS)
  const link = path.join(dir, "skills-link");
  fs.symlinkSync(dest, link);
  const viaLink = spawnSync(process.execPath, [own, "--install-skills", link, "--force"], { encoding: "utf8" });
  assert.equal(viaLink.status, 64, viaLink.stdout + viaLink.stderr);
  assert.ok(fs.existsSync(own));
});

test("--attach does not infer completion while a re-seeded subagent is still active", async () => {
  const items = [
    { type: "subAgentActivity", id: "a1", kind: "started", agentThreadId: "S" },
    { type: "subAgentActivity", id: "a2", kind: "interacted", agentThreadId: "S" },
  ];
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) return p.respond(m.id, { thread: thread("R") });
    if (m.method === "thread/resume") return p.respond(m.id, opened("R"));
    if (m.method === "thread/read") {
      p.respond(m.id, { thread: thread("R", { turns: [{ id: "T1", status: "inProgress", items }] }) });
      setTimeout(() => p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("parent final") }), 50);
    }
    if (m.method === "turn/interrupt") p.respond(m.id, {});
  });
  const r = await runCli(["--attach", "R", "--allow-subagents", "-t", "7", "-C", dir], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "timeout(7s)", r.stdout + r.stderr);
});

test("an async question from a nested subagent not seen spawning is recognized by its parent chain", async () => {
  const parents = { S2: "S1", S1: "R" };
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/read" && !m.params.includeTurns) {
      return p.respond(m.id, { thread: thread(m.params.threadId, parents[m.params.threadId] ? { parentThreadId: parents[m.params.threadId] } : {}) });
    }
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "S2", turnId: "TS2", item: { ...agentMessage("need input"), questions: [{ title: "Go?", options: ["yes", "no"] }] } });
    }
  });
  const r = await runCli(["--allow-subagents", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "question", r.stdout + r.stderr);
  assert.match(r.fields.question_thread, /^S2 /);
});

test("pruning keeps an expired job that holds this run's task file, even through a symlink", async () => {
  const home = path.join(dir, "prune-home");
  const old = path.join(home, "jobs", "job-old");
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, "task.md"), "again\n");
  fs.writeFileSync(path.join(old, "meta.json"), JSON.stringify({ ended: 1 }));
  const link = path.join(dir, "task-link.md");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join(old, "task.md"), link);
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("ok") });
      p.notify("turn/completed", { threadId: "R", turn: { id: "T1", status: "completed" } });
    }
  });
  const r = await runCli(["-C", dir, link], { dir, sock: srv.sock, env: { CODEX_RUN_HOME: home } });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(old, "task.md")));
});

test("a missing turn/completed is not reported as success while the daemon still shows the turn active", async () => {
  let reads = 0;
  const srv = await fakeServer(dir, (m, p) => {
    if (m.method === "thread/start") return p.respond(m.id, opened("R"));
    if (m.method === "turn/start") {
      p.respond(m.id, { turn: { id: "T1" } });
      p.notify("item/completed", { threadId: "R", turnId: "T1", item: agentMessage("final") });
    }
    if (m.method === "thread/read") {
      reads += 1;
      const [ts, th] = reads === 1 ? ["inProgress", "active"] : ["completed", "idle"];
      p.respond(m.id, { thread: thread("R", { status: { type: th }, turns: [{ id: "T1", status: ts, items: [] }] }) });
    }
  });
  const r = await runCli(["--allow-subagents", "-C", dir, task], { dir, sock: srv.sock });
  await srv.close();
  assert.equal(r.fields.status, "ok", r.stdout + r.stderr);
  assert.equal(reads, 2);
  assert.match(r.fields.inferred, /turn completed, thread idle/);
});
