// v0.2 Real `pi` CLI (jiti-loaded TS extension) in print mode, isolated agent dir.
// Run: node tests/cli.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `cli-${id}`);
const cwd = join(base, "project");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "host a\n");
const PREFIX = `pi-lfs-ct-${id}-`;
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const results = [];
const step = (name, fn) => {
  try {
    const ev = fn();
    results.push(true);
    console.log(`PASS ${name}${ev ? ` :: ${String(ev).slice(0, 240)}` : ""}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 3).join(" | ")}`);
  }
};

function piArgs(extra) {
  return ["-p", "--no-session", "--offline", "-ne", "-e", join(root, "tests/fixtures/faux-model.ts"), "-e", join(root, "src/index.ts"), ...extra, "--model", "lfs-faux/m", "run the script"];
}
function piEnv(script, env = {}) {
  return { ...process.env, PI_CODING_AGENT_DIR: join(base, "agent"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_LFS_SCRIPT: JSON.stringify(script), PI_LAYERFS_ROOT: join(base, "lfs"), PI_LAYERFS_PREFIX: PREFIX, ...env };
}
function piAsync(script) {
  return new Promise((resolve) => {
    const c = spawn("pi", piArgs([]), { cwd, env: piEnv(script), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (status) => resolve({ status, stdout: out, stderr: err }));
  });
}
function pi(script, extra = [], env = {}) {
  const t0 = Date.now();
  const r = spawnSync("pi", piArgs(extra), { cwd, encoding: "utf8", timeout: 180_000, env: piEnv(script, env) });
  return { ...r, ms: Date.now() - t0 };
}

try {
  step("print mode: write + bash stay in LayerFS; host untouched", () => {
    const r = pi([[["write", { path: "a.txt", content: "agent a\n" }]], [["bash", { command: "uname -s && cat a.txt && echo made > b.txt" }]]]);
    assert.equal(r.status, 0, r.stderr.slice(-1500));
    assert.match(r.stdout, /SCRIPT_DONE/);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "host a\n");
    assert.equal(existsSync(join(cwd, "b.txt")), false);
    return `exit 0 in ${r.ms} ms`;
  });

  await (async () => {
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      piAsync([[["bash", { command: "echo A > same.txt; sleep 0.5; cat same.txt" }]]]),
      piAsync([[["bash", { command: "echo B > same.txt; sleep 0.5; cat same.txt" }]]]),
    ]);
    step("two concurrent pi sessions in one folder share one Project Store and stay isolated", () => {
      assert.equal(a.status, 0, a.stderr.slice(-600));
      assert.equal(b.status, 0, b.stderr.slice(-600));
      assert.equal(existsSync(join(cwd, "same.txt")), false);
      const vols = docker("volume", "ls", "-q", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
      assert.equal(vols.length, 1, `expected 1 shared project volume, got: ${vols}`);
      const bindings = JSON.parse(readFileSync(join(base, "lfs/state/bindings.json"), "utf8"));
      const sessions = Object.entries(bindings.sessions);
      console.log("  sessions:", JSON.stringify(sessions.map(([k, v]) => [k, v.workBranch])));
      assert.ok(sessions.length >= 2, `sessions recorded in bindings.json: ${sessions.length}`);
      assert.equal(new Set(sessions.map(([, v]) => v.workBranch)).size, sessions.length, "each session has its own branch");
      return `both exit 0 in ${Date.now() - t0} ms on shared volume ${vols[0]}`;
    });
  })();

  step("--no-layerfs: explicit opt-out writes the host folder", () => {
    const r = pi([[["write", { path: "c.txt", content: "host c\n" }]]], ["--no-layerfs"]);
    assert.equal(r.status, 0, r.stderr.slice(-800));
    assert.equal(readFileSync(join(cwd, "c.txt"), "utf8"), "host c\n");
  });

  step("missing Docker image: run reports the error; nothing written to host", () => {
    const r = pi([[["write", { path: "d.txt", content: "x" }]]], [], { PI_LAYERFS_IMAGE: "pi-lfs-missing:none" });
    assert.equal(existsSync(join(cwd, "d.txt")), false);
    assert.match(r.stdout + r.stderr, /SCRIPT_DONE/);
    return `exit ${r.status}`;
  });
} finally {
  const left = docker("ps", "-aq", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed; cleaned ${left.length} containers, ${vols.length} volumes`);
  rmSync(base, { recursive: true, force: true });
  process.exit(results.every(Boolean) ? 0 : 1);
}
