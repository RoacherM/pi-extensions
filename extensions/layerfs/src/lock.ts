// Cross-process directory locks for bindings.json and per-project mutations.
//
// - A lock is stale only when its owner process is gone (same host, pid not alive), or when its
//   heartbeat stopped for HEARTBEAT_STALE_MS (other host / pid reused / owner frozen).
// - The holder refreshes a heartbeat; before each beat it checks it still owns the lock (token).
//   If it lost the lock (reclaimed while frozen), it stops beating and `lost` becomes true, so the
//   caller can refuse to continue (re-review N4). owner.json is written atomically (tmp + rename).
// - Reclaiming is serialized by a `<lock>.reclaim` sub-lock (mkdir). The reclaimer re-checks the
//   owner token it judged stale right before moving the lock away, so a freshly re-acquired lock
//   is never removed by a slower reclaimer (re-review N5).
// - Waiting is async (setTimeout); only short bindings.json sections use the sync variant.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const HEARTBEAT_MS = 2_000;
const HEARTBEAT_STALE_MS = 30_000;
const RECLAIM_STALE_MS = 10_000;

interface Owner { pid: number; host: string; token: string; at: number }

function readOwner(lockDir: string): Owner | null {
  try { return JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")); } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** The owner token if the lock is stale, else null. "" means stale with no owner file. */
function staleToken(lockDir: string): string | null {
  let st;
  try { st = statSync(lockDir); } catch { return null; }
  const owner = readOwner(lockDir);
  const age = Date.now() - Math.max(st.mtimeMs, owner?.at ?? 0);
  if (!owner) return age > HEARTBEAT_STALE_MS ? "" : null;
  if (owner.host === hostname() && !alive(owner.pid)) return owner.token;
  return age > HEARTBEAT_STALE_MS ? owner.token : null;
}

function tryReclaim(lockDir: string, token: string): void {
  const sub = `${lockDir}.reclaim`;
  try {
    mkdirSync(sub);
  } catch (e: any) {
    // another reclaimer is working; break a reclaimer that died mid-way
    try { if (Date.now() - statSync(sub).mtimeMs > RECLAIM_STALE_MS) rmSync(sub, { recursive: true, force: true }); } catch {}
    return;
  }
  try {
    const now = readOwner(lockDir);
    if ((now?.token ?? "") !== token) return; // it changed hands since we judged it stale
    const grave = `${lockDir}.stale-${process.pid}-${Date.now()}`;
    renameSync(lockDir, grave);
    rmSync(grave, { recursive: true, force: true });
  } catch {
    // released or reclaimed meanwhile
  } finally {
    rmSync(sub, { recursive: true, force: true });
  }
}

export interface LockHandle {
  /** true once another process took the lock over (this holder was frozen past the stale age) */
  readonly lost: boolean;
  release(): void;
}

function tryAcquire(lockDir: string): LockHandle | null {
  try {
    mkdirSync(lockDir);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    return null;
  }
  const token = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let lost = false;
  let released = false;
  const writeOwner = () => {
    const tmp = join(lockDir, `.owner.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() } satisfies Owner));
    renameSync(tmp, join(lockDir, "owner.json"));
    const now = new Date();
    utimesSync(lockDir, now, now);
  };
  try { writeOwner(); } catch { rmSync(lockDir, { recursive: true, force: true }); return null; }
  const timer = setInterval(() => {
    if (released || lost) return;
    if (readOwner(lockDir)?.token !== token) { lost = true; clearInterval(timer); return; }
    try { writeOwner(); } catch { lost = true; clearInterval(timer); }
  }, HEARTBEAT_MS);
  timer.unref?.();
  return {
    get lost() { return lost || (!released && readOwner(lockDir)?.token !== token); },
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (readOwner(lockDir)?.token === token) rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

/** Acquires `lockDir` asynchronously (refused as Busy after `timeoutMs`). */
export async function acquireLock(lockDir: string, timeoutMs = 60_000): Promise<LockHandle> {
  mkdirSync(join(lockDir, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (let delay = 10; ; delay = Math.min(delay * 2, 200)) {
    const got = tryAcquire(lockDir);
    if (got) return got;
    const stale = staleToken(lockDir);
    if (stale !== null) { tryReclaim(lockDir, stale); continue; }
    if (Date.now() > deadline) throw Object.assign(new Error(`lock busy: ${lockDir}`), { code: "Busy" });
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** Synchronous variant for short critical sections (bindings.json read-modify-write, a few ms). */
export function acquireLockSync(lockDir: string, timeoutMs = 10_000): LockHandle {
  mkdirSync(join(lockDir, ".."), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = tryAcquire(lockDir);
    if (got) return got;
    const stale = staleToken(lockDir);
    if (stale !== null) { tryReclaim(lockDir, stale); continue; }
    if (Date.now() > deadline) throw Object.assign(new Error(`lock busy: ${lockDir}`), { code: "Busy" });
    const until = Date.now() + 5;
    while (Date.now() < until) { /* short spin: bindings sections hold the lock for a few ms */ }
  }
}
