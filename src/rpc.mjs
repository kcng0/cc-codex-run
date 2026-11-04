// JSON-RPC over the app-server control socket (WebSocket on a Unix domain socket).
import fs from "node:fs";
import WebSocket from "ws";
import { currentStop, onStop } from "./signals.mjs";

export class ConnectionClosed extends Error {}
export class RpcError extends Error {}
export class TimeoutError extends Error {
  constructor() { super("timed out waiting for an app-server message"); }
}

export const CALL_TIMEOUT_MS = 120_000;
// Blocking questions (request_user_input) arrive as server requests and are handed to the run loop
export const USER_INPUT = "item/tool/requestUserInput";
// Only final events are needed; streaming deltas are opted out
const OPT_OUT_NOTIFICATIONS = [
  "item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded",
];

// Message queue over a ws connection: next() resolves with the next text message
class Conn {
  static open(sockPath, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix:${sockPath}:/`, { handshakeTimeout: timeoutMs, perMessageDeflate: false });
      const onError = (e) => reject(new ConnectionClosed(`cannot connect to ${sockPath}: ${e.message}`));
      ws.once("error", onError);
      ws.once("open", () => { ws.off("error", onError); resolve(new Conn(ws)); });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    this.waiter = null;
    this.closed = null;
    ws.on("message", (data) => {
      const msg = data.toString("utf8");
      if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(msg); }
      else this.queue.push(msg);
    });
    ws.on("error", (e) => this.onClosed(new ConnectionClosed(e.message)));
    ws.on("close", (code, reason) => this.onClosed(new ConnectionClosed(`connection closed (${code}) ${reason.toString("utf8")}`.trim())));
  }

  onClosed(err) {
    if (this.closed) return;
    this.closed = err;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); }
  }

  send(text) {
    if (this.closed) throw this.closed;
    this.ws.send(text);
  }

  // timeoutMs null = no limit; abortOnStop rejects with the Stopped error as soon as a stop signal arrives
  next(timeoutMs, abortOnStop) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.closed);
    if (abortOnStop && currentStop()) return Promise.reject(currentStop());
    return new Promise((resolve, reject) => {
      let timer = null, off = () => {};
      const done = (f, v) => { clearTimeout(timer); off(); this.waiter = null; f(v); };
      this.waiter = { resolve: (v) => done(resolve, v), reject: (e) => done(reject, e) };
      if (timeoutMs !== null) timer = setTimeout(() => done(reject, new TimeoutError()), Math.max(0, timeoutMs));
      if (abortOnStop) off = onStop((e) => done(reject, e));
    });
  }

  close() {
    this.ws.close(1000);
    this.ws.terminate();
  }
}

export class Client {
  constructor(conn, eventsFd, abortOnStop) {
    this.conn = conn;
    this.eventsFd = eventsFd;
    this.abortOnStop = abortOnStop;
    this.nextId = 0;
    this.pending = [];
  }

  log(m) {
    if (this.eventsFd !== null) fs.writeSync(this.eventsFd, JSON.stringify(m) + "\n");
  }

  send(obj) {
    this.conn.send(JSON.stringify(obj));
  }

  async recv(timeoutMs = null, interruptible = true) {
    const m = JSON.parse(await this.conn.next(timeoutMs, this.abortOnStop && interruptible));
    this.log(m);
    if ("id" in m && "method" in m && m.method !== USER_INPUT) {
      // With approvalPolicy=never no approval requests are expected; reject explicitly so the turn does not hang
      this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "codex-run does not handle interactive requests" } });
    }
    return m;
  }

  // interruptible=false keeps waiting for the response after a stop signal (the caller checks the stop afterwards)
  async call(method, params, { interruptible = true } = {}) {
    const rid = ++this.nextId;
    this.send({ jsonrpc: "2.0", id: rid, method, params });
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    for (;;) {
      let m;
      try {
        m = await this.recv(deadline - Date.now(), interruptible);
      } catch (e) {
        if (e instanceof TimeoutError) throw new RpcError(`${method}: no response within ${CALL_TIMEOUT_MS / 1000}s`);
        throw e;
      }
      if (m.id === rid && !("method" in m)) {
        if (m.error) throw new RpcError(`${method} failed: ${m.error.message ?? JSON.stringify(m.error)}`);
        return m.result;
      }
      this.pending.push(m);
    }
  }

  async nextNotification(timeoutMs) {
    if (this.pending.length) return this.pending.shift();
    return this.recv(timeoutMs);
  }

  close() {
    this.conn.close();
  }
}

export async function connect(sock, eventsFd, abortOnStop, version) {
  const cl = new Client(await Conn.open(sock, 30_000), eventsFd, abortOnStop);
  await cl.call("initialize", {
    clientInfo: { name: "codex-run", version },
    capabilities: { optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
  });
  cl.send({ jsonrpc: "2.0", method: "initialized" });
  return cl;
}

// Short-lived connection for control calls (--ps, --stop, interrupt on stop); not aborted by stop signals
export async function control(sock, version, fn, eventsFd = null) {
  const cl = await connect(sock, eventsFd, false, version);
  try {
    return await fn(cl);
  } finally {
    cl.close();
  }
}

// Follows nextCursor pagination of a list method
export async function listAll(cl, method, params = {}) {
  const out = [];
  let cursor = null;
  do {
    const r = await cl.call(method, cursor ? { ...params, cursor } : params);
    out.push(...(r.data || []));
    cursor = r.nextCursor || null;
  } while (cursor);
  return out;
}
