// Process-wide stop state: SIGTERM/SIGINT/SIGHUP set it once; waiters registered here are rejected with it.

export class Stopped extends Error {}

let stopped = null;
const listeners = new Set();

export function installSignalHandlers() {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (stopped) return;
      stopped = new Stopped(sig);
      for (const f of listeners) f(stopped);
    });
  }
}

export const currentStop = () => stopped;

export function onStop(f) {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function sleep(ms) {
  return new Promise((resolve, reject) => {
    if (stopped) return reject(stopped);
    const off = onStop((e) => { clearTimeout(t); reject(e); });
    const t = setTimeout(() => { off(); resolve(); }, ms);
  });
}
