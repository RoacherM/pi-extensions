// v0.2 Real `pi --mode rpc`: exercises the extension's UI paths (status line, notify,
// apply confirm dialog) the way an interactive client does. Run: node tests/rpc.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `rpc-${id}`);
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "host a\n");
const PREFIX = `pi-lfs-rt-${id}-`;
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const results = [];
const step = async (name, fn) => {
  try {
    const ev = await fn();
    results.push(true);
    console.log(`PASS ${name}${ev ? ` :: ${String(ev).slice(0, 200)}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`);
  }
};

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "-ne", "-e", join(root, "tests/fixtures/faux-model.ts"), "-e", join(root, "src/index.ts"), "--model", "lfs-faux/m"], {
  cwd, stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env, PI_CODING_AGENT_DIR: join(base, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_LAYERFS_ROOT: join(base, "lfs"), PI_LAYERFS_PREFIX: PREFIX,
    PI_LFS_SCRIPT: JSON.stringify([[["write", { path: "a.txt", content: "agent a\n" }], ["write", { path: "new.txt", content: "new\n" }]]]),
  },
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const events = [];
const waiters = [];
createInterface({ input: child.stdout }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  events.push(m);
  for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
});
const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
const waitFor = (pred, label, ms = 60_000) => {
  const hit = events.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); } };
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${label}; stderr: ${stderr.slice(-500)}`)); }, ms);
    waiters.push(w);
  });
};
const ui = (method, pred = () => true) => (m) => m.type === "extension_ui_request" && m.method === method && pred(m);
const settledAfter = (n) => (m) => m.type === "agent_settled" && events.indexOf(m) >= n;

try {
  await step("status line: starting -> on", async () => {
    await waitFor(ui("setStatus", (m) => /LayerFS starting/.test(m.statusText ?? "")), "starting status", 30_000);
    await waitFor(ui("setStatus", (m) => /LayerFS s-/.test(m.statusText ?? "")), "ready status", 90_000);
  });

  await step("agent writes stay in LayerFS (0 Sandboxes); status shows checkpoints/unapplied", async () => {
    const n = events.length;
    send({ id: "p1", type: "prompt", message: "go" });
    await waitFor(settledAfter(n), "agent settled");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "host a\n");
    assert.equal(existsSync(join(cwd, "new.txt")), false);
    const sb = docker("ps", "-q", "--filter", `name=^${PREFIX}`, "--filter", "label=layerfs.role=sandbox").stdout.trim();
    assert.equal(sb, "", "Store-direct writes in RPC mode must start 0 Sandboxes");
    const st = await waitFor(ui("setStatus", (m) => /2 unapplied/.test(m.statusText ?? "")), "checkpoint status");
    return st.statusText;
  });

  await step("/layerfs status notifies", async () => {
    const n = events.length;
    send({ id: "p2", type: "prompt", message: "/layerfs status" });
    const m = await waitFor((e) => events.indexOf(e) >= n && ui("notify")(e), "status notify");
    assert.match(m.message, /project project · volume/);
  });

  await step("/layerfs apply -> confirm declined -> nothing written", async () => {
    const n = events.length;
    send({ id: "p3", type: "prompt", message: "/layerfs apply" });
    const c = await waitFor((e) => events.indexOf(e) >= n && ui("confirm")(e), "confirm dialog");
    assert.match(c.message, /Modified \/a\.txt/);
    assert.match(c.message, /Added \/new\.txt/);
    send({ type: "extension_ui_response", id: c.id, confirmed: false });
    await waitFor((e) => events.indexOf(e) >= n && ui("notify", (m) => /Apply cancelled/.test(m.message))(e), "cancel notify");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "host a\n");
  });

  await step("/layerfs apply -> confirm accepted -> host updated", async () => {
    const n = events.length;
    send({ id: "p4", type: "prompt", message: "/layerfs apply" });
    const c = await waitFor((e) => events.indexOf(e) >= n && ui("confirm")(e), "confirm dialog");
    send({ type: "extension_ui_response", id: c.id, confirmed: true });
    const m = await waitFor((e) => events.indexOf(e) >= n && ui("notify", (x) => /Applied 2 change/.test(x.message))(e), "applied notify");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "agent a\n");
    assert.equal(readFileSync(join(cwd, "new.txt"), "utf8"), "new\n");
    return m.message.split("\n")[0];
  });

  await step("exit: pi shuts down cleanly", async () => {
    child.stdin.end();
    await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGTERM"); r(); }, 30_000); child.on("close", () => { clearTimeout(t); r(); }); });
  });
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  const left = docker("ps", "-aq", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed; cleaned ${left.length} containers, ${vols.length} volumes`);
  rmSync(base, { recursive: true, force: true });
  process.exit(results.every(Boolean) ? 0 : 1);
}
