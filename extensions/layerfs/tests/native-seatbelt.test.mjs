// macOS Native Mode + Seatbelt Sandbox Test Suite (Zero Docker, Pure macOS Native NFSv3 loopback)
// Run: node tests/native-seatbelt.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  promises as fsp,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";
import { formatHistory, loadHistory } from "../src/history.ts";
import { LayerfsSession, stopNativeDaemons } from "../src/workspace.ts";

const id = Date.now().toString(36);
const base = join(homedir(), ".cache/pi-layerfs-test", `native-${id}`);
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const ev = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${String(ev).slice(0, 220)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.stack });
    console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 5).join(" | ")}`);
  }
};

const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const pgrep = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
const git = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });

const root = join(base, "root");
const cwd = join(base, "project");
const outside = join(base, "outside.txt");
const config = {
  ...resolveConfig({ PI_LAYERFS_SANDBOX: "native" }),
  root,
  prefix: `pi-nat-${id}-`,
  killGraceMs: 800,
  excludes: [...resolveConfig().excludes, "*.env", "**/secrets/*.key", "secrets/"],
};

function fixture(dir) {
  mkdirSync(join(dir, "src/sub"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "secrets"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });

  writeFileSync(join(dir, "README.md"), "hello native v1\n");
  writeFileSync(join(dir, "src/app.js"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/sub/util.ts"), "export const util = 42;\n");
  writeFileSync(join(dir, "node_modules/pkg/index.js"), "export const a = 999;\n");
  writeFileSync(join(dir, "scripts/build.sh"), "#!/bin/sh\necho build-v1\n");
  chmodSync(join(dir, "scripts/build.sh"), 0o755);

  writeFileSync(join(dir, ".env"), "SECRET=host-production\n");
  writeFileSync(join(dir, "app/.ENV"), "SECRET_APP=host-app\n");
  writeFileSync(join(dir, "secrets/api.key"), "API_KEY=host-api-key\n");
  writeFileSync(join(dir, "delete-me.txt"), "delete me\n");
  writeFileSync(join(dir, "rename-me.txt"), "rename me\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
}

rmSync(base, { recursive: true, force: true });
fixture(cwd);
writeFileSync(outside, "outside-host\n");

let sA, sWorker, sLead;

try {
  // 1. Preflight & Project Init
  await step("1.1 preflight validates native bundle and macOS system binaries (zero Docker)", async () => {
    const res = await LayerfsSession.preflight(config);
    assert.equal(res, "native", "preflight must return 'native'");

    const badConfig = { ...config, bundle: "/tmp/non-existent-bundle" };
    await assert.rejects(
      LayerfsSession.preflight(badConfig),
      (e) => e.code === "Preflight" && /missing/.test(e.message),
    );
  });

  await step("1.2 open session A: initializes native APFS Store with 0 Docker containers and 0 daemons", async () => {
    sA = new LayerfsSession(cwd, `sessA-${id}`, config, (m) => console.log(`  [sA] ${m}`));
    await sA.open();

    // Check store.sqlite exists on APFS
    const storeSqlite = join(sA.boxSpec.stores, sA.volume, "global", "store.sqlite");
    assert.ok(existsSync(storeSqlite), `Store database must exist at ${storeSqlite}`);

    // Verify 0 Docker containers
    const dockerPs = docker("ps", "-aq", "--filter", `name=^${config.prefix}`).stdout.trim();
    assert.equal(dockerPs, "", "Native mode must never create Docker containers");

    // Verify 0 layerfs-daemon started during pure Store initialization
    const daemons = pgrep(`layerfs-daemon --config ${sA.boxSpec.localDir}/`).stdout.trim();
    assert.equal(daemons, "", "Pure Store init must not start layerfs-daemon");

    return `project=${sA.project} work=${sA.workBranch} base=${sA.baseBranch} dockerContainers=0 daemons=0`;
  });

  await step("1.3 Store-direct operations (read, write, ls, find, grep, diff, history, switchToRef) in ms with 0 daemons", async () => {
    // readFile
    assert.equal((await sA.readFile(join(cwd, "README.md"))).toString(), "hello native v1\n");
    assert.equal((await sA.readFile(outside)).toString(), "outside-host\n");
    assert.equal(await sA.exists(join(cwd, ".env")), false, "excluded .env must not exist in Store");
    assert.equal(await sA.isDirectory(join(cwd, "src")), true);
    assert.deepEqual(await sA.readdir(join(cwd, "src")), ["app.js", "sub"]);

    // findFiles
    const found = await sA.findFiles("**/*.{js,ts}", join(cwd, "src"), { ignore: [], limit: 50 });
    assert.deepEqual(found.map((p) => p.slice(cwd.length + 1)).sort(), ["src/app.js", "src/sub/util.ts"]);

    // grep
    const g = await sA.grepWorkspace({ pattern: "export const a", path: "." });
    assert.deepEqual(g.lines, ["src/app.js:1: export const a = 1;"]);

    // Store-direct write
    const r = await sA.mutate("t1", "write", () => sA.writeFile(join(cwd, "nested/dir/note.txt"), "store-direct write\n"));
    assert.ok(r.checkpoint?.commit, "expected commit from fs.apply");
    assert.equal((await sA.readFile(join(cwd, "nested/dir/note.txt"))).toString(), "store-direct write\n");
    assert.equal(existsSync(join(cwd, "nested/dir/note.txt")), false, "host disk must stay untouched");

    // diff
    const diffItems = await sA.diff();
    assert.ok(diffItems.some((d) => d.path === "/nested/dir/note.txt"));

    // history
    const hist = await loadHistory(sA);
    assert.ok(hist.rows && hist.rows.length >= 1, "history must show commits");

    // switchToRef
    const currentRef = sA.effectiveRef;
    const switched = await sA.switchToRef(sA.baseRef);
    assert.equal(await sA.exists(join(cwd, "nested/dir/note.txt")), false, "switched back to base: note.txt gone");
    await sA.switchToRef(currentRef);
    assert.equal(await sA.exists(join(cwd, "nested/dir/note.txt")), true, "switched forward to head: note.txt restored");

    // Verify 0 daemons started for pure Store operations
    const daemons = pgrep(`layerfs-daemon --config ${sA.boxSpec.localDir}/`).stdout.trim();
    assert.equal(daemons, "", "Pure Store operations must still have 0 daemons running");
  });

  // 2. Native NFSv3 Workspace Mount + bash Execution
  await step("2.1 native NFSv3 workspace mount + bash execution (uname -s prints Darwin)", async () => {
    const chunks = [];
    const r = await sA.mutate("t2", "bash", () =>
      sA.exec(
        `
        uname -s
        echo "bash native" > created-in-bash.txt
        echo "modified by bash" >> README.md
        rm delete-me.txt
        mv rename-me.txt renamed-in-bash.txt
        `,
        cwd,
        { onData: (d) => chunks.push(d.toString()) },
      )
    );
    assert.equal(r.value.exitCode, 0, "bash command must exit with 0");
    const output = chunks.join("");
    assert.match(output, /Darwin/, "uname -s must output Darwin on native macOS");

    // Verify file changes in Store
    assert.equal((await sA.readFile(join(cwd, "created-in-bash.txt"))).toString().trim(), "bash native");
    assert.ok((await sA.readFile(join(cwd, "README.md"))).toString().includes("modified by bash"));
    assert.equal(await sA.exists(join(cwd, "delete-me.txt")), false);
    assert.equal((await sA.readFile(join(cwd, "renamed-in-bash.txt"))).toString().trim(), "rename me");

    // Host must remain untouched before apply
    assert.equal(existsSync(join(cwd, "created-in-bash.txt")), false);
    assert.equal(existsSync(join(cwd, "delete-me.txt")), true);
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello native v1\n");
  });

  // 3. Claude Code (`srt`)-style Seatbelt Security Enforcement
  await step("3.1 host project folder write protection: writing to ${cwd} fails with EPERM", async () => {
    const chunks = [];
    const r = await sA.mutate("sec1", "bash", () =>
      sA.exec(`echo "hacked" > "${cwd}/README.md"`, cwd, { onData: (d) => chunks.push(d.toString()) })
    );
    assert.notEqual(r.value.exitCode, 0, "write to host folder must fail");
    const output = chunks.join("");
    assert.match(output, /Operation not permitted/, "must fail with Operation not permitted");
    assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "hello native v1\n", "host README must be 100% untouched");
  });

  await step("3.2 mandatory .lww and .git/hooks write protection: writes fail with EPERM", async () => {
    const chunks1 = [];
    const r1 = await sA.mutate("sec2", "bash", () =>
      sA.exec("echo bad > .lww", cwd, { onData: (d) => chunks1.push(d.toString()) })
    );
    assert.notEqual(r1.value.exitCode, 0);
    assert.match(chunks1.join(""), /Operation not permitted/);

    const chunks2 = [];
    const r2 = await sA.mutate("sec3", "bash", () =>
      sA.exec("mkdir -p .git/hooks && echo pwn > .git/hooks/pre-commit", cwd, { onData: (d) => chunks2.push(d.toString()) })
    );
    assert.notEqual(r2.value.exitCode, 0);
    assert.match(chunks2.join(""), /Operation not permitted/);
  });

  await step("3.3 kernel-level secret read protection (denyRead): reading .env, app/.ENV, secrets/api.key fails with EPERM", async () => {
    // 3.3a: Read host secrets via absolute path
    const chunksHost = [];
    await sA.exec(`cat "${cwd}/.env"`, cwd, { onData: (d) => chunksHost.push(d.toString()) });
    assert.match(chunksHost.join(""), /Operation not permitted/);

    const chunksHostApp = [];
    await sA.exec(`cat "${cwd}/app/.ENV"`, cwd, { onData: (d) => chunksHostApp.push(d.toString()) });
    assert.match(chunksHostApp.join(""), /Operation not permitted/);

    const chunksHostKey = [];
    await sA.exec(`cat "${cwd}/secrets/api.key"`, cwd, { onData: (d) => chunksHostKey.push(d.toString()) });
    assert.match(chunksHostKey.join(""), /Operation not permitted/);

    // 3.3b: Inject a secret into workspace store to test relative cat & python3 reads inside workspace
    await sA.lfs.fs.apply(sA.workBranch, [
      { op: "write", path: "/.env", bytes: Buffer.from("ws-secret\n") },
      { op: "mkdir", path: "/app" },
      { op: "write", path: "/app/.ENV", bytes: Buffer.from("ws-app-secret\n") },
    ], "inject test secrets");

    const chunksWsEnv = [];
    await sA.exec("cat .env", cwd, { onData: (d) => chunksWsEnv.push(d.toString()) });
    assert.match(chunksWsEnv.join(""), /Operation not permitted/);

    const chunksPy = [];
    await sA.exec("python3 -c \"open('.env').read()\"", cwd, { onData: (d) => chunksPy.push(d.toString()) });
    assert.match(chunksPy.join(""), /Operation not permitted/);

    // 3.3c: Move-blocking rule: attempting mv .env exposed.txt fails with EPERM
    const chunksMv = [];
    await sA.exec("mv .env exposed.txt", cwd, { onData: (d) => chunksMv.push(d.toString()) });
    assert.match(chunksMv.join(""), /Operation not permitted/);

    // Clean up injected test secrets from store
    await sA.lfs.fs.apply(sA.workBranch, [{ op: "rm", path: "/.env" }], "clean test secret");
  });

  await step("3.4 outside credential protection: reading $HOME/.ssh or $HOME/.epi/pi/auth.json fails with EPERM", async () => {
    const chunksSsh = [];
    await sA.exec("cat ~/.ssh/id_ed25519 2>&1 || cat ~/.ssh/config 2>&1", cwd, { onData: (d) => chunksSsh.push(d.toString()) });
    assert.match(chunksSsh.join(""), /Operation not permitted/);

    const chunksAuth = [];
    await sA.exec("cat ~/.epi/pi/auth.json", cwd, { onData: (d) => chunksAuth.push(d.toString()) });
    assert.match(chunksAuth.join(""), /Operation not permitted/);
  });

  await step("3.5 P0-1: git core.fsmonitor execution prevention and .git/config / .git/hooks / .lww write protection", async () => {
    const pwnedPath = join(base, "pwned-p01");
    rmSync(pwnedPath, { force: true });

    // In bash: git config core.fsmonitor fails with EPERM because .git/config is write-denied in Seatbelt
    const chunks = [];
    const r = await sA.mutate("sec-p01-a", "bash", () =>
      sA.exec(`git config core.fsmonitor "touch ${pwnedPath}"`, cwd, { onData: (d) => chunks.push(d.toString()) })
    );
    assert.notEqual(r.value.exitCode, 0);
    assert.match(chunks.join(""), /Operation not permitted/);

    // mustStorePath refuses writes to .lww, .git/config, .git/hooks
    await assert.rejects(
      sA.writeFile(join(cwd, ".git/config"), "bad"),
      (e) => e.code === "EACCES" && /refused for security/.test(e.message)
    );
    await assert.rejects(
      sA.writeFile(join(cwd, ".lww"), "bad"),
      (e) => e.code === "EACCES" && /refused for security/.test(e.message)
    );
    await assert.rejects(
      sA.writeFile(join(cwd, ".git/hooks/pre-commit"), "bad"),
      (e) => e.code === "EACCES" && /refused for security/.test(e.message)
    );

    // Even if injected directly into Store .git/config, prepareNativeGit runs git with -c core.fsmonitor=false -c core.hooksPath=/dev/null and GIT_CONFIG_*=/dev/null
    await sA.lfs.fs.apply(sA.workBranch, [
      { op: "write", path: "/.git/config", bytes: Buffer.from(`[core]\n\tfsmonitor = "touch ${pwnedPath}"\n`) }
    ], "inject malicious git config");

    const execRes = await sA.exec("true", cwd, { onData: () => {} });
    assert.equal(execRes.exitCode, 0);
    assert.equal(existsSync(pwnedPath), false, "malicious fsmonitor must never be executed");

    // Clean up injected git config
    await sA.lfs.fs.apply(sA.workBranch, [{ op: "rm", path: "/.git/config" }], "cleanup git config");
  });

  await step("3.6 P0-2: symlinked paths must not read secrets or write outside workspace", async () => {
    const pwnedFile = join(base, "pwned-p02.txt");
    rmSync(pwnedFile, { force: true });

    // Create symlinks in workspace via bash (including a dangling final symlink AND a 2-hop chained dangling symlink pointing outside workspace, plus a valid in-workspace symlink)
    await sA.mutate("sec-p02-sym", "bash", () =>
      sA.exec(`ln -s ~/.ssh/config sym-read && ln -s "${base}" sym-dir && ln -s "${pwnedFile}" sym-dangling && ln -s sym-dangling sym-chain-dangling && ln -s src/app.js sym-valid-in-ws`, cwd, { onData: () => {} })
    );

    // Valid in-workspace symlink write MUST succeed and update the target inside the workspace
    await sA.mutate("sec-p02-valid", "write", () =>
      sA.writeFile(join(cwd, "sym-valid-in-ws"), "export const a = 123;\n")
    );
    assert.equal((await sA.readFile(join(cwd, "src/app.js"))).toString(), "export const a = 123;\n");

    // readFile on sym-read pointing to secret must be refused
    await assert.rejects(
      sA.readFile(join(cwd, "sym-read")),
      (e) => e.code === "ENOENT" || e.code === "EPERM"
    );

    // writeFile through sym-dir pointing outside workspace must be refused
    await assert.rejects(
      sA.writeFile(join(cwd, "sym-dir/pwned-p02.txt"), "hacked"),
      /refusing to write through a symlink pointing outside the LayerFS workspace/
    );
    // writeFile through dangling final symlink pointing outside workspace must ALSO be refused
    await assert.rejects(
      sA.writeFile(join(cwd, "sym-dangling"), "hacked"),
      /refusing to write through a symlink pointing outside the LayerFS workspace/
    );
    // writeFile through 2-hop chained dangling symlink (sym-chain-dangling -> sym-dangling -> outside) must ALSO be refused
    await assert.rejects(
      sA.writeFile(join(cwd, "sym-chain-dangling"), "hacked"),
      /refusing to write through a symlink pointing outside the LayerFS workspace/
    );
    assert.equal(existsSync(pwnedFile), false, "file outside workspace must never be written through symlink");
  });

  await step("3.7 P1-1: configRoot isolation (stores, bindings.json, daemon.setup) and mount_nfs blocking", async () => {
    // Reading bindings.json fails with EPERM
    const chunksBindings = [];
    await sA.exec(`cat "${sA.config.root}/state/bindings.json"`, cwd, { onData: (d) => chunksBindings.push(d.toString()) });
    assert.match(chunksBindings.join(""), /Operation not permitted/);

    // Listing stores fails with EPERM
    const chunksStores = [];
    await sA.exec(`ls "${sA.boxSpec.stores}"`, cwd, { onData: (d) => chunksStores.push(d.toString()) });
    assert.match(chunksStores.join(""), /Operation not permitted/);

    // Reading daemon.setup fails with EPERM
    const setupDir = (await fsp.readdir(sA.boxSpec.localDir).catch(() => []))[0];
    const daemonSetupPath = setupDir ? join(sA.boxSpec.localDir, setupDir, "config", "daemon.setup") : join(sA.boxSpec.localDir, "default", "config", "daemon.setup");
    const chunksDaemon = [];
    await sA.exec(`cat "${daemonSetupPath}"`, cwd, { onData: (d) => chunksDaemon.push(d.toString()) });
    assert.match(chunksDaemon.join(""), /Operation not permitted/);

    // /sbin/mount_nfs is blocked by process-exec deny, and copying it to /tmp/m is blocked from mounting by (deny file-mount)
    const chunksMount = [];
    await sA.exec("/sbin/mount_nfs 2>&1 || true", cwd, { onData: (d) => chunksMount.push(d.toString()) });
    assert.match(chunksMount.join(""), /Operation not permitted/);

    const chunksCopyMount = [];
    const rCopyMount = await sA.exec("mkdir -p /private/tmp/mnt-test-$$ && cp /sbin/mount_nfs /private/tmp/m-$$ && /private/tmp/m-$$ -o vers=3,tcp,port=65530,mountport=65530 127.0.0.1:/ /private/tmp/mnt-test-$$ 2>&1; rc=$?; rm -rf /private/tmp/m-$$ /private/tmp/mnt-test-$$; exit $rc", cwd, { onData: (d) => chunksCopyMount.push(d.toString()) });
    assert.notEqual(rCopyMount.exitCode, 0, "copied mount_nfs must fail to mount under (deny file-mount)");
  });

  await step("3.8 P1-2 & P1-3: unanchored glob protection (.env, *.pem), system CA cert.pem carve-out, and **/ patterns", async () => {
    // 3.8a: Reading ${base}/other.env and ${base}/private.pem outside the project fails with EPERM,
    // while reading macOS system CA bundle /private/etc/ssl/cert.pem succeeds so HTTPS works!
    const otherEnvPath = join(base, "other.env");
    const otherPemPath = join(base, "private.pem");
    writeFileSync(otherEnvPath, "SECRET=outside-env\n");
    writeFileSync(otherPemPath, "PRIVATE KEY\n");

    const chunksOtherEnv = [];
    await sA.exec(`cat "${otherEnvPath}"`, cwd, { onData: (d) => chunksOtherEnv.push(d.toString()) });
    assert.match(chunksOtherEnv.join(""), /Operation not permitted/);

    const chunksOtherPem = [];
    await sA.exec(`cat "${otherPemPath}"`, cwd, { onData: (d) => chunksOtherPem.push(d.toString()) });
    assert.match(chunksOtherPem.join(""), /Operation not permitted/);

    const chunksSysCert = [];
    const rSysCert = await sA.exec("head -n 1 /private/etc/ssl/cert.pem", cwd, { onData: (d) => chunksSysCert.push(d.toString()) });
    assert.equal(rSysCert.exitCode, 0, `system CA cert.pem must remain readable: ${chunksSysCert.join("")}`);

    // 3.8b: Pattern **/secrets/*.key matches nested directories
    await sA.lfs.fs.apply(sA.workBranch, [
      { op: "mkdir", path: "/nested" },
      { op: "mkdir", path: "/nested/deep" },
      { op: "mkdir", path: "/nested/deep/secrets" },
      { op: "write", path: "/nested/deep/secrets/deep.key", bytes: Buffer.from("SECRET_DEEP_KEY\n") },
    ], "inject test key");

    const chunksNestedKey = [];
    await sA.exec("cat nested/deep/secrets/deep.key", cwd, { onData: (d) => chunksNestedKey.push(d.toString()) });
    assert.match(chunksNestedKey.join(""), /Operation not permitted/);

    // 3.8c: Directory-only pattern secrets/ blocks unlinking/renaming secrets directory
    await sA.lfs.fs.apply(sA.workBranch, [
      { op: "mkdir", path: "/secrets" },
      { op: "write", path: "/secrets/temp.txt", bytes: Buffer.from("temp\n") },
    ], "inject secrets dir");

    const chunksMvSecrets = [];
    await sA.exec("mv secrets secrets_exposed", cwd, { onData: (d) => chunksMvSecrets.push(d.toString()) });
    assert.match(chunksMvSecrets.join(""), /Operation not permitted/);

    // Clean up
    await sA.lfs.fs.apply(sA.workBranch, [
      { op: "rm", path: "/nested/deep/secrets/deep.key" },
      { op: "rm", path: "/secrets/temp.txt" },
      { op: "rm", path: "/secrets" },
    ], "cleanup test secrets");
  });

  await step("3.9 P2-2: mv .git .g inside bash fails with Operation not permitted", async () => {
    const chunks = [];
    const r = await sA.mutate("sec-p22", "bash", () =>
      sA.exec("mv .git .g", cwd, { onData: (d) => chunks.push(d.toString()) })
    );
    assert.notEqual(r.value.exitCode, 0);
    assert.match(chunks.join(""), /Operation not permitted/);
    assert.equal(existsSync(join(cwd, ".git")), true, ".git must remain intact");
  });

  // 4. Network Isolation
  await step("4.1 network: 'deny' blocks outbound HTTP/TCP while workspace ops continue", async () => {
    const netDenyConfig = { ...config, network: "deny" };
    const sNet = new LayerfsSession(cwd, `sessNet-${id}`, netDenyConfig);
    await sNet.open();

    const chunks = [];
    const r = await sNet.mutate("net1", "bash", () =>
      sNet.exec(
        `
        node -e 'fetch("http://1.1.1.1").catch(e => console.log("FETCH_ERR:" + (e.cause?.code || e.message)))'
        echo "workspace write succeeds" > net-test.txt
        `,
        cwd,
        { onData: (d) => chunks.push(d.toString()) },
      )
    );
    assert.equal(r.value.exitCode, 0);
    const output = chunks.join("");
    assert.match(output, /FETCH_ERR:EPERM/, "network deny must block node fetch with EPERM");
    assert.equal((await sNet.readFile(join(cwd, "net-test.txt"))).toString().trim(), "workspace write succeeds");
    await sNet.close({ stopDaemons: true });
  });

  // 5. Process Group & Background Job Reaping
  await step("5.1 nohup background jobs are reaped even if cd / out of workspace (process group kill)", async () => {
    const t0 = Date.now();
    const r = await sA.mutate("reap1", "bash", () =>
      sA.exec(
        `(cd /; nohup sleep 200 >/dev/null 2>&1 &) && sleep 0.1 && echo "spawned bg"`,
        cwd,
        { onData: () => {} },
      )
    );
    assert.equal(r.value.exitCode, 0);
    const duration = Date.now() - t0;
    assert.ok(duration < 3000, `execution must complete promptly, took ${duration} ms`);

    // Verify background sleep process was killed immediately
    await new Promise((r) => setTimeout(r, 100));
    const sleepPids = pgrep("sleep 200").stdout.trim();
    assert.equal(sleepPids, "", "background sleep 200 must be killed by process group kill");
  });

  await step("5.2 abort and timeout reap process groups cleanly", async () => {
    const ac = new AbortController();
    const p = sA.exec("sleep 300", cwd, { onData: () => {}, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await assert.rejects(p, /aborted/);

    await assert.rejects(
      sA.exec("sleep 30", cwd, { onData: () => {}, timeout: 1 }),
      /timeout:1/,
    );
  });

  // 6. Multi-Agent Team Mode & 3-Way Apply
  await step("6.1 Multi-Agent Team mode: Lead and Worker collaborate, merge, and apply with 3-way check", async () => {
    sLead = new LayerfsSession(cwd, `sessLead-${id}`, config);
    await sLead.open();

    sWorker = new LayerfsSession(cwd, `sessWorker-${id}`, config);
    await sWorker.open();

    assert.equal(sLead.project, sWorker.project, "Lead and Worker must share same project");
    assert.notEqual(sLead.workBranch, sWorker.workBranch, "Must have distinct work branches");

    // Worker performs edits in bash
    await sWorker.mutate("w1", "bash", () =>
      sWorker.exec(
        `
        echo "feature by worker" > feature.txt
        echo "export const extra = 99;" >> src/app.js
        `,
        cwd,
        { onData: () => {} },
      )
    );

    // Lead merges Worker's branch
    const mergeRes = await sLead.mergeBranch(sWorker.workBranch);
    assert.equal(mergeRes.merged, true, "merge must succeed");

    // Verify Lead sees Worker's changes in Store
    assert.equal((await sLead.readFile(join(cwd, "feature.txt"))).toString().trim(), "feature by worker");
    assert.ok((await sLead.readFile(join(cwd, "src/app.js"))).toString().includes("extra = 99"));

    // Lead applies changes to host disk
    const applyRes = await sLead.apply();
    assert.deepEqual(applyRes.conflicts, [], "apply must have zero conflicts");
    assert.ok(applyRes.applied.includes("feature.txt"));
    assert.ok(applyRes.applied.includes("src/app.js"));

    // Verify host disk has the merged files
    assert.equal(readFileSync(join(cwd, "feature.txt"), "utf8").trim(), "feature by worker");
    assert.ok(readFileSync(join(cwd, "src/app.js"), "utf8").includes("extra = 99"));
  });

  await step("6.2 apply 3-way conflict detection on host drift", async () => {
    // Worker edits feature.txt
    await sWorker.mutate("w2", "write", () => sWorker.writeFile(join(cwd, "feature.txt"), "worker revision 2\n"));

    // Lead merges
    await sLead.mergeBranch(sWorker.workBranch);

    // Host file is modified externally before apply!
    writeFileSync(join(cwd, "feature.txt"), "host external conflict\n");

    // Lead applies: must detect conflict and refuse to overwrite
    const applyRes = await sLead.apply();
    assert.ok(applyRes.conflicts.includes("feature.txt"), "must detect conflict on feature.txt");
    assert.equal(readFileSync(join(cwd, "feature.txt"), "utf8"), "host external conflict\n");
  });

} finally {
  console.log("\n==> Cleaning up sessions and native daemons...");
  await sA?.close({ stopDaemons: true }).catch(() => {});
  await sWorker?.close({ stopDaemons: true }).catch(() => {});
  await sLead?.close({ stopDaemons: true }).catch(() => {});
  await stopNativeDaemons(join(root, "local")).catch(() => {});

  const remainingDaemons = pgrep(`layerfs-daemon --config ${join(root, "local")}`).stdout.trim();
  if (remainingDaemons) {
    console.log(`Warning: lingering daemons [${remainingDaemons}], killing with SIGKILL...`);
    spawnSync("pkill", ["-9", "-f", `layerfs-daemon --config ${join(root, "local")}`]);
  }
  await new Promise((r) => setTimeout(r, 250));
  rmSync(base, { recursive: true, force: true });
}

console.log("\n==========================================");
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} tests passed in ${results.reduce((a, b) => a + b.ms, 0)} ms`);
if (passed !== results.length) {
  process.exit(1);
}
