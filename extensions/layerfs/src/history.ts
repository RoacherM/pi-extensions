// `/layerfs history`: a read-only view of this session's file history on its LayerFS
// Branch. Store reads only (list_commits, diff_commits, diff_branches): no Sandbox starts.
import type { LayerfsSession } from "./workspace.ts";

export interface HistoryFile { kind: string; path: string }
export interface HistoryRow {
  id: string;
  time: number;
  message: string;
  origins: string[];
  label: string;
  files: HistoryFile[];
  filesMore: boolean;
  /** build-output files (branch-only) changed in this commit: counted, not listed */
  build?: number;
  isHead: boolean;
  applied: boolean;
}
export interface HistoryView {
  project: string;
  branch: string;
  baseRef: string;
  rows: HistoryRow[];
  more: boolean;
  unapplied: HistoryFile[];
}

const FILES_PER_ROW = 8;

/** Paths never shown in history: LayerFS merge rules and git internals (apply never writes them either). */
export function hiddenPath(path: string): boolean {
  const p = String(path).replace(/^\/+/, "");
  return p === ".lww" || p === ".git" || p.startsWith(".git/");
}

/** `pi bash (exit 3) [call_1,call_2]` -> { label: "bash (exit 3)", origins: [...] } */
export function parseMessage(message: string | null | undefined): { label: string; origins: string[] } {
  const text = String(message ?? "").trim();
  const m = /^pi\s+(.*?)\s*(?:\[([^\]]*)\])?$/.exec(text);
  if (!m) return { label: text || "(no message)", origins: [] };
  const origins = (m[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { label: m[1] || "change", origins };
}

async function changedFiles(s: LayerfsSession, from: string | null, to: string): Promise<{ files: HistoryFile[]; more: boolean }> {
  const page = from
    ? await s.lfs.branch.diff_commits(from, to, 200, 0, { hunks: false })
    : null;
  const items = page?.items ?? [];
  return summarize(s, items, Boolean(page?.hasMore));
}

/** Source files first (build output marked branch-only is counted, not listed). */
function summarize(s: LayerfsSession, items: any[], hasMore: boolean): { files: HistoryFile[]; more: boolean; build: number } {
  const all = items.filter((i: any) => i.type !== "dir" && !hiddenPath(i.path));
  const files = all.filter((i: any) => s.isApplicable(i.path)).map((i: any) => ({ kind: i.kind, path: String(i.path).replace(/^\/+/, "") }));
  const build = all.length - files.length;
  return { files: files.slice(0, FILES_PER_ROW), more: files.length > FILES_PER_ROW || (hasMore && build === 0), build: build + (hasMore && build > 0 ? 1 : 0) };
}

export async function loadHistory(s: LayerfsSession, limit = 20): Promise<HistoryView> {
  const page = await s.lfs.branch.list_commits(s.workBranch, Math.max(1, Math.min(limit, 100)), 0);
  const commits: any[] = page.items ?? [];
  const applied = await appliedCommits(s);
  const rows: HistoryRow[] = [];
  for (const c of commits) {
    const { label, origins } = parseMessage(c.message);
    let files: HistoryFile[] = [];
    let filesMore = false;
    let build = 0;
    try {
      if (c.parent) {
        ({ files, more: filesMore, build } = await changedFiles(s, c.parent, c.id));
      } else {
        // First Commit on the Branch: its parent is the base Layer, which diff_commits refuses.
        // Compare the Layer (as a Branch with no Commits) with a Branch pinned at this Commit.
        ({ files, more: filesMore, build } = await firstCommitFiles(s, c));
      }
    } catch {
      // keep the row without its file list
    }
    rows.push({
      id: c.id,
      time: Number(c.time) || 0,
      message: c.message ?? "",
      origins,
      label,
      files,
      filesMore,
      build,
      isHead: c.id === s.headCommit,
      applied: applied.has(c.id),
    });
  }
  const unapplied = (await s.diff())
    .filter((i) => i.type !== "dir" && !hiddenPath(i.path) && s.isApplicable(i.path))
    .map((i) => ({ kind: i.kind, path: i.path.replace(/^\/+/, "") }));
  return { project: s.project, branch: s.workBranch, baseRef: s.baseRef, rows, more: Boolean(page.hasMore), unapplied };
}

/** Cached per process: Branch names pinned at a Layer or at a Commit (immutable refs, so reusable). */
const pinned = new Map<string, string>();
async function pinBranch(s: LayerfsSession, ref: string): Promise<string> {
  const key = `${s.project}\n${ref}`;
  const known = pinned.get(key);
  if (known) return known;
  const name = `h-${ref.slice(0, 20)}`;
  await s.lfs.branch.fork(name, ref).catch((e: any) => {
    if (e?.code !== "Exists" && !/exists/i.test(String(e?.message))) throw e;
  });
  pinned.set(key, name);
  return name;
}

async function firstCommitFiles(s: LayerfsSession, c: any): Promise<{ files: HistoryFile[]; more: boolean }> {
  const from = await pinBranch(s, c.base);
  const to = await pinBranch(s, c.id);
  const d = await s.lfs.branch.diff_branches(from, to, 200, 0, { hunks: false });
  return summarize(s, d.items ?? [], Boolean(d.hasMore));
}

/** Commits at or before the session's base anchor have been applied to the host. */
async function appliedCommits(s: LayerfsSession): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const page = await s.lfs.branch.list_commits(s.baseBranch, 100, 0);
    for (const c of page.items ?? []) out.add(c.id);
  } catch {
    // a base Branch with no Commits yet (head null) refuses nothing useful; nothing applied
  }
  return out;
}

const KIND_MARK: Record<string, string> = { Added: "+", Modified: "~", Removed: "-" };

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Plain-text rendering (works in TUI notify, RPC and print mode). */
export function formatHistory(v: HistoryView, now = Date.now()): string {
  const lines: string[] = [];
  lines.push(`LayerFS history · ${v.project} · ${v.branch}`);
  if (!v.rows.length) {
    lines.push("  (no changes on this branch yet)");
  }
  for (const r of v.rows) {
    const marks = [r.isHead ? "HEAD" : "", r.applied ? "applied" : ""].filter(Boolean).join(", ");
    lines.push(`${r.isHead ? "●" : "○"} ${r.id.slice(0, 12)}  ${r.label.padEnd(18).slice(0, 18)} ${ago(r.time, now).padStart(8)}${marks ? `  (${marks})` : ""}`);
    const buildNote = r.build ? `${r.files.length ? "  " : ""}(+${r.build}${r.build >= 200 ? "+" : ""} build file${r.build === 1 ? "" : "s"})` : "";
    lines.push(r.files.length || r.build
      ? `│   ${r.files.map((f) => `${KIND_MARK[f.kind] ?? "?"}${f.path}`).join("  ")}${r.filesMore ? "  …" : ""}${buildNote}`
      : "│   (only git metadata changed)");
  }
  if (v.more) lines.push("│   … older changes not shown (/layerfs history <n>)");
  lines.push(`└ base ${v.baseRef.slice(0, 12)} (session start / last apply)`);
  lines.push(
    v.unapplied.length
      ? `Not yet applied: ${v.unapplied.length} file(s) · /layerfs diff · /layerfs apply`
      : "Everything on this branch is applied to your folder.",
  );
  return lines.join("\n");
}
