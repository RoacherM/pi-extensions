// The Store container's worker (macOS Live; owner direction of 2026-10-20 in
// AGENTS.md): the Store container's main process, which makes every ported SDK call of
// the Mac's host and agents (binding.js) with the real Linux binding. It
// listens on port 7070, published to the Mac's loopback only; a connection's
// first frame must carry the Store container's secret (DSH_BOX_SECRET), answered as id 0,
// and then each frame { id, fn, op, args, open } is answered by { id, answer }
// (`ping` answers at once, for readiness). With `open`, the call needs the
// project's Store: the worker opens it once and keeps it open while calls use
// it, closing it after a quiet minute. Each call is made once.
import { timingSafeEqual } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { made, storeOf } from "./call.mjs";
import { frame, readFrames } from "./frames.mjs";

const PORT = 7070, IDLE_MS = 60_000;
const SOCK = process.env.DSH_BOX_SOCK || "";
const secret = Buffer.from(process.env.DSH_BOX_SECRET ?? "", "hex");
if (secret.length < 16) {
  console.error("layerfs store worker: DSH_BOX_SECRET is not set");
  process.exit(2);
}
// The binding opens each Store with a folder /tmp/layerfs-store-<pid>-<n>. A
// container Docker started again keeps its /tmp, and this worker may get the
// same pid, so an earlier run's folders would refuse the open (File exists).
// This worker is the only process here that opens Stores, and none is open
// yet: they are its own earlier run's.
for (const name of readdirSync(tmpdir())) if (name.startsWith("layerfs-store-")) rmSync(join(tmpdir(), name), { recursive: true, force: true });
const binding = createRequire(import.meta.url)(process.env.LAYERFS_NATIVE);

/** Open Stores by path: { opening, users, timer }. */
const stores = new Map();

/** Per-storePath mutation queue to serialize SQLite/MergeScratch mutations across concurrent calls. */
const storeMutations = new Map();

const MUTATING_OPS = new Set([
  "fs.apply", "fs.write", "fs.edit", "fs.rm", "fs.mv", "fs.mkdir",
  "workspace.commit", "branch.merge", "branch.publish", "branch.fork",
]);

/** Calls `made` with up to 3 short backoff retries if the binding answers Busy. */
async function callWithRetry(fn, op, args) {
  for (let attempt = 0; ; attempt++) {
    const answer = await made(binding, fn, op, args);
    if (attempt < 3 && answer?.refused?.code === "Busy") {
      const backoff = 50 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    return answer;
  }
}

/** Serializes mutating operations per storePath. */
async function runCall(fn, op, args) {
  const key = args?.storePath || (args?.home && args?.project ? `${args.home}:${args.project}` : null);
  if (!key || !MUTATING_OPS.has(op)) {
    return callWithRetry(fn, op, args);
  }
  const prev = storeMutations.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const chain = prev.then(() => current, () => current);
  storeMutations.set(key, chain);
  await prev.catch(() => {});
  try {
    return await callWithRetry(fn, op, args);
  } finally {
    release();
    if (storeMutations.get(key) === chain) {
      storeMutations.delete(key);
    }
  }
}

/** Runs `work` with the call's Store open: a Store that does not open answers its refusal. */
async function withStore(args, work) {
  const key = args.storePath;
  let held = stores.get(key);
  if (!held) stores.set(key, held = { opening: binding.storeOpen(storeOf(args)), users: 0, timer: null });
  held.users++;
  clearTimeout(held.timer);
  try {
    const opened = await held.opening.catch((error) => ({ thrown: error }));
    if (opened?.refused || opened?.thrown) {
      if (stores.get(key) === held) stores.delete(key);
      if (opened.thrown) throw opened.thrown;
      return opened;
    }
    return await work();
  } finally {
    if (--held.users === 0 && stores.get(key) === held) {
      held.timer = setTimeout(() => {
        stores.delete(key);
        binding.storeClose(storeOf(args)).catch((error) => console.error(`layerfs store worker: closing ${key}: ${error}`));
      }, IDLE_MS);
    }
  }
}

async function answer({ fn, op, args, open }) {
  const call = () => runCall(fn, op, args);
  try {
    return await (open ? withStore(args, call) : call());
  } catch (error) {
    return { thrown: String(error?.stack ?? error) };
  }
}

const trusted = (value) => {
  const given = Buffer.from(String(value?.secret ?? ""), "hex");
  return given.length === secret.length && timingSafeEqual(given, secret);
};

const server = createServer((socket) => {
  socket.setNoDelay(true);
  let hello = false;
  socket.on("error", () => {}); // a caller that went away; its calls still finish here
  readFrames(socket, (value) => {
    if (!hello) {
      if (!trusted(value)) return socket.destroy();
      hello = true;
      return socket.write(frame({ id: 0, answer: { value: "hello" } }));
    }
    if (value.fn === "ping") return socket.write(frame({ id: value.id, answer: { value: "ready" } }));
    answer(value).then((result) => { if (!socket.destroyed) socket.write(frame({ id: value.id, answer: result })); });
  }, () => socket.destroy());
});
if (SOCK) {
  rmSync(SOCK, { force: true });
  server.listen(SOCK, () => console.error(`layerfs store worker: listening on ${SOCK}`));
} else {
  server.listen(PORT, "0.0.0.0", () => console.error(`layerfs store worker: listening on ${PORT}`));
}
