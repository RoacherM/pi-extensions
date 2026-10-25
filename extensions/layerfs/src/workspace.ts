import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsc, existsSync, mkdtempSync, promises as fsp, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { BindingStore, type HostEntry, type HostIndex, type ProjectRecord, type SessionBinding } from "./bindings.ts";
import type { LayerfsConfig } from "./config.ts";
import { createProjectClient, ensureNativeDirs, type NativeSpec } from "./core/client.ts";
import { run } from "./core/exec-helper.ts";
import { bothSpellings, buildSeatbeltProfile } from "./seatbelt.ts";

export interface Workspace { sandbox: string; path: string; image?: string }
export interface Checkpoint { origins: string[]; label: string; commit: string | null; branch: string; changed: boolean; at: number }
export interface ApplyResult { applied: string[]; skipped: string[]; conflicts: string[]; unchanged: string[]; warnings: string[] }
export interface UserBranch { name: string; base: string; head: string | null; logicalBranch: string; isYours: boolean }
export interface MergeResult {
  merged: boolean;
  branch: string;
  head: string | null;
  conflicts: Array<{ path: string; kind?: string }>;
  lww: number;
  lwwPaths?: string[];
  fallback?: boolean;
}
export interface OpenOptions {
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  resumeBinding?: { project?: string; baseBranch?: string; workBranch?: string; baseRef?: string; headCommit?: string | null };
  forkFromRef?: string | null;
}

export async function assertInsideWorkspace(wsReal: string, candidate: string, allowFinalSymlink = false): Promise<string> {
  const allowed = bothSpellings(wsReal);
  const isInside = (target: string) => allowed.some((w) => target === w || target.startsWith(`${w}/`));
  const denyOutside = () => {
    const err = new Error("refusing to write through a symlink pointing outside the LayerFS workspace");
    (err as any).code = "EPERM";
    return err;
  };
  if (!isInside(candidate)) throw denyOutside();

  const checkSingleNode = async (nodePath: string) => {
    let hop = nodePath;
    for (let depth = 0; depth < 40; depth++) {
      if (!isInside(hop)) throw denyOutside();
      const lst = await fsp.lstat(hop).catch(() => null);
      if (lst?.isSymbolicLink()) {
        const rawTarget = await fsp.readlink(hop);
        hop = resolve(dirname(hop), rawTarget);
        if (!isInside(hop)) throw denyOutside();
        continue;
      }
      if (lst) {
        const real = await fsp.realpath(hop).catch(() => null);
        if (!real || !isInside(real)) throw denyOutside();
        return;
      }
      // Target does not exist yet: walk up to nearest existing ancestor and verify it is inside wsReal
      let anc = dirname(hop);
      while (anc && anc !== dirname(anc)) {
        const realAnc = await fsp.realpath(anc).catch(() => null);
        if (realAnc) {
          if (!isInside(realAnc)) throw denyOutside();
          break;
        }
        anc = dirname(anc);
      }
      return;
    }
    throw denyOutside();
  };

  let cur = allowFinalSymlink ? dirname(candidate) : candidate;
  while (cur && isInside(cur) && cur !== dirname(cur)) {
    await checkSingleNode(cur);
    if (allowed.includes(cur)) break;
    cur = dirname(cur);
  }
  return candidate;
}

export class LayerfsError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail: unknown = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

type Log = (msg: string) => void;
const LWW_DEFAULT = "%include .gitignore\n.git/\n";
const HOMES = [...new Set([homedir(), (() => { try { return realpathSync(homedir()); } catch { return homedir(); } })()])];
/** Extra secrets never readable outside the project, on top of config.excludes. */
const OUTSIDE_SECRET_PATTERNS = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json", ".config/gh", ".config/gcloud", ".azure",
  ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".pi/agent/auth.json", ".epi/pi/auth.json", "auth.json",
];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * Native LayerFS Session:
 * - Shares one persistent APFS Project Store per host folder across sessions/agents (`BindingStore`)
 * - Syncs external host edits into `"main"` on session start
 * - Routes `read / write / edit / ls / find / grep` through `lfs.fs.*` directly on the Store,
 *   with automatic byte-exact Workspace fallback for binary, symlinks or >48KB lines
 * - Mounts a Workspace on demand per `bash` call via native NFSv3 loopback + Seatbelt (`sandbox-exec`)
 * - Diffs and applies against this session's own `baseBranch` anchor and merges before publishing `"main"`
 * - Supports `/resume`, `/tree` and `/fork` time-travel via `switchToRef()`
 */
export class LayerfsSession {
  readonly cwd: string;
  readonly sessionId: string;
  readonly shortId: string;
  readonly logicalBranch: string;
  readonly touchPathsOnNextExec = new Set<string>();
  readonly config: LayerfsConfig;
  readonly log: Log;

  get isNative(): boolean { return true; }

  bindings!: BindingStore;
  spec!: NativeSpec;
  get boxSpec(): NativeSpec { return this.spec; }
  projectRecord!: ProjectRecord;
  lfs: any;
  operator: any;
  LayerFSError: any;

  baseBranch = "";
  workBranch = "";
  baseRef = "";
  headCommit: string | null = null;
  seq = 0;

  blocked: { reason: string; heldWs?: Workspace } | null = null;
  pendingOrigins: string[] = [];
  checkpoints: Checkpoint[] = [];
  unapplied = false;

