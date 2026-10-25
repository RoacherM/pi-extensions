// Regression tests for the Opus 5.5 implementation review fixes (real LayerFS).
// Run: node tests/review-fixes.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, promises as fsp, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { acquireLock } from "../src/lock.ts";
import { isExcludedPath, LayerfsSession, stopNativeDaemons } from "../src/workspace.ts";
import { formatHistory, loadHistory } from "../src/history.ts";
import layerfsExtension from "../src/index.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `fix-${id}`);
const config = { ...resolveConfig({}), root: join(base, "root"), prefix: `pi-lfs-fx-${id}-`, killGraceMs: 800, excludes: [...resolveConfig({}).excludes, "secrets/"] };
const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
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
    const r = await s.mutate("b1", "bash", () => s.exec(`cat a.txt; echo blocked > "${cwd}/a.txt" 2>&1 || true; printf 'root=%s\\nsibling=%s\\n' "${cwd}" "${sibling}" > conf.txt; cat conf.txt`, cwd, o));
    assert.equal(r.value.exitCode, 0, o.text());
    assert.match(o.text(), /Operation not permitted/, "writing to host cwd is blocked by Seatbelt");
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
      a.exec(`sleep 0.4; cat who.txt`, cwd, oa),
      b.exec(`sleep 0.4; cat who.txt`, cwd, ob),
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
    const left = pgrep("sleep (300|30)").stdout.trim();
    assert.equal(left, "", "no lingering sleep processes");
  });

  await step("#4 grep: a glob with quotes/shell syntax is data, not code", async () => {
    const cwd = project();
    const s = await open(cwd, "g");
    const marker = `/tmp/pwned-${id}`;
    await s.grepWorkspace({ pattern: "x\\s*=", path: ".", glob: `*.js';touch ${marker};'` }).catch(() => {});
    assert.equal(existsSync(marker), false, "no command injection");
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
    const left = pgrep("sleep 20[01]").stdout.trim();
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

  await step("bash keeps working after the Sandbox daemon restarts", async () => {
    const cwd = project();
    const s = await open(cwd, "rr");
    const o1 = out();
    await s.mutate("1", "bash", () => s.exec("echo one", cwd, o1));
    assert.match(o1.text(), /one/);
    // Kill the project's layerfs-daemon process with SIGTERM
    const daemonPids = pgrep(`layerfs-daemon --config ${s.spec.localDir}/`).stdout.trim().split(/\s+/).filter(Boolean);
    for (const pid of daemonPids) {
      try { process.kill(Number(pid), "SIGTERM"); } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
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

  await step("fallback merge on InvalidRecord and after rm/mv in bash", async () => {
    const cwd = project();
    const lead = await open(cwd, "fbm-lead");
    const worker = await open(cwd, "fbm-w");
    // Part A: Injected InvalidRecord
    await lead.mutate("1", "write", () => lead.writeFile(join(cwd, "lead.txt"), "lead\n"));
    await worker.mutate("2", "write", () => worker.writeFile(join(cwd, "worker.txt"), "worker\n"));

    const realMerge = lead.lfs.branch.merge.bind(lead.lfs.branch);
    lead.lfs.branch.merge = async () => {
      throw Object.assign(new Error("invalid record: binding kind"), { code: "InvalidRecord" });
    };
    try {
      const r = await lead.mergeBranch(worker.workBranch);
      assert.equal(r.merged, true);
      assert.equal(r.fallback, true);
      assert.equal((await lead.readFile(join(cwd, "worker.txt"))).toString(), "worker\n");
      assert.equal((await lead.readFile(join(cwd, "lead.txt"))).toString(), "lead\n");
    } finally {
      lead.lfs.branch.merge = realMerge;
    }

    // Part B: Real rm/mv/script writes in bash
    await worker.mutate("3", "bash", () => worker.exec("rm a.txt && mv src/app.js src/app-renamed.js && echo 'from script' > script.txt", cwd, { onData: () => {} }));
    const r2 = await lead.mergeBranch(worker.workBranch);
    assert.equal(r2.merged, true);
    assert.equal(await lead.exists(join(cwd, "a.txt")), false);
    assert.equal(await lead.exists(join(cwd, "src/app.js")), false);
    assert.equal(await lead.exists(join(cwd, "src/app-renamed.js")), true);
    assert.equal((await lead.readFile(join(cwd, "script.txt"))).toString(), "from script\n");
  });

  await step("conflict resolution via strategy theirs and strategy ours", async () => {
    const cwd = project();
    const lead = await open(cwd, "str-lead");
    const worker = await open(cwd, "str-w");
    await lead.mutate("1", "write", () => lead.writeFile(join(cwd, "conf.txt"), "ours initial\n"));
    await worker.mutate("2", "write", () => worker.writeFile(join(cwd, "conf.txt"), "theirs v1\n"));

    const c = await lead.mergeBranch(worker.workBranch);
    assert.equal(c.merged, false);
    assert.deepEqual(c.conflicts.map((x) => x.path), ["conf.txt"]);

    const rTheirs = await lead.mergeBranch(worker.workBranch, { strategy: "theirs" });
    assert.equal(rTheirs.merged, true);
    assert.equal((await lead.readFile(join(cwd, "conf.txt"))).toString(), "theirs v1\n");

    await worker.mutate("3", "write", () => worker.writeFile(join(cwd, "conf.txt"), "theirs v2\n"));
    const rOurs = await lead.mergeBranch(worker.workBranch, { strategy: "ours" });
    assert.equal(rOurs.merged, true);
    assert.equal((await lead.readFile(join(cwd, "conf.txt"))).toString(), "theirs v1\n");
  });

  await step("layerfs show >60KB without truncation, pagination, ls, checkout, and cross-branch diff", async () => {
    const cwd = project();
    process.env.PI_LAYERFS_TEAM = "1";
    process.env.PI_LAYERFS_ROOT = config.root;
    process.env.PI_LAYERFS_PREFIX = config.prefix;

    let layerfsTool;
    let sessionStartHandler;
    let sessionShutdownHandler;
    const fakePi = {
      registerFlag: () => {},
      registerTool: (t) => { if (t.name === "layerfs") layerfsTool = t; },
      registerCommand: () => {},
      on: (evt, fn) => {
        if (evt === "session_start") sessionStartHandler = fn;
        if (evt === "session_shutdown") sessionShutdownHandler = fn;
      },
      appendEntry: () => {},
      events: { emit: () => {} },
      getFlag: () => false,
    };
    layerfsExtension(fakePi);
    assert.ok(layerfsTool, "layerfs tool registered");

    const fakeCtx = {
      cwd,
      sessionManager: { getSessionId: () => `lead-${id}`, getBranch: () => [] },
      ui: { setStatus: () => {}, notify: () => {} },
    };
    await sessionStartHandler({ reason: "startup" }, fakeCtx);

    const worker = new LayerfsSession(cwd, `show-w-${id}`, { ...config, branchName: "worker-feat" });
    sessions.push(worker);
    await worker.open();

    // Create >60KB file (1200 lines, ~70KB) on worker branch
    const bigContent = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}: ${"x".repeat(50)}\n`).join("");
    assert.ok(bigContent.length > 60000);
    await worker.mutate("1", "write", () => worker.writeFile(join(cwd, "big.txt"), bigContent));

    // 1. show >60KB file without 49KB truncation
    const showRes = await layerfsTool.execute("c1", { action: "show", branch: "worker-feat", path: "big.txt" }, null, null, fakeCtx);
    assert.equal(showRes.content[0].text, bigContent);

    // 2. show with offset and limit pagination
    const pageRes = await layerfsTool.execute("c2", { action: "show", branch: "worker-feat", path: "big.txt", offset: 10, limit: 5 }, null, null, fakeCtx);
    assert.ok(pageRes.content[0].text.includes("showing lines 10-14 of 1200"));
    assert.ok(pageRes.content[0].text.includes("pass offset=15 to read more"));

    // 3. show on a directory
    const dirRes = await layerfsTool.execute("c3", { action: "show", branch: "worker-feat", path: "src" }, null, null, fakeCtx);
    assert.equal(dirRes.content[0].text.trim(), "app.js");

    // 4. action=ls
    const lsRes = await layerfsTool.execute("c4", { action: "ls", branch: "worker-feat", path: "/" }, null, null, fakeCtx);
    assert.ok(lsRes.content[0].text.includes("src/"));
    assert.ok(lsRes.content[0].text.includes("big.txt"));

    // 5. action=checkout
    const coRes = await layerfsTool.execute("c5", { action: "checkout", branch: "worker-feat", path: "big.txt" }, null, null, fakeCtx);
    assert.ok(coRes.content[0].text.includes("Checked out 1 file(s)"));
    const leadCheck = await layerfsTool.execute("c5b", { action: "show", branch: "lead", path: "big.txt" }, null, null, fakeCtx);
    assert.equal(leadCheck.content[0].text, bigContent);

    // 6. cross-branch diff
    await worker.mutate("2", "write", () => worker.writeFile(join(cwd, "diff-check.txt"), "diff\n"));
    const diffRes = await layerfsTool.execute("c6", { action: "diff", branch: "worker-feat", base: "main" }, null, null, fakeCtx);
    assert.ok(diffRes.content[0].text.includes("diff-check.txt"));
    assert.ok(diffRes.content[0].text.includes("big.txt"));

    // 7. sync from worker branch
    const syncRes = await layerfsTool.execute("c7", { action: "sync", branch: "worker-feat" }, null, null, fakeCtx);
    assert.ok(syncRes.content[0].text.includes("Merged"));
    const leadCheckSync = await layerfsTool.execute("c7b", { action: "show", branch: "lead", path: "diff-check.txt" }, null, null, fakeCtx);
    assert.equal(leadCheckSync.content[0].text, "diff\n");

    await sessionShutdownHandler?.({}, fakeCtx);
  });

  await step("stable branch name resolution and filtered listUserBranches", async () => {
    const cwd = project();
    const lead = new LayerfsSession(cwd, `res-lead-${id}`, { ...config, team: true });
    sessions.push(lead);
    await lead.open();
    const worker = new LayerfsSession(cwd, `res-w-${id}`, { ...config, team: true, branchName: "worker-sub" });
    sessions.push(worker);
    await worker.open();

    const initialWorkBranch = worker.workBranch;
    assert.match(initialWorkBranch, /-1$/);

    // Rotate worker branch via merges/checkpoints
    await worker.mutate("1", "write", () => worker.writeFile(join(cwd, "f1.txt"), "1\n"));
    const sy1 = await worker.mergeBranch("main");
    assert.ok(sy1.merged);
    assert.match(worker.workBranch, /-2$/);

    await worker.mutate("2", "write", () => worker.writeFile(join(cwd, "f2.txt"), "2\n"));
    const sy2 = await worker.mergeBranch("main");
    assert.ok(sy2.merged);
    assert.match(worker.workBranch, /-3$/);

    // Resolve by logicalBranch alias
    assert.equal(await lead.resolveBranchName("worker-sub"), worker.workBranch);
    assert.equal(await lead.resolveBranchName("lead"), lead.workBranch);
    assert.equal(await lead.resolveBranchName("main"), "main");

    // Resolve by stale/old workBranch name
    assert.equal(await lead.resolveBranchName(initialWorkBranch), worker.workBranch);

    // Resolve by shortId
    assert.equal(await lead.resolveBranchName(worker.shortId), worker.workBranch);
    assert.equal(await lead.resolveBranchName(`s-${worker.shortId}`), worker.workBranch);

    // listUserBranches
    const uBranches = await lead.listUserBranches();
    const names = uBranches.map((b) => b.name);
    assert.ok(names.includes(worker.workBranch));
    assert.ok(!names.includes(initialWorkBranch));
    for (const b of uBranches) {
      assert.ok(!/^(?:[abcrhm]|sync)-/.test(b.name), `unexpected internal branch: ${b.name}`);
    }
  });

  await step("touching merged source files on next exec when target/ is branchOnly", async () => {
    const cwd = project();
    const bcfg = { ...config, branchOnly: ["target/"], team: true };
    const lead = new LayerfsSession(cwd, `tch-lead-${id}`, bcfg);
    sessions.push(lead);
    await lead.open();
    const worker = new LayerfsSession(cwd, `tch-w-${id}`, { ...bcfg, branchName: "compiler" });
    sessions.push(worker);
    await worker.open();

    // Worker creates build artifact and source
    await worker.mutate("1", "bash", () => worker.exec("mkdir -p target/debug && echo bin-v1 > target/debug/app && echo 'fn main() { 1 }' > main.rs", cwd, { onData: () => {} }));

    await new Promise((r) => setTimeout(r, 1100));

    // Lead merges worker
    const m = await lead.mergeBranch(worker.workBranch);
    assert.ok(m.merged);
    assert.ok(lead.touchPathsOnNextExec.has("main.rs"), "touchPathsOnNextExec contains main.rs");

    // Lead runs exec
    const chunks = [];
    await lead.mutate("2", "bash", () => lead.exec("(stat -f %m main.rs 2>/dev/null || stat -c %Y main.rs) && (stat -f %m target/debug/app 2>/dev/null || stat -c %Y target/debug/app)", cwd, { onData: (d) => chunks.push(d.toString()) }));
    const [srcMtime, appMtime] = chunks.join("").trim().split(/\s+/).map(Number);
    assert.ok(srcMtime >= appMtime, `main.rs (${srcMtime}) must be >= target/debug/app (${appMtime})`);
  });

  await step("fallbackMergeBranch with forkedFrom commit:..., +x mode and symlink, then lead.apply() without WouldRevert", async () => {
    const cwd = project();
    const lead = await open(cwd, "fbm-sym-lead");
    const worker = await open(cwd, "fbm-sym-w");

    // Lead writes an initial file and applies it, so lead.baseRef becomes a commit
    await lead.mutate("1", "write", () => lead.writeFile(join(cwd, "lead-init.txt"), "lead initial\n"));
    const applyInit = await lead.apply();
    assert.ok(applyInit.applied.includes("lead-init.txt"));
    assert.ok(lead.baseRef, "lead has a baseRef");

    // Worker creates an executable script and a symlink
    await worker.mutate("2", "bash", () =>
      worker.exec("echo '#!/bin/sh\necho test' > test.sh && chmod +x test.sh && ln -s test.sh link-test.sh", cwd, { onData: () => {} })
    );

    // Also worker modifies run.sh mode to +x without changing its content (content identical to base, mode changed)
    await worker.mutate("3", "bash", () =>
      worker.exec("chmod +x run.sh", cwd, { onData: () => {} })
    );

    // Simulate other having forkedFrom: "commit:<hex>" in list_branches (P0-1)
    const realListBranches = lead.lfs.project.list_branches.bind(lead.lfs.project);
    lead.lfs.project.list_branches = async (...args) => {
      const res = await realListBranches(...args);
      if (res?.items) {
        for (const item of res.items) {
          if (item.name === worker.workBranch && item.head) {
            item.forkedFrom = `commit:${item.head}`;
          }
        }
      }
      return res;
    };

    // Simulate InvalidRecord on native merge to trigger fallbackMergeBranch
    const realMerge = lead.lfs.branch.merge.bind(lead.lfs.branch);
    lead.lfs.branch.merge = async (...args) => {
      throw Object.assign(new Error("invalid record: binding kind"), { code: "InvalidRecord" });
    };

    try {
      const r = await lead.mergeBranch(worker.workBranch);
      assert.equal(r.merged, true, "merge succeeded");
      assert.equal(r.fallback, true, "fallback merge was used");

      // Verify test.sh exists and is executable on lead
      const rExec = await lead.sh("(stat -f %Lp test.sh 2>/dev/null || stat -c %a test.sh) && (stat -f %Lp run.sh 2>/dev/null || stat -c %a run.sh) && readlink link-test.sh");
      assert.equal(rExec.code, 0);
      const lines = rExec.stdout.trim().split("\n");
      assert.ok(parseInt(lines[0], 8) & 0o111, "test.sh is executable");
      assert.ok(parseInt(lines[1], 8) & 0o111, "run.sh is executable");
      assert.equal(lines[2], "test.sh", "link-test.sh points to test.sh");

      // Verify lead.apply() succeeds without WouldRevert
      const applyRes = await lead.apply();
      assert.ok(applyRes.applied.includes("test.sh"), "applied test.sh");
      assert.ok(applyRes.applied.includes("link-test.sh"), "applied link-test.sh");
      assert.ok(applyRes.applied.includes("run.sh"), "applied run.sh");

      // Verify host state
      const hostTestSh = statSync(join(cwd, "test.sh"));
      assert.ok(hostTestSh.mode & 0o111, "host test.sh has +x");
      const hostRunSh = statSync(join(cwd, "run.sh"));
      assert.ok(hostRunSh.mode & 0o111, "host run.sh has +x");
      assert.ok(lstatSync(join(cwd, "link-test.sh")).isSymbolicLink(), "host link-test.sh is symlink");
      assert.equal(readlinkSync(join(cwd, "link-test.sh")), "test.sh");
    } finally {
      lead.lfs.project.list_branches = realListBranches;
      lead.lfs.branch.merge = realMerge;
    }
  });

} finally {
  for (const s of sessions) await s.close({ stopDaemons: true }).catch(() => {});
  await stopNativeDaemons(join(config.root, "local")).catch(() => {});
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed (zero Docker)`);
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  process.exit(results.every(Boolean) ? 0 : 1);
}
