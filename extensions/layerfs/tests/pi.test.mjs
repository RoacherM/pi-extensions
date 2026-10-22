// v0.2 Real Pi 1.2.0 AgentSession + scripted faux model + real LayerFS backend.
// Covers: Store-direct tools, on-demand bash mount/abort, /layerfs diff+apply,
// multi-session apply without reverting, /tree + /fork + /resume time-travel,
// Store container self-healing, fail-closed startup, and explicit opt-out.
// Run: node tests/pi.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_HOME = homedir();
const id = Date.now().toString(36);
const base = join(REAL_HOME, ".cache/pi-layerfs-test", `pi-${id}`);
const cwd = join(base, "project");
mkdirSync(join(cwd, "src"), { recursive: true });
writeFileSync(join(cwd, "README.md"), "original readme\n");
writeFileSync(join(cwd, "src/math.js"), "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n");
writeFileSync(join(cwd, ".env"), "TOKEN=secret\n");
process.env.HOME = join(base, "home");
mkdirSync(process.env.HOME, { recursive: true });
process.env.PI_CODING_AGENT_DIR = join(base, "agent");
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
const PREFIX = `pi-lfs-pt-${id}-`;
process.env.PI_LAYERFS_ROOT = join(base, "lfs");
process.env.PI_LAYERFS_PREFIX = PREFIX;
process.env.PI_LAYERFS_KILL_GRACE_MS = "1000";
process.env.PI_LAYERFS_BUNDLE ??= join(REAL_HOME, ".cache/epi-layerfs/bundle-5fb68dd");

const { fauxAssistantMessage, fauxText, fauxToolCall, createFauxCore } = await import("@earendil-works/pi-ai");
const { createAgentSessionServices, createAgentSessionFromServices, resolveCliModel, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { default: layerfs, CHECKPOINT_ENTRY } = await import("../src/index.ts");

const docker = (...a) => spawnSync("docker", a, { encoding: "utf8" });
const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const ev = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - t0} ms)${ev ? ` :: ${String(ev).slice(0, 220)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`);
  }
};
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

function faux(pi, pendingRef) {
  const core = createFauxCore({ provider: "lfs-faux", models: [{ id: "m" }] });
  core.setResponses(Array.from({ length: 200 }, () => () => {
    const calls = pendingRef.calls;
    pendingRef.calls = [];
    if (!calls.length) return fauxAssistantMessage(fauxText("done"));
    return fauxAssistantMessage(calls.map(([n, a]) => fauxToolCall(n, a)), { stopReason: "toolUse" });
  }));
  pi.registerProvider("lfs-faux", {
    baseUrl: "http://localhost:0", apiKey: "faux", api: core.api, streamSimple: core.streamSimple,
    models: core.models.map((m) => ({ id: m.id, name: m.name, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens })),
  });
}

async function makeSession({ withLayerfs = true, sessionManager } = {}) {
  const pending = { calls: [] };
  const updates = [];
  const services = await createAgentSessionServices({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => faux(pi, pending), (pi) => pi.on("tool_execution_update", (e) => updates.push({ t: Date.now(), id: e.toolCallId })), ...(withLayerfs ? [layerfs] : [])],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const { model } = resolveCliModel({ cliModel: "lfs-faux/m", modelRuntime: services.modelRuntime });
  const { session } = await createAgentSessionFromServices({
    services, model, thinkingLevel: "off", sessionManager: sessionManager ?? SessionManager.inMemory(cwd),
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  });
  const errors = [];
  session.extensionRunner.onError((e) => errors.push(e));
  await session.bindExtensions({ mode: "print" });
  return {
    session, errors, updates,
    async run(calls) {
      const before = session.messages.length;
      pending.calls = calls;
      await session.prompt("scripted");
      return session.messages.slice(before).filter((m) => m.role === "toolResult");
    },
    checkpoints: () => session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === CHECKPOINT_ENTRY),
    shutdown: () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
  };
}

