// v0.2 Real-size repo benchmark & smoke test (22,783-file Epi checkout):
// Tests cold first-time project init, warm second-session open, Store-direct
// read/write/find/grep with 0 Sandboxes, on-demand bash, diff, apply, and close.
// Run: node tests/scale.test.mjs [sourceDir]
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { LayerfsSession } from "../src/workspace.ts";

const source = process.argv[2] ?? join(homedir(), "Projects/sides/epi");
const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `scale-${id}`);
const cwd = join(base, "repo");
mkdirSync(base, { recursive: true });
const clone = spawnSync("cp", ["-c", "-R", source, cwd], { encoding: "utf8" });
assert.equal(clone.status, 0, clone.stderr);
const prefix = `pi-lfs-sc-${id}-`;
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const timings = {};
const time = async (k, fn) => { const t0 = Date.now(); const v = await fn(); timings[k] = Date.now() - t0; return v; };

const cfg = { ...resolveConfig({}), root: join(base, "lfs"), prefix };
const s1 = new LayerfsSession(cwd, `scale1-${id}`, cfg, (m) => console.log(`  [s1] ${m}`));
const s2 = new LayerfsSession(cwd, `scale2-${id}`, cfg, (m) => console.log(`  [s2] ${m}`));
let ok = false;

try {
  await time("1_cold_open_23k_files", () => s1.open());
  await time("2_warm_second_session_open_23k_files", () => s2.open());
  assert.equal(s1.project, s2.project);

  const g = await time("3_store_literal_grep_TaskRuntime", () => s1.grepWorkspace({ pattern: "TaskRuntime", path: "src" }));
  assert.ok(g.lines.some((l) => l.includes("task-runtime.ts")));

  const found = await time("4_store_find_ts_files", () => s1.findFiles("**/*.ts", join(cwd, "src"), { ignore: [], limit: 200 }));
  assert.ok(found.length > 10);

  const before = readFileSync(join(cwd, "README.md"), "utf8");
  const w = await time("5_store_write_and_checkpoint", () => s1.mutate("w1", "write", () => s1.writeFile(join(cwd, "README.md"), before + "\nlayerfs v0.2 scale test\n")));
  assert.ok(w.checkpoint?.commit);

  const sandboxesBeforeBash = docker("ps", "-q", "--filter", `name=^${prefix}`, "--filter", "label=layerfs.role=sandbox").stdout.trim();
  assert.equal(sandboxesBeforeBash, "", "all Store ops on 23k-file repo must run with 0 Sandboxes");

  const b = await time("6_on_demand_bash_find_wc", () => s1.mutate("b1", "bash", () => s1.exec(`find src -name '*.ts' | xargs wc -l | tail -1 > loc.txt`, cwd, { onData: () => {} })));
  assert.equal(b.value.exitCode, 0);

  const d = await time("7_diff", () => s1.diff());
  const a = await time("8_apply", () => s1.apply());
  assert.deepEqual(a.conflicts, []);
  assert.match(readFileSync(join(cwd, "README.md"), "utf8"), /layerfs v0.2 scale test/);

  await time("9_close", async () => { await s1.close(); await s2.close(); });
  console.log(JSON.stringify({
    source,
    foundTsInSrc: found.length,
    grepMatches: g.matches,
    diff: d.filter((i) => i.type !== "dir").map((i) => `${i.kind}:${i.path}`),
    applied: a.applied,
    timings,
  }, null, 2));
  ok = true;
} catch (e) {
  console.log("ERROR", e.stack?.split("\n").slice(0, 6).join("\n"), "\ntimings so far", JSON.stringify(timings));
} finally {
  await s1.close().catch(() => {});
  await s2.close().catch(() => {});
  const left = docker("ps", "-aq", "--filter", `name=^${prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  rmSync(base, { recursive: true, force: true });
  console.log(`${ok ? "PASS" : "FAIL"} scale; cleaned ${left.length} containers, ${vols.length} volumes`);
  process.exit(ok ? 0 : 1);
}
