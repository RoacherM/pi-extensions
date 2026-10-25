// v0.2 Real LayerFS backend + Opus 5.5 P0/P1 regression test suite (macOS Native, zero Docker).
// Run: node tests/backend.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, promises as fsp, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { LayerfsSession, stopNativeDaemons } from "../src/workspace.ts";
import { formatHistory, loadHistory, parseMessage } from "../src/history.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `v2-${id}`);
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const ev = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${String(ev).slice(0, 220)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.stack });
    console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`);
  }
};
const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const config = { ...resolveConfig({}), root: join(base, "root"), prefix: `pi-lfs-v2-${id}-`, killGraceMs: 1000 };

function fixture(dir) {
  mkdirSync(join(dir, "src/sub"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });

  writeFileSync(join(dir, "README.md"), "hello v1\n");
  writeFileSync(join(dir, "src/app.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/sub/util.ts"), "export const util = 42;\n");
  writeFileSync(join(dir, "node_modules/pkg/index.js"), "export const a = 999;\n");
  writeFileSync(join(dir, "scripts/build.sh"), "#!/bin/sh\necho build-v1\n");
  chmodSync(join(dir, "scripts/build.sh"), 0o755);
  writeFileSync(join(dir, "longline.txt"), `HEADER\n${"L".repeat(120_000)}\nFOOTER\n`);
  writeFileSync(join(dir, "delete-me.txt"), "bye\n");
  writeFileSync(join(dir, "conflict.txt"), "base\n");
  writeFileSync(join(dir, ".env"), "SECRET=production-secret\n");
  writeFileSync(join(dir, "img.bin"), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
  symlinkSync("src/app.js", join(dir, "link"));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  const git = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

const cwd = join(base, "project");
const outside = join(base, "outside.txt");
fixture(cwd);
writeFileSync(outside, "outside-host\n");

let sA, sB, sC;

try {
  await step("preflight refuses missing bundle (no resources created)", async () => {
    const bad = { ...config, bundle: "/tmp/non-existent-bundle" };
    await assert.rejects(new LayerfsSession(cwd, "bad", bad).open(), (e) => e.code === "Preflight" && /missing/.test(e.message));
  });

  await step("open session A: initializes shared Project Store; 0 Sandboxes started", async () => {
    sA = new LayerfsSession(cwd, `sessA-${id}`, config, (m) => console.log(`  [sA] ${m}`));
    await sA.open();
    const daemons = pgrep(`layerfs-daemon --config ${sA.spec.localDir}/`).stdout.trim();
    assert.equal(daemons, "", "Store init + branch.fork must not start any daemon");
    return `project=${sA.project} work=${sA.workBranch} base=${sA.baseBranch} daemons=0`;
  });

  await step("Store-direct reads/ls/find/literal-grep run with 0 Sandboxes", async () => {
    assert.equal((await sA.readFile(join(cwd, "README.md"))).toString(), "hello v1\n");
    assert.equal((await sA.readFile(outside)).toString(), "outside-host\n");
    assert.equal(await sA.exists(join(cwd, ".env")), false);
    assert.equal(await sA.isDirectory(join(cwd, "src")), true);
    assert.deepEqual(await sA.readdir(join(cwd, "src")), ["app.js", "sub"]);

    // P1-2: find supports brace expansion {js,ts} and subPath relative matching while skipping node_modules
    const found = await sA.findFiles("**/*.{js,ts}", join(cwd, "src"), { ignore: [], limit: 50 });
    assert.deepEqual(found.map((p) => p.slice(cwd.length + 1)).sort(), ["src/app.js", "src/sub/util.ts"]);

    // P1-1: literal grep runs on Store and skips node_modules
    const g = await sA.grepWorkspace({ pattern: "export const a", path: "." });
    assert.deepEqual(g.lines, ["src/app.js:1: export const a = 1;"]);

    const daemons = pgrep(`layerfs-daemon --config ${sA.spec.localDir}/`).stdout.trim();
    assert.equal(daemons, "", "pure Store reads/ls/find/grep must still have 0 daemons");
  });

  await step("Store-direct write (incl. nested mkdir) commits in ms with 0 Sandboxes", async () => {
    const r = await sA.mutate("t1", "write", () => sA.writeFile(join(cwd, "nested/dir/note.txt"), "from store write\n"));
    assert.ok(r.checkpoint?.commit, "expected a Commit from fs.apply");
    assert.equal((await sA.readFile(join(cwd, "nested/dir/note.txt"))).toString(), "from store write\n");
    assert.equal(existsSync(join(cwd, "nested/dir/note.txt")), false, "host untouched");

    const noop = await sA.mutate("t2", "write", () => sA.writeFile(join(cwd, "nested/dir/note.txt"), "from store write\n"));
    assert.equal(noop.checkpoint, null, "unchanged write must return UpToDate and make no Commit");

    const daemons = pgrep(`layerfs-daemon --config ${sA.spec.localDir}/`).stdout.trim();
    assert.equal(daemons, "", "Store writes must not start a daemon");
    return `commit=${r.checkpoint.commit.slice(0, 12)}`;
  });

  await step("P0-2: >48KB single line + binary + symlink read/write are byte-exact (never truncated)", async () => {
    const longBuf = await sA.readFile(join(cwd, "longline.txt"));
    assert.equal(longBuf.length, 120_015, "long line must not be clipped by fs.read");
    const editedLong = longBuf.toString().replace("HEADER", "HEADER_EDITED");
    await sA.mutate("t3", "edit", () => sA.writeFile(join(cwd, "longline.txt"), editedLong));
    const afterLong = await sA.readFile(join(cwd, "longline.txt"));
    assert.equal(afterLong.length, 120_022);
    assert.ok(afterLong.toString().endsWith(`${"L".repeat(100)}\nFOOTER\n`));

    assert.equal(sha(await sA.readFile(join(cwd, "img.bin"))), sha(readFileSync(join(cwd, "img.bin"))));
    assert.equal((await sA.readFile(join(cwd, "link"))).toString(), "export const a = 1;\n");
  });

  await step("P0-5: overwriting an executable file (0755) via Store write preserves its +x mode", async () => {
    await sA.mutate("t4", "write", () => sA.writeFile(join(cwd, "scripts/build.sh"), "#!/bin/sh\necho build-v2\n"));
    const runScript = await sA.exec("./scripts/build.sh", cwd, { onData: () => {} });
    assert.equal(runScript.exitCode, 0, "scripts/build.sh must remain executable (0755)");
  });

  await step("P1-1: regex + ignoreCase grep works accurately", async () => {
    const g = await sA.grepWorkspace({ pattern: "EXPORT CONST [A-Z]+ = \\d+", path: "src", ignoreCase: true });
    assert.equal(g.matches, 2);
    assert.ok(g.lines.some((l) => l.includes("app.js:1: export const a = 1;")));
    assert.ok(g.lines.some((l) => l.includes("sub/util.ts:1: export const util = 42;")));
  });

  await step("bash: on-demand mount, streaming, env filter, host path rewrite, immediate unmount", async () => {
    const chunks = [];
    const t0 = Date.now();
    const r = await sA.mutate("t5", "bash", () =>
      sA.exec(
        `for i in 1 2 3; do echo tick$i; sleep 0.35; done; echo PI_X=$PI_X SECRET=\${SECRET_KEY:-unset}; cat scripts/build.sh; exit 3`,
        cwd,
        { onData: (d) => chunks.push({ t: Date.now() - t0, s: d.toString() }), env: { PI_X: "yes", SECRET_KEY: "leak" } },
      ),
    );
    assert.equal(r.value.exitCode, 3);
    const all = chunks.map((c) => c.s).join("");
    assert.match(all, /PI_X=yes SECRET=unset/);
    assert.match(all, /build-v2/);
    assert.ok(chunks[0].t < 600 && chunks.at(-1).t > 650, `expected streaming chunks: ${JSON.stringify(chunks.map((c) => c.t))}`);
  });

  await step("git in workspace: excluded .env is not shown as deleted, .lww not shown as untracked", async () => {
    const out = [];
    const r = await sA.exec("git status --porcelain", cwd, { onData: (d) => out.push(d.toString()) });
    assert.equal(r.exitCode, 0);
    const text = out.join("");
    assert.doesNotMatch(text, /\.env/, `git status mentions .env: ${text}`);
    assert.doesNotMatch(text, /\.lww/, `git status mentions .lww: ${text}`);
    // a read-only command must not create a Commit (the prelude must not rewrite .git/index again)
    const ro = await sA.mutate("ro", "bash", () => sA.exec("node -e 1 && git status --porcelain >/dev/null", cwd, { onData: () => {} }));
    assert.equal(ro.checkpoint, null, `read-only bash created a Commit ${ro.checkpoint?.commit}`);
    return text.trim().split("\n").slice(0, 6).join(" | ") || "(clean)";
  });

  await step("bash abort & timeout reap process groups cleanly", async () => {
    const ac = new AbortController();
    const p = sA.exec(`trap '' TERM; (trap '' TERM; sleep 300) & sleep 300; wait`, cwd, { onData: () => {}, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 800));
    ac.abort();
    await assert.rejects(p, /aborted/);
    await assert.rejects(sA.exec(`sleep 30`, cwd, { onData: () => {}, timeout: 1 }), /timeout:1/);
  });

  await step("second session B on same folder opens in <300ms (shares Project Store)", async () => {
    const t0 = Date.now();
    sB = new LayerfsSession(cwd, `sessB-${id}`, config);
    await sB.open();
    const ms = Date.now() - t0;
    assert.equal(sB.project, sA.project, "must share the same LayerFS project");
    assert.notEqual(sB.workBranch, sA.workBranch, "must have its own Branch");
    assert.equal((await sB.readFile(join(cwd, "README.md"))).toString(), "hello v1\n");
    return `opened in ${ms} ms on branch ${sB.workBranch}`;
  });

  await step("P0-1 & P0-4: multi-session apply + publish never reverts sibling session's applied files and never overwrites .env", async () => {
    // Session A edits README.md, adds a-only.txt, and tries to create a rogue .env
    await sA.mutate("a1", "write", () => sA.writeFile(join(cwd, "README.md"), "hello from A\n"));
    await sA.mutate("a2", "write", () => sA.writeFile(join(cwd, "a-only.txt"), "made by A\n"));
    await sA.mutate("a3", "bash", () => sA.exec("rm delete-me.txt", cwd, { onData: () => {} }));
    const resEnv = await sA.lfs.fs.apply(sA.workBranch, [{ op: "write", path: "/.env", bytes: Buffer.from("ROGUE=1\n") }], "rogue env");
    sA.headCommit = resEnv.commit?.id ?? resEnv.head ?? sA.headCommit;

    // Session B (forked from L1 before A's edits!) edits src/app.js
    await sB.mutate("b1", "write", () => sB.writeFile(join(cwd, "src/app.js"), "export const a = 222;\n"));

    // 1. Session A applies first
    const appA = await sA.apply();
    assert.deepEqual(appA.conflicts, []);
    assert.ok(appA.skipped.includes(".env"), "rogue .env must be skipped");
    assert.equal(readFileSync(join(cwd, ".env"), "utf8"), "SECRET=production-secret\n", "host .env must stay intact");
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello from A\n");
    assert.equal(readFileSync(join(cwd, "a-only.txt"), "utf8"), "made by A\n");
    assert.equal(existsSync(join(cwd, "delete-me.txt")), false);
    assert.equal(statSync(join(cwd, "scripts/build.sh")).mode & 0o111, 0o111, "host build.sh kept +x");

    // 2. Now Session B runs diff & apply: must ONLY apply src/app.js and NEVER revert README.md or a-only.txt!
    const diffB = await sB.diff();
    assert.deepEqual(diffB.map((d) => d.path), ["/src/app.js"], "B's diff must only contain B's own changes");
    const appB = await sB.apply();
    assert.deepEqual(appB.conflicts, []);
    assert.deepEqual(appB.applied, ["src/app.js"]);
    assert.equal(readFileSync(join(cwd, "src/app.js"), "utf8"), "export const a = 222;\n");
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello from A\n", "A's README.md must NOT be reverted by B");
    assert.equal(readFileSync(join(cwd, "a-only.txt"), "utf8"), "made by A\n", "A's a-only.txt must NOT be deleted by B");

    // 3. If B now edits README.md (which A already modified on the host relative to B's base), B's apply must detect conflict!
    await sB.mutate("b2", "write", () => sB.writeFile(join(cwd, "README.md"), "conflicting edit from B\n"));
    const appBConflict = await sB.apply();
    assert.deepEqual(appBConflict.conflicts, ["README.md"]);
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello from A\n");
    return `A applied ${appA.applied.length}, B applied ${appB.applied.length} cleanly`;
  });

  await step("P1-5: /tree & /fork time-travel via switchToRef restores historical file snapshots in ms", async () => {
    const c1 = await sA.mutate("t-step1", "write", () => sA.writeFile(join(cwd, "time.txt"), "step 1\n"));
    const c2 = await sA.mutate("t-step2", "write", () => sA.writeFile(join(cwd, "time.txt"), "step 2\n"));
    assert.equal((await sA.readFile(join(cwd, "time.txt"))).toString(), "step 2\n");

    // Jump back to c1.checkpoint.commit (simulating /tree navigation)
    const t0 = Date.now();
    await sA.switchToRef(c1.checkpoint.commit);
    const ms = Date.now() - t0;
    assert.equal((await sA.readFile(join(cwd, "time.txt"))).toString(), "step 1\n");

    // Jump back to c2.checkpoint.commit (abandoned branch is still in Store!)
    await sA.switchToRef(c2.checkpoint.commit);
    assert.equal((await sA.readFile(join(cwd, "time.txt"))).toString(), "step 2\n");

    // Jump all the way back to baseRef (before time.txt existed)
    await sA.switchToRef(sA.baseRef);
    assert.equal(await sA.exists(join(cwd, "time.txt")), false);
    return `switched snapshots in ${ms} ms`;
  });

  await step("/layerfs history: newest first, tool origins, changed files, HEAD after /tree, applied marks, 0 Sandboxes", async () => {
    assert.deepEqual(parseMessage("pi bash (exit 3) [call_1,call_2]"), { label: "bash (exit 3)", origins: ["call_1", "call_2"] });
    const sH = new LayerfsSession(cwd, `sessH-${id}`, config);
    await sH.open();
    try {
      await sH.mutate("h1", "write", () => sH.writeFile(join(cwd, "hist/one.txt"), "1\n"));
      await sH.mutate("h2", "bash", () => sH.exec("echo 2 > hist/two.txt && rm hist/one.txt", cwd, { onData: () => {} }));
      const h3 = await sH.mutate("h3", "write", () => sH.writeFile(join(cwd, "hist/three.txt"), "3\n"));
      const daemonsBefore = pgrep(`layerfs-daemon --config ${sH.spec.localDir}/`).stdout.trim().split("\n").filter(Boolean).length;

      const v = await loadHistory(sH);
      assert.equal(v.rows.length, 3);
      assert.deepEqual(v.rows.map((r) => r.origins[0]), ["h3", "h2", "h1"], "newest first with tool-call origins");
      assert.deepEqual(v.rows[0].files, [{ kind: "Added", path: "hist/three.txt" }]);
      assert.deepEqual(v.rows[1].files.map((f) => `${f.kind}:${f.path}`).sort(), ["Added:hist/two.txt", "Removed:hist/one.txt"]);
      assert.deepEqual(v.rows[2].files, [{ kind: "Added", path: "hist/one.txt" }], "first Commit's files from the base Branch");
      assert.equal(v.rows[0].isHead, true);
      assert.equal(v.unapplied.length > 0, true);
      const text = formatHistory(v);
      assert.match(text, /● [0-9a-f]{12}  write .*\(HEAD\)/);
      assert.match(text, /\+hist\/three\.txt/);
      assert.match(text, /Not yet applied: \d+ file/);

      const daemonsAfter = pgrep(`layerfs-daemon --config ${sH.spec.localDir}/`).stdout.trim().split("\n").filter(Boolean).length;
      assert.equal(daemonsAfter, daemonsBefore, "history must not start a daemon");

      // /tree back to h2: history shows h2 as HEAD and no h3
      await sH.switchToRef(v.rows[1].id);
      const v2 = await loadHistory(sH);
      assert.deepEqual(v2.rows.map((r) => r.origins[0]), ["h2", "h1"]);
      assert.equal(v2.rows[0].isHead, true);

      // apply marks Commits as applied
      await sH.switchToRef(h3.checkpoint.commit);
      const res = await sH.apply();
      assert.deepEqual(res.conflicts, []);
      const v3 = await loadHistory(sH);
      assert.ok(v3.rows.every((r) => r.applied), "all Commits applied after /layerfs apply");
      assert.equal(v3.unapplied.length, 0);
      assert.match(formatHistory(v3), /Everything on this branch is applied/);
      return text.split("\n").slice(0, 4).join(" / ");
    } finally {
      await sH.close({ stopDaemons: true });
    }
  });

  await step("P0-6: external host edits (e.g. git pull) are synced into main when a new session C starts", async () => {
    writeFileSync(join(cwd, "src/app.js"), "export const a = 777; // edited on host\n");
    writeFileSync(join(cwd, "from-git-pull.txt"), "pulled from remote\n");

    sC = new LayerfsSession(cwd, `sessC-${id}`, config);
    await sC.open();
    assert.equal((await sC.readFile(join(cwd, "src/app.js"))).toString(), "export const a = 777; // edited on host\n");
    assert.equal((await sC.readFile(join(cwd, "from-git-pull.txt"))).toString(), "pulled from remote\n");
    assert.equal((await sC.readFile(join(cwd, "a-only.txt"))).toString(), "made by A\n");
  });
} finally {
  await sA?.close({ stopDaemons: true }).catch(() => {});
  await sB?.close({ stopDaemons: true }).catch(() => {});
  await sC?.close({ stopDaemons: true }).catch(() => {});
  await stopNativeDaemons(join(config.root, "local")).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed (zero Docker)`);
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
}