let main, peer;
try {
  main = await makeSession();
  const { session, run } = main;

  await step("registration: one tool per name, /layerfs command", async () => {
    for (const n of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
      assert.equal(session.getAllTools().filter((t) => t.name === n).length, 1, n);
    }
    assert.ok(session.extensionRunner.getCommand("layerfs"));
  });

  await step("read sees the imported snapshot, not later host edits (0 Sandboxes)", async () => {
    const [r0] = await run([["read", { path: "README.md" }]]);
    assert.equal(r0.isError, false, text(r0));
    writeFileSync(join(cwd, "README.md"), "host edited after start\n");
    const [r] = await run([["read", { path: "README.md" }]]);
    assert.match(text(r), /original readme/);
    writeFileSync(join(cwd, "README.md"), "original readme\n");
    const sb = docker("ps", "-q", "--filter", `name=^${PREFIX}`, "--filter", "label=layerfs.role=sandbox").stdout.trim();
    assert.equal(sb, "", "Store-direct read must not start a Sandbox");
  });

  await step(".env is not visible in the workspace", async () => {
    const [r] = await run([["read", { path: ".env" }]]);
    assert.equal(r.isError, true);
    assert.doesNotMatch(text(r), /TOKEN=secret/);
  });

  await step("write: Store changes in ms, host untouched, checkpoint entry has toolCallId", async () => {
    const [r] = await run([["write", { path: "notes/plan.md", content: "# plan v1\n" }]]);
    assert.equal(r.isError, false, text(r));
    assert.equal(existsSync(join(cwd, "notes/plan.md")), false);
    const cps = main.checkpoints();
    assert.equal(cps.length, 1);
    assert.deepEqual(cps[0].data.origins, [r.toolCallId]);
    return `commit ${cps[0].data.commit?.slice(0, 12)}`;
  });

  await step("edit with two replacements in one call (Store-direct)", async () => {
    const [r] = await run([["edit", { path: "src/math.js", edits: [{ oldText: "a + b", newText: "a + b + 0" }, { oldText: "a - b", newText: "a - b - 0" }] }]]);
    assert.equal(r.isError, false, text(r));
    const [rr] = await run([["read", { path: "src/math.js" }]]);
    assert.match(text(rr), /a \+ b \+ 0/);
    assert.match(text(rr), /a - b - 0/);
    assert.doesNotMatch(readFileSync(join(cwd, "src/math.js"), "utf8"), /\+ 0/);
  });

  await step("bash streams updates, runs in Linux, commits, and unmounts immediately", async () => {
    main.updates.length = 0;
    const [r] = await run([["bash", { command: "uname -s; for i in 1 2 3; do echo step$i; sleep 0.35; done; echo generated > gen.txt" }]]);
    assert.equal(r.isError, false, text(r));
    assert.match(text(r), /Linux[\s\S]*step3/);
    assert.ok(main.updates.length >= 2, `expected streaming updates, got ${main.updates.length}`);
    assert.equal(existsSync(join(cwd, "gen.txt")), false);
    assert.equal(main.checkpoints().at(-1).data.origins[0], r.toolCallId);
  });

  await step("grep / find / ls see the Branch (incl. files written by bash)", async () => {
    const [g, f, l] = await run([["grep", { pattern: "generated", path: "." }], ["find", { pattern: "*.md" }], ["ls", { path: "." }]]);
    assert.match(text(g), /gen\.txt:1: generated/);
    assert.match(text(f), /notes\/plan\.md/);
    assert.match(text(l), /gen\.txt/);
    assert.doesNotMatch(text(l), /\.env/);
  });

  await step("user ! command routes into the Branch and checkpoints", async () => {
    const routed = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "echo user > user.txt && pwd", cwd, excludeFromContext: false });
    assert.ok(routed?.operations, "user_bash must be routed");
    const out = await session.executeBash("echo user > user.txt && pwd", undefined, { operations: routed.operations });
    assert.equal(out.output.trim().split("\n").at(-1), cwd, "commands see the Branch at the host path");
    assert.equal(existsSync(join(cwd, "user.txt")), false);
    assert.ok(main.checkpoints().some((c) => c.data.origins.includes("user_bash")));
  });

  await step("abort stops the remote command tree", async () => {
    const p = run([["bash", { command: "trap '' TERM; sleep 300" }]]);
    await new Promise((r) => setTimeout(r, 1200));
    await session.abort();
    await p;
    await new Promise((r) => setTimeout(r, 300));
    const ctr = docker("ps", "--filter", `name=^${PREFIX}`, "--filter", "label=layerfs.role=sandbox", "--format", "{{.Names}}").stdout.trim().split("\n")[0];
    if (ctr) {
      assert.equal(docker("exec", ctr, "sh", "-c", "pgrep -u 501 -f 'sleep 300' || true").stdout.trim(), "");
    }
  });

  await step("parallel tool calls in one turn are serialized, each checkpointed", async () => {
    const before = main.checkpoints().length;
    const rs = await run([["write", { path: "p1.txt", content: "1\n" }], ["write", { path: "p2.txt", content: "2\n" }], ["bash", { command: "echo 3 > p3.txt" }]]);
    assert.ok(rs.every((r) => !r.isError), rs.map(text).join(" | "));
    const cps = main.checkpoints().slice(before);
    assert.equal(cps.length, 3);
    assert.deepEqual(cps.flatMap((c) => c.data.origins).sort(), rs.map((r) => r.toolCallId).sort());
  });

  await step("/tree + /fork time-travel: jumping to an earlier entry restores file state", async () => {
    const firstCpEntry = main.checkpoints()[0]; // right after notes/plan.md was written, before gen.txt / p1.txt
    // Simulate /fork at firstCpEntry
    await session.extensionRunner.emit({ type: "session_before_fork", entryId: firstCpEntry.id, position: "at" });
    await session.extensionRunner.emit({ type: "session_start", reason: "fork" });
    const [rPlan, rGen] = await run([["read", { path: "notes/plan.md" }], ["read", { path: "gen.txt" }]]);
    assert.equal(rPlan.isError, false);
    assert.match(text(rPlan), /# plan v1/);
    assert.equal(rGen.isError, true, "gen.txt did not exist at firstCpEntry");

    // Simulate /tree jumping back to the latest leaf (where gen.txt and p1..p3 exist)
    await session.extensionRunner.emit({ type: "session_tree", newLeafId: session.sessionManager.getLeafId(), oldLeafId: firstCpEntry.id });
    const [rGenAfter] = await run([["read", { path: "gen.txt" }]]);
    assert.equal(rGenAfter.isError, false);
    assert.match(text(rGenAfter), /generated/);
  });

  await step("multi-session /layerfs apply: peer session B and main session A both apply without reverting each other", async () => {
    peer = await makeSession();
    await peer.run([["write", { path: "peer-only.txt", content: "from peer B\n" }]]);

    let out = "";
    const log = console.log;
    console.log = (m) => (out += `${m}\n`);
    try {
      await session.prompt("/layerfs diff");
      await session.prompt("/layerfs apply");
      await peer.session.prompt("/layerfs apply");
    } finally { console.log = log; }

    assert.match(out, /Added\s+gen\.txt/);
    assert.equal(readFileSync(join(cwd, "gen.txt"), "utf8"), "generated\n");
    assert.equal(readFileSync(join(cwd, "notes/plan.md"), "utf8"), "# plan v1\n");
    assert.match(readFileSync(join(cwd, "src/math.js"), "utf8"), /a \+ b \+ 0/);
    assert.equal(readFileSync(join(cwd, "peer-only.txt"), "utf8"), "from peer B\n", "peer B applied its file without reverting A's files");
    assert.equal(readFileSync(join(cwd, ".env"), "utf8"), "TOKEN=secret\n");
    return `both sessions applied cleanly`;
  });

  await step("Store container self-heals when stopped mid-session", async () => {
    docker("stop", "-t", "1", `${PREFIX}store`);
    // The first call triggers onUnreachable self-heal; wait briefly and verify next call succeeds
    await run([["read", { path: "README.md" }]]).catch(() => {});
    for (let i = 0; i < 30; i++) {
      const state = docker("inspect", "-f", "{{.State.Running}}", `${PREFIX}store`).stdout.trim();
      if (state === "true") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const [rAfter] = await run([["read", { path: "README.md" }]]);
    assert.equal(rAfter.isError, false, text(rAfter));
    assert.match(text(rAfter), /original readme/);
  });

  await step("fail-closed: broken LayerFS -> tools error, host never written", async () => {
    process.env.PI_LAYERFS_IMAGE = "pi-lfs-missing:none";
    const bad = await makeSession();
    try {
      const [r, w] = await bad.run([["read", { path: "README.md" }], ["write", { path: "fallback.txt", content: "x" }]]);
      assert.equal(r.isError, true);
      assert.match(text(r), /LayerFS failed to start/);
      assert.equal(w.isError, true);
      assert.equal(existsSync(join(cwd, "fallback.txt")), false);
      return text(r).slice(0, 120);
    } finally { delete process.env.PI_LAYERFS_IMAGE; await bad.shutdown(); }
  });

  await step("explicit opt-out PI_LAYERFS=0 uses the host folder", async () => {
    process.env.PI_LAYERFS = "0";
    const off = await makeSession();
    try {
      const [r] = await off.run([["read", { path: ".env" }]]);
      assert.match(text(r), /TOKEN=secret/);
    } finally { delete process.env.PI_LAYERFS; await off.shutdown(); }
  });
} finally {
  await main?.shutdown().catch(() => {});
  await peer?.shutdown().catch(() => {});
  const left = docker("ps", "-aq", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (left.length) docker("rm", "-f", ...left);
  const vols = docker("volume", "ls", "-q", "--filter", `name=^${PREFIX}`).stdout.trim().split("\n").filter(Boolean);
  if (vols.length) docker("volume", "rm", ...vols);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; cleaned ${left.length} containers, ${vols.length} volumes`);
  rmSync(base, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