  private lastStoreCommit: { kind: string; head: string | null } | null = null;
  private activeSids = new Map<string, () => Promise<void>>();
  private pendingUnmounts = new Set<Promise<unknown>>();
  private mutex: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(cwd: string, sessionId: string, config: LayerfsConfig, log: Log = () => {}) {
    // canonical path: /tmp/x and /private/tmp/x (or a symlinked folder) are one project
    this.cwd = (() => { try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); } })();
    this.sessionId = sessionId;
    this.shortId = createHash("sha256").update(`${sessionId}:${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 10);
    this.logicalBranch = config.branchName || (config.team && process.env.PI_SUBAGENT_CHILD !== "1" ? "lead" : `s-${this.shortId}`);
    this.config = config;
    this.log = log;
  }

  get project(): string { return this.projectRecord?.name ?? ""; }
  get volume(): string { return this.projectRecord?.volume ?? ""; }
  /** Effective snapshot ref even when no Commit has been made on workBranch yet. */
  get effectiveRef(): string { return this.headCommit ?? this.baseRef; }

  // ---------------------------------------------------------------- startup & project sharing

  static async preflight(config: LayerfsConfig): Promise<string> {
    const problems: string[] = [];
    for (const f of ["layerfs.node", "layerfs-daemon", "sdk/js/src/index.js"]) {
      try { await fsp.access(join(config.bundle, f), fsc.R_OK); } catch { problems.push(`missing ${join(config.bundle, f)}`); }
    }
    for (const bin of ["/sbin/mount_nfs", "/usr/bin/sandbox-exec"]) {
      try { await fsp.access(bin, fsc.X_OK); } catch { problems.push(`missing or non-executable ${bin}`); }
    }
    if (problems.length) throw new LayerfsError("Preflight", `LayerFS is not available: ${problems.join("; ")}`);
    return "native";
  }

  async open(options: OpenOptions = {}): Promise<void> {
    const t0 = Date.now();
    await LayerfsSession.preflight(this.config);
    this.spec = ensureNativeDirs(this.config);
    this.bindings = new BindingStore(join(this.config.root, "state"));

    const existing = this.bindings.byFolder(this.cwd);
    const usable = existing && (await this.isProjectAlive(existing));
    if (!usable) {
      this.projectRecord = await this.initProjectForFolder();
    } else {
      this.projectRecord = existing!;
      const client = await createProjectClient(this.spec, this.projectRecord);
      this.lfs = client.lfs;
      this.operator = client.operator;
      this.LayerFSError = client.LayerFSError;
      if (options.reason !== "reload" && options.reason !== "resume" && !options.forkFromRef) {
        await this.syncHostDriftIntoMain();
      }
    }

    await this.setupBranches(options);
    this.persistSessionBinding();
    this.log(`ready in ${Date.now() - t0} ms (project=${this.project} base=${this.baseBranch} work=${this.workBranch})`);
  }

  private async isProjectAlive(p: ProjectRecord): Promise<boolean> {
    const homeEntry = join(this.spec.home, p.name);
    const hasHome = await fsp.access(homeEntry).then(() => true, () => false);
    if (!hasHome) return false;
    return fsp.access(join(this.spec.stores, p.volume, "global", "store.sqlite")).then(() => true, () => false);
  }

  private async initProjectForFolder(): Promise<ProjectRecord> {
    return this.bindings.withProjectLock("_init", async () => {
      const name = this.bindings.freeProjectName(this.cwd, this.spec.home);
      const again = this.bindings.byFolder(this.cwd);
      if (again && (await this.isProjectAlive(again))) {
        const client = await createProjectClient(this.spec, again);
        this.lfs = client.lfs;
        this.operator = client.operator;
        this.LayerFSError = client.LayerFSError;
        return again;
      }
      const created = Date.now();
      const volume = `${this.config.prefix}${name}-store-${created.toString(36)}`;
      const staged = join(this.config.root, "staging", `${name}-${created}`);
      await fsp.mkdir(staged, { recursive: true });
      try {
        const list = join(this.config.root, "staging", `${name}-${created}.files`);
        await fsp.writeFile(list, (await listImportable(this.cwd, this.hostSkip)).join("\0"));
        const rs = await runLocal("rsync", ["-a", "--no-implied-dirs", "--links", "--from0", `--files-from=${list}`, `${this.cwd}/`, `${staged}/`]);
        await fsp.rm(list, { force: true });
        if (rs.code !== 0) throw new LayerfsError("Failed", `staging copy failed: ${rs.stderr.slice(0, 400)}`);

        const stagedScan = await scanHostDirectory(staged, this.hostSkip, {}, true);
        const hostIndex: HostIndex = {};
        for (const [rel, ent] of Object.entries(stagedScan.index)) {
          hostIndex[rel] = ent;
        }
        const lwwPath = join(staged, ".lww");
        const hadLww = await fsp.access(lwwPath).then(() => true, () => false);
        if (!hadLww) await fsp.writeFile(lwwPath, LWW_DEFAULT + this.config.branchOnly.map((p) => `${p}\n`).join(""));

        await fsp.mkdir(join(this.spec.stores, volume), { recursive: true, mode: 0o700 });
        const record: ProjectRecord = { name, source: this.cwd, volume, mainRef: "", created, updatedAt: created };
        const client = await createProjectClient(this.spec, record);
        this.lfs = client.lfs;
        this.operator = client.operator;
        this.LayerFSError = client.LayerFSError;
        try {
          const initRes = await this.lfs.project.init(staged);
          record.mainRef = initRes.layer;
        } catch (e) {
          await fsp.rm(join(this.spec.stores, volume), { recursive: true, force: true }).catch(() => {});
          await fsp.rm(join(this.spec.home, name), { recursive: true, force: true }).catch(() => {});
          throw e;
        }
        this.bindings.writeHostIndex(name, hostIndex);
        this.bindings.addProject(this.cwd, record);
        return record;
      } finally {
        await fsp.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  /**
   * Detects host edits made outside Pi (editor, git pull) and syncs them into "main" before forking.
   */
  async syncHostDriftIntoMain(options: { full?: boolean } = {}): Promise<{ synced: string[] }> {
    return this.bindings.withProjectLock(this.projectRecord.name, async (guard) => {
      const full = options.full || Boolean(this.bindings.byName(this.projectRecord.name)?.mainStale);
      const prev = full ? await this.mainIndex() : this.bindings.readHostIndex(this.projectRecord.name);
      const scanned = await scanHostDirectory(this.cwd, this.hostSkip, full ? {} : prev, true);
      const curr = scanned.index;
      const changed: string[] = [];
      const removed: string[] = [];
      for (const [rel, ent] of Object.entries(curr)) {
        const old = prev[rel];
        if (!old || !sameSig(old, ent)) changed.push(rel);
      }
      for (const rel of Object.keys(prev)) if (!curr[rel]) removed.push(rel);
      if (!changed.length && !removed.length) {
        this.bindings.writeHostIndex(this.projectRecord.name, curr);
        if (full) this.bindings.setMainStale(this.projectRecord.name, false);
        return { synced: [] };
      }

      const syncBranch = `sync-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
      await this.lfs.branch.fork(syncBranch, "main");
      const storeOps: any[] = [];
      const mountJobs: Array<{ rel: string; entry: HostEntry }> = [];
      for (const rel of removed) storeOps.push({ op: "rm", path: `/${rel}` });
      for (const rel of changed) {
        const ent = curr[rel];
        const prevEnt = prev[rel];
        const exec = ((ent.mode ?? 0o644) & 0o111) !== 0;
        if (ent.kind === "symlink" || prevEnt?.kind === "symlink" || exec || (prevEnt?.mode !== undefined && ((prevEnt.mode ^ (ent.mode ?? 0o644)) & 0o111))) {
          mountJobs.push({ rel, entry: ent });
        } else {
          const dir = posix.dirname(`/${rel}`);
          if (dir !== "/") storeOps.push({ op: "mkdir", path: dir });
          storeOps.push({ op: "write", path: `/${rel}`, bytes: scanned.bytes.get(rel) ?? (await fsp.readFile(join(this.cwd, rel))) });
        }
      }
      if (storeOps.length) {
        await this.lfs.fs.apply(syncBranch, storeOps, "sync host drift");
      }
      if (mountJobs.length) {
        await this.withMountedBranch(syncBranch, true, "sync host special files", async (wsPath) => {
          for (const { rel, entry } of mountJobs) {
            const dst = posix.join(wsPath, rel);
            await this.assertInsideWs(wsPath, dst, true);
            await fsp.mkdir(dirname(dst), { recursive: true });
            await fsp.rm(dst, { force: true });
            if (entry.kind === "symlink") {
              const target = entry.sig.slice("link:".length);
              await fsp.symlink(target, dst);
            } else {
              const bytes = scanned.bytes.get(rel) ?? (await fsp.readFile(join(this.cwd, rel)));
              const mode = (entry.mode ?? 0o644) & 0o7777;
              await fsp.writeFile(dst, bytes);
              await fsp.chmod(dst, mode);
            }
          }
        });
      }
      guard();
      const pub = await this.lfs.branch.publish(syncBranch);
      this.projectRecord.mainRef = pub.layer ?? this.projectRecord.mainRef;
      this.bindings.updateProjectMain(this.projectRecord.name, this.projectRecord.mainRef);
      this.bindings.writeHostIndex(this.projectRecord.name, curr);
      if (full) this.bindings.setMainStale(this.projectRecord.name, false);
      return { synced: [...changed, ...removed] };
    });
  }

  /** Signatures of every file in main, read via one short mount without subprocesses. */
  private async mainIndex(): Promise<HostIndex> {
    const tmp = `r-${this.shortId}-${(++this.seq)}`;
    await this.lfs.branch.fork(tmp, "main");
    return this.withMountedBranch(tmp, false, "main index", async (wsPath) => {
      return (await scanHostDirectory(wsPath, this.hostSkip, {}, true)).index;
    });
  }

  private get hostSkip(): string[] {
    return [...this.config.excludes, ...this.config.branchOnly];
  }

  private async setupBranches(options: OpenOptions): Promise<void> {
    const saved = options.resumeBinding;
    if (saved?.workBranch && (options.reason === "resume" || options.reason === "reload")) {
      const branches = await this.listAllBranches();
      const wb = branches.find((b) => b.name === saved.workBranch);
      const bb = saved.baseBranch ? branches.find((b) => b.name === saved.baseBranch) : null;
      const targetRef = saved.headCommit ?? saved.baseRef;
      if (wb && bb) {
        this.baseBranch = saved.baseBranch!;
        this.workBranch = saved.workBranch;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.headCommit = wb.head;
        this.unapplied = await this.hasApplicable();
        return;
      }
      if (targetRef && bb) {
        this.seq++;
        this.baseBranch = saved.baseBranch!;
        this.baseRef = saved.baseRef ?? bb.head ?? bb.base;
        this.workBranch = `s-${this.shortId}-${this.seq}`;
        const f = await this.lfs.branch.fork(this.workBranch, targetRef);
        this.headCommit = f.head ?? null;
        this.unapplied = await this.hasApplicable();
        return;
      }
    }

    const fromRef = options.forkFromRef || "main";
    this.seq++;
    this.baseBranch = `b-${this.shortId}-${this.seq}`;
    this.workBranch = `s-${this.shortId}-${this.seq}`;
    const fb = await this.lfs.branch.fork(this.baseBranch, "main");
    const fw = await this.lfs.branch.fork(this.workBranch, fromRef);
    this.baseRef = fb.head ?? fb.base;
    this.headCommit = fw.head ?? (fromRef !== "main" && fromRef !== this.baseRef ? fromRef : null);
    this.unapplied = fromRef !== "main" ? (await this.diff()).filter((i) => i.type !== "dir").length > 0 : false;
  }

  /** Switches `workBranch` to a historical Commit or Layer ref (for `/tree` and `/fork`). */
  async switchToRef(targetRef: string | null | undefined): Promise<{ branch: string; ref: string }> {
    const job = this.mutex.then(async () => {
      const ref = targetRef || this.baseRef;
      this.seq++;
      const nextWork = `s-${this.shortId}-${this.seq}`;
      const forked = await this.lfs.branch.fork(nextWork, ref);
      this.workBranch = nextWork;
      this.headCommit = forked.head ?? (ref !== this.baseRef ? ref : null);
      this.blocked = null;
      this.pendingOrigins = [];
      this.unapplied = await this.hasApplicable();
      this.persistSessionBinding();
      return { branch: this.workBranch, ref: this.effectiveRef };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  /**
   * Merges another Branch of this project into this session's work branch.
   */
  async mergeBranch(
    other: string,
    options?: { strategy?: "ours" | "theirs"; resolve?: Record<string, "ours" | "theirs"> }
  ): Promise<MergeResult> {
    const job = this.mutex.then(async () => {
      if (this.blocked) throw new Error(`cannot merge while a checkpoint is pending (${this.blocked.reason}); run /layerfs retry`);
      const resolvedOther = await this.resolveBranchName(other);
      const branches = await this.listAllBranches();
      const known = branches.find((b) => b.name === resolvedOther);
      if (!known) throw new LayerfsError("NoSuchBranch", `no LayerFS branch named ${other} (see /layerfs branches)`);

      if (options?.strategy || options?.resolve) {
        return await this.fallbackMergeBranch(resolvedOther, options);
      }

      this.seq++;
      const target = `s-${this.shortId}-${this.seq}`;
      const priorWork = this.workBranch;
      try {
        const m = await this.lfs.branch.merge(this.workBranch, resolvedOther, target, `merge ${resolvedOther} into ${this.workBranch}`);
        this.workBranch = target;
        this.headCommit = m.head ?? this.headCommit;
        this.unapplied = await this.hasApplicable();
        this.persistSessionBinding();
        if (m.head) this.checkpoints.push({ origins: [`merge:${resolvedOther}`], label: "merge", commit: m.head, branch: target, changed: true, at: Date.now() });

        const diffItems: any[] = [];
        for (let pos = 0; ; ) {
          const page = await this.lfs.branch.diff_branches(priorWork, resolvedOther, 1000, pos, { hunks: false }).catch(() => null);
          for (const it of page?.items ?? []) diffItems.push(it);
          if (!page?.hasMore || !(page?.items ?? []).length) break;
          pos = page.nextPagePos ?? (pos + page.items.length);
        }
        for (const it of diffItems) {
          if (it.type !== "dir" && this.isApplicable(it.path)) {
            this.touchPathsOnNextExec.add(it.path.replace(/^\/+/, ""));
          }
        }

        const lwwPaths: string[] = [];
        for (const entry of (m.lww ?? [])) {
          const p = String(entry.path ?? "").replace(/^\/+/, "");
          if (p && !p.startsWith(".git/") && p !== ".git") {
            lwwPaths.push(p);
          }
        }

        return { merged: true, branch: target, head: m.head ?? null, conflicts: [], lww: (m.lww ?? []).length, lwwPaths };
      } catch (e: any) {
        if (e?.code === "Conflict") {
          if (options?.strategy || options?.resolve) {
            return await this.fallbackMergeBranch(resolvedOther, options);
          }
          const conflicts = (e.detail?.conflicts ?? []).map((c: any) => ({ path: String(c.path).replace(/^\/+/, ""), kind: c.kind }));
          return { merged: false, branch: this.workBranch, head: this.headCommit, conflicts, lww: 0 };
        }
        if (e?.code === "NoSuchBranch") throw e;
        const isRecordFailure = /invalid record|binding kind/i.test(String(e?.message ?? "")) || e?.code === "InvalidRecord";
        if (options?.strategy || options?.resolve || isRecordFailure) {
          return await this.fallbackMergeBranch(resolvedOther, options);
        }
        throw e;
      }
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  private async fallbackMergeBranch(
    resolvedOther: string,
    options?: { strategy?: "ours" | "theirs"; resolve?: Record<string, "ours" | "theirs"> }
  ): Promise<MergeResult> {
    const theirDiff: any[] = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.branch.diff_branches(this.baseBranch, resolvedOther, 1000, pos, { hunks: false }).catch(() => null);
      for (const it of page?.items ?? []) theirDiff.push(it);
      if (!page?.hasMore || !(page?.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }

    const ourDiff: any[] = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.branch.diff_branches(this.baseBranch, this.workBranch, 1000, pos, { hunks: false }).catch(() => null);
      for (const it of page?.items ?? []) ourDiff.push(it);
      if (!page?.hasMore || !(page?.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }

    const ourMap = new Map<string, any>();
    for (const it of ourDiff) ourMap.set(it.path, it);

    const ops: any[] = [];
    const mountJobs: Array<{ rel: string; entry: HostEntry; bytes?: Buffer }> = [];
    const conflicts: Array<{ path: string; kind?: string }> = [];

    for (const theirItem of theirDiff) {
      const p = theirItem.path;
      if (p === "/.lww" || !p || theirItem.type === "dir" || !this.isApplicable(p)) continue;
      const rel = p.replace(/^\/+/, "");
      const ourItem = ourMap.get(p);

      const fileResolution = options?.resolve?.[rel] || options?.strategy;

      if (!ourItem) {
        if (theirItem.kind === "Removed") {
          ops.push({ op: "rm", path: p });
        } else {
          const theirSig = await this.readSigAtBranch(resolvedOther, rel);
          if (theirSig?.kind === "symlink") {
            mountJobs.push({ rel, entry: theirSig });
          } else {
            const bytes = await readRefBytes(this, resolvedOther, p);
            if (bytes !== null) {
              const dir = posix.dirname(p);
              if (dir !== "/") ops.push({ op: "mkdir", path: dir });
              ops.push({ op: "write", path: p, bytes });
              if (theirSig && (((theirSig.mode ?? 0o644) & 0o111) !== 0 || (theirSig.mode !== undefined && (theirSig.mode & 0o7777) !== 0o644))) {
                mountJobs.push({ rel, entry: theirSig, bytes });
              }
            }
          }
        }
        continue;
      }

      if (fileResolution === "ours") continue;
      if (fileResolution === "theirs") {
        if (theirItem.kind === "Removed") {
          ops.push({ op: "rm", path: p });
        } else {
          const theirSig = await this.readSigAtBranch(resolvedOther, rel);
          if (theirSig?.kind === "symlink") {
            mountJobs.push({ rel, entry: theirSig });
          } else {
            const bytes = await readRefBytes(this, resolvedOther, p);
            if (bytes !== null) {
              const dir = posix.dirname(p);
              if (dir !== "/") ops.push({ op: "mkdir", path: dir });
              ops.push({ op: "write", path: p, bytes });
              if (theirSig && (((theirSig.mode ?? 0o644) & 0o111) !== 0 || (theirSig.mode !== undefined && (theirSig.mode & 0o7777) !== 0o644))) {
                mountJobs.push({ rel, entry: theirSig, bytes });
              }
            }
          }
        }
        continue;
      }

      if (ourItem.kind === "Removed" && theirItem.kind === "Removed") continue;
      if (ourItem.kind === "Removed" || theirItem.kind === "Removed") {
        conflicts.push({ path: rel, kind: "DeleteEditConflict" });
        continue;
      }

      const ourBytes = await readRefBytes(this, this.workBranch, p);
      const theirBytes = await readRefBytes(this, resolvedOther, p);
      const baseBytes = await readRefBytes(this, this.baseBranch, p);

      if (ourBytes && theirBytes && ourBytes.equals(theirBytes)) continue;

      if (!ourBytes || !theirBytes || isBinary(ourBytes) || isBinary(theirBytes) || (baseBytes && isBinary(baseBytes))) {
        conflicts.push({ path: rel, kind: "BinaryConflict" });
        continue;
      }

      const mergeRes = threeWayMerge(ourBytes, baseBytes, theirBytes);
      if ("merged" in mergeRes) {
        const dir = posix.dirname(p);
        if (dir !== "/") ops.push({ op: "mkdir", path: dir });
        ops.push({ op: "write", path: p, bytes: mergeRes.merged });
        const theirSig = await this.readSigAtBranch(resolvedOther, rel);
        if (theirSig && (((theirSig.mode ?? 0o644) & 0o111) !== 0 || (theirSig.mode !== undefined && (theirSig.mode & 0o7777) !== 0o644))) {
          mountJobs.push({ rel, entry: theirSig, bytes: mergeRes.merged });
        }
      } else {
        conflicts.push({ path: rel, kind: "ContentConflict" });
      }
    }

    if (conflicts.length > 0) {
      return {
        merged: false,
        branch: this.workBranch,
        head: this.headCommit,
        conflicts,
        lww: 0,
      };
    }

    this.seq++;
    const target = `s-${this.shortId}-${this.seq}`;
    await this.lfs.branch.fork(target, this.workBranch);
    if (ops.length > 0) {
      const res = await this.lfs.fs.apply(target, ops, `merge ${resolvedOther} into ${this.workBranch} (fallback)`);
      this.headCommit = res.commit?.id ?? res.head ?? this.headCommit;
    }
    if (mountJobs.length > 0) {
      await this.withMountedBranch(target, true, `merge special files from ${resolvedOther}`, async (wsPath) => {
        for (const { rel, entry, bytes } of mountJobs) {
          const dst = posix.join(wsPath, rel);
          await this.assertInsideWs(wsPath, dst, true);
          await fsp.mkdir(dirname(dst), { recursive: true });
          await fsp.rm(dst, { force: true });
          if (entry.kind === "symlink") {
            const target = entry.sig.slice("link:".length);
            await fsp.symlink(target, dst);
          } else {
            const mode = (entry.mode ?? 0o644) & 0o7777;
            await fsp.writeFile(dst, bytes ?? Buffer.alloc(0));
            await fsp.chmod(dst, mode);
          }
        }
      });
      this.headCommit = this.lastStoreCommit?.head ?? this.headCommit;
    }
    this.workBranch = target;
    this.unapplied = await this.hasApplicable();
    this.persistSessionBinding();
    if (this.headCommit) {
      this.checkpoints.push({ origins: [`merge:${resolvedOther}`], label: "merge", commit: this.headCommit, branch: target, changed: ops.length > 0 || mountJobs.length > 0, at: Date.now() });
    }

    for (const it of theirDiff) {
      if (this.isApplicable(it.path) && it.type !== "dir") {
        this.touchPathsOnNextExec.add(it.path.replace(/^\/+/, ""));
      }
    }

    return {
      merged: true,
      branch: target,
      head: this.headCommit,
      conflicts: [],
      lww: 0,
      fallback: true,
    };
  }

  private persistSessionBinding(): void {
    if (!this.bindings || !this.projectRecord) return;
    this.bindings.setSession(this.sessionId, {
      project: this.projectRecord.name,
      cwd: this.cwd,
      baseBranch: this.baseBranch,
      workBranch: this.workBranch,
      baseRef: this.baseRef,
      headCommit: this.headCommit,
      unapplied: this.unapplied,
      seq: this.seq,
      updatedAt: Date.now(),
      logicalBranch: this.logicalBranch,
    });
  }

  async listAllBranches(): Promise<Array<{ name: string; base: string; head: string | null }>> {
    const out: Array<{ name: string; base: string; head: string | null }> = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.project.list_branches(100, pos);
      out.push(...(page.items ?? []));
      if (!page.hasMore || !(page.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }
    return out;
  }

  async resolveBranchName(name: string): Promise<string> {
    const trimmed = String(name ?? "").trim();
    if (!trimmed || trimmed === "main") return "main";
    this.bindings?.reload();

    const sessions = Object.values(this.bindings?.data?.sessions ?? {})
      .filter((s) => s.project === this.projectRecord?.name)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    for (const s of sessions) {
      if (s.logicalBranch === trimmed || (s as any).sessionId === trimmed) {
        return s.workBranch;
      }
    }

    for (const s of sessions) {
      if (s.workBranch === trimmed) {
        return s.workBranch;
      }
    }

    const branches = await this.listAllBranches();
    const sm = /^(?:s-)?([a-f0-9]{8,16})(?:-(\d+))?$/.exec(trimmed);
    if (sm) {
      const shortId = sm[1];
      for (const s of sessions) {
        if (s.workBranch?.startsWith(`s-${shortId}-`)) {
          return s.workBranch;
        }
      }
      if (sm[2] && branches.some((b) => b.name === trimmed)) {
        return trimmed;
      }
      let highestBranch: string | null = null;
      let highestSeq = -1;
      for (const b of branches) {
        const bm = /^s-([a-f0-9]+)-(\d+)$/.exec(b.name);
        if (bm && bm[1] === shortId) {
          const seq = parseInt(bm[2], 10);
          if (seq > highestSeq) {
            highestSeq = seq;
            highestBranch = b.name;
          }
        }
      }
      if (highestBranch) return highestBranch;
    }

    for (const b of branches) {
      if (b.name === trimmed) return b.name;
    }
    return trimmed;
  }

  async listUserBranches(): Promise<UserBranch[]> {
    this.bindings?.reload();
    const all = await this.listAllBranches();
    const isInternal = (name: string) => /^(?:[abcrhm]|sync|test-merge)-/.test(name);
    const nonInternal = all.filter((b) => !isInternal(b.name));

    const sessions = Object.values(this.bindings?.data?.sessions ?? {})
      .filter((s) => s.project === this.projectRecord?.name);

    const sMap = new Map<string, { branch: (typeof all)[0]; seq: number }>();
    const others: typeof all = [];

    for (const b of nonInternal) {
      const m = /^s-([a-f0-9]+)-(\d+)$/.exec(b.name);
      if (m) {
        const shortId = m[1];
        const seq = parseInt(m[2], 10);
        const existing = sMap.get(shortId);
        if (!existing || seq > existing.seq) {
          sMap.set(shortId, { branch: b, seq });
        }
      } else {
        others.push(b);
      }
    }

    const branchesToShow = [...Array.from(sMap.values()).map((v) => v.branch), ...others];

    const out: UserBranch[] = [];
    for (const b of branchesToShow) {
      if (b.name === "main") continue;
      const matchingSession = sessions.find((s) => s.workBranch === b.name);
      out.push({
        name: b.name,
        base: b.base,
        head: b.head,
        logicalBranch: matchingSession?.logicalBranch || "",
        isYours: b.name === this.workBranch,
      });
    }
    return out;
  }

  toRel(hostPath: string): string | null {
    const trimmed = String(hostPath ?? "").trim();
    if (!trimmed || trimmed === "." || trimmed === "./") return "";
    const abs = resolve(this.cwd, trimmed);
    const rel = relative(this.cwd, abs);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split("\\").join("/");
  }

  toStorePath(hostPath: string): string | null {
    const rel = this.toRel(hostPath);
    if (rel === null) return null;
    return rel === "" ? "/" : `/${rel}`;
  }

  private mustStorePath(hostPath: string): string {
    const sp = this.toStorePath(hostPath);
    if (!sp) throw new Error(`${hostPath} is outside the LayerFS workspace (${this.cwd}); writes there are refused`);
    const rel = sp.replace(/^\/+/, "");
    const relNorm = rel.toLowerCase();
    if (relNorm === ".lww" || relNorm === ".git/config" || relNorm === ".git/hooks" || relNorm.startsWith(".git/hooks/")) {
      const err = new Error(`writes to ${rel} are refused for security`);
      (err as any).code = "EACCES";
      throw err;
    }
    if (isExcludedPath(rel, this.config.excludes)) {
      const err = new Error(`writes to excluded path ${rel} are refused`);
      (err as any).code = "EACCES";
      throw err;
    }
    return sp;
  }

  private async hasSymlinkInChain(storePath: string, ref = this.workBranch): Promise<boolean> {
    const parts = storePath.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += `/${part}`;
      const st = await this.lfs.fs.stat(ref, cur).catch(() => null);
      if (!st) return false;
      if (st.type === "symlink") return true;
    }
    return false;
  }

  /** Reads exact bytes of `storePath` at `ref` without loss. */
  async readBytesAtRef(ref: string, storePath: string, originalHostPath = storePath): Promise<Buffer> {
    const rel = storePath.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(originalHostPath, "not found");

    const st = await this.lfs.fs.stat(ref, storePath).catch((e: any) => {
      if (e?.code === "NoSuchPath") return null;
      throw e;
    });
    if (!st) {
      if (await this.hasSymlinkInChain(posix.dirname(storePath), ref)) {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      throw enoent(originalHostPath, "does not exist");
    }
    if (st.type === "dir") throw Object.assign(new Error(`EISDIR: ${originalHostPath} is a directory`), { code: "EISDIR" });
    if (st.type === "symlink") return this.readBytesViaMount(ref, storePath, originalHostPath);
    if (st.size === 0) return Buffer.alloc(0);

    try {
      const parts: string[] = [];
      for (let line: number | null = 1; line !== null; ) {
        const page = await this.lfs.fs.read(ref, storePath, line);
        if (page.lineTruncated) {
          return this.readBytesViaMount(ref, storePath, originalHostPath);
        }
        parts.push(page.text);
        line = page.nextLine ?? null;
      }
      const buf = Buffer.from(parts.join(""), "utf8");
      if (typeof st.size === "number" && buf.length !== st.size) {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      return buf;
    } catch (e: any) {
      if (e?.code === "Binary") {
        return this.readBytesViaMount(ref, storePath, originalHostPath);
      }
      throw e;
    }
  }

  private async readBytesViaMount(ref: string, storePath: string, originalHostPath = storePath): Promise<Buffer> {
    let branchToMount = ref;
    if (ref !== this.workBranch && ref !== this.baseBranch && !ref.startsWith("b-") && !ref.startsWith("s-")) {
      branchToMount = `r-${this.shortId}-${(++this.seq)}`;
      await this.lfs.branch.fork(branchToMount, ref);
    }
    return this.withMountedBranch(branchToMount, false, "read bytes", async (wsPath) => {
      const p = posix.join(wsPath, storePath.replace(/^\/+/, ""));
      try {
        await this.assertInsideWs(wsPath, p, false);
      } catch (e: any) {
        throw enoent(originalHostPath, e.message);
      }
      return await fsp.readFile(p);
    });
  }

  async readFile(hostPath: string): Promise<Buffer> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      const abs = resolve(this.cwd, hostPath);
      const real = await fsp.realpath(abs).catch(() => abs);
      if (isOutsideSecret(real, this.config.excludes)) {
        throw new Error(`cannot read ${hostPath}: secret file outside the project is not readable`);
      }
      return fsp.readFile(abs);
    }
    return this.readBytesAtRef(this.workBranch, sp, hostPath);
  }

  async access(hostPath: string, write = false): Promise<void> {
    const sp = this.toStorePath(hostPath);
    if (!sp) {
      if (write) this.mustStorePath(hostPath);
      return fsp.access(resolve(this.cwd, hostPath), fsc.R_OK);
    }
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "not accessible");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      await this.withMountedBranch(this.workBranch, false, "access", async (wsPath) => {
        const p = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, p, false);
        await fsp.access(p, write ? (fsc.R_OK | fsc.W_OK) : fsc.R_OK);
      });
      return;
    }
    throw enoent(hostPath, "not accessible");
  }

  async exists(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return fsp.access(resolve(this.cwd, hostPath)).then(() => true, () => false);
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) return false;
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) return true;
    if (await this.hasSymlinkInChain(posix.dirname(sp), this.workBranch)) {
      return this.withMountedBranch(this.workBranch, false, "exists", async (wsPath) => {
        const p = posix.join(wsPath, rel);
        await this.assertInsideWs(wsPath, p, false);
        return await fsp.access(p).then(() => true, () => false);
      });
    }
    return false;
  }

  async isDirectory(hostPath: string): Promise<boolean> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return (await fsp.stat(resolve(this.cwd, hostPath))).isDirectory();
    const rel = sp.replace(/^\/+/, "");
    if (rel && isExcludedPath(rel, this.config.excludes)) throw enoent(hostPath, "no such file or directory");
    const st = await this.lfs.fs.stat(this.workBranch, sp).catch(() => null);
    if (st) {
      if (st.type === "dir") return true;
      if (st.type === "file") return false;
    }
    return this.withMountedBranch(this.workBranch, false, "isDirectory", async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, false);
      const s = await fsp.stat(p).catch((e) => { throw enoent(hostPath, e.message); });
      return s.isDirectory();
    });
  }

  async readdir(hostPath: string): Promise<string[]> {
    const sp = this.toStorePath(hostPath);
    if (!sp) return fsp.readdir(resolve(this.cwd, hostPath));
    try {
      const names: string[] = [];
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(this.workBranch, sp, 1000, pos);
        for (const it of page.items ?? []) {
          if (it.name !== ".lww" && !isExcludedPath(posix.join(sp.replace(/^\/+/, ""), it.name), this.config.excludes)) {
            names.push(it.name);
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return names.sort();
    } catch (e: any) {
      if (e?.code === "NotDirectory" || e?.code === "NoSuchPath") {
        const rel = sp.replace(/^\/+/, "");
        return this.withMountedBranch(this.workBranch, false, "readdir", async (wsPath) => {
          const dir = posix.join(wsPath, rel);
          await this.assertInsideWs(wsPath, dir, false);
          const entries = await fsp.readdir(dir).catch(() => []);
          return entries.filter((n) => n && n !== ".lww" && !isExcludedPath(rel ? `${rel}/${n}` : n, this.config.excludes)).sort();
        });
      }
      throw e;
    }
  }

  async mkdir(hostPath: string): Promise<void> {
    this.mustStorePath(hostPath);
  }

  async writeFile(hostPath: string, content: string | Buffer): Promise<void> {
    const sp = this.mustStorePath(hostPath);
    const bytes = Buffer.from(content);
    const hasLink = await this.hasSymlinkInChain(sp, this.workBranch);
    if (!hasLink) {
      const parent = posix.dirname(sp);
      const ops: any[] = parent !== "/" ? [{ op: "mkdir", path: parent }, { op: "write", path: sp, bytes }] : [{ op: "write", path: sp, bytes }];
      const msg = `pi write [${this.pendingOrigins.join(",") || "write"}]`.slice(0, 4000);
      const res = await this.lfs.fs.apply(this.workBranch, ops, msg);
      this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      return;
    }
    const rel = sp.replace(/^\/+/, "");
    await this.withMountedBranch(this.workBranch, true, `pi write [${this.pendingOrigins.join(",") || "write"}]`, async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, false);
      await fsp.mkdir(dirname(p), { recursive: true });
      await fsp.writeFile(p, bytes);
    });
  }

  // ---------------------------------------------------------------- Store-backed find & hybrid grep

  async findFiles(pattern: string, searchCwd: string, options: { ignore: string[]; limit: number }): Promise<string[]> {
    const baseSp = this.toStorePath(searchCwd);
    if (!baseSp) throw new Error(`${searchCwd} is outside the LayerFS workspace`);
    const expanded = expandBraces(pattern);
    const out: string[] = [];
    const walk = async (dirSp: string, relFromSearch: string) => {
      if (out.length >= options.limit) return;
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.list(this.workBranch, dirSp, 1000, pos);
        for (const it of page.items ?? []) {
          if (out.length >= options.limit) return;
          if (it.name === ".git" || it.name === "node_modules" || it.name === ".lww") continue;
          const repoRel = it.path.replace(/^\/+/, "");
          if (isExcludedPath(repoRel, this.config.excludes)) continue;
          const rel = relFromSearch ? `${relFromSearch}/${it.name}` : it.name;
          if (options.ignore.some((g) => posix.matchesGlob(rel, g))) continue;
          if (it.type === "dir") {
            await walk(it.path, rel);
          } else if (expanded.some((pat) => matchesToolGlob(rel, pat))) {
            out.push(join(searchCwd, rel));
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
    };
    await walk(baseSp, "");
    return out;
  }

  async grepWorkspace(params: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }): Promise<{ lines: string[]; matches: number; limitReached: boolean }> {
    const targetHost = resolve(this.cwd, params.path ?? ".");
    const sp = this.toStorePath(targetHost);
    if (!sp) throw new Error(`${params.path} is outside the LayerFS workspace`);
    const limit = Math.max(1, params.limit ?? 100);
    const isPlainLiteral = (params.literal === true || !/[\\^$.|?*+()[\]{}]/.test(params.pattern)) && !params.ignoreCase && !(params.context && params.context > 0);
    const globPatterns = params.glob ? expandBraces(params.glob) : null;

    if (isPlainLiteral) {
      const lines: string[] = [];
      let matches = 0;
      const prefix = sp === "/" ? "" : `${sp}/`;
      for (let pos = 0; ; ) {
        const page = await this.lfs.fs.grep(this.workBranch, params.pattern, sp, 500, pos);
        for (const m of page.items ?? []) {
          const repoRel = m.path.replace(/^\/+/, "");
          if (repoRel === ".lww" || repoRel.startsWith(".git/") || repoRel.includes("/node_modules/") || repoRel.startsWith("node_modules/") || isExcludedPath(repoRel, this.config.excludes)) continue;
          const display = sp === "/" ? repoRel : m.path === sp ? posix.basename(sp) : m.path.startsWith(prefix) ? m.path.slice(prefix.length) : repoRel;
          if (globPatterns && !globPatterns.some((g) => matchesToolGlob(display, g))) continue;
          if (matches >= limit) return { lines, matches, limitReached: true };
          lines.push(`${display}:${m.line}: ${String(m.text).replace(/\r?\n$/, "")}`);
          matches++;
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      return { lines, matches, limitReached: false };
    }

    return this.withMountedBranch(this.workBranch, false, "grep", async (wsPath) => {
      const rel = sp.replace(/^\/+/, "");
      const targetWs = rel ? posix.join(wsPath, rel) : wsPath;
      const flags = [
        "-rnIH", "--exclude=.lww", "--exclude-dir=.git", "--exclude-dir=node_modules",
        params.ignoreCase ? "-i" : "", params.literal ? "-F" : "-E",
        params.context ? `-C${Math.floor(params.context)}` : "",
        ...(globPatterns ? globPatterns.map((g) => `--include=${g}`) : []),
      ].filter(Boolean);
      const isDir = await this.isDirectory(targetHost);
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "grep");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath,
        hostCwd: this.cwd,
        scratchDir,
        configRoot: this.config.root,
        excludes: this.config.excludes,
        outsideSecrets: OUTSIDE_SECRET_PATTERNS,
        network: "deny",
      });
      const args = [
        "-p", profile,
        "grep",
        ...flags,
        "-e", params.pattern,
        isDir ? "." : basename(targetWs),
      ];
      const r = await run("/usr/bin/sandbox-exec", args, { cwd: isDir ? targetWs : dirname(targetWs) });
      if (r.code === 1) return { lines: [], matches: 0, limitReached: false };
      if (r.code !== 0) throw new Error(r.stderr.trim() || "grep failed");
      const lines: string[] = [];
      let matches = 0;
      let limitReached = false;
      for (const raw of r.stdout.toString().split("\n")) {
        if (!raw) continue;
        const clean = raw.replace(/^\.\//, "");
        if (/^.+?:\d+:/.test(clean)) {
          if (matches >= limit) { limitReached = true; break; }
          matches++;
        }
        lines.push(clean.replace(/^(.+?):(\d+):/, "$1:$2: ").replace(/^(.+?)-(\d+)-/, "$1-$2- "));
      }
      return { lines, matches, limitReached };
    });
  }

  // ---------------------------------------------------------------- on-demand Workspace mount & bash executor

  private async assertInsideWs(wsReal: string, candidate: string, allowFinalSymlink = false): Promise<void> {
    await assertInsideWorkspace(wsReal, candidate, allowFinalSymlink);
  }

  /** Mounts `branch`, runs `fn`, optionally commits, reaps holders of `ws.path`, and unmounts immediately. */
  private async withMountedBranch<T>(
    branch: string,
    commitAfter: boolean,
    message: string,
    fn: (wsPath: string, ws: Workspace) => Promise<T>,
  ): Promise<T> {
    const ws = await this.lfs.workspace.mount(branch);
    const wsPath = await fsp.realpath(ws.path).catch(() => ws.path);
    let keepMounted = false;
    try {
      const value = await fn(wsPath, ws);
      if (commitAfter) {
        const res = await this.lfs.workspace.commit(ws, message.slice(0, 4000));
        this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      }
      return value;
    } catch (e) {
      if (commitAfter) {
        try {
          const res = await this.lfs.workspace.commit(ws, `${message} (failed)`.slice(0, 4000));
          this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
        } catch (ce: any) {
          keepMounted = true;
          this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws };
        }
      }
      throw e;
    } finally {
      if (!keepMounted) {
        await this.reapHolders(wsPath).catch(() => {});
        await this.lfs.workspace.unmount(ws, !commitAfter).catch(() => {});
      }
    }
  }

  /** Runs a shell snippet in a short-lived Workspace of `workBranch` (read-only helper for tests/apply). */
  async sh(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.withMountedBranch(this.workBranch, false, "sh", async (wsPath) => {
      const rewrittenArgs = args.map((a) => (a === this.cwd ? wsPath : a.startsWith(`${this.cwd}/`) ? posix.join(wsPath, a.slice(this.cwd.length + 1)) : a));
      const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, "sh");
      await fsp.mkdir(scratchDir, { recursive: true });
      const profile = buildSeatbeltProfile({
        wsPath,
        hostCwd: this.cwd,
        scratchDir,
        configRoot: this.config.root,
        excludes: this.config.excludes,
        outsideSecrets: OUTSIDE_SECRET_PATTERNS,
        network: "allow",
      });
      const r = await run("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "_", ...rewrittenArgs], { cwd: wsPath });
      return { code: r.code, stdout: r.stdout.toString(), stderr: r.stderr };
    });
  }

  /**
   * Mounts a Workspace for this command, streams stdout/stderr inside Seatbelt sandbox-exec,
   * commits any file changes, reaps holders of this Workspace path, and unmounts immediately.
   */
  async exec(
    command: string,
    hostCwd: string,
    options: { onData: (d: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ exitCode: number | null }> {
    if (options.signal?.aborted) throw new Error("aborted");

    const ws = await this.lfs.workspace.mount(this.workBranch);
    const wsReal = await fsp.realpath(ws.path).catch(() => ws.path);

    if (this.touchPathsOnNextExec.size > 0) {
      const paths = [...this.touchPathsOnNextExec];
      this.touchPathsOnNextExec.clear();
      for (const p of paths) {
        const full = join(wsReal, p);
        try {
          await this.assertInsideWs(wsReal, full, true);
          const now = new Date();
          if (typeof fsp.lutimes === "function") {
            await fsp.lutimes(full, now, now).catch(() => {});
          }
        } catch {}
      }
    }

    await this.prepareNativeGit(wsReal);

    const scratchDir = join(this.config.root, "scratch", this.projectRecord.name, this.logicalBranch);
    await fsp.mkdir(scratchDir, { recursive: true });

    const relCwd = this.toRel(hostCwd);
    const runCwd = relCwd ? join(wsReal, relCwd) : wsReal;

    const profile = buildSeatbeltProfile({
      wsPath: wsReal,
      hostCwd: this.cwd,
      scratchDir,
      configRoot: this.config.root,
      excludes: this.config.excludes,
      outsideSecrets: OUTSIDE_SECRET_PATTERNS,
      network: this.config.network,
    });

    const childEnv: NodeJS.ProcessEnv = {
      HOME: homedir(),
      PATH: process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: "/private/tmp",
      USER: process.env.USER || "user",
      LOGNAME: process.env.LOGNAME || "user",
    };
    for (const [k, v] of Object.entries(options.env ?? process.env)) {
      if (typeof v === "string" && (k.startsWith("PI_") || this.config.envAllow.includes(k))) {
        childEnv[k] = v;
      }
    }

    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "/bin/bash", "-c", command],
      { cwd: runCwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);

    const tag = `${this.shortId}-${randomBytes(4).toString("hex")}`;
    let stopping: Promise<void> | null = null;
    let killFailed: unknown = null;
    const kill = () => (stopping ??= this.killNativeSession(child, wsReal).catch((e) => { killFailed = e; }));
    this.activeSids.set(tag, kill);

    let timedOut = false;
    const timer = options.timeout && options.timeout > 0 ? setTimeout(() => { timedOut = true; void kill(); }, options.timeout * 1000) : undefined;
    const onAbort = () => void kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) void kill();

    let keepMounted = false;
    try {
      const code = await new Promise<number | null>((resolveCode, reject) => {
        child.on("error", reject);
        child.on("close", (c) => resolveCode(c));
      });
      if (stopping) await stopping;
      if (killFailed) {
        keepMounted = true;
        this.blocked = { reason: "a cancelled command could not be stopped inside the Sandbox", heldWs: ws };
        throw killFailed;
      }

      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }

      await this.reapHolders(wsReal).catch(() => {});

      const lwwFile = join(wsReal, ".lww");
      if (!existsSync(lwwFile)) {
        writeFileSync(lwwFile, LWW_DEFAULT + this.config.branchOnly.map((p) => `${p}\n`).join(""));
      }

      const msg = `pi bash (exit ${code ?? "sig"}) [${this.pendingOrigins.join(",") || "bash"}]`.slice(0, 4000);
      try {
        const res = await this.lfs.workspace.commit(ws, msg);
        this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
      } catch (ce: any) {
        keepMounted = true;
        this.blocked = { reason: `${ce?.code ?? "Error"}: ${String(ce?.message ?? ce).slice(0, 200)}`, heldWs: ws };
      }

      if (options.signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      return { exitCode: code };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.activeSids.delete(tag);
      if (!keepMounted) {
        const u = (async () => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch {}
          }
          await this.reapHolders(wsReal).catch(() => {});
          await this.lfs.workspace.unmount(ws).catch(() => {});
        })();
        if (options.signal?.aborted || timedOut) this.pendingUnmounts.add(u.finally(() => this.pendingUnmounts.delete(u)));
        else await u;
      }
    }
  }

  private async reapHolders(wsPath: string): Promise<void> {
    const spellings = bothSpellings(wsPath);
    for (const p of spellings) {
      const r = await run("lsof", ["-t", "+D", p], { timeoutMs: 5000 }).catch(() => null);
      if (r?.stdout && r.stdout.length > 0) {
        const pids = r.stdout.toString().split(/\s+/).filter(Boolean);
        for (const pid of pids) {
          const n = Number(pid);
          if (n > 0 && n !== process.pid) {
            try { process.kill(n, "SIGKILL"); } catch {}
          }
        }
      }
    }
  }

  private async prepareNativeGit(wsReal: string): Promise<void> {
    const gitDir = join(wsReal, ".git");
    const gitStat = await fsp.lstat(gitDir).catch(() => null);
    if (!gitStat || !gitStat.isDirectory() || gitStat.isSymbolicLink()) return;
    const allowed = bothSpellings(wsReal);
    const isInside = (target: string) => allowed.some((w) => target === w || target.startsWith(`${w}/`));
    const realGit = await fsp.realpath(gitDir).catch(() => null);
    if (!realGit || !isInside(realGit)) return;

    const infoDir = join(gitDir, "info");
    const infoStat = await fsp.lstat(infoDir).catch(() => null);
    if (infoStat && (!infoStat.isDirectory() || infoStat.isSymbolicLink())) return;
    await fsp.mkdir(infoDir, { recursive: true });
    const realInfo = await fsp.realpath(infoDir).catch(() => null);
    if (!realInfo || !isInside(realInfo)) return;

    const excludePath = join(infoDir, "exclude");
    const exStat = await fsp.lstat(excludePath).catch(() => null);
    if (exStat && exStat.isSymbolicLink()) return;
    const existing = await fsp.readFile(excludePath, "utf8").catch(() => "");
    if (!existing.split("\n").includes("/.lww")) {
      await fsp.appendFile(excludePath, (existing.length && !existing.endsWith("\n") ? "\n" : "") + "/.lww\n").catch(() => {});
    }
    if (this.config.excludes.length > 0) {
      const excludesFlat = this.config.excludes.flatMap(expandBraces).filter(Boolean);
      const excludeArgs = excludesFlat.flatMap((pat) => [`:(glob,icase)${pat}`, `:(glob,icase)**/${pat}`]);
      const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      const ls = await run("git", ["-C", wsReal, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=false", "ls-files", "-v", "--", ...excludeArgs], { env: gitEnv, timeoutMs: 10_000 }).catch(() => null);
      if (ls?.code === 0 && ls.stdout.length > 0) {
        const lines = ls.stdout.toString().split("\n");
        const skipFiles: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const [tag, ...rest] = line.split(" ");
          const f = rest.join(" ");
          if (tag !== "S" && f) {
            const exists = await fsp.access(join(wsReal, f)).then(() => true, () => false);
            if (!exists) skipFiles.push(f);
          }
        }
        if (skipFiles.length > 0) {
          await run("git", ["-C", wsReal, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "update-index", "--skip-worktree", "--", ...skipFiles], { env: gitEnv, timeoutMs: 10_000 }).catch(() => null);
        }
      }
    }
  }

  private async killNativeSession(child: ReturnType<typeof spawn>, wsReal: string): Promise<void> {
    const pid = child.pid;
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
    const grace = Math.max(100, this.config.killGraceMs);
    const start = Date.now();
    let alive = true;
    while (Date.now() - start < grace) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(-pid, 0);
      } catch {
        alive = false;
        break;
      }
    }
    if (alive) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
    await this.reapHolders(wsReal).catch(() => {});
  }

  // ---------------------------------------------------------------- mutation queue & checkpoint gate

  mutate<T>(origin: string, label: string, fn: () => Promise<T>): Promise<{ value: T; checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (this.blocked) {
        throw new Error(`LayerFS checkpoint failed earlier (${this.blocked.reason}); changes are blocked until /layerfs retry succeeds`);
      }
      this.pendingOrigins.push(origin);
      this.lastStoreCommit = null;
      let value: T;
      let fnError: unknown = null;
      try {
        value = await fn();
      } catch (e) {
        fnError = e;
      }
      const cp = await this.finalizeCheckpoint(label);
      if (fnError) throw fnError;
      return { value: value!, ...cp };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  private async finalizeCheckpoint(label: string): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    if (this.blocked) {
      return { checkpoint: null, error: new Error(this.blocked.reason) };
    }
    const res = this.lastStoreCommit;
    this.lastStoreCommit = null;
    if (!res || res.kind === "UpToDate") {
      this.pendingOrigins = [];
      return { checkpoint: null, error: null };
    }
    if (res.kind === "Committed") {
      const cp: Checkpoint = {
        origins: [...this.pendingOrigins],
        label,
        commit: res.head,
        branch: this.workBranch,
        changed: true,
        at: Date.now(),
      };
      this.headCommit = res.head;
      this.unapplied = true;
      this.pendingOrigins = [];
      this.checkpoints.push(cp);
      this.persistSessionBinding();
      return { checkpoint: cp, error: null };
    }
    return { checkpoint: null, error: null };
  }

  async retry(): Promise<{ checkpoint: Checkpoint | null; error: Error | null }> {
    const job = this.mutex.then(async () => {
      if (!this.blocked) return { checkpoint: null, error: null };
      const held = this.blocked.heldWs;
      if (held) {
        try {
          const res = await this.lfs.workspace.commit(held, `retry [${this.pendingOrigins.join(",") || "retry"}]`);
          await this.lfs.workspace.unmount(held, false);
          this.blocked = null;
          this.lastStoreCommit = { kind: res.kind, head: res.commit?.id ?? res.head ?? null };
          return await this.finalizeCheckpoint("retry");
        } catch (e: any) {
          this.blocked = { reason: `${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 200)}`, heldWs: held };
          return { checkpoint: null, error: e };
        }
      }
      this.blocked = null;
      return { checkpoint: null, error: null };
    });
    this.mutex = job.catch(() => {});
    return job;
  }

  async diff(): Promise<Array<{ path: string; kind: string; type: string }>> {
    const items: Array<{ path: string; kind: string; type: string }> = [];
    for (let pos = 0; ; ) {
      const page = await this.lfs.branch.diff_branches(this.baseBranch, this.workBranch, 1000, pos, { hunks: false });
      for (const it of page.items ?? []) {
        if (it.path === "/.lww") continue;
        items.push({ path: it.path, kind: it.kind, type: it.type });
      }
      if (!page.hasMore || !(page.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }
    return items;
  }

  /** Signature (content + exec bit, or link target) of `rel` at `branch`. One short mount reads both. */
  private async readSigAtBranch(branch: string, rel: string): Promise<HostEntry | null> {
    const sp = `/${rel}`;
    const st = await this.lfs.fs.stat(branch, sp).catch(() => null);
    if (!st || st.type === "dir") return null;
    return this.withMountedBranch(branch, false, "read base", async (wsPath) => {
      const p = posix.join(wsPath, rel);
      await this.assertInsideWs(wsPath, p, true);
      const lst = await fsp.lstat(p).catch(() => null);
      if (!lst) return null;
      if (lst.isSymbolicLink()) {
        const target = await fsp.readlink(p);
        return linkSig(target);
      }
      const data = await fsp.readFile(p);
      return fileSig(data, lst.mode);
    });
  }

  async apply(options: { allowRevert?: boolean } = {}): Promise<ApplyResult> {
    const job = this.mutex.then(() => this.applyLocked(options));
    this.mutex = job.catch(() => {});
    return job;
  }

  private async applyLocked(options: { allowRevert?: boolean }): Promise<ApplyResult> {
    if (this.blocked) {
      throw new Error(`cannot apply while a checkpoint is pending (${this.blocked.reason}); run /layerfs retry`);
    }
    return this.bindings.withProjectLock(this.projectRecord.name, async (guard) => {
      const result: ApplyResult = { applied: [], skipped: [], conflicts: [], unchanged: [], warnings: [] };
      const snapRef = this.headCommit ?? this.baseRef;
      this.seq++;
      const snapBranch = `a-${this.shortId}-${this.seq}`;
      await this.lfs.branch.fork(snapBranch, snapRef);

      if (!options.allowRevert && !(await this.snapshotContainsBase(snapBranch))) {
        throw new LayerfsError("WouldRevert", "this branch no longer contains what was already applied to your folder (you went back with /tree, maybe edited since); applying would revert files on disk. Use /layerfs apply --revert to do that on purpose.");
      }

      const items: Array<{ path: string; kind: string; type: string }> = [];
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.diff_branches(this.baseBranch, snapBranch, 1000, pos, { hunks: false });
        for (const it of page.items ?? []) {
          if (it.type !== "dir" && !(this.config.branchOnly.length && isExcludedPath(it.path.replace(/^\/+/, ""), this.config.branchOnly))) {
            items.push({ path: it.path, kind: it.kind, type: it.type });
          }
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      if (!items.length && !this.config.branchOnly.length) {
        this.unapplied = false;
        this.persistSessionBinding();
        return result;
      }

      type Next = { kind: "file"; data: Buffer; mode: number } | { kind: "symlink"; target: string } | null;
      const plan: Array<{ rel: string; next: Next; host: HostEntry | null }> = [];

      await this.withMountedBranch(snapBranch, false, "apply read", async (wsPath) => {
        for (const it of items) {
          const rel = it.path.replace(/^\/+/, "");
          if (rel === ".lww" || rel === ".git" || rel.startsWith(".git/") || isExcludedPath(rel, this.hostSkip)) {
            result.skipped.push(rel);
            continue;
          }
          let next: Next = null;
          if (it.kind !== "Removed" && it.kind !== "deleted") {
            const p = posix.join(wsPath, rel);
            await this.assertInsideWs(wsPath, p, true);
            const lst = await fsp.lstat(p).catch(() => null);
            if (!lst) continue;
            if (lst.isSymbolicLink()) {
              const target = await fsp.readlink(p);
              next = { kind: "symlink", target };
            } else {
              const data = await fsp.readFile(p);
              const mode = lst.mode & 0o7777;
              next = { kind: "file", data, mode };
            }
          }
          const host = await hostState(join(this.cwd, rel));
          if (host === "other") { result.conflicts.push(rel); continue; }
          const base = it.kind === "Added" ? null : await this.readSigAtBranch(this.baseBranch, rel);
          const want = next ? (next.kind === "file" ? fileSig(next.data, next.mode) : linkSig(next.target)) : null;
          if (sameSig(host, want)) { result.unchanged.push(rel); continue; }
          if (!sameSig(host, base)) { result.conflicts.push(rel); continue; }
          plan.push({ rel, next, host });
        }
      });

      if (result.conflicts.length) return result;

      const depth = (r: string) => r.split("/").length;
      const ordered = [
        ...plan.filter((p) => !p.next).sort((a, b) => depth(b.rel) - depth(a.rel)),
        ...plan.filter((p) => p.next).sort((a, b) => depth(a.rel) - depth(b.rel)),
      ];
      const hostIndex = this.bindings.readHostIndex(this.projectRecord.name);
      const tmps: string[] = [];
      try {
        for (const { rel, next, host } of ordered) {
          guard();
          const target = join(this.cwd, rel);
          await assertInsideWorkspace(this.cwd, target, true);
          const now = await hostState(target);
          if (now === "other" || !sameSig(now, host)) {
            result.conflicts.push(rel);
            throw new LayerfsError("ChangedDuringApply", `${rel} changed on disk while applying`);
          }
          if (!next) {
            await fsp.rm(target, { force: true });
            delete hostIndex[rel];
            await removeEmptyParents(this.cwd, rel);
          } else if (next.kind === "symlink") {
            await fsp.mkdir(dirname(target), { recursive: true });
            await fsp.rm(target, { force: true });
            await fsp.symlink(next.target, target);
            const st = await fsp.lstat(target);
            hostIndex[rel] = { ...linkSig(next.target), mtimeMs: st.mtimeMs, size: st.size };
          } else {
            await fsp.mkdir(dirname(target), { recursive: true });
            const tmp = join(dirname(target), `.${posix.basename(rel)}.pi-layerfs-${randomBytes(4).toString("hex")}`);
            tmps.push(tmp);
            await fsp.writeFile(tmp, next.data, { mode: next.mode & 0o7777 });
            await fsp.chmod(tmp, next.mode & 0o7777);
            await fsp.rename(tmp, target);
            tmps.pop();
            const st = await fsp.lstat(target);
            hostIndex[rel] = { ...fileSig(next.data, next.mode), mode: next.mode & 0o7777, mtimeMs: st.mtimeMs, size: st.size };
          }
          result.applied.push(rel);
          this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);
        }
      } catch (e: any) {
        for (const t of tmps) await fsp.rm(t, { force: true }).catch(() => {});
        this.bindings.writeHostIndex(this.projectRecord.name, hostIndex);
        if (result.applied.length) this.bindings.setMainStale(this.projectRecord.name, true);
        const err = new LayerfsError(e?.code ?? "PartialApply", `apply stopped after ${result.applied.length} file(s): ${e?.message ?? e}`);
        (err as any).result = result;
        throw err;
      }

      try {
        guard();
        const mainVsBase = await this.lfs.branch.diff_branches("main", this.baseBranch, 1, 0, { hunks: false });
        const mainUnchanged = Boolean(mainVsBase.from?.root) && mainVsBase.from?.root === mainVsBase.to?.root;
        let toPublish = snapBranch;
        if (!mainUnchanged) {
          const merged = `m-${this.shortId}-${(++this.seq)}`;
          const m = await this.lfs.branch.merge("main", snapBranch, merged, "merge applied session");
          if (m?.kind && m.kind !== "Merged" && m.kind !== "FastForward" && m.kind !== "UpToDate") throw new Error(`merge answered ${m.kind}`);
          toPublish = merged;
        }
        const pub = await this.lfs.branch.publish(toPublish);
        if (pub?.layer) this.bindings.updateProjectMain(this.projectRecord.name, pub.layer);
      } catch (e: any) {
        this.bindings.setMainStale(this.projectRecord.name, true);
        result.warnings.push(`your folder is updated, but LayerFS main could not be updated (${e?.code ?? "Error"}: ${String(e?.message ?? e).slice(0, 160)}); the next session will resync main from your folder`);
      }

      this.seq++;
      const nextBase = `b-${this.shortId}-${this.seq}`;
      const fb = await this.lfs.branch.fork(nextBase, snapRef);
      this.baseBranch = nextBase;
      this.baseRef = fb.head ?? fb.base;
      this.unapplied = this.headCommit !== snapRef;
      this.persistSessionBinding();
      return result;
    });
  }

  private async snapshotContainsBase(snapBranch: string): Promise<boolean> {
    try {
      const baseIsCommit = await this.baseIsCommit();
      const cleanedBaseRef = cleanRef(this.baseRef);
      for (let pos = 0; ; ) {
        const page = await this.lfs.branch.list_commits(snapBranch, 500, pos);
        for (const c of page.items ?? []) {
          const cid = cleanRef(c.id);
          const cbase = cleanRef(c.base);
          if (baseIsCommit && (c.id === this.baseRef || cid === cleanedBaseRef)) return true;
          if (!baseIsCommit && c.base !== this.baseRef && cbase !== cleanedBaseRef) return false;
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      if (!baseIsCommit) return true;
      return await this.mergeAddsNothing(snapBranch, this.baseBranch);
    } catch {
      return false;
    }
  }

  private async baseIsCommit(): Promise<boolean> {
    const list = await this.lfs.branch.list_commits(this.baseBranch, 1, 0).catch(() => ({ items: [] }));
    return Boolean(list.items?.length);
  }

  private async mergeAddsNothing(targetBranch: string, otherBranch: string): Promise<boolean> {
    const testMerge = `test-merge-${this.shortId}-${(++this.seq)}`;
    try {
      await this.lfs.branch.merge(targetBranch, otherBranch, testMerge, "test merge");
      const d = await this.lfs.branch.diff_branches(targetBranch, testMerge, 1, 0, { hunks: false });
      return (d.items ?? []).length === 0;
    } catch {
      return false;
    } finally {
      await this.lfs.branch.delete?.(testMerge).catch(() => {});
    }
  }

  isApplicable(path: string): boolean {
    const p = String(path ?? "").replace(/^\/+/, "");
    if (this.config.branchOnly.length && isExcludedPath(p, this.config.branchOnly)) return false;
    return !isExcludedPath(p, this.config.excludes);
  }

  private async hasApplicable(): Promise<boolean> {
    const d = await this.diff();
    return d.some((i) => i.type !== "dir" && this.isApplicable(i.path));
  }

  async stopNativeDaemons(): Promise<void> {
    if (!this.spec?.localDir) return;
    return stopNativeDaemons(this.spec.localDir);
  }

  async close(options: { stopDaemons?: boolean } = {}): Promise<{ kept: boolean; notes: string[] }> {
    const notes: string[] = [];
    if (this.closed) return { kept: true, notes };
    this.closed = true;
    await Promise.allSettled([...this.activeSids.values()].map((k) => k()));
    await Promise.allSettled([...this.pendingUnmounts]);
    if (this.blocked?.heldWs) {
      await this.lfs?.workspace.unmount(this.blocked.heldWs, true).catch(() => {});
    }
    this.persistSessionBinding();
    try { await this.lfs?.close?.(); } catch {}
    if (options.stopDaemons) {
      await this.stopNativeDaemons().catch(() => {});
    }
    if (this.unapplied || this.blocked) {
      notes.push(`unapplied changes remain on branch ${this.workBranch} in project ${this.project} (volume ${this.volume})`);
    }
    return { kept: true, notes };
  }
}

// ---------------------------------------------------------------- helpers

async function readRefBytes(s: LayerfsSession, ref: string, sp: string): Promise<Buffer | null> {
  try {
    return await s.readBytesAtRef(ref, sp);
  } catch (e: any) {
    if (e?.code === "ENOENT" || e?.code === "NoSuchPath" || /not found|does not exist/i.test(e?.message)) {
      return null;
    }
    throw e;
  }
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function threeWayMerge(ours: Buffer, base: Buffer | null, theirs: Buffer): { merged: Buffer } | { conflict: true } {
  const tmpDir = mkdtempSync(join(tmpdir(), "lfs-merge-"));
  const fOurs = join(tmpDir, "ours");
  const fBase = join(tmpDir, "base");
  const fTheirs = join(tmpDir, "theirs");
  try {
    writeFileSync(fOurs, ours);
    writeFileSync(fTheirs, theirs);
    if (base !== null) writeFileSync(fBase, base);
    else writeFileSync(fBase, Buffer.alloc(0));
    const res = spawnSync("git", ["merge-file", "-p", "-q", fOurs, fBase, fTheirs], { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 });
    if (res.status === 0 && res.stdout) {
      return { merged: res.stdout };
    }
    return { conflict: true };
  } catch {
    return { conflict: true };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function enoent(path: string, why: string) {
  const err = new Error(`ENOENT: ${path} (${why})`);
  (err as any).code = "ENOENT";
  return err;
}

const sameSig = (a: HostEntry | null | undefined, b: HostEntry | null | undefined) =>
  a === b || (Boolean(a) && Boolean(b) && a!.kind === b!.kind && a!.sig === b!.sig && ((a!.mode ?? 0o644) & 0o7777) === ((b!.mode ?? 0o644) & 0o7777));

const cleanRef = (ref: string | null | undefined) => (ref ?? "").replace(/^(\w+)-/, "").slice(0, 12);
const fileSig = (data: Buffer, mode?: number): HostEntry => ({ kind: "file", sig: sha(data), ...(mode !== undefined ? { mode: mode & 0o7777 } : {}) });
const linkSig = (target: string): HostEntry => ({ kind: "symlink", sig: `link:${target}` });

async function hostState(abs: string): Promise<HostEntry | null | "other"> {
  const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : Promise.reject(e)));
  if (!st) return null;
  if (st.isSymbolicLink()) return linkSig(await fsp.readlink(abs));
  if (st.isFile()) return fileSig(await fsp.readFile(abs), st.mode);
  return "other";
}

async function removeEmptyParents(root: string, rel: string): Promise<void> {
  let dir = posix.dirname(rel);
  while (dir && dir !== "." && dir !== "/") {
    try { await fsp.rmdir(join(root, dir)); } catch { return; }
    dir = posix.dirname(dir);
  }
}

export function isOutsideSecret(abs: string, excludes: string[]): boolean {
  if (isExcludedPath(abs, excludes.filter((p) => !p.replace(/\/$/, "").includes("/")))) return true;
  for (const home of HOMES) {
    if (abs.startsWith(`${home}/`) && isExcludedPath(abs.slice(home.length + 1), OUTSIDE_SECRET_PATTERNS)) return true;
  }
  return false;
}

export function isExcludedPath(relPath: string, patterns: string[]): boolean {
  const rel = relPath.replace(/^\/+/, "").toLowerCase();
  if (!rel) return false;
  const parts = rel.split("/");
  for (const raw of patterns.flatMap(expandBraces)) {
    let pat = raw.trim().toLowerCase();
    if (!pat) continue;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    const anchored = pat.startsWith("/") || pat.includes("/");
    pat = pat.replace(/^\/+/, "");
    if (!anchored) {
      const comps = dirOnly ? parts.slice(0, -1) : parts;
      if (comps.some((c) => posix.matchesGlob(c, pat))) return true;
      continue;
    }
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (dirOnly && i === parts.length) break;
      if (posix.matchesGlob(prefix, pat)) return true;
    }
  }
  return false;
}

async function listImportable(root: string, excludes: string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw new LayerfsError("ScanFailed", `cannot read ${relative(root, dir) || "."}: ${e?.code ?? e}`);
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (!rel.startsWith(".git/") && rel !== ".git" && (isExcludedPath(rel, excludes) || (ent.isDirectory() && isExcludedPath(`${rel}/x`, excludes)))) continue;
      if (ent.isDirectory()) await walk(abs);
      else out.push(rel);
    }
  };
  await walk(root);
  return out;
}

export function rsyncExcludeArgs(patterns: string[]): string[] {
  const ci = (p: string) => p.replace(/\[[^\]]*\]|[a-z]/gi, (m) => (m.length > 1 ? m : `[${m.toLowerCase()}${m.toUpperCase()}]`));
  return patterns.flatMap(expandBraces).map((p) => p.trim()).filter(Boolean).map((p) => {
    const dirOnly = p.endsWith("/");
    const body = dirOnly ? p.slice(0, -1) : p;
    const anchored = body.startsWith("/") || body.includes("/");
    const rule = `${anchored ? `/${body.replace(/^\/+/, "")}` : body}${dirOnly ? "/" : ""}`;
    return `--exclude=${ci(rule)}`;
  });
}

