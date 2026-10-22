#!/usr/bin/env node
// Real-LayerFS probe orchestrator (runs on the Mac). Touches only resources it
// names itself: volume/containers prefixed epi-lfs-probe-<id>, a run dir under
// ~/.cache/epi-layerfs/runs. Never touches layerfs-store or ~/layerfs-linux-build.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = process.env.EPI_LFS_BUNDLE ?? join(homedir(), ".cache/epi-layerfs/bundle-5fb68dd");
const IMAGE_TAG = process.env.EPI_LFS_IMAGE ?? "epi-lfs-runtime:node24-5fb68dd";
const id = Date.now().toString(36);
const RUN = join(homedir(), ".cache/epi-layerfs/runs", id);
const SRC = process.env.EPI_LFS_SRC_COPY_FROM ? join(RUN, "staged") : join(RUN, "source");
const HOME = join(RUN, "home");
const STATE = join(RUN, "state.json");
const PROJECT = "probe";
const NET = process.env.EPI_LFS_NET ?? "host"; // "host" | "bridge"
const PREFIX = `epi-lfs-probe-${id}-`;
const VOLUME = `epi-lfs-probe-${id}`;
const report = { id, net: NET, run: RUN, startedAt: new Date().toISOString(), docker: [], notes: [] };

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: opts.binary ? "buffer" : "utf8", timeout: opts.timeout ?? 120_000, maxBuffer: 64 << 20 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr?.toString?.() ?? "", error: r.error?.message };
};
const docker = (...args) => sh("docker", args);
const record = (name, ok, evidence) => { report.docker.push({ name, ok, evidence }); console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence).slice(0, 300)}`); };

// ---------- fixture ----------
function fixture() {
  mkdirSync(join(SRC, "src"), { recursive: true });
  writeFileSync(join(SRC, "src/app.js"), "export const hello = () => 'hi';\n");
  writeFileSync(join(SRC, "crlf.txt"), "one\r\ntwo\r\n");
  writeFileSync(join(SRC, "long.txt"), "x".repeat(200_000) + "\nnext line\n");
  writeFileSync(join(SRC, "shared.txt"), Array.from({ length: 30 }, (_, i) => `line${String(i + 1).padStart(2, "0")}\n`).join(""));
  writeFileSync(join(SRC, ".env"), "SECRET=should-not-be-imported-blindly\n");
  // tiny valid PNG + random bytes with NULs
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) & 255))]);
  writeFileSync(join(SRC, "img.png"), png);
  symlinkSync("src/app.js", join(SRC, "link-to-app"));
  report.fixtureSha = { "img.png": createHash("sha256").update(png).digest("hex") };
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p, { throwIfNoEntry: false }); if (!s) continue; if (s.isDirectory()) walk(p); else out[p.slice(dir.length)] = createHash("sha256").update(readFileSync(p)).digest("hex"); } };
  walk(dir);
  return out;
}

// ---------- container steps ----------
function step(name) {
  const imageId = docker("image", "inspect", "--format", "{{.Id}}", IMAGE_TAG).stdout.trim();
  const args = [
    "run", "--rm", "--pull", "never", "--name", `${PREFIX}client-${name}`,
    "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", "/var/lib/docker/volumes:/var/lib/docker/volumes",
    "-v", `${RUN}:${RUN}`, "-v", `${BUNDLE}:${BUNDLE}:ro`, "-v", `${here}:${here}:ro`,
    "-e", `LFS_PREWARM=${process.env.LFS_PREWARM ?? ""}`, "-e", `LFS_ROUNDS=${process.env.LFS_ROUNDS ?? ""}`, "-e", `LFS_MATRIX=${process.env.LFS_MATRIX ?? ""}`, "-e", `LFS_BUNDLE=${BUNDLE}`, "-e", `LFS_PROJECT=${PROJECT}`, "-e", `LFS_SOURCE=${SRC}`,
    "-e", `LAYERFS_NATIVE=${BUNDLE}/layerfs.node`, "-e", `LAYERFS_HOME=${HOME}`, "-e", `LAYERFS_IMAGE=${imageId}`,
    "-e", `LAYERFS_VOLUME=${VOLUME}`, "-e", `LAYERFS_DAEMON=${BUNDLE}/layerfs-daemon`,
    "-e", `LAYERFS_STORE_PATH=/var/lib/docker/volumes/${VOLUME}/_data/global/store.sqlite`,
    ...(NET === "host" ? ["--network", "host"] : ["-e", "LAYERFS_DAEMON_HOST=host.docker.internal"]),
    "-e", `LAYERFS_CONTAINER_PREFIX=${PREFIX}`,
    "--entrypoint", "node", imageId, join(here, "sdk-step.mjs"), name, STATE,
  ];
  const start = Date.now();
  const r = sh("docker", args, { timeout: 300_000 });
  report[`step_${name}`] = { code: r.code, ms: Date.now() - start, stderr: r.stderr.slice(-3000), error: r.error };
  console.log(`step ${name}: exit ${r.code} in ${Date.now() - start}ms`);
  if (r.stderr.trim()) console.log(r.stderr.slice(-1500));
  return r.code === 0;
}

// ---------- docker exec probes (Mac side) ----------
function streamExec(ctr, ident, dir, script, { env = {}, killLocalAfterMs, onData } = {}) {
  return new Promise((resolve) => {
    const args = ["exec", "-i", "-u", ident, "-e", "HOME=/tmp", ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), "-w", dir, ctr, "bash", "-c", script];
    const start = Date.now();
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; const bufs = [];
    p.stdout.on("data", (d) => { onData?.(d.toString()); chunks.push({ t: Date.now() - start, s: d.toString().slice(0, 80) }); bufs.push(d); });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    if (killLocalAfterMs) setTimeout(() => p.kill("SIGKILL"), killLocalAfterMs);
    p.on("close", (code, signal) => resolve({ code, signal, chunks, out: Buffer.concat(bufs), err, ms: Date.now() - start }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procsInSession = (ctr, sid) => docker("exec", ctr, "bash", "-c", `ps -eo pid=,sid=,pgid=,stat=,args= | awk '$2==${sid}'`).stdout.trim();

async function dockerExecProbes() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const inspect = state.results.find((r) => r.name === "workspace.exec id/pwd/env");
  const out = inspect?.value?.stdout ?? "";
  report.nativeExecInspect = out;
  const uid = /uid=(\d+)/.exec(out)?.[1], gid = /gid=(\d+)/.exec(out)?.[1];
  const dir = out.split("\n").find((l) => l.startsWith("/"));
  const ctr = docker("ps", "--filter", `name=^${PREFIX}${PROJECT}-`, "--format", "{{.Names}}").stdout.trim().split("\n")[0];
  report.sandbox = { ctr, uid, gid, dir, ws: state.ws };
  if (!ctr || !uid || !dir) return record("discover sandbox/identity/dir", false, report.sandbox);
  record("discover sandbox/identity/dir", true, report.sandbox);
  const ident = `${uid}:${gid}`;
  const only = process.env.EPI_LFS_ONLY ? new Set(process.env.EPI_LFS_ONLY.split(",")) : null;
  const want = (n) => !only || only.has(String(n));

  if (want(1)) {
  // 1. live streaming
  const s = await streamExec(ctr, ident, dir, "for i in 1 2 3 4 5; do echo tick$i; sleep 0.4; done");
  const first = s.chunks[0]?.t ?? Infinity, last = s.chunks.at(-1)?.t ?? 0;
  record("streaming: chunks arrive incrementally", s.code === 0 && s.chunks.length >= 3 && last - first > 1000, { first, last, n: s.chunks.length, ms: s.ms });

  }
  if (want(2)) {
  // 2. env + exit code
  const e = await streamExec(ctr, ident, dir, 'echo FOO=$FOO; exit 7', { env: { FOO: "bar baz" } });
  record("env passthrough + exit code", e.code === 7 && e.out.toString().includes("FOO=bar baz"), { code: e.code, out: e.out.toString().trim() });

  }
  if (want(3)) {
  // 3. same view as native exec: sees branch b content, writes land in workspace
  const v = await streamExec(ctr, ident, dir, "cat b-dir/x.txt && echo hello-from-docker-exec > from-docker-exec.txt && ls -ln from-docker-exec.txt");
  record("docker exec sees workspace & writes", v.code === 0 && v.out.toString().startsWith("x"), v.out.toString().trim());

  }
  if (want(4)) {
  // 4. binary bytes through stdout
  const b = await streamExec(ctr, ident, dir, "cat img.png");
  const sha = createHash("sha256").update(b.out).digest("hex");
  record("binary stdout byte-exact", sha === report.fixtureSha["img.png"], { bytes: b.out.length, sha });

  }
  if (want(5)) {
  // 5. symlink in workspace
  const l = await streamExec(ctr, ident, dir, "readlink link-to-app; cat link-to-app");
  record("symlink preserved in workspace", l.out.toString().startsWith("src/app.js"), l.out.toString().trim());

  }
  if (want(6)) {
  // 6. killing the local docker client does NOT stop the remote command (expected) -> must kill remotely
  const tag = `orphan-${id}`;
  const k = streamExec(ctr, ident, dir, `exec -a ${tag} sleep 30`, { killLocalAfterMs: 1500 });
  await k; await sleep(500);
  const orphan = docker("exec", ctr, "bash", "-c", `pgrep -af ${tag} || true`).stdout.trim();
  record("local client kill leaves remote process (expected true)", orphan.length > 0, orphan || "(none)");
  docker("exec", ctr, "bash", "-c", `pkill -KILL -f ${tag} || true`);

  }
  if (want(7)) {
  // 7. remote cancel: setsid session, TERM-ignoring child + background grandchild, TERM then KILL
  const body = `trap '' TERM\n(trap '' TERM; while :; do sleep 1; done) &\necho SID:$$\nwhile :; do sleep 1; done\n`;
  sh("bash", ["-c", `printf %s "$1" | docker exec -i ${ctr} sh -c 'cat > /tmp/cancel-${id}.sh; chmod 755 /tmp/cancel-${id}.sh'`, "_", body]);
  let sidOut = "";
  const cancelRun = streamExec(ctr, ident, dir, `exec setsid -w /tmp/cancel-${id}.sh`, { onData: (d) => (sidOut += d) });
  await sleep(1200);
  const sid = /SID:(\d+)/.exec(sidOut)?.[1] ?? "";
  const before = procsInSession(ctr, sid);
  const t0 = Date.now();
  docker("exec", ctr, "bash", "-c", `pkill -TERM -s ${sid}; true`);
  await sleep(1000);
  const afterTerm = procsInSession(ctr, sid);
  docker("exec", ctr, "bash", "-c", `pkill -KILL -s ${sid}; true`);
  const r = await cancelRun;
  await sleep(300);
  const afterKill = procsInSession(ctr, sid);
  record("remote cancel TERM->KILL by session reaps all", before.split("\n").length >= 3 && afterTerm.length > 0 && afterKill.length === 0, { sid, before, afterTerm, afterKill, clientExit: r.code, cancelMs: Date.now() - t0 });

  }
  // 8. what holds the mount? processes with cwd/fds under the workspace
  report.holdersBeforeUnmount = holders(ctr, dir, ident);
  record("no process holds workspace before unmount", report.holdersBeforeUnmount === "", report.holdersBeforeUnmount || "(none)");
}

const holders = (ctr, dir, ident = "0:0") => docker("exec", "-u", ident, ctr, "sh", "-c", `for p in /proc/[0-9]*; do c=$(readlink $p/cwd 2>/dev/null); f=$(ls -l $p/fd 2>/dev/null | grep -c ' ${dir}'); case "$c" in ${dir}*) echo "$(basename $p) cwd=$c $(tr '\\0' ' ' < $p/cmdline)";; *) [ "$f" -gt 0 ] && echo "$(basename $p) fds=$f $(tr '\\0' ' ' < $p/cmdline)";; esac; done`).stdout.trim();

// ---------- cleanup ----------
function cleanup() {
  const names = docker("ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{.Names}}").stdout.trim().split("\n").filter(Boolean);
  if (names.length) docker("rm", "-f", ...names);
  const v = docker("volume", "rm", VOLUME);
  report.cleanup = { removedContainers: names, volume: v.code === 0 ? "removed" : v.stderr.trim() };
  const left = docker("ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{.Names}}").stdout.trim();
  report.cleanup.leftover = left || null;
}

// ---------- main ----------
mkdirSync(HOME, { recursive: true }); chmodSync(HOME, 0o700);
if (process.env.EPI_LFS_SRC_COPY_FROM) {
  const t0 = Date.now();
  const r = sh("rsync", ["-a", "--exclude=.env", "--exclude=.env.*", "--exclude=*.pem", "--exclude=*.key", `${process.env.EPI_LFS_SRC_COPY_FROM}/`, `${SRC}/`], { timeout: 600_000 });
  report.stagingMs = Date.now() - t0; console.log("staging rsync", r.code, report.stagingMs, "ms");
} else fixture();
const srcBefore = snapshot(SRC);
if (docker("volume", "create", VOLUME).code !== 0) throw new Error("volume create failed");
try {
  if (process.env.EPI_LFS_MODE === "diff") { step("diffFormat"); } else
  if (process.env.EPI_LFS_MODE === "init") { step("initOnly"); } else
  if (process.env.EPI_LFS_MODE === "matrix") { step("matrix"); } else
  if (process.env.EPI_LFS_MODE === "race") { step("race"); const c = docker("ps", "--filter", `name=^${PREFIX}${PROJECT}-`, "--format", "{{.Names}}").stdout.trim().split("\n")[0]; if (c) report.daemonLog = docker("logs", "--tail", "80", c).stderr + docker("logs", "--tail", "80", c).stdout; } else
  if (step("setup")) {
    await dockerExecProbes();
    step("afterDockerExec");
    const ctr = report.sandbox?.ctr;
    if (ctr) {
      report.holdersAfterSteps = holders(ctr, "/workspaces/", `${report.sandbox.uid}:${report.sandbox.gid}`);
      report.mountsAfterSteps = docker("exec", ctr, "sh", "-c", "grep workspaces /proc/mounts || true").stdout.trim();
      console.log("holders after steps:", report.holdersAfterSteps || "(none)");
      console.log("mounts after steps:", report.mountsAfterSteps || "(none)");
    }
  }
} finally {
  if (process.env.EPI_LFS_KEEP === "1") { report.cleanup = "kept"; writeFileSync(join(RUN, "cleanup.sh"), `docker rm -f $(docker ps -aq --filter name=^${PREFIX}) ; docker volume rm ${VOLUME}\n`); console.log("KEPT; cleanup:", join(RUN, "cleanup.sh")); } else
  cleanup();
  const srcAfter = snapshot(SRC);
  report.sourceUnchanged = JSON.stringify(srcBefore) === JSON.stringify(srcAfter);
  try { report.sdk = JSON.parse(readFileSync(STATE, "utf8")).results; } catch { report.sdk = null; }
  writeFileSync(join(RUN, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nsource unchanged: ${report.sourceUnchanged}; cleanup: ${JSON.stringify(report.cleanup)}`);
  console.log(`report: ${join(RUN, "report.json")}`);
}
