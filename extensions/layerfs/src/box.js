// The Store container of ported Live projects (macOS):
// `<prefix>store` (`pi-lfs-store` by default): one long-lived Linux container
// per LayerFS home whose main process is `port/worker.mjs`.
//
// Why `--network host` + `DAEMON_HOST = "127.0.0.1"`:
// On Docker Desktop for Mac, `host.docker.internal` resolves to `0.250.250.254`
// (the macOS host's async port forwarder). When LayerFS creates a Sandbox
// container and dials its published port the instant `LAYERFS_DAEMON_LISTEN`
// appears in the container log, the Linux VM's `127.0.0.1:<port>` is already
// listening, but the macOS forwarder on `0.250.250.254:<port>` is opened
// asynchronously and frequently returns `ECONNREFUSED`.
// Running the Store container with `--network host` puts it in the Linux VM's
// own network namespace so it dials `127.0.0.1:<port>` directly inside the VM
// with zero race. Mac processes connect to `worker.mjs` over a persistent
// `docker exec -i <box>` stream to the worker's Unix socket in `/tmp`.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { frame, readFrames } from "./port/frames.mjs";

const run = promisify(execFile);
export const VOLUMES = "/var/lib/docker/volumes";
export const PORT = dirname(fileURLToPath(new URL("./port/run.mjs", import.meta.url)));
/** Inside `--network host` (the Linux VM), Sandbox daemon ports are on 127.0.0.1. */
export const DAEMON_HOST = "127.0.0.1";
const READY_MS = 15_000;

/** `docker run` mounts and settings of a ported call's process: the Store container's worker, or Init's own. */
export const callMounts = ({ home, bundle }) => [
  "-v", "/var/run/docker.sock:/var/run/docker.sock",
  "-v", `${VOLUMES}:${VOLUMES}`,
  "-v", `${home}:${home}`,
  "-v", `${bundle}:${bundle}:ro`,
  "-v", `${PORT}:${PORT}:ro`,
  "-e", `LAYERFS_NATIVE=${join(bundle, "layerfs.node")}`,
];

/** Where a ported call opens the Store of the project volume `volume`. */
export const storePathOf = (volume) => `${VOLUMES}/${volume}/_data/global/store.sqlite`;

/** The Store container's name: one per LayerFS home, whose container prefix sets it apart. */
export const storeName = (prefix) => `${prefix}store`;

/** The file that tells a home's processes how to reach its Store container's worker: { box, sock, secret }. */
export const storeFile = (home) => join(home, ".layerfs-store.json");

/** A short id of a build folder, as the Store container's label. */
export const buildOf = (bundle) => createHash("sha256").update(bundle).digest("hex").slice(0, 12);

/** The worker's code, as the Store container's label: a changed worker replaces it. */
const workerVersion = () => {
  const hash = createHash("sha256");
  for (const file of ["worker.mjs", "call.mjs", "frames.mjs"]) hash.update(readFileSync(join(PORT, file)));
  return hash.digest("hex").slice(0, 12);
};

/** Opens a full-duplex stream to the worker's Unix socket inside `box`. */
export function connectBoxSocket(box, sockPath) {
  const child = spawn(
    "docker",
    [
      "exec", "-i", box, "node", "-e",
      `const s=require("node:net").connect(process.argv[1]);process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0));process.stdin.on("end",()=>s.end());`,
      sockPath,
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
    child.stdin.on("error", () => {});
    return {
    write: (buf) => child.stdin.write(buf),
    destroy: () => { try { child.stdin.end(); child.kill("SIGKILL"); } catch {} },
    ref: () => { child.ref?.(); child.stdout.ref?.(); },
    unref: () => { child.unref?.(); child.stdout.unref?.(); },
    on: (ev, fn) => {
      if (ev === "data") child.stdout.on("data", fn);
      else if (ev === "error") child.on("error", fn);
      else if (ev === "close") child.on("close", fn);
    },
  };
}

let starting = null;
/** Starts the Store container and its worker unless they run, and writes storeFile; one start at a time. */
export function ensureBox(spec) {
  starting ??= start(spec).finally(() => { starting = null; });
  return starting;
}

async function start(spec) {
  const docker = (...args) => run("docker", ["-H", `unix://${spec.docker}`, ...args]).then((r) => r.stdout.trim());
  const version = workerVersion();
  const build = buildOf(spec.bundle);
  const sock = `/tmp/${spec.box}.sock`;

  let state = await docker(
    "inspect", "-f",
    '{{.State.Running}} {{index .Config.Labels "layerfs.worker"}} {{index .Config.Labels "layerfs.build"}} {{index .Config.Labels "layerfs.home"}}',
    spec.box,
  ).catch(() => null);
  const home = state?.split(" ").slice(3).join(" ");
  if (home && home !== spec.home) {
    throw new Error(`the Store container ${spec.box} serves the LayerFS home ${home}; give this home its own containerPrefix`);
  }
  if (state && (state.split(" ")[1] !== version || state.split(" ")[2] !== build || !home)) {
    await docker("rm", "-f", spec.box);
    state = null;
  }
  let secret;
  if (!state) {
    secret = randomBytes(32).toString("hex");
    await docker(
      "run", "-d", "--pull", "never", "--network", "host", "--name", spec.box, "--init",
      "--restart", "unless-stopped",
      "--label", "layerfs.role=store",
      "--label", `layerfs.worker=${version}`,
      "--label", `layerfs.build=${build}`,
      "--label", `layerfs.home=${spec.home}`,
      "-e", `DSH_BOX_SECRET=${secret}`,
      "-e", `DSH_BOX_SOCK=${sock}`,
      "-e", "UV_THREADPOOL_SIZE=64",
      ...callMounts(spec),
      "--entrypoint", "node", spec.image, join(PORT, "worker.mjs"),
    );
  } else {
    if (state.startsWith("false")) await docker("start", spec.box);
    const env = await docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", spec.box);
    secret = /^DSH_BOX_SECRET=([0-9a-f]+)$/m.exec(env)?.[1];
    if (!secret) throw new Error(`the Store container ${spec.box} has no secret`);
  }
  await listening(spec.box, sock, secret);
  const file = storeFile(spec.home);
  writeFileSync(`${file}.tmp`, JSON.stringify({ box: spec.box, sock, secret }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Waits until the worker answers a ping over its Unix socket. */
async function listening(box, sock, secret) {
  for (const until = Date.now() + READY_MS; ; ) {
    const ok = await new Promise((resolve) => {
      const stream = connectBoxSocket(box, sock);
      const done = (value) => { clearTimeout(timer); stream.destroy(); resolve(value); };
      const timer = setTimeout(() => done(false), 1500);
      readFrames(stream, (value) => { if (value?.id === 1) done(value.answer?.value === "ready"); }, () => done(false));
      stream.on("error", () => done(false));
      stream.on("close", () => done(false));
      stream.write(Buffer.concat([frame({ secret }), frame({ id: 1, fn: "ping" })]));
    });
    if (ok) return;
    if (Date.now() > until) throw new Error(`the Store container ${box}'s worker did not answer within ${READY_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