export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const prefix = pattern.slice(0, m.index);
  const suffix = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

export function matchesToolGlob(rel: string, pattern: string): boolean {
  if (pattern.includes("/")) return posix.matchesGlob(rel, pattern) || posix.matchesGlob(rel, `**/${pattern}`);
  return posix.matchesGlob(posix.basename(rel), pattern);
}

async function scanHostDirectory(root: string, excludes: string[], cache: HostIndex = {}, strict = false): Promise<{ index: HostIndex; bytes: Map<string, Buffer> }> {
  const index: HostIndex = {};
  const bytes = new Map<string, Buffer>();
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e: any) {
      if (e?.code === "ENOENT" || !strict) return;
      throw new LayerfsError("ScanFailed", `cannot read ${relative(root, dir) || "."}: ${e?.code ?? e}`);
    }
    for (const ent of entries) {
      if (ent.name === ".git" || ent.name === ".lww" || ent.name.includes(".pi-layerfs-")) continue;
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split("\\").join("/");
      if (isExcludedPath(rel, excludes)) continue;
      if (ent.isDirectory()) { await walk(abs); continue; }
      const st = await fsp.lstat(abs).catch((e: any) => (e?.code === "ENOENT" ? null : Promise.reject(e)));
      if (!st) continue;
      const prev = cache[rel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && (prev.mode === undefined || prev.mode === (st.mode & 0o7777))) {
        index[rel] = prev;
        continue;
      }
      if (st.isSymbolicLink()) {
        index[rel] = { ...linkSig(await fsp.readlink(abs)), mtimeMs: st.mtimeMs, size: st.size };
      } else if (st.isFile()) {
        const data = await fsp.readFile(abs);
        bytes.set(rel, data);
        index[rel] = { ...fileSig(data, st.mode), mtimeMs: st.mtimeMs, size: st.size };
      }
    }
  };
  await walk(root);
  return { index, bytes };
}

function runLocal(cmd: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolveRun({ code: -1, stderr: e.message }));
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
}

export async function stopNativeDaemons(localDir?: string): Promise<void> {
  const pattern = localDir ? `layerfs-daemon --config ${localDir}/` : "layerfs-daemon --config ";
  const r = await run("pgrep", ["-f", pattern]).catch(() => null);
  if (r?.code === 0 && r.stdout.length > 0) {
    const pids = r.stdout.toString().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      const n = Number(pid);
      if (n > 0 && n !== process.pid) {
        try { process.kill(n, "SIGTERM"); } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
