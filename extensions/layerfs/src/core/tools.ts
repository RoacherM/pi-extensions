// Harness-agnostic tool schemas, action executors, and file/bash operation bindings.
// Any agent harness (Pi, Epi, Claude Code, Codex, Cursor, DSH, MCP, custom SDKs) can
// import these directly from `@roacherm/pi-layerfs/core` with zero Pi dependencies.
import path from "node:path";
import { hiddenPath } from "../history.ts";
import { isExcludedPath, type LayerfsSession, type MergeResult } from "../workspace.ts";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const LAYERFS_TOOL_DESCRIPTION = [
  "Inspect and combine LayerFS branches of this project (your file tools and bash work on your own branch).",
  "action=status: your branch name and alias (report alias to whoever merges your work), head, whether you have unapplied changes.",
  "action=diff [branch=<name>] [base=<name>]: files changed on your branch or between specified branches (build output is counted, not listed).",
  "action=branches: active branches of the project (with aliases).",
  "action=sync [branch=<name>] [strategy=ours|theirs]: merge trunk (main) or a specified branch (e.g. branch='lead') into your branch.",
  "action=merge branch=<name> [strategy=ours|theirs]: merge another branch into yours. On conflict nothing changes and conflicts are listed.",
  "action=show branch=<name> path=<file> [offset=1] [limit=N]: print a file (or list directory) from another branch (supports pagination).",
  "action=ls [branch=<name>] [path=/]: list directory entries on a branch.",
  "action=checkout branch=<name> (path=<file>|paths=[...]): copy files or directories from another branch into your branch.",
].join(" ");

export const LAYERFS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["status", "diff", "branches", "sync", "merge", "show", "ls", "checkout"] },
    branch: { type: "string", description: "branch to merge (action=merge), read from (action=show/ls/checkout), or diff (action=diff/sync)" },
    base: { type: "string", description: "base branch to diff against (action=diff)" },
    path: { type: "string", description: "file or directory path (action=show, action=ls, action=checkout)" },
    paths: { type: "array", items: { type: "string" }, description: "multiple file or directory paths to copy (action=checkout)" },
    strategy: { type: "string", enum: ["ours", "theirs"], description: "conflict resolution strategy: 'ours' keeps your branch's version, 'theirs' takes the other branch's version" },
    offset: { type: "integer", description: "1-indexed starting line number (action=show, default: 1)" },
    limit: { type: "integer", description: "maximum lines to show (action=show)" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

export const LAYERFS_APPLY_TOOL_DESCRIPTION =
  "Write your branch's changes into the user's real project folder and advance the trunk (main), so new sessions and sub-agents start from it. Three-way checked: if a file changed in the folder meanwhile, nothing is written and the files are listed. Build output marked branch-only is never written.";

export const LAYERFS_APPLY_TOOL_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export interface LayerfsActionParams {
  action: "status" | "diff" | "branches" | "sync" | "merge" | "show" | "ls" | "checkout";
  branch?: string;
  base?: string;
  path?: string;
  paths?: string[];
  strategy?: "ours" | "theirs";
  offset?: number;
  limit?: number;
}

export interface LayerfsActionHooks {
  onStatusChange?: () => void;
  onMerged?: (otherBranch: string, result: MergeResult) => void;
}

export function cleanRelPath(s: LayerfsSession, raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || trimmed === "/" || trimmed === ".") return "";
  if (path.isAbsolute(trimmed)) {
    const r = s.toRel(trimmed);
    if (r !== null) return r;
  }
  return trimmed.replace(/^\.?\/+/, "");
}

/**
 * Standard file & shell operations bound to a `LayerfsSession`.
 * Can be plugged into Pi's tool factories (`createReadTool`, etc.) or any other agent harness.
 */
export function createHarnessOperations(s: LayerfsSession) {
  return {
    read: {
      readFile: (p: string) => s.readFile(p),
      access: (p: string) => s.access(p),
      detectImageMimeType: async (p: string) => IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null,
    },
    write: {
      writeFile: (p: string, c: string | Buffer) => s.writeFile(p, c),
      mkdir: (p: string) => s.mkdir(p),
    },
    edit: {
      readFile: (p: string) => s.readFile(p),
      writeFile: (p: string, c: string | Buffer) => s.writeFile(p, c),
      access: (p: string) => s.access(p, true),
    },
    bash: {
      exec: (cmd: string, cwd: string, o: any) => s.exec(cmd, cwd, o),
    },
    ls: {
      exists: (p: string) => s.exists(p),
      stat: async (p: string) => {
        const d = await s.isDirectory(p);
        return { isDirectory: () => d };
      },
      readdir: (p: string) => s.readdir(p),
    },
    find: {
      exists: (p: string) => s.exists(p),
      glob: (pattern: string, cwd: string, o: { ignore: string[]; limit: number }) => s.findFiles(pattern, cwd, o),
    },
  };
}

