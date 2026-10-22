// Runs INSIDE a Linux container (real layerfs.node). One step per process, so
// later steps also prove that a fresh process can reuse records in LAYERFS_HOME.
// Usage: node sdk-step.mjs <step> <stateFile>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [step, stateFile] = process.argv.slice(2);
const bundle = process.env.LFS_BUNDLE;
const { LayerFS } = await import(`${bundle}/sdk/js/src/index.js`);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const lfs = new LayerFS(process.env.LFS_PROJECT);
const results = (state.results ??= []);
const t = async (name, fn) => {
  const start = Date.now();
  try {
    const value = await fn();
    results.push({ step, name, ok: true, ms: Date.now() - start, value });
    return value;
  } catch (error) {
    results.push({ step, name, ok: false, ms: Date.now() - start, error: { code: error?.code, message: String(error?.message ?? error).slice(0, 600), detail: error?.detail ?? null } });
    return undefined;
  }
};

const steps = {
  async setup() {
    await t("project.init", () => lfs.project.init(process.env.LFS_SOURCE));
    await t("branch.fork a", () => lfs.branch.fork("a"));
    await t("branch.fork b", () => lfs.branch.fork("b"));
    await t("fs.read text", () => lfs.fs.read("a", "/src/app.js", 1, 50));
    await t("fs.read crlf", () => lfs.fs.read("a", "/crlf.txt", 1, 10));
    await t("fs.read longline", async () => {
      const r = await lfs.fs.read("a", "/long.txt", 1, 5);
      return { ...r, content: undefined, contentLength: JSON.stringify(r).length };
    });
    await t("fs.read binary (expect Binary refusal)", () => lfs.fs.read("a", "/img.png", 1, 5));
    await t("fs.stat symlink", () => lfs.fs.stat("a", "/link-to-app"));
    await t("fs.stat .env imported?", () => lfs.fs.stat("a", "/.env"));
    await t("fs.list root", () => lfs.fs.list("a", "/", 100, 0));
    await t("fs.write a (new file)", () => lfs.fs.write("a", "/a-only.txt", "from a\n", "write a-only"));
    await t("fs.edit a (top hunk)", () => lfs.fs.edit("a", "/shared.txt", "line01\n", "line01-A\n", "edit top"));
    await t("fs.apply b (batch)", () => lfs.fs.apply("b", [
      { op: "mkdir", path: "/b-dir" },
      { op: "write", path: "/b-dir/x.txt", content: "x\n" },
      { op: "edit", path: "/shared.txt", oldText: "line20\n", newText: "line20-B\n" },
    ], "batch b"));
    await t("list_commits a", () => lfs.branch.list_commits("a", 10, 0));
    const ws = await t("workspace.mount b", () => lfs.workspace.mount("b"));
    state.ws = ws;
    await t("workspace.exec id/pwd/env", () => lfs.workspace.exec(ws, "id; pwd; echo HOME=$HOME; echo FOO=${FOO:-unset}; ls -la | head -20; mount | grep -E 'workspaces|fuse' | head -5", "inspect"));
    await t("workspace.exec sees b batch", () => lfs.workspace.exec(ws, "cat b-dir/x.txt; sed -n 20p shared.txt", "check"));
    await t("workspace.exec nonzero exit", () => lfs.workspace.exec(ws, "echo out; echo err >&2; exit 7", "fail"));
    save();
    lfs.close?.();
  },

  async afterDockerExec() {
    const ws = state.ws;
    await t("workspace.status after docker-exec writes", () => lfs.workspace.status(ws));
    await t("workspace.commit docker-exec writes", () => lfs.workspace.commit(ws, "docker exec writes"));
    await t("fs.read docker-exec file via Store", () => lfs.fs.read("b", "/from-docker-exec.txt", 1, 5));
    await t("workspace.exec dirty then unmount (expect refusal)", async () => {
      await lfs.workspace.exec(ws, "echo dirty > dirty.txt");
      return lfs.workspace.unmount(ws);
    });
    await t("workspace.commit dirty", () => lfs.workspace.commit(ws, "dirty"));
    await t("workspace.unmount clean", () => lfs.workspace.unmount(ws));
    await t("workspace.unmount retry after 1.5s", async () => { await new Promise((r) => setTimeout(r, 1500)); return lfs.workspace.unmount(ws); });
    // Mount-snapshot consistency: fs.write moves head after mount
    const ws2 = await t("mount a (consistency)", () => lfs.workspace.mount("a"));
    await t("fs.write a after mount", () => lfs.fs.write("a", "/after-mount.txt", "late\n"));
    await t("exec sees post-mount fs.write?", () => lfs.workspace.exec(ws2, "ls after-mount.txt 2>&1; true"));
    await t("exec write + commit on stale mount", async () => {
      await lfs.workspace.exec(ws2, "echo ws2 > ws2.txt");
      return lfs.workspace.commit(ws2, "ws2 write");
    });
    await t("fs.read a both files", async () => ({
      late: (await lfs.fs.read("a", "/after-mount.txt", 1, 2)).text,
      ws2: (await lfs.fs.read("a", "/ws2.txt", 1, 2)).text,
    }));
    await t("unmount ws2", () => lfs.workspace.unmount(ws2));
    // merges
    await t("merge a+b different hunks/files", () => lfs.branch.merge("a", "b", "ab"));
    await t("fs.read merged shared.txt", () => lfs.fs.read("ab", "/shared.txt", 1, 3));
    await t("fork c,d from main", async () => { await lfs.branch.fork("c"); await lfs.branch.fork("d"); return true; });
    await t("conflict setup", async () => {
      await lfs.fs.edit("c", "/shared.txt", "line10\n", "line10-C\n");
      await lfs.fs.edit("d", "/shared.txt", "line10\n", "line10-D\n");
      return true;
    });
    await t("merge c+d same hunk (expect Conflict)", () => lfs.branch.merge("c", "d", "cd"));
    await t("list_branches", () => lfs.project.list_branches(50, 0));
    await t("diff_commits main..ab", async () => {
      const head = (await lfs.branch.list_commits("ab", 1, 0)).items[0];
      return lfs.branch.diff_commits("main", head.id ?? head.commit ?? head, 50, 0, { hunks: false });
    });
    save();
    lfs.close?.();
  },
};

