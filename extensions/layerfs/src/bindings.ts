// Project & session bindings (adapted from dsh/packages/host/src/binding.js),
// plus per-project file locks and host-index manifests for P0-1 / P0-6 / P1-6.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { acquireLock, acquireLockSync } from "./lock.ts";
import { basename, join } from "node:path";

export interface ProjectRecord {
  name: string;
  source: string;
  volume: string;
  image?: string;
  mainRef: string;
  /** main in the Store may lag the host (a publish after apply failed): resync on next start */
  mainStale?: boolean;
  created: number;
  updatedAt: number;
}

export interface SessionBinding {
  project: string;
  cwd: string;
  baseBranch: string;
  workBranch: string;
  baseRef: string;
  headCommit: string | null;
  unapplied: boolean;
  seq: number;
  updatedAt: number;
  logicalBranch?: string;
}

export interface HostEntry {
  kind: "file" | "symlink";
  sig: string;
  mode?: number;
  mtimeMs?: number;
  size?: number;
}

export type HostIndex = Record<string, HostEntry>;

interface BindingsData {
  version: 1;
  projects: Record<string, ProjectRecord>;
  workspaces: Record<string, { lastUsed: string | null }>;
  sessions: Record<string, SessionBinding>;
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;

export function nameFromFolder(folder: string): string {
  const base = basename(folder).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 48);
  return NAME_RE.test(base) ? base : "project";
}

export class BindingStore {
  readonly stateDir: string;
  readonly file: string;
  readonly lockDir: string;
  private stamp: string | null = null;
  private depth = 0;
  private _data: BindingsData = { version: 1, projects: {}, workspaces: {}, sessions: {} };

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.file = join(stateDir, "bindings.json");
    this.lockDir = `${this.file}.lock`;
    mkdirSync(stateDir, { recursive: true });
    this.reload();
  }

  reload(): void {
    let stat;
    try { stat = statSync(this.file); } catch { return; }
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (stamp === this.stamp) return;
    this._data = JSON.parse(readFileSync(this.file, "utf8"));
    this.stamp = stamp;
  }

  get data(): BindingsData {
    if (this.depth === 0) this.reload();
    return this._data;
  }

  update<T>(change: (data: BindingsData) => T): T {
    if (this.depth > 0) return change(this._data);
    const lock = acquireLockSync(this.lockDir);
    const release = () => lock.release();
    this.depth++;
    try {
      this.stamp = null;
      this.reload();
      const result = change(this._data);
      this.save();
      return result;
    } finally {
      this.depth--;
      release();
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this._data, null, 2) + "\n");
    renameSync(tmp, this.file);
    const stat = statSync(this.file);
    this.stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }

  /** Serializes project-level mutations (init, host-drift sync, apply + publish) across processes. */
  async withProjectLock<T>(projectName: string, fn: (guard: () => void) => Promise<T>, timeoutMs = 60_000): Promise<T> {
    const lockDir = join(this.stateDir, "locks", `${projectName}.lock`);
    const lock = await acquireLock(lockDir, timeoutMs);
    // call guard() before an irreversible step: it throws if another process took the lock over
    const guard = () => {
      if (lock.lost) throw Object.assign(new Error(`lost the project lock for ${projectName} (process was frozen?); aborting`), { code: "LockLost" });
    };
    try {
      return await fn(guard);
    } finally {
      lock.release();
    }
  }

  freeProjectName(folder: string, homeDir: string): string {
    const base = nameFromFolder(folder);
    const taken = new Set(Object.keys(this.data.projects));
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? base : `${base.slice(0, 55)}-${i}`;
      if (!taken.has(candidate) && !existsSync(join(homeDir, candidate))) return candidate;
    }
  }

  byFolder(folder: string): ProjectRecord | null {
    const name = this.data.workspaces[folder]?.lastUsed;
    return name ? (this.data.projects[name] ?? null) : null;
  }

  byName(name: string): ProjectRecord | null {
    return this.data.projects[name] ?? null;
  }

  projects(): ProjectRecord[] {
    return Object.values(this.data.projects).sort((a, b) => a.created - b.created);
  }

  addProject(folder: string, project: ProjectRecord): void {
    this.update((d) => {
      d.projects[project.name] = project;
      (d.workspaces[folder] ||= { lastUsed: null }).lastUsed = project.name;
    });
  }

  updateProjectMain(name: string, mainRef: string): void {
    this.update((d) => {
      if (d.projects[name]) {
        d.projects[name].mainRef = mainRef;
        d.projects[name].updatedAt = Date.now();
      }
    });
  }

  setMainStale(name: string, stale: boolean): void {
    this.update((d) => {
      if (d.projects[name]) d.projects[name].mainStale = stale;
    });
  }

  removeProject(name: string): void {
    this.update((d) => {
      delete d.projects[name];
      for (const w of Object.values(d.workspaces)) if (w.lastUsed === name) w.lastUsed = null;
      for (const [sid, s] of Object.entries(d.sessions)) if (s.project === name) delete d.sessions[sid];
    });
    try {
      const f = this.manifestFile(name);
      if (existsSync(f)) renameSync(f, `${f}.removed.${Date.now()}`);
    } catch {}
  }

  session(sessionId: string): SessionBinding | null {
    return this.data.sessions[sessionId] ?? null;
  }

  setSession(sessionId: string, binding: SessionBinding): void {
    this.update((d) => {
      d.sessions[sessionId] = binding;
    });
  }

  manifestFile(projectName: string): string {
    const dir = join(this.stateDir, "manifests");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${projectName}.json`);
  }

  readHostIndex(projectName: string): HostIndex {
    const f = this.manifestFile(projectName);
    if (!existsSync(f)) return {};
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; }
  }

  writeHostIndex(projectName: string, index: HostIndex): void {
    const f = this.manifestFile(projectName);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, f);
  }
}