/**
 * Executes a `layerfs` tool action (`status | diff | branches | show | ls | checkout | sync | merge`)
 * on `s` and returns the plain-text response string.
 */
export async function executeLayerfsAction(
  s: LayerfsSession,
  params: LayerfsActionParams,
  hooks?: LayerfsActionHooks,
): Promise<string> {
  const action = params?.action;
  if (action === "status") {
    return [
      `branch: ${s.workBranch} (alias: ${s.logicalBranch})`,
      `head: ${s.headCommit ?? "none (no changes yet)"}`,
      `unapplied changes: ${s.unapplied ? "yes" : "no"}`,
      s.blocked ? `BLOCKED: ${s.blocked.reason}` : "",
    ].filter(Boolean).join("\n");
  }
  if (action === "diff") {
    if (params?.branch) {
      const resolvedBranch = await s.resolveBranchName(params.branch);
      let resolvedBase = s.baseBranch;
      if (params?.base) {
        resolvedBase = await s.resolveBranchName(params.base);
      } else if (resolvedBranch !== "main") {
        const bInfo = (await s.listAllBranches()).find((b) => b.name === resolvedBranch);
        if (bInfo?.base) {
          resolvedBase = `h-${bInfo.base.slice(0, 20)}`;
          await s.lfs.branch.fork(resolvedBase, bInfo.base).catch(() => {});
        }
      }
      const all: Array<{ path: string; kind: string; type: string }> = [];
      for (let pos = 0; ; ) {
        const page = await s.lfs.branch.diff_branches(resolvedBase, resolvedBranch, 1000, pos, { hunks: false });
        for (const it of page.items ?? []) {
          if (it.path === "/.lww" || !it.path || it.type === "dir" || hiddenPath(it.path)) continue;
          all.push({ path: it.path, kind: it.kind, type: it.type });
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      const d = all.filter((i) => s.isApplicable(i.path));
      const lines = d.slice(0, 300).map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`);
      if (d.length > 300) lines.push(`… ${d.length - 300} more`);
      const other = all.length - d.length;
      if (other) lines.push(`(+${other} branch-only/build files, never applied)`);
      return lines.length ? lines.join("\n") : `No changes between ${resolvedBase} and ${resolvedBranch}.`;
    }
    const all = (await s.diff()).filter((i) => i.type !== "dir" && !hiddenPath(i.path));
    const d = all.filter((i) => s.isApplicable(i.path));
    const lines = d.slice(0, 300).map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`);
    if (d.length > 300) lines.push(`… ${d.length - 300} more`);
    const other = all.length - d.length;
    if (other) lines.push(`(+${other} branch-only/build files, never applied)`);
    return lines.length ? lines.join("\n") : "No changes on this branch.";
  }
  if (action === "branches") {
    const list = await s.listUserBranches();
    return list
      .map((b) => `${b.name}${b.isYours ? " (yours)" : ""}${b.logicalBranch && b.logicalBranch !== b.name ? ` (alias: ${b.logicalBranch})` : ""} head ${(b.head ?? "-").slice(0, 12)}`)
      .join("\n");
  }
  if (action === "show") {
    const b = String(params?.branch ?? "").trim();
    const rawPath = String(params?.path ?? "").trim();
    if (!b || !rawPath) throw new Error("action=show needs branch=<name> and path=<file>");
    const resolvedBranch = await s.resolveBranchName(b);
    const rel = cleanRelPath(s, rawPath);
    if (rel && !s.isApplicable(rel) && rel !== ".lww") throw new Error(`${rel} is not readable here (secret, git metadata or build output)`);
    const storePath = rel ? `/${rel}` : "/";
    const st = await s.lfs.fs.stat(resolvedBranch, storePath).catch(() => null);
    if (!st) throw new Error(`ENOENT: ${rawPath} does not exist on branch ${resolvedBranch}`);
    if (st.type === "dir") {
      const entries: string[] = [];
      for (let pos = 0; ; ) {
        const page = await s.lfs.fs.list(resolvedBranch, storePath, 1000, pos);
        for (const it of page.items ?? []) {
          if (it.name === ".lww" || it.name === ".git" || it.name.startsWith(".git/")) continue;
          const itRel = it.path.replace(/^\/+/, "");
          if (isExcludedPath(itRel, s.config.excludes) || !s.isApplicable(itRel)) continue;
          entries.push(it.type === "dir" ? `${it.name}/` : it.name);
        }
        if (!page.hasMore || !(page.items ?? []).length) break;
        pos = page.nextPagePos ?? (pos + page.items.length);
      }
      entries.sort();
      return entries.length ? entries.join("\n") : "(empty directory)";
    }
    const fullBytes = await s.readBytesAtRef(resolvedBranch, storePath, rel);
    const fullText = fullBytes.toString("utf8");
    const allLines = fullText.length === 0 ? [] : (fullText.endsWith("\n") ? fullText.slice(0, -1).split(/\r?\n/) : fullText.split(/\r?\n/));
    const totalLines = allLines.length;
    const offset = Math.max(1, Number(params?.offset ?? 1));
    const limit = params?.limit !== undefined ? Math.max(1, Number(params.limit)) : undefined;

    if (totalLines === 0) return "";
    if (offset > totalLines) return `(offset ${offset} is past end of file; file has ${totalLines} lines)`;

    const selectedLines: string[] = [];
    let currentBytes = 0;
    let nextLine = offset;
    for (let i = offset - 1; i < totalLines; i++) {
      if (limit !== undefined && selectedLines.length >= limit) break;
      const line = allLines[i];
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (selectedLines.length > 0 && currentBytes + lineBytes > 100_000) break;
      selectedLines.push(line);
      currentBytes += lineBytes;
      nextLine = i + 2;
    }
    const endLine = offset + selectedLines.length - 1;
    const isTruncated = endLine < totalLines;
    if (!isTruncated && offset === 1 && limit === undefined) return fullText;
    let output = selectedLines.join("\n");
    if (isTruncated) {
      output += `\n… (truncated: showing lines ${offset}-${endLine} of ${totalLines}, total ${fullBytes.length} bytes; pass offset=${nextLine} to read more, or use action="checkout" to copy the file)`;
    }
    return output;
  }
  if (action === "ls") {
    const b = params?.branch ? await s.resolveBranchName(params.branch) : s.workBranch;
    const rawPath = String(params?.path ?? "/").trim();
    const rel = cleanRelPath(s, rawPath);
    if (rel && !s.isApplicable(rel)) throw new Error(`${rel} is not readable here (secret, git metadata or build output)`);
    const storePath = rel ? `/${rel}` : "/";
    const entries: string[] = [];
    for (let pos = 0; ; ) {
      const page = await s.lfs.fs.list(b, storePath, 1000, pos);
      for (const it of page.items ?? []) {
        if (it.name === ".lww" || it.name === ".git" || it.name.startsWith(".git/")) continue;
        const itRel = it.path.replace(/^\/+/, "");
        if (isExcludedPath(itRel, s.config.excludes) || !s.isApplicable(itRel)) continue;
        entries.push(it.type === "dir" ? `${it.name}/` : it.name);
      }
      if (!page.hasMore || !(page.items ?? []).length) break;
      pos = page.nextPagePos ?? (pos + page.items.length);
    }
    entries.sort();
    return entries.length ? entries.join("\n") : "(empty directory)";
  }
  if (action === "checkout") {
    const b = String(params?.branch ?? "").trim();
    if (!b) throw new Error("action=checkout needs branch=<name>");
    const resolvedBranch = await s.resolveBranchName(b);
    const rawPaths = params?.paths ? (Array.isArray(params.paths) ? params.paths : [params.paths]) : (params?.path ? [params.path] : []);
    if (!rawPaths.length) throw new Error("action=checkout needs path=<file> or paths=[...]");

    const r = await s.mutate("checkout", "checkout", async () => {
      const copied: Array<{ path: string; size: number }> = [];

      const collectFiles = async (dirSp: string): Promise<string[]> => {
        const files: string[] = [];
        for (let pos = 0; ; ) {
          const page = await s.lfs.fs.list(resolvedBranch, dirSp, 1000, pos);
          for (const item of page.items ?? []) {
            if (item.name === ".lww" || item.name === ".git" || item.name.startsWith(".git/")) continue;
            const itemRel = item.path.replace(/^\/+/, "");
            if (isExcludedPath(itemRel, s.config.excludes) || !s.isApplicable(itemRel)) continue;
            if (item.type === "dir") {
              files.push(...(await collectFiles(item.path)));
            } else {
              files.push(itemRel);
            }
          }
          if (!page.hasMore || !(page.items ?? []).length) break;
          pos = page.nextPagePos ?? (pos + page.items.length);
        }
        return files;
      };

      for (const targetPath of rawPaths) {
        const rel = cleanRelPath(s, targetPath);
        if (rel && !s.isApplicable(rel)) throw new Error(`${rel} cannot be checked out (secret, git metadata or build output)`);
        const storePath = rel ? `/${rel}` : "/";
        const st = await s.lfs.fs.stat(resolvedBranch, storePath).catch(() => null);
        if (!st) throw new Error(`action=checkout: "${targetPath}" does not exist on branch ${resolvedBranch}`);
        if (st.type === "dir") {
          const dirFiles = await collectFiles(storePath);
          for (const fileRel of dirFiles) {
            if (fileRel && !s.isApplicable(fileRel)) throw new Error(`${fileRel} cannot be checked out (secret, git metadata or build output)`);
            const bytes = await s.readBytesAtRef(resolvedBranch, "/" + fileRel, fileRel);
            await s.writeFile(path.join(s.cwd, fileRel), bytes);
            copied.push({ path: fileRel, size: bytes.length });
          }
        } else {
          const bytes = await s.readBytesAtRef(resolvedBranch, storePath, rel);
          await s.writeFile(path.join(s.cwd, rel), bytes);
          copied.push({ path: rel, size: bytes.length });
        }
      }
      return copied;
    });

    hooks?.onStatusChange?.();
    const copied = r.value;
    return [
      `Checked out ${copied.length} file(s) from ${resolvedBranch}:`,
      ...copied.map((c) => `  ${c.path} (${c.size} bytes)`),
    ].join("\n");
  }
  if (action === "sync" || action === "merge") {
    const branchParam = action === "sync" ? (params?.branch || "main") : params?.branch;
    const target = String(branchParam ?? "").trim();
    if (!target) throw new Error("action=merge needs branch=<name> (see action=branches)");
    const other = await s.resolveBranchName(target);
    if (other === s.workBranch) throw new Error("that is your own branch");
    const strategy = params?.strategy;
    if (strategy && strategy !== "ours" && strategy !== "theirs") {
      throw new Error(`invalid strategy "${strategy}": expected "ours" or "theirs"`);
    }
    const r = await s.mergeBranch(other, strategy ? { strategy } : undefined);
    hooks?.onStatusChange?.();
    if (!r.merged) {
      return [
        `CONFLICT merging ${other}: nothing changed (you are still on ${s.workBranch}).`,
        "Conflicting files:",
        ...r.conflicts.map((c) => `  ${c.path}${c.kind ? ` (${c.kind})` : ""}`),
        "How to resolve (LayerFS merges three-way, so editing only your side keeps conflicting):",
        `  1. Run with strategy: action="merge" branch="${target}" strategy="theirs" (or strategy="ours");`,
        `  2. Or inspect with action=show branch=${other} path=<file>, checkout files with action=checkout branch=${other} path=<file>, or edit your files.`,
      ].join("\n");
    }
    hooks?.onMerged?.(other, r);
    const lwwInfo = r.lww
      ? r.lwwPaths?.length
        ? ` (${r.lww} generated file(s) took the newer side: ${r.lwwPaths.slice(0, 5).join(", ")}${r.lwwPaths.length > 5 ? ", …" : ""})`
        : ` (${r.lww} generated file(s) took the newer side)`
      : "";
    const fallbackInfo = r.fallback ? " (via path-wise merge)" : "";
    return `Merged ${other}${fallbackInfo}. You are now on ${r.branch}${lwwInfo}.`;
  }
  throw new Error(`unknown action ${action}`);
}

/**
 * Executes `layerfs_apply` on `s` and returns the plain-text response string.
 */
export async function executeLayerfsApply(
  s: LayerfsSession,
  hooks?: { onStatusChange?: () => void; onApplied?: () => void },
): Promise<string> {
  let r;
  try {
    r = await s.apply();
  } catch (e: any) {
    hooks?.onStatusChange?.();
    const partial = e?.result as { applied: string[] } | undefined;
    throw new Error(`apply stopped: ${e?.message ?? e}${partial?.applied.length ? ` (already written: ${partial.applied.join(", ")})` : " (nothing was written)"}`);
  }
  hooks?.onStatusChange?.();
  hooks?.onApplied?.();
  if (r.conflicts.length) {
    return `Nothing applied: these files changed in the user's folder since your branch started:\n${r.conflicts.join("\n")}`;
  }
  return [
    r.applied.length ? `Applied ${r.applied.length} file(s) to ${s.cwd}; main now includes your branch.` : "No source changes to write; main now includes your branch.",
    ...r.warnings.map((w) => `Warning: ${w}`),
  ].join("\n");
}
