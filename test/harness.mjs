// Test harness: a scripted fake app-server on a Unix socket plus a runner for the built codex-run script.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const root = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT = path.join(root, "..", "plugin", "skills", "codex", "scripts", "codex-run.mjs");

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-run-test-"));
}

// handler(msg, peer) is called for every client message; peer.send/notify/request/respond write back.
// Every received message is recorded in server.log.
export async function fakeServer(dir, handler) {
  const sock = path.join(dir, "app-server.sock");
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const server = { sock, log: [], peers: [] };
  wss.on("connection", (ws) => {
    const peer = {
      send: (obj) => ws.send(JSON.stringify(obj)),
      respond: (id, result) => peer.send({ jsonrpc: "2.0", id, result }),
      notify: (method, params) => peer.send({ jsonrpc: "2.0", method, params }),
      request: (id, method, params) => peer.send({ jsonrpc: "2.0", id, method, params }),
    };
    server.peers.push(peer);
    ws.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      server.log.push(msg);
      if (msg.method === "initialize") return peer.respond(msg.id, {});
      if (msg.method === "initialized" || msg.method === "thread/name/set") return msg.id !== undefined && peer.respond(msg.id, {});
      await handler(msg, peer);
    });
  });
  await new Promise((r) => httpServer.listen(sock, r));
  server.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); httpServer.close(r); });
  server.calls = (method) => server.log.filter((m) => m.method === method);
  return server;
}

export function runCli(args, { dir, sock, env = {}, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: {
        ...process.env,
        PATH: `${path.join(root, "fixtures")}${path.delimiter}${process.env.PATH}`,
        CODEX_HOME: path.join(dir, "codex-home"),
        CODEX_RUN_HOME: path.join(dir, "run-home"),
        FAKE_CODEX_SOCK: sock ?? "",
        ...env,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    onSpawn?.(child);
    child.on("close", (code) => resolve({ code, stdout, stderr, fields: parseFields(stdout) }));
  });
}

export function parseFields(stdout) {
  const out = {};
  for (const line of stdout.split("\n")) {
    const m = /^([a-z_]+)=(.*)$/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

export const thread = (id, extra = {}) => ({ id, model: "m-1", reasoningEffort: "low", cwd: "/", status: { type: "idle" }, turns: [], ...extra });
export const agentMessage = (text, phase = "final_answer") => ({ type: "agentMessage", id: `msg-${Math.random()}`, text, phase });
