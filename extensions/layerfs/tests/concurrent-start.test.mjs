// Several Pi processes (e.g. parallel sub-agents) start against a fresh LayerFS root at once:
// each must open its own session (Store container start, project init and the store file race).
// Run: node tests/concurrent-start.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stopNativeDaemons } from "../src/workspace.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `cs-${id}`);
const prefix = `pi-lfs-cs-${id}-`;
const cwd = join(base, "proj");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(cwd, "a.txt"), "a\n");
const child = `
  import { resolveConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).pathname)};
  import { LayerfsSession } from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).pathname)};
  const s = new LayerfsSession(process.argv[1], "cs-" + process.argv[2], { ...resolveConfig({}), root: process.argv[3], prefix: process.argv[4] });
  await s.open();
  await s.mutate("w", "write", () => s.writeFile(process.argv[1] + "/w" + process.argv[2] + ".txt", "x"));
  console.log("OK", s.project, s.workBranch);
  await s.close();
`;
const N = 4;
const t0 = Date.now();
const runs = await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
  const p = spawn(process.execPath, ["--input-type=module", "-e", child, cwd, String(i), join(base, "root"), prefix], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => res({ code, out }));
})));
let ok = false;
try {
  for (const r of runs) assert.equal(r.code, 0, r.out.slice(-600));
  const projects = new Set(runs.map((r) => r.out.match(/^OK (\S+)/m)?.[1]));
  assert.equal(projects.size, 1, `all sessions share one project: ${[...projects]}`);
  const storesDir = join(base, "root/stores");
  const storeDirs = existsSync(storesDir) ? readdirSync(storesDir).filter((d) => !d.startsWith(".")) : [];
  assert.equal(storeDirs.length, 1, `expected 1 shared project store, got: ${storeDirs}`);
  ok = true;
  console.log(`PASS ${N} concurrent processes opened one shared project (${Date.now() - t0} ms)`);
} catch (e) {
  console.log(`FAIL ${e.message}`);
} finally {
  await stopNativeDaemons(join(base, "root/local")).catch(() => {});
  rmSync(base, { recursive: true, force: true });
  console.log(`${ok ? 1 : 0}/1 passed (zero Docker)`);
  process.exit(ok ? 0 : 1);
}
