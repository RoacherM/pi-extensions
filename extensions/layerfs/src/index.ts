/**
 * pi-layerfs v0.2: every Pi session works on an isolated LayerFS Branch in a
 * shared Project Store by default.
 * - File tools (`read`, `write`, `edit`, `ls`, `find`, `grep`) go directly to the Store
 *   with automatic byte-exact Workspace fallback for binary, symlinks and >48KB lines.
 * - `bash` and `!cmd` mount a Workspace on demand, stream output, and unmount immediately.
 * - `/resume`, `/tree` and `/fork` restore or branch the file state alongside the conversation.
 * - The host folder is written only by `/layerfs apply` (with three-way conflict detection).
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool,
  DEFAULT_MAX_BYTES, formatSize, truncateHead,
} from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config.ts";
import { isExcludedPath, LayerfsSession, type Checkpoint } from "./workspace.ts";
import { formatHistory, hiddenPath, loadHistory } from "./history.ts";

export const CHECKPOINT_ENTRY = "layerfs-checkpoint";
export const SESSION_ENTRY = "layerfs-session";
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const cleanRel = (s: LayerfsSession, raw: string): string => {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || trimmed === "/" || trimmed === ".") return "";
  if (path.isAbsolute(trimmed)) {
    const r = s.toRel(trimmed);
    if (r !== null) return r;
  }
  return trimmed.replace(/^\.?\/+/, "");
};

export default function layerfsExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-layerfs", { description: "Disable LayerFS isolation for this run (tools act on the host folder)", type: "boolean", default: false });

  let session: LayerfsSession | null = null;
  let ready: Promise<LayerfsSession> | null = null;
  let disabled = false;
  let startError: Error | null = null;
  let pendingForkRef: string | null = null;

  const proto = process.cwd();
  let hostCwd = proto;
  const local = {
    read: createReadTool(proto), write: createWriteTool(proto), edit: createEditTool(proto), bash: createBashTool(proto),
    grep: createGrepTool(proto), find: createFindTool(proto), ls: createLsTool(proto),
  };
  const host: Record<string, (cwd: string) => any> = {
    read: createReadTool, write: createWriteTool, edit: createEditTool, bash: createBashTool, grep: createGrepTool, find: createFindTool, ls: createLsTool,
  };
  const onHost = (name: string, id: string, params: any, signal: any, onUpdate: any) => host[name](hostCwd).execute(id, params, signal, onUpdate);

  // Default footer (setStatus) + chip for statusline extensions that listen to `notify:status`
  // on pi.events (e.g. @savagelands-net/pi-statusline).
  const status = (ctx: ExtensionContext | undefined, text: string | undefined) => {
    try { ctx?.ui.setStatus("layerfs", text); } catch {}
    try {
      if (text === undefined) {
        pi.events.emit("notify:status", { source: "layerfs", state: "cleared" });
      } else {
        const isError = /FAILED|BLOCKED/.test(text);
        pi.events.emit("notify:status", {
          source: "layerfs",
          state: isError ? "error" : "active",
          label: text.replace(/^LayerFS\s*/, "") || text,
          icon: "LFS",
        });
      }
    } catch {}
  };
  const describe = (s: LayerfsSession) => {
    if (s.blocked) return "LayerFS BLOCKED · /layerfs retry";
    const pending = s.unapplied ? ` · ${s.checkpoints.length} unapplied` : "";
    return `LayerFS ${s.workBranch}${pending}`;
  };

  async function need(): Promise<LayerfsSession> {
    if (disabled) throw new Error("LayerFS is disabled for this run");
    if (startError) throw new Error(`LayerFS failed to start: ${startError.message}. File tools are disabled (no fallback to the host folder).`);
    if (!ready) throw new Error("LayerFS has not started (no session)");
    return ready.catch((e) => { throw new Error(`LayerFS failed to start: ${e.message}. File tools are disabled (no fallback to the host folder).`); });
  }

  function report(ctx: ExtensionContext | undefined, s: LayerfsSession, r: { checkpoint: Checkpoint | null; error: Error | null }) {
    if (r.checkpoint) pi.appendEntry(CHECKPOINT_ENTRY, { ...r.checkpoint, project: s.project, branch: s.workBranch });
    status(ctx, describe(s));
    return r.error
      ? `\n\n[LayerFS] The change is in the workspace but its checkpoint failed (${(r.error as any).code ?? "Error"}: ${r.error.message}). Further changes are blocked until /layerfs retry succeeds.`
      : "";
  }

  const recordSession = (s: LayerfsSession) =>
    pi.appendEntry(SESSION_ENTRY, { project: s.project, volume: s.volume, cwd: s.cwd, baseBranch: s.baseBranch, workBranch: s.workBranch, baseRef: s.baseRef, headCommit: s.headCommit });
  const recordMerge = (s: LayerfsSession, other: string, r: { head: string | null; branch: string }) => {
    if (r.head) pi.appendEntry(CHECKPOINT_ENTRY, { origins: [`merge:${other}`], label: "merge", commit: r.head, branch: r.branch, changed: true, at: Date.now(), project: s.project });
    recordSession(s);
  };
  const applicableDiff = async (s: LayerfsSession) => (await s.diff()).filter((i) => i.type !== "dir" && !hiddenPath(i.path) && s.isApplicable(i.path));

  const withNote = (result: any, note: string) =>
    note ? { ...result, content: [...(result.content ?? []), { type: "text", text: note }] } : result;

  // ------------------------------------------------------------- tools

  const ops = (s: LayerfsSession) => ({
    read: {
      readFile: (p: string) => s.readFile(p),
      access: (p: string) => s.access(p),
      detectImageMimeType: async (p: string) => IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null,
    },
    write: { writeFile: (p: string, c: string) => s.writeFile(p, c), mkdir: (p: string) => s.mkdir(p) },
    edit: { readFile: (p: string) => s.readFile(p), writeFile: (p: string, c: string) => s.writeFile(p, c), access: (p: string) => s.access(p, true) },
    bash: { exec: (cmd: string, cwd: string, o: any) => s.exec(cmd, cwd, o) },
    ls: {
      exists: (p: string) => s.exists(p),
      stat: async (p: string) => { const d = await s.isDirectory(p); return { isDirectory: () => d }; },
      readdir: (p: string) => s.readdir(p),
    },
    find: {
      exists: (p: string) => s.exists(p),
      glob: (pattern: string, cwd: string, o: { ignore: string[]; limit: number }) => s.findFiles(pattern, cwd, o),
    },
  });

  pi.registerTool({
    ...local.read,
    async execute(id, params, signal, onUpdate) {
      if (disabled) return onHost("read", id, params, signal, onUpdate);
      const s = await need();
      return createReadTool(s.cwd, { operations: ops(s).read }).execute(id, params, signal, onUpdate);
    },
  });

  for (const name of ["write", "edit", "bash"] as const) {
    pi.registerTool({
      ...local[name],
      async execute(id: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) {
        if (disabled) return onHost(name, id, params, signal, onUpdate);
        const s = await need();
        const o = ops(s);
        const tool: any = name === "write" ? createWriteTool(s.cwd, { operations: o.write })
          : name === "edit" ? createEditTool(s.cwd, { operations: o.edit })
          : createBashTool(s.cwd, { operations: o.bash });
        const r = await s.mutate(id, name, () => tool.execute(id, params, signal, onUpdate));
        return withNote(r.value, report(ctx, s, r));
      },
    } as any);
  }

  pi.registerTool({
    ...local.ls,
    async execute(id, params, signal, onUpdate) {
      if (disabled) return onHost("ls", id, params, signal, onUpdate);
      const s = await need();
      return createLsTool(s.cwd, { operations: ops(s).ls }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.find,
    async execute(id, params, signal, onUpdate) {
      if (disabled) return onHost("find", id, params, signal, onUpdate);
      const s = await need();
      return createFindTool(s.cwd, { operations: ops(s).find }).execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...local.grep,
    async execute(id, params: any, signal, onUpdate) {
      if (disabled) return onHost("grep", id, params, signal, onUpdate);
      const s = await need();
      const g = await s.grepWorkspace(params);
      if (g.matches === 0) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
      const limit = Math.max(1, params.limit ?? 100);
      const t = truncateHead(g.lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notes = [g.limitReached ? `${limit} matches limit reached` : "", t.truncated ? `${formatSize(DEFAULT_MAX_BYTES)} limit reached` : ""].filter(Boolean);
      return { content: [{ type: "text" as const, text: t.content + (notes.length ? `\n\n[${notes.join(". ")}]` : "") }], details: undefined };
    },
  });

  // ------------------------------------------------------------- team mode (PI_LAYERFS_TEAM=1)
  // Agent-facing branch tools for multi-agent runs. `layerfs` is for every session (lead and
  // sub-agents); `layerfs_apply` (writes the user's folder) only for the top-level session:
  // pi-subagents children (PI_SUBAGENT_CHILD=1) never get it.
  const boot = resolveConfig();
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  if (boot.team && boot.enabled) {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
    pi.registerTool({
      name: "layerfs",
      label: "LayerFS",
      description: [
        "Inspect and combine LayerFS branches of this project (your file tools and bash work on your own branch).",
        "action=status: your branch name and alias (report alias to whoever merges your work), head, whether you have unapplied changes.",
        "action=diff [branch=<name>] [base=<name>]: files changed on your branch or between specified branches (build output is counted, not listed).",
        "action=branches: active branches of the project (with aliases).",
        "action=sync [branch=<name>] [strategy=ours|theirs]: merge trunk (main) or a specified branch (e.g. branch='lead') into your branch.",
        "action=merge branch=<name> [strategy=ours|theirs]: merge another branch into yours. On conflict nothing changes and conflicts are listed.",
        "action=show branch=<name> path=<file> [offset=1] [limit=N]: print a file (or list directory) from another branch (supports pagination).",
        "action=ls [branch=<name>] [path=/]: list directory entries on a branch.",
        "action=checkout branch=<name> (path=<file>|paths=[...]): copy files or directories from another branch into your branch.",
      ].join(" "),
      parameters: {
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
      } as any,
      async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
        if (disabled) return text("LayerFS is off for this run: there are no branches; tools act on the user's folder.");
        const s = await need();
        const action = params?.action;
        if (action === "status") {
          return text([
            `branch: ${s.workBranch} (alias: ${s.logicalBranch})`,
            `head: ${s.headCommit ?? "none (no changes yet)"}`,
            `unapplied changes: ${s.unapplied ? "yes" : "no"}`,
            s.blocked ? `BLOCKED: ${s.blocked.reason}` : "",
          ].filter(Boolean).join("\n"));
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
            return text(lines.length ? lines.join("\n") : `No changes between ${resolvedBase} and ${resolvedBranch}.`);
          }
          const all = (await s.diff()).filter((i) => i.type !== "dir" && !hiddenPath(i.path));
          const d = all.filter((i) => s.isApplicable(i.path));
          const lines = d.slice(0, 300).map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`);
          if (d.length > 300) lines.push(`… ${d.length - 300} more`);
          const other = all.length - d.length;
          if (other) lines.push(`(+${other} branch-only/build files, never applied)`);
          return text(lines.length ? lines.join("\n") : "No changes on this branch.");
        }
        if (action === "branches") {
          const list = await s.listUserBranches();
          return text(list.map((b) => `${b.name}${b.isYours ? " (yours)" : ""}${b.logicalBranch && b.logicalBranch !== b.name ? ` (alias: ${b.logicalBranch})` : ""} head ${(b.head ?? "-").slice(0, 12)}`).join("\n"));
        }
        if (action === "show") {
          const b = String(params?.branch ?? "").trim();
          const rawPath = String(params?.path ?? "").trim();
          if (!b || !rawPath) throw new Error("action=show needs branch=<name> and path=<file>");
          const resolvedBranch = await s.resolveBranchName(b);
          const rel = cleanRel(s, rawPath);
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
                if (isExcludedPath(itRel, s.config.excludes)) continue;
                entries.push(it.type === "dir" ? `${it.name}/` : it.name);
              }
              if (!page.hasMore || !(page.items ?? []).length) break;
              pos = page.nextPagePos ?? (pos + page.items.length);
            }
            entries.sort();
            return text(entries.length ? entries.join("\n") : "(empty directory)");
          }
          const fullBytes = await s.readBytesAtRef(resolvedBranch, storePath, rel);
          const fullText = fullBytes.toString("utf8");
          const allLines = fullText.length === 0 ? [] : (fullText.endsWith("\n") ? fullText.slice(0, -1).split(/\r?\n/) : fullText.split(/\r?\n/));
          const totalLines = allLines.length;
          const offset = Math.max(1, Number(params?.offset ?? 1));
          const limit = params?.limit !== undefined ? Math.max(1, Number(params.limit)) : undefined;

          if (totalLines === 0) {
            return text("");
          }

          if (offset > totalLines) {
            return text(`(offset ${offset} is past end of file; file has ${totalLines} lines)`);
          }

          const selectedLines: string[] = [];
          let currentBytes = 0;
          let nextLine = offset;
          for (let i = offset - 1; i < totalLines; i++) {
            if (limit !== undefined && selectedLines.length >= limit) break;
            const line = allLines[i];
            const lineBytes = Buffer.byteLength(line, "utf8") + 1;
            if (selectedLines.length > 0 && currentBytes + lineBytes > 100_000) {
              break;
            }
            selectedLines.push(line);
            currentBytes += lineBytes;
            nextLine = i + 2;
          }
          const endLine = offset + selectedLines.length - 1;
          const isTruncated = endLine < totalLines;
          if (!isTruncated && offset === 1 && limit === undefined) {
            return text(fullText);
          }
          let output = selectedLines.join("\n");
          if (isTruncated) {
            output += `\n… (truncated: showing lines ${offset}-${endLine} of ${totalLines}, total ${fullBytes.length} bytes; pass offset=${nextLine} to read more, or use action="checkout" to copy the file)`;
          }
          return text(output);
        }
        if (action === "ls") {
          const b = params?.branch ? await s.resolveBranchName(params.branch) : s.workBranch;
          const rawPath = String(params?.path ?? "/").trim();
          const rel = cleanRel(s, rawPath);
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
          return text(entries.length ? entries.join("\n") : "(empty directory)");
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
                  if (isExcludedPath(itemRel, s.config.excludes)) continue;
                  if (!s.isApplicable(itemRel)) continue;
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
              const rel = cleanRel(s, targetPath);
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

          status(ctx, describe(s));
          const copied = r.value;
          const lines = [
            `Checked out ${copied.length} file(s) from ${resolvedBranch}:`,
            ...copied.map((c) => `  ${c.path} (${c.size} bytes)`),
          ];
          return text(lines.join("\n"));
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
          status(ctx, describe(s));
          if (!r.merged) {
            return text([
              `CONFLICT merging ${other}: nothing changed (you are still on ${s.workBranch}).`,
              "Conflicting files:", ...r.conflicts.map((c) => `  ${c.path}${c.kind ? ` (${c.kind})` : ""}`),
              "How to resolve (LayerFS merges three-way, so editing only your side keeps conflicting):",
              `  1. Run with strategy: action="merge" branch="${target}" strategy="theirs" (or strategy="ours");`,
              `  2. Or inspect with action=show branch=${other} path=<file>, checkout files with action=checkout branch=${other} path=<file>, or edit your files.`,
            ].join("\n"));
          }
          recordMerge(s, other, r);
          const lwwInfo = r.lww ? (r.lwwPaths?.length ? ` (${r.lww} generated file(s) took the newer side: ${r.lwwPaths.slice(0, 5).join(", ")}${r.lwwPaths.length > 5 ? ", …" : ""})` : ` (${r.lww} generated file(s) took the newer side)`) : "";
          const fallbackInfo = (r as any).fallback ? " (via path-wise merge)" : "";
          return text(`Merged ${other}${fallbackInfo}. You are now on ${r.branch}${lwwInfo}.`);
        }
        throw new Error(`unknown action ${action}`);
      },
    } as any);

    if (!isChild) {
      pi.registerTool({
        name: "layerfs_apply",
        label: "LayerFS apply",
        description: "Write your branch's changes into the user's real project folder and advance the trunk (main), so new sessions and sub-agents start from it. Three-way checked: if a file changed in the folder meanwhile, nothing is written and the files are listed. Build output marked branch-only is never written.",
        parameters: { type: "object", properties: {}, additionalProperties: false } as any,
        async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
          if (disabled) return text("LayerFS is off for this run: your edits are already in the user's folder.");
          const s = await need();
          let r;
          try {
            r = await s.apply();
          } catch (e: any) {
            status(ctx, describe(s));
            const partial = e?.result as { applied: string[] } | undefined;
            throw new Error(`apply stopped: ${e?.message ?? e}${partial?.applied.length ? ` (already written: ${partial.applied.join(", ")})` : " (nothing was written)"}`);
          }
          status(ctx, describe(s));
          recordSession(s);
          if (r.conflicts.length) return text(`Nothing applied: these files changed in the user's folder since your branch started:\n${r.conflicts.join("\n")}`);
          return text([
            r.applied.length ? `Applied ${r.applied.length} file(s) to ${s.cwd}; main now includes your branch.` : "No source changes to write; main now includes your branch.",
            ...r.warnings.map((w) => `Warning: ${w}`),
          ].join("\n"));
        },
      } as any);
    }
  }

  pi.on("user_bash", async (_event, ctx) => {
    if (disabled) return undefined;
    const s = await need();
    return {
      operations: {
        exec: async (cmd: string, cwd: string, o: any) => {
          const r = await s.mutate("user_bash", "user_bash", () => s.exec(cmd, cwd, o));
          const note = report(ctx, s, r);
          if (note) o.onData(Buffer.from(note));
          return r.value;
        },
      },
    };
  });

  // ------------------------------------------------------------- lifecycle & tree / fork / resume

  /** Extracts the snapshot ref and session binding along a session entry chain (up to optional `stopAtEntryId`). */
  function inspectBranchEntries(entries: any[], stopAtEntryId?: string, inclusive = true) {
    let baseRef: string | undefined;
    let baseBranch: string | undefined;
    let workBranch: string | undefined;
    let project: string | undefined;
    let headCommit: string | null = null;
    for (const e of entries) {
      if (stopAtEntryId && e.id === stopAtEntryId && !inclusive) break;
      if (e.type === "custom" && e.customType === SESSION_ENTRY && e.data) {
        project = e.data.project ?? project;
        baseBranch = e.data.baseBranch ?? baseBranch;
        workBranch = e.data.workBranch ?? workBranch;
        baseRef = e.data.baseRef ?? baseRef;
      }
      if (e.type === "custom" && e.customType === CHECKPOINT_ENTRY && e.data?.commit) {
        headCommit = e.data.commit;
        workBranch = e.data.branch ?? workBranch;
      }
      if (stopAtEntryId && e.id === stopAtEntryId && inclusive) break;
    }
    return { project, baseBranch, workBranch, baseRef, headCommit };
  }

  pi.on("session_before_fork", async (event, ctx) => {
    if (disabled || !session) return;
    const branchEntries = ctx.sessionManager.getBranch();
    const info = inspectBranchEntries(branchEntries, event.entryId, event.position === "at");
    pendingForkRef = info.headCommit ?? info.baseRef ?? session.effectiveRef;
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (disabled) return;
    const s = await need().catch(() => null);
    if (!s) return;
    const info = inspectBranchEntries(ctx.sessionManager.getBranch());
    const targetRef = info.headCommit ?? info.baseRef ?? s.baseRef;
    const switched = await s.switchToRef(targetRef);
    pi.appendEntry(SESSION_ENTRY, {
      project: s.project, volume: s.volume, cwd: s.cwd,
      baseBranch: s.baseBranch, workBranch: switched.branch, baseRef: s.baseRef, headCommit: s.headCommit,
    });
    status(ctx, describe(s));
  });

  pi.on("session_start", async (event, ctx) => {
    const config = resolveConfig();
    hostCwd = ctx.cwd;
    disabled = !config.enabled || pi.getFlag("no-layerfs") === true;
    if (disabled) {
      status(ctx, "LayerFS off");
      if (ctx.hasUI) ctx.ui.notify("LayerFS isolation is OFF for this run: tools act directly on the host folder.", "warning");
      return;
    }
    if (session && event.reason === "reload") {
      status(ctx, describe(session));
      return;
    }
    const branchInfo = inspectBranchEntries(ctx.sessionManager.getBranch());
    const forkRef = event.reason === "fork" ? (pendingForkRef ?? branchInfo.headCommit ?? branchInfo.baseRef ?? null) : null;
    pendingForkRef = null;

    const s = new LayerfsSession(ctx.cwd, ctx.sessionManager.getSessionId(), config);
    session = s;
    startError = null;
    status(ctx, "LayerFS starting…");
    ready = s.open({
      reason: event.reason,
      resumeBinding: branchInfo.project ? branchInfo : undefined,
      forkFromRef: forkRef,
    }).then(() => {
      pi.appendEntry(SESSION_ENTRY, {
        project: s.project, volume: s.volume, cwd: s.cwd,
        baseBranch: s.baseBranch, workBranch: s.workBranch, baseRef: s.baseRef, headCommit: s.headCommit,
      });
      status(ctx, describe(s));
      return s;
    }, (e) => {
      startError = e;
      status(ctx, "LayerFS FAILED");
      if (ctx.hasUI) ctx.ui.notify(`LayerFS failed to start: ${e.message}\nFile tools are disabled; nothing is written to the host folder.`, "error");
      throw e;
    });
    ready.catch(() => {});
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") return;
    const s = session;
    session = null;
    const r = ready;
    ready = null;
    if (!s) return;
    await r?.catch(() => {});
    const out = await s.close().catch((e) => ({ kept: true, notes: [`close failed: ${e.message}`] }));
    status(ctx, undefined);
    if (out.notes.length && ctx.hasUI) ctx.ui.notify(`LayerFS: ${out.notes.join("; ")}`, out.kept ? "warning" : "info");
  });

  pi.on("before_agent_start", async (event) => {
    if (disabled) return undefined;
    const note = [
      "",
      "File tools and bash run on an isolated LayerFS Branch of this project.",
      `Paths under ${session?.cwd ?? "the working directory"} refer to that Branch; edits there do NOT reach the user's folder until the user runs /layerfs apply.`,
      "Files outside the working directory are read-only. Secret files such as .env are not imported.",
      "Each bash call runs in its own sandbox: background processes (`cmd &`, dev servers) end when that call ends. Start and use a server within one bash call.",
      ...(resolveConfig().team ? [
        isChild
          ? "Team mode: you work on your own branch. Use the `layerfs` tool (status/diff/sync); report your branch name from `layerfs status` when you finish. You cannot write the user's folder."
          : "Team mode: the `layerfs` tool merges other branches (e.g. sub-agents') into yours; `layerfs_apply` writes your branch into the user's folder and advances main, which new sub-agents start from.",
      ] : []),
    ].join("\n");
    return { systemPrompt: `${event.systemPrompt}\n${note}` };
  });

  // ------------------------------------------------------------- command

  const SUBCOMMANDS: Array<[string, string]> = [
    ["status", "当前分支、checkpoint 数、是否有未写回的改动"],
    ["diff", "列出本会话改了哪些文件"],
    ["history", "本会话的保存历史：每次改动、来自哪个工具、改了哪些文件（可加条数，如 history 50）"],
    ["apply", "把改动写回你的项目目录（有冲突则一个都不写；--revert 允许回退已写回的内容）"],
    ["sync", "把你在 Pi 外的改动同步进 LayerFS main（--full 全量重新校验）"],
    ["branches", "列出项目里所有 LayerFS 分支"],
    ["merge", "把另一个分支（如子 agent 的分支）合并进本会话：merge <branch>"],
    ["retry", "checkpoint 失败被锁住后重试"],
  ];
  pi.registerCommand("layerfs", {
    description: "LayerFS workspace: status | diff | history | apply | merge | retry | sync | branches",
    // Pi's editor treats Enter on an open argument menu as "apply completion" (not submit),
    // because the argument prefix does not start with "/". So once the typed argument is
    // already a complete subcommand, show no menu and let Enter submit directly.
    getArgumentCompletions: (prefix: string) => {
      const typed = prefix.trim();
      if (SUBCOMMANDS.some(([n]) => n === typed || typed.startsWith(`${n} `))) return null;
      const items = SUBCOMMANDS.filter(([n]) => n.startsWith(typed)).map(([value, description]) => ({ value, label: value, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = argv[0] || "status";
      const say = (t: string, level: "info" | "warning" | "error" = "info") => (ctx.hasUI ? ctx.ui.notify(t, level) : console.log(t));
      if (disabled) return say("LayerFS is off for this run.", "warning");
      let s: LayerfsSession;
      try { s = await need(); } catch (e: any) { return say(e.message, "error"); }
      if (sub === "status") {
        return say([
          describe(s),
          `project ${s.project} · volume ${s.volume}`,
          `branch ${s.workBranch} (alias: ${s.logicalBranch}, base ${s.baseBranch} @ ${s.baseRef.slice(0, 12)}) · head ${(s.headCommit ?? "none").slice(0, 12)}`,
          s.blocked ? `blocked: ${s.blocked.reason}` : "",
        ].filter(Boolean).join("\n"));
      }
      if (sub === "history") {
        const n = Number(argv[1] ?? 20);
        const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
        return say(formatHistory(await loadHistory(s, limit)));
      }
      if (sub === "branches") {
        const list = await s.listUserBranches();
        return say(list.map((b) => `${b.name.padEnd(20)} ${(b.logicalBranch ? `[${b.logicalBranch}]` : "").padEnd(14)} head ${(b.head ?? "-").slice(0, 12)} base ${(b.base ?? "-").slice(0, 12)}`).join("\n"));
      }
      if (sub === "merge") {
        const otherParam = argv[1];
        if (!otherParam) return say("用法：/layerfs merge <branch> [--ours|--theirs]（分支名见 /layerfs branches）", "warning");
        const strategy = argv.includes("--theirs") ? "theirs" : argv.includes("--ours") ? "ours" : undefined;
        const other = await s.resolveBranchName(otherParam);
        const r = await s.mergeBranch(other, strategy ? { strategy } : undefined);
        status(ctx, describe(s));
        if (!r.merged) return say([`Conflict merging ${other}; nothing changed. Conflicting files:`, ...r.conflicts.map((c) => `  ${c.path}${c.kind ? ` (${c.kind})` : ""}`)].join("\n"), "error");
        recordMerge(s, other, r);
        const lwwInfo = r.lww ? (r.lwwPaths?.length ? `, ${r.lww} generated file(s) took the newer side: ${r.lwwPaths.slice(0, 5).join(", ")}${r.lwwPaths.length > 5 ? ", …" : ""}` : `, ${r.lww} generated file(s) took the newer side`) : "";
        return say(`Merged ${other} into this session (now on ${r.branch}${lwwInfo}). /layerfs diff to review, /layerfs apply to write to your folder.`);
      }
      if (sub === "diff") {
        if (argv[1]) {
          const targetBranch = await s.resolveBranchName(argv[1]);
          let baseBranch = s.baseBranch;
          if (argv[2]) {
            baseBranch = await s.resolveBranchName(argv[2]);
          } else if (targetBranch !== "main") {
            const bInfo = (await s.listAllBranches()).find((b) => b.name === targetBranch);
            if (bInfo?.base) {
              baseBranch = `h-${bInfo.base.slice(0, 20)}`;
              await s.lfs.branch.fork(baseBranch, bInfo.base).catch(() => {});
            }
          }
          const all: Array<{ path: string; kind: string; type: string }> = [];
          for (let pos = 0; ; ) {
            const page = await s.lfs.branch.diff_branches(baseBranch, targetBranch, 1000, pos, { hunks: false });
            for (const it of page.items ?? []) {
              if (it.path === "/.lww" || !it.path || it.type === "dir" || hiddenPath(it.path)) continue;
              all.push({ path: it.path, kind: it.kind, type: it.type });
            }
            if (!page.hasMore || !(page.items ?? []).length) break;
            pos = page.nextPagePos ?? (pos + page.items.length);
          }
          const d = all.filter((i) => s.isApplicable(i.path));
          return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : `No changes between ${baseBranch} and ${targetBranch}.`);
        }
        const d = await applicableDiff(s);
        return say(d.length ? d.map((i) => `${i.kind.padEnd(8)} ${i.path.replace(/^\//, "")}`).join("\n") : "No changes in the LayerFS workspace.");
      }
      if (sub === "sync") {
        const res = await s.syncHostDriftIntoMain({ full: argv.includes("--full") });
        return say(res.synced.length ? `Synced ${res.synced.length} host file(s) into main: ${res.synced.join(", ")}` : "Host folder is already in sync with main.");
      }
      if (sub === "retry") {
        const r = await s.retry();
        report(ctx, s, r);
        return say(r.error ? `Retry failed: ${r.error.message}` : "Checkpoint saved; changes are unblocked.", r.error ? "error" : "info");
      }
      if (sub === "apply") {
        const allowRevert = argv.includes("--revert");
        const d = await applicableDiff(s);
        if (!d.length) return say("Nothing to apply.");
        if (ctx.hasUI && !(await ctx.ui.confirm("Apply LayerFS changes to your folder?", d.map((i) => `${i.kind} ${i.path}`).slice(0, 40).join("\n")))) return say("Apply cancelled.");
        let r;
        try {
          r = await s.apply({ allowRevert });
        } catch (e: any) {
          status(ctx, describe(s));
          const partial = e?.result as { applied: string[]; conflicts: string[] } | undefined;
          if (e?.code === "WouldRevert") return say(e.message, "warning");
          return say([
            `Apply stopped: ${e?.message ?? e}`,
            partial?.applied.length ? `Already written to your folder: ${partial.applied.join(", ")}` : "Nothing was written to your folder.",
            partial?.conflicts.length ? `Changed on disk during apply: ${partial.conflicts.join(", ")}` : "",
          ].filter(Boolean).join("\n"), "error");
        }
        if (r.conflicts.length) return say(`Nothing applied: these files changed on disk since the session started (or are directories now):\n${r.conflicts.join("\n")}`, "error");
        status(ctx, describe(s));
        return say([
          `Applied ${r.applied.length} change(s) to ${s.cwd}.`,
          r.skipped.length ? `Skipped (never applied): ${r.skipped.filter((p) => !hiddenPath(p)).join(", ") || "git metadata"}` : "",
          ...r.warnings.map((w) => `Warning: ${w}`),
          s.unapplied ? "Changes made while applying are still pending: run /layerfs apply again." : "",
        ].filter(Boolean).join("\n"), r.warnings.length ? "warning" : "info");
      }
      return say([`未知子命令 "${sub}"。可用：`, ...SUBCOMMANDS.map(([n, d]) => `  /layerfs ${n.padEnd(9)} ${d}`)].join("\n"), "warning");
    },
  });
}
