// Regression tests for the Opus 5.5 implementation review fixes (real LayerFS).
// Run: node tests/review-fixes.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { acquireLock } from "../src/lock.ts";
import { isExcludedPath, LayerfsSession } from "../src/workspace.ts";
import { formatHistory, loadHistory } from "../src/history.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `fix-${id}`);
const config = { ...resolveConfig({}), root: join(base, "root"), prefix: `pi-lfs-fx-${id}-`, killGraceMs: 800, excludes: [...resolveConfig({}).excludes, "secrets/"] };
const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const ev = await fn(); results.push(true); console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${String(ev).slice(0, 200)}` : ""}`); }
  catch (e) { results.push(false); console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`); }
};
const out = () => { const chunks = []; return { onData: (d) => chunks.push(d.toString()), text: () => chunks.join("") }; };

let n = 0;
function project() {
  const dir = join(base, `p${++n}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "src/app.js"), "export const x = 1;\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho run\n");
  chmodSync(join(dir, "run.sh"), 0o644);
  return dir;
}
const sessions = [];
async function open(cwd, name) { const s = new LayerfsSession(cwd, `${name}-${id}`, config); sessions.push(s); await s.open(); return s; }

try {
  await step("#1 apply runs in the mutex on a pinned snapshot: a write queued during apply is not lost", async () => {
    const cwd = project();
    const s = await open(cwd, "m");
    await s.mutate("w1", "write", () => s.writeFile(join(cwd, "one.txt"), "1\n"));
    const applying = s.apply();
    const late = s.mutate("w2", "write", () => s.writeFile(join(cwd, "two.txt"), "2\n")); // queued behind apply
    const r = await applying;
    await late;
    assert.deepEqual(r.applied, ["one.txt"]);
    assert.equal(existsSync(join(cwd, "two.txt")), false, "late write is not applied by this apply");
    const d = (await s.diff()).filter((i) => i.type !== "dir").map((i) => i.path);
    assert.deepEqual(d, ["/two.txt"], "late write is still pending (not swallowed by the base advance)");
    const r2 = await s.apply();
    assert.deepEqual(r2.applied, ["two.txt"]);
    assert.equal(readFileSync(join(cwd, "two.txt"), "utf8"), "2\n");
  });

  await step("#2 lock: stale lock of a dead pid is reclaimed; live holder keeps it past 15 s via heartbeat", async () => {
    const lockDir = join(base, "locks", "t.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 999999, host: (await import("node:os")).hostname(), token: "dead", at: Date.now() }));
    const l1 = await acquireLock(lockDir, 2000); // dead pid -> reclaimed immediately
    // a second acquirer must wait while the live holder heartbeats
    let got2 = false;
    const p2 = acquireLock(lockDir, 3000).then((l) => { got2 = true; l.release(); }, (e) => e.code);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(got2, false, "live holder must keep the lock");
    l1.release();
    assert.equal(await p2, undefined);
    assert.equal(got2, true);
  });

  await step("#3 bash: host absolute paths work, nothing is rewritten in file contents, prefix-sibling paths untouched", async () => {
    const cwd = project();
    const s = await open(cwd, "p");
    const o = out();
    const sibling = `${cwd}-old/x`;
    const r = await s.mutate("b1", "bash", () => s.exec(`pwd; cat ${cwd}/a.txt; printf 'root=%s\\nsibling=%s\\n' "${cwd}" "${sibling}" > conf.txt; cat conf.txt`, cwd, o));
    assert.equal(r.value.exitCode, 0, o.text());
    assert.match(o.text(), new RegExp(`^${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`), "pwd is the host path");
    const conf = (await s.readFile(join(cwd, "conf.txt"))).toString();
    assert.equal(conf, `root=${cwd}\nsibling=${sibling}\n`, "file content keeps host paths verbatim");
    assert.doesNotMatch(o.text(), /\/workspaces\//);
  });

  await step("#3 per-exec bind is private: two sessions in one Sandbox see their own branch at the same path", async () => {
    const cwd = project();
    const a = await open(cwd, "pa");
    const b = await open(cwd, "pb");
    await a.mutate("x", "write", () => a.writeFile(join(cwd, "who.txt"), "A\n"));
    await b.mutate("y", "write", () => b.writeFile(join(cwd, "who.txt"), "B\n"));
    const oa = out(), ob = out();
    await Promise.all([
      a.exec(`sleep 0.4; cat ${cwd}/who.txt`, cwd, oa),
      b.exec(`sleep 0.4; cat ${cwd}/who.txt`, cwd, ob),
    ]);
    assert.equal(oa.text().trim(), "A");
    assert.equal(ob.text().trim(), "B");
  });

  await step("#3 abort before the command records its SID still stops it; abort/timeout reap the tree", async () => {
    const cwd = project();
    const s = await open(cwd, "k");
    const ac = new AbortController();
    const p = s.exec("trap '' TERM; sleep 300", cwd, { onData: () => {}, signal: ac.signal });
    ac.abort(); // immediately, likely before the SID file exists
    await assert.rejects(p, /aborted/);
    await assert.rejects(s.exec("sleep 30", cwd, { onData: () => {}, timeout: 1 }), /timeout:1/);
    const ctr = docker("ps", "--filter", `name=^${config.prefix}${s.project}-`, "--format", "{{.Names}}").stdout.trim().split("\n")[0];
    if (ctr) assert.equal(docker("exec", ctr, "sh", "-c", "pgrep -f 'sleep (300|30)' || true").stdout.trim(), "");
  });

  await step("#4 grep: a glob with quotes/shell syntax is data, not code", async () => {
    const cwd = project();
    const s = await open(cwd, "g");
    const marker = `/tmp/pwned-${id}`;
    await s.grepWorkspace({ pattern: "x\\s*=", path: ".", glob: `*.js';touch ${marker};'` }).catch(() => {});
    const ctr = docker("ps", "--filter", `name=^${config.prefix}${s.project}-`, "--format", "{{.Names}}").stdout.trim().split("\n")[0];
    if (ctr) assert.equal(docker("exec", ctr, "sh", "-c", `test -e ${marker} && echo yes || echo no`).stdout.trim(), "no", "no command injection");
    const ok = await s.grepWorkspace({ pattern: "x\\s*=", path: ".", glob: "*.js" });
    assert.equal(ok.matches, 1);
  });

  await step("#5 apply re-checks each file right before writing (TOCTOU) and reports a partial apply", async () => {
    const cwd = project();
    const s = await open(cwd, "t");
    await s.mutate("1", "write", () => s.writeFile(join(cwd, "aaa.txt"), "agent\n"));
    await s.mutate("2", "write", () => s.writeFile(join(cwd, "src/app.js"), "export const x = 2;\n"));
    // simulate the user saving src/app.js after the check but before the write
    const realWrite = fsp.writeFile;
    let hooked = false;
    fsp.writeFile = async (...args) => {
      if (!hooked && String(args[0]).includes("aaa.txt")) { hooked = true; writeFileSync(join(cwd, "src/app.js"), "export const x = 99; // user\n"); }
      return realWrite.apply(fsp, args);
    };
    try {
      await assert.rejects(s.apply(), (e) => e.code === "ChangedDuringApply" && e.result.conflicts.includes("src/app.js"));
    } finally { fsp.writeFile = realWrite; }
    assert.equal(readFileSync(join(cwd, "src/app.js"), "utf8"), "export const x = 99; // user\n", "user save is kept");
    assert.equal(readFileSync(join(cwd, "aaa.txt"), "utf8"), "agent\n", "the file written before the stop is reported, not rolled back");
    assert.equal(readdirSync(cwd).filter((f) => f.includes(".pi-layerfs-")).length, 0, "no temp files left");
  });

  await step("#5 directory in the way = conflict; exec-bit-only change is applied", async () => {
    const cwd = project();
    const s = await open(cwd, "d");
    await s.mutate("1", "write", () => s.writeFile(join(cwd, "thing"), "file\n"));
    mkdirSync(join(cwd, "thing")); // user made a directory with that name
    const r = await s.apply();
    assert.deepEqual(r.conflicts, ["thing"]);
    // exec bit only
    const cwd2 = project();
    const s2 = await open(cwd2, "x");
    await s2.mutate("1", "bash", () => s2.exec("chmod +x run.sh", cwd2, { onData: () => {} }));
    const r2 = await s2.apply();
    assert.deepEqual(r2.applied, ["run.sh"]);
    assert.ok(statSync(join(cwd2, "run.sh")).mode & 0o100, "exec bit reached the host");
  });

  await step("#5 /tree back before an apply: apply refuses to revert unless --revert", async () => {
    const cwd = project();
    const s = await open(cwd, "r");
    const c1 = await s.mutate("1", "write", () => s.writeFile(join(cwd, "a.txt"), "v1\n"));
    await s.mutate("2", "write", () => s.writeFile(join(cwd, "a.txt"), "v2\n"));
    await s.apply();
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "v2\n");
    await s.switchToRef(c1.checkpoint.commit);
    await assert.rejects(s.apply(), (e) => e.code === "WouldRevert");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "v2\n", "host untouched");
    await s.apply({ allowRevert: true });
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "v1\n");
  });

  await step("#5 main publish failure is reported and marks mainStale; next start resyncs main", async () => {
    const cwd = project();
    const s = await open(cwd, "s");
    await s.mutate("1", "write", () => s.writeFile(join(cwd, "pub.txt"), "p\n"));
    const realPub = s.lfs.branch.publish.bind(s.lfs.branch);
    s.lfs.branch.publish = async () => { throw Object.assign(new Error("injected"), { code: "Busy" }); };
    const r = await s.apply();
    s.lfs.branch.publish = realPub;
    assert.deepEqual(r.applied, ["pub.txt"]);
    assert.match(r.warnings.join(" "), /main could not be updated/);
    assert.equal(s.bindings.byName(s.project).mainStale, true);
    const s2 = await open(cwd, "s2");
    assert.equal((await s2.readFile(join(cwd, "pub.txt"))).toString(), "p\n", "next session sees the applied file via resync");
    assert.equal(s2.bindings.byName(s2.project).mainStale, false);
  });

  await step("sync: an unreadable directory aborts the sync instead of deleting it from main", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "locked"));
    writeFileSync(join(cwd, "locked/keep.txt"), "keep\n");
    const s = await open(cwd, "u");
    chmodSync(join(cwd, "locked"), 0o000);
    try {
      await assert.rejects(s.syncHostDriftIntoMain(), (e) => e.code === "ScanFailed");
    } finally { chmodSync(join(cwd, "locked"), 0o755); }
    assert.equal((await s.lfs.fs.read("main", "/locked/keep.txt")).text, "keep\n", "main still has it");
  });

  await step("#8 excludes: nested, case-insensitive, directory patterns; same in import and sync", async () => {
    const E = config.excludes;
    for (const p of [".env", "a/b/.env", ".ENV", "app/.env.local", "deep/x.KEY", "secrets/a.txt", "x/secrets/a.txt"]) assert.equal(isExcludedPath(p, E), true, p);
    for (const p of ["src/env.ts", "envs/a", "secrets.md"]) assert.equal(isExcludedPath(p, E), false, p);
    const cwd = project();
    mkdirSync(join(cwd, "secrets"));
    writeFileSync(join(cwd, "secrets/token.txt"), "t\n");
    mkdirSync(join(cwd, "app"));
    writeFileSync(join(cwd, "app/.ENV"), "S=1\n");
    const s = await open(cwd, "e");
    assert.equal(await s.exists(join(cwd, "secrets/token.txt")), false, "not imported");
    assert.equal(await s.exists(join(cwd, "app/.ENV")), false, "case-insensitive");
    writeFileSync(join(cwd, "secrets/new.txt"), "n\n"); // added later on the host
    await s.syncHostDriftIntoMain();
    await assert.rejects(s.lfs.fs.stat("main", "/secrets/new.txt"), (e) => e.code === "NoSuchPath", "not synced either");
  });

  await step("outside-project reads: configured excludes and $HOME credentials refused, also via symlink", async () => {
    const cwd = project();
    const s = await open(cwd, "o");
    writeFileSync(join(base, "other.env"), "x\n");
    mkdirSync(join(base, "elsewhere"), { recursive: true });
    writeFileSync(join(base, "elsewhere/.env"), "SECRET=1\n");
    writeFileSync(join(base, "notes.md"), "ok\n");
    await assert.rejects(s.readFile(join(base, "elsewhere/.env")), /secret file/);
    // symlink outside the project pointing at a $HOME credential file
    const real = join(homedir(), ".pi/agent/auth.json");
    const link = join(base, "innocent.txt");
    (await import("node:fs")).symlinkSync(real, link);
    await assert.rejects(s.readFile(link), /secret file|ENOENT/);
    assert.equal((await s.readFile(join(base, "notes.md"))).toString(), "ok\n");
  });

  await step("N1: background jobs started by bash die with the command (PID namespace)", async () => {
    const cwd = project();
    const s = await open(cwd, "n1");
    const r = await s.exec("nohup sh -c 'sleep 200' >/dev/null 2>&1 & (setsid sleep 201 &) ; echo started", cwd, { onData: () => {} });
    assert.equal(r.exitCode, 0);
    const ctr = docker("ps", "--filter", `name=^${config.prefix}${s.project}-`, "--format", "{{.Names}}").stdout.trim().split("\n")[0];
    const left = ctr ? docker("exec", ctr, "sh", "-c", "pgrep -f 'sleep 20[01]' || true").stdout.trim() : "";
    assert.equal(left, "", `leftover background processes: ${left}`);
  });

  await step("N2/N3: partial apply marks mainStale; another session's publish does not clear it", async () => {
    const cwd = project();
    const a = await open(cwd, "n2a");
    const b = await open(cwd, "n2b");
    await a.mutate("1", "write", () => a.writeFile(join(cwd, "aa1.txt"), "1\n"));
    await a.mutate("2", "write", () => a.writeFile(join(cwd, "zz2.txt"), "2\n"));
    const realRename = fsp.rename;
    let n = 0;
    fsp.rename = async (...args) => { if (String(args[1]).endsWith("zz2.txt") && n++ === 0) throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); return realRename.apply(fsp, args); };
    try { await assert.rejects(a.apply(), (e) => e.result?.applied?.includes("aa1.txt")); } finally { fsp.rename = realRename; }
    assert.equal(a.bindings.byName(a.project).mainStale, true, "partial apply marks stale");
    await b.mutate("3", "write", () => b.writeFile(join(cwd, "bb.txt"), "b\n"));
    const rb = await b.apply();
    assert.deepEqual(rb.applied, ["bb.txt"]);
    assert.equal(b.bindings.byName(b.project).mainStale, true, "another session's publish must not clear stale");
    const c = await open(cwd, "n2c");
    assert.equal((await c.readFile(join(cwd, "aa1.txt"))).toString(), "1\n", "full resync brings the partially applied file into main");
    assert.equal(c.bindings.byName(c.project).mainStale, false);
  });

  await step("N6: /tree back then edit -> apply still refuses to revert applied content", async () => {
    const cwd = project();
    const s = await open(cwd, "n6");
    const c1 = await s.mutate("1", "write", () => s.writeFile(join(cwd, "a.txt"), "v1\n"));
    await s.mutate("2", "write", () => s.writeFile(join(cwd, "a.txt"), "v2\n"));
    await s.apply();
    await s.switchToRef(c1.checkpoint.commit);
    await s.mutate("3", "write", () => s.writeFile(join(cwd, "new.txt"), "n\n")); // edit after going back
    await assert.rejects(s.apply(), (e) => e.code === "WouldRevert");
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "v2\n");
  });

  await step("two sessions that both ran git: apply + merge on .git metadata does not conflict (.lww .git/)", async () => {
    const cwd = project();
    spawnSync("git", ["-C", cwd, "init", "-q"]); spawnSync("git", ["-C", cwd, "add", "-A"]); spawnSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);
    const a = await open(cwd, "ga");
    const b = await open(cwd, "gb");
    await a.mutate("1", "bash", () => a.exec("git status >/dev/null; git add -A; echo A > a.txt", cwd, { onData: () => {} }));
    await b.mutate("2", "bash", () => b.exec("git status >/dev/null; git log -1 >/dev/null; echo B > src/app.js", cwd, { onData: () => {} }));
    const ra = await a.apply();
    const rb = await b.apply();
    assert.deepEqual(ra.warnings, []);
    assert.deepEqual(rb.warnings, [], `merge/publish warnings: ${rb.warnings}`);
    assert.equal((await a.lfs.fs.read("main", "/a.txt")).text, "A\n");
    assert.equal((await a.lfs.fs.read("main", "/src/app.js")).text, "B\n");
  });

  await step("brace excludes are honored at import (*.{pem,crt})", async () => {
    const cwd = project();
    writeFileSync(join(cwd, "server.pem"), "P\n");
    writeFileSync(join(cwd, "server.crt"), "C\n");
    const s = new LayerfsSession(cwd, `br-${id}`, { ...config, excludes: [...config.excludes, "*.{pem,crt}"] });
    sessions.push(s);
    await s.open();
    assert.equal(await s.exists(join(cwd, "server.pem")), false);
    assert.equal(await s.exists(join(cwd, "server.crt")), false);
    await assert.rejects(s.lfs.fs.stat("main", "/server.pem"), (e) => e.code === "NoSuchPath");
  });
  await step("merge: a lead session merges sub-agent branches and applies them; /tmp alias is one project", async () => {
    const cwd = project();
    const alias = cwd.replace(/^\/Users\//, "/Users/"); // same path; realpath check below uses a symlink
    const link = `${cwd}-link`;
    (await import("node:fs")).symlinkSync(cwd, link);
    const lead = await open(link, "ml"); // opened through a symlink
    const w1 = await open(cwd, "mw1");
    const w2 = await open(cwd, "mw2");
    assert.equal(lead.project, w1.project, "symlinked path and real path are one project");
    await w1.mutate("1", "write", () => w1.writeFile(join(cwd, "w1.txt"), "one\n"));
    await w2.mutate("2", "write", () => w2.writeFile(join(cwd, "w2.txt"), "two\n"));
    const m1 = await lead.mergeBranch(w1.workBranch);
    const m2 = await lead.mergeBranch(w2.workBranch);
    assert.ok(m1.merged && m2.merged);
    const r = await lead.apply();
    assert.deepEqual(r.applied.sort(), ["w1.txt", "w2.txt"]);
    // conflict: both edit the same line
    await w1.mutate("3", "write", () => w1.writeFile(join(cwd, "a.txt"), "from w1\n"));
    await w2.mutate("4", "write", () => w2.writeFile(join(cwd, "a.txt"), "from w2\n"));
    assert.ok((await lead.mergeBranch(w1.workBranch)).merged);
    const c = await lead.mergeBranch(w2.workBranch);
    assert.equal(c.merged, false);
    assert.deepEqual(c.conflicts.map((x) => x.path), ["a.txt"]);
    // sync: an older session merges main (advanced by the lead's apply) into its branch
    const late = await open(cwd, "mlate");
    const lead2 = await open(cwd, "ml2");
    await lead2.mutate("5", "write", () => lead2.writeFile(join(cwd, "trunk.txt"), "trunk\n"));
    await lead2.apply();
    assert.equal(await late.exists(join(cwd, "trunk.txt")), false);
    const sy = await late.mergeBranch("main");
    assert.ok(sy.merged, JSON.stringify(sy.conflicts));
    assert.equal((await late.readFile(join(cwd, "trunk.txt"))).toString(), "trunk\n", "sync brings main in");
    void alias;
  });

  await step("branch-only: target/ stays in branches, is never applied, survives a full sync, host target/ is not drift", async () => {
    const cwd = project();
    const bcfg = { ...config, branchOnly: ["target/", ".cargo-home/"] };
    const mk = async (name) => { const s = new LayerfsSession(cwd, `${name}-${id}`, bcfg); sessions.push(s); await s.open(); return s; };
    mkdirSync(join(cwd, "target"), { recursive: true });
    writeFileSync(join(cwd, "target/host-only.bin"), "host build\n"); // a host build dir: never imported
    const a = await mk("bo1");
    assert.equal(await a.exists(join(cwd, "target/host-only.bin")), false, "host target/ not imported");
    const out1 = out();
    await a.mutate("b", "bash", () => a.exec("mkdir -p target/debug && echo artifact > target/debug/app && echo src > lib.rs", cwd, out1));
    assert.ok(a.unapplied);
    const r = await a.apply();
    assert.deepEqual(r.applied, ["lib.rs"], "only source is applied");
    assert.equal(existsSync(join(cwd, "target/debug/app")), false, "artifact never reaches the host");
    assert.equal(a.unapplied, false, "branch-only changes do not count as unapplied");
    // full sync (host vs main) must not delete target/ from main
    const sy = await a.syncHostDriftIntoMain({ full: true });
    assert.deepEqual(sy.synced, [], `nothing to sync, got ${sy.synced}`);
    const b = await mk("bo2"); // new session forks from main: inherits the build cache
    assert.equal((await b.readFile(join(cwd, "target/debug/app"))).toString(), "artifact\n", "new session inherits target/ from main");
    // host edits to target/ are not drift
    writeFileSync(join(cwd, "target/host-only.bin"), "changed\n");
    assert.deepEqual((await b.syncHostDriftIntoMain()).synced, []);
    // team merge: two sessions both rebuilt target/: lww takes the newer side, no conflict
    const o2 = out(), o3 = out();
    await a.mutate("c", "bash", () => a.exec("echo a > target/debug/app && echo a > a-src.rs", cwd, o2));
    await b.mutate("d", "bash", () => b.exec("echo b > target/debug/app && echo b > b-src.rs", cwd, o3));
    const m = await a.mergeBranch(b.workBranch);
    assert.ok(m.merged, `merge with both target/ edits: ${JSON.stringify(m.conflicts)}`);
  });

  await step("team round: lead applies, worker forks the new main, lead merges it and applies again (no false WouldRevert)", async () => {
    const cwd = project();
    const lead = await open(cwd, "tr-lead");
    await lead.mutate("1", "write", () => lead.writeFile(join(cwd, "skel.txt"), "skel\n"));
    assert.deepEqual((await lead.apply()).applied, ["skel.txt"]);
    const w = await open(cwd, "tr-w"); // forks main after the apply
    await w.mutate("2", "write", () => w.writeFile(join(cwd, "w.txt"), "w\n"));
    const m = await lead.mergeBranch(w.workBranch);
    assert.ok(m.merged, JSON.stringify(m.conflicts));
    const r = await lead.apply();
    assert.deepEqual(r.applied, ["w.txt"]);
    // second round
    const w2 = await open(cwd, "tr-w2");
    await w2.mutate("3", "write", () => w2.writeFile(join(cwd, "w2.txt"), "w2\n"));
    await lead.mutate("4", "write", () => lead.writeFile(join(cwd, "lead.txt"), "l\n"));
    assert.ok((await lead.mergeBranch(w2.workBranch)).merged);
    assert.deepEqual((await lead.apply()).applied.sort(), ["lead.txt", "w2.txt"]);
  });

  await step("bash keeps working after the Sandbox container restarts (runner reinstalled, not cached)", async () => {
    const cwd = project();
    const s = await open(cwd, "rr");
    const o1 = out();
    await s.mutate("1", "bash", () => s.exec("echo one", cwd, o1));
    const ctrs = docker("ps", "--format", "{{.Names}}", "--filter", `name=^${config.prefix}`).stdout.split("\n").filter((n) => n && !n.endsWith("store"));
    assert.ok(ctrs.length, "a Sandbox container exists");
    for (const c of ctrs) docker("exec", "-u", "0", c, "sh", "-c", "rm -f /run/pi-lfs/pi-lfs-run-*.sh"); // what a restart does to /run
    const o2 = out();
    const r = await s.mutate("2", "bash", () => s.exec("echo two", cwd, o2));
    assert.equal(r.value.exitCode, 0, o2.text());
    assert.match(o2.text(), /two/);
  });

  await step("history folds branch-only build output into a count; unapplied ignores it", async () => {
    const cwd = project();
    const s = new LayerfsSession(cwd, `hb-${id}`, { ...config, branchOnly: ["target/"] });
    sessions.push(s);
    await s.open();
    const o = out();
    await s.mutate("1", "bash", () => s.exec("mkdir -p target/d && for i in 1 2 3; do echo $i > target/d/f$i; done && echo x > src.rs", cwd, o));
    const v = await loadHistory(s, 5);
    const text = formatHistory(v);
    assert.match(text, /~?\+?src\.rs/);
    assert.match(text, /\(\+3 build files\)/);
    assert.doesNotMatch(text, /target\/d\/f1/);
    assert.equal(v.unapplied.length, 1, JSON.stringify(v.unapplied));
  });

} finally {
  for (const s of sessions) await s.close().catch(() => {});
  const left = docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${config.prefix}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed; cleaned ${left.length} containers, ${vols.length} volumes`);
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
}