steps.matrix = async () => {
  await t("project.init", () => lfs.project.init(process.env.LFS_SOURCE));
  const W = (ws, c) => lfs.workspace.exec(ws, c);
  const variants = {
    V1_mount_unmount: async (ws) => {},
    V2_readonly_exec: async (ws) => { await W(ws, "cat shared.txt >/dev/null"); },
    V3_write_commit: async (ws) => { await W(ws, "echo v > v.txt"); await lfs.workspace.commit(ws, "v"); },
    V4_write_dirtyUnmount_commit: async (ws) => { await W(ws, "echo v > v.txt"); await lfs.workspace.unmount(ws).catch((e) => e.code); await lfs.workspace.commit(ws, "v"); },
    V5_emptyCommit_write_commit: async (ws) => { await lfs.workspace.commit(ws, "empty").catch((e) => e.code); await W(ws, "echo v > v.txt"); await lfs.workspace.commit(ws, "v"); },
    V6_emptyCommit_only: async (ws) => { await lfs.workspace.commit(ws, "empty").catch((e) => e.code); },
    V7_status_only: async (ws) => { await lfs.workspace.status(ws); },
    V8_write_commit_wait2s: async (ws) => { await W(ws, "echo v > v.txt"); await lfs.workspace.commit(ws, "v"); await new Promise((r) => setTimeout(r, 2000)); },
  };
  if (process.env.LFS_MATRIX === "idle") {
    for (const k of Object.keys(variants)) delete variants[k];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const ms of [500, 1000, 1500, 3000, 10000]) variants[`I_idle_${ms}`] = async () => wait(ms);
    variants.I_idle_3000_then_exec = async (ws) => { await wait(3000); await W(ws, "true"); };
    variants.I_idle_3000_then_status = async (ws) => { await wait(3000); await lfs.workspace.status(ws); };
    variants.I_keepalive_status_every_500ms_for_3s = async (ws) => { for (let i = 0; i < 6; i++) { await wait(500); await lfs.workspace.status(ws); } };
  }
  for (const [name, body] of Object.entries(variants)) {
    await lfs.branch.fork(name.toLowerCase().replace(/_/g, "-"));
    const ws = await lfs.workspace.mount(name.toLowerCase().replace(/_/g, "-"));
    let pre;
    try { await body(ws); pre = "ok"; } catch (e) { pre = `pre-error ${e.code}`; }
    await t(`${name} [${pre}] unmount`, async () => { const r = await lfs.workspace.unmount(ws); return r.kind; });
  }
  save();
};
steps.race = async () => {
  await t("project.init", () => lfs.project.init(process.env.LFS_SOURCE));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rounds = [];
  if (process.env.LFS_PREWARM === "1") { await lfs.branch.fork("warm"); const w = await lfs.workspace.mount("warm"); await wait(1500); try { rounds.push({ i: -1, warm: (await lfs.workspace.unmount(w)).kind }); } catch (e) { rounds.push({ i: -1, warm: e.code }); } await wait(2000); }
  for (let i = 0; i < Number(process.env.LFS_ROUNDS || 30); i++) {
    const br = `r${i}`;
    await lfs.branch.fork(br);
    const ws = await lfs.workspace.mount(br);
    if (i % 2) { await lfs.workspace.exec(ws, `echo ${i} > f.txt`); await lfs.workspace.commit(ws, "w"); }
    const ms = Math.floor(Math.random() * 1500);
    await wait(ms);
    const r = { i, ms, wrote: !!(i % 2), path: ws.path };
    const t0 = Date.now();
    try { r.unmount = (await lfs.workspace.unmount(ws)).kind; } catch (e) { r.unmount = `${e.code}:${(e.message.match(/stage: \w+/) || [""])[0]}`; }
    r.unmountMs = Date.now() - t0;
    if (r.unmount !== "Unmounted") {
      try { r.retry = (await lfs.workspace.unmount(ws)).kind; } catch (e) { r.retry = `${e.code}:${e.message.slice(0, 80)}`; }
      try { r.retryDiscard = (await lfs.workspace.unmount(ws, true)).kind; } catch (e) { r.retryDiscard = `${e.code}:${e.message.slice(0, 80)}`; }
      try { const ws2 = await lfs.workspace.mount(br); r.remount = ws2.path; await lfs.workspace.exec(ws2, "cat f.txt 2>/dev/null; true"); r.remountUnmount = (await lfs.workspace.unmount(ws2)).kind; } catch (e) { r.remount = `${e.code}:${e.message.slice(0, 80)}`; }
    }
    rounds.push(r);
  }
  results.push({ step, name: "race rounds", ok: true, value: rounds });
  save();
};
steps.initOnly = async () => {
  await t("project.init big", () => lfs.project.init(process.env.LFS_SOURCE));
  await t("fork+mount", async () => { await lfs.branch.fork("w"); return lfs.workspace.mount("w"); });
  save();
};
steps.diffFormat = async () => {
  await t("init", () => lfs.project.init(process.env.LFS_SOURCE));
  await lfs.branch.fork("w");
  const ws = await lfs.workspace.mount("w");
  await lfs.workspace.exec(ws, "echo new > added.txt && echo changed >> shared.txt && rm crlf.txt && chmod +x src/app.js && ln -sf shared.txt link-to-app && mkdir -p d/e && printf '\\000\\001' > d/e/bin.dat && mv long.txt moved.txt");
  await t("commit", () => lfs.workspace.commit(ws, "changes"));
  await t("diff_branches main w (no hunks)", () => lfs.branch.diff_branches("main", "w", 50, 0, { hunks: false }));
  await t("diff_branches main w (hunks)", () => lfs.branch.diff_branches("main", "w", 50, 0));
  await t("status after", () => lfs.workspace.status(ws));
  await lfs.workspace.unmount(ws).catch(() => {});
  save();
};
steps.unmountOnly = async () => { await t("unmount after reaping holders", () => lfs.workspace.unmount(state.ws)); save(); };
if (!steps[step]) throw new Error(`unknown step ${step}`);
await steps[step]();
process.exit(0);
