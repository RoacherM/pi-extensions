# `pi-layerfs` v0.2 设计与改造文档（含 Opus 5.5 架构审查修复）

状态：**v0.2 实施规范（已合入 `REVIEW-v0.2-opus-5.5.md` 全部 P0/P1 修复）**  
基线：LayerFS `5fb68dd` + Pi 1.2.0

---

## 1. 升级目标与设计原则

将 `pi-layerfs` 从 v0.1（每会话独立拷贝建库 + 全工具常驻挂载 `docker exec`）升级为对齐官方 `dsh × layerfs` 的 v0.2 架构：

1. **单日常驻 Store 容器 + 一次性 Init 容器**（移植自 `dsh/packages/host/src/port/` 与 `box.js`）：
   - Mac 侧通过 `LAYERFS_NATIVE` 指向 `src/port/binding.ts`，把原装 `@layerfs/sdk` 的底层调用通过本地回环 TCP（4B 长度头 + `v8.serialize` 帧 + 32B 密钥握手）转发给常驻容器 `pi-lfs-store`。
   - `project.init` 单独启动一次性 `docker run --rm` 容器并只读挂载 staging 目录，常驻 `pi-lfs-store` 绝不挂载用户源码目录。
2. **同目录多会话共享同一个 Project Store**：
   - 通过带目录锁的 `bindings.json` 管理“宿主机目录 ↔ Project Store”映射。
   - 第一次进入目录执行一次 `project.init`；后续新窗口、并行会话、`/fork`、`/tree` 全部在同一个 Store 内毫秒级 `branch.fork`。
   - **会话启动漂移同步（修 P0-6）**：若宿主机目录在会话外发生了编辑或 `git pull`，启动时自动将宿主机增量同步进 Store 并推进 `main`，避免新会话基于过期代码工作。
3. **文件工具直走 Store + 字节级安全兜底（修 P0-2、P0-5、P1-1～P1-4）**：
   - `read` / `write` / `edit` / `ls` 优先直调 `lfs.fs.*`（1～5 ms，不启动 Sandbox）。
   - **严防 `fs.read` 超长行截断破坏 `edit`（修 P0-2）**：每次 `fs.read` 校验 `!lineTruncated && Buffer.byteLength(text, "utf8") === size`；一旦遇到超长行截断、二进制（`Binary`）或软链接，立即回退到短挂载 Workspace 读取原始字节 `Buffer`。
   - **`fs.write` 自动创建父目录并保留权限/软链语义（修 P0-5、P1-3、P1-4）**：通过 `fs.apply([{ op: "mkdir", path: parent }, { op: "write", path, content }])` 原子创建父目录并写入；源码确认 `fs.write` 覆盖已有普通文件会保留原 `mode`（如 `0755`），遇到软链（`NotFile`）或目录中含软链时自动回退到短挂载写入。
   - **`grep` / `find` 精确兼容 Pi 契约（修 P1-1、P1-2）**：
     - `find`：基于 `fs.list` 在 Store 树上递归遍历（天然在目录层跳过 `.git` 和 `node_modules`，无需启动 Sandbox），并在客户端用 `path.posix.matchesGlob`（支持花括号展开与 `subPath` 相对匹配）过滤。
     - `grep`：由于 `fs.grep` 仅支持字面量且不跳过 `node_modules`，当 pattern 为纯字面量且无 `ignoreCase`/`context` 时可用 `fs.grep`（过滤 `.git` 与 `node_modules`），含正则/忽略大小写/上下文时使用短挂载运行 GNU `grep -P`。
4. **`bash` 按需短挂载 + 无全局软链污染（修 P0-3）**：
   - 每次 `bash`（及 `!cmd`）执行 `workspace.mount(workBranch) → docker exec (setsid) → workspace.commit → workspace.unmount`，跑完立刻卸载（~2 ms），彻底消除常驻挂载与 2s 预热。
   - **禁止在 Sandbox 容器内建全局软链 `ln -sfn /workspaces/N <cwd>`（修 P0-3）**：同一 Sandbox 容器可同时挂载 16 个工作区，全局软链会导致并发会话跨分支串写。改为通过 `-w <wsPath>` 进入工作区，并在命令字符串中将宿主机 `cwd` 前缀替换为本次挂载的 `ws.path`。
5. **每会话独立 `baseBranch` 锚点 + Merge-then-Publish（修 P0-1、P0-4）**：
   - 每个会话创建两个分支：**基线锚点分支 `baseBranch`（`b-<id>`）** 与 **工作分支 `workBranch`（`s-<id>`）**。
   - `/layerfs diff` 与 `/layerfs apply` 永远比较 `diff_branches(baseBranch, workBranch)`（只提取**本会话自己**做过的修改，绝不与动态变化的 `"main"` 直接 diff）。
   - 每个变更文件的基线指纹 `baseSig` 直接从 `baseBranch` 快照读取计算，不依赖可被其他会话改写的全局 manifest。
   - **完整冲突判定表（修 P0-1、P0-4）**：
     - 匹配 `excludes`（如 `.env`、`*.key`）或 `.git/**` 的路径一律跳过，绝不覆盖宿主机敏感文件；
     - `Added`：若宿主机上该路径已存在且 `hostSig !== wantSig` → **冲突**；
     - `Modified` / `Removed`：若 `hostSig !== baseSig` 且 `hostSig !== wantSig` → **冲突**。
   - **推进 `main` 时先合并再发布**：落盘成功后，在项目锁内检查 `"main"` 是否仍等于 `baseBranch`；若其他会话已推进 `"main"`，先执行 `branch.merge("main", workBranch, mergedBranch)` 再 `branch.publish(mergedBranch)`，最后把本会话的 `baseBranch` 更新到当前 `workBranch` 快照。
6. **完整支持 Pi 的 `/resume`、`/tree`、`/fork`、`/reload`（修 P1-5）**：
   - 每个分支的 `effectiveRef = headCommit ?? baseRef`（解决刚 fork 尚未产生 Commit 时 `head === null` 的问题）。
   - `/tree` 与 `/fork` 执行前先等待 `mutate` 互斥队列排空，按目标节点绑定的 `effectiveRef` 毫秒级 `branch.fork` 出新工作分支。

---

## 2. 与 LayerFS 交互的完整协议与流程

### 2.1 `src/port/`：Mac 到 `pi-lfs-store` 容器的桥接协议

```text
Pi 进程 (macOS)
  import("@layerfs/sdk")  ──LAYERFS_NATIVE──▶  src/port/binding.ts
                                                    │
         ┌──────────────────────────────────────────┴───────────────────────────┐
         │ op === "project.init"                                                │ 其他所有 op
         ▼                                                                      ▼
  一次性容器 docker run --rm -i                                    常驻容器 pi-lfs-store (127.0.0.1:port)
  (-v <staged>:<staged>:ro, port/run.mjs)                          (port/worker.mjs, 60s Store 连接池)
```

- **容器标签与自愈**：`pi-lfs-store` 带 `--restart unless-stopped` 及 `layerfs.worker=<hash>`、`layerfs.build=<hash>`、`layerfs.home=<home>` 标签。若未启动或端口不可达，`ensureBox()` 自动启动并写入 `home/.layerfs-store.json`（`{ box, port, secret }`）。
- **帧协议**：4 字节大端长度 + `v8.serialize(payload)`。首帧发送 `{ secret }`，收到 `{ id: 0, answer: { value: "hello" } }` 后发送 `{ id, fn, op, args, open }`。
- **断线处理**：握手前断线返回 `Failed` 并触发自愈；握手后断线返回 `Unknown`（不自动重试）。

### 2.2 项目初始化与宿主机漂移同步（Host → Store）

```text
session_start(cwd)
  └── bindings.acquireLock()
        ├── 情况 A：cwd 尚未绑定 Project（或卷已删）
        │     1. APFS clone (cp -c -R) 或 rsync 到 staging，剔除 excludes (.env 等)
        │     2. 写入 staging/.lww ("%include .gitignore\n")
        │     3. 生成 hostIndex (relPath -> { kind, sig, mode, mtimeMs, size })
        │     4. docker volume create + 一次性容器 project.init(staging)
        │     5. 记录 project 到 bindings.json
        │
        └── 情况 B：cwd 已绑定 Project
              1. 扫描当前宿主机文件（mtimeMs + size 命中缓存则免算 sha256）
              2. 对比上次同步的 hostIndex：
                 • 若无差异 (0 ms)：直接使用当前 "main"
                 • 若有外部增删改：
                   a. fork("sync-<ts>", "main")
                   b. 普通文本/二进制增删通过 fs.apply 批量提交到 sync 分支
                   c. 若含 symlink 或可执行位变更，短挂载 sync 分支同步后 commit
                   d. branch.publish("sync-<ts>") 推进 "main"，更新 hostIndex
```

### 2.3 会话分支模型（`baseBranch` + `workBranch`）

每个会话维护：
- `baseRef: string`：本会话分叉时的 Layer ID 或 Commit ID（`/tree`、`/fork` 跳回尚无 Commit 的起点时使用）。
- `baseBranch: string`（`b-<sessionShort>-<seq>`）：指向本会话基线（或上次成功 `apply` 后的位置）的锚点分支。
- `workBranch: string`（`s-<sessionShort>-<seq>`）：当前读写与挂载的工作分支。
- `headCommit: string | null`：`workBranch` 上的最新 Commit ID（无修改时为 `null`，此时 `effectiveRef = baseRef`）。

### 2.4 工具调用与 LayerFS SDK 的精确映射

| Pi 工具 | 与 LayerFS 的交互路径 | 关键边界保护 |
|---|---|---|
| `read` | 调 `fs.stat(workBranch, p)` + 循环分页 `fs.read(workBranch, p, line)`；校验 `!lineTruncated && byteLength === size` | 若报 `Binary`、`lineTruncated` 或路径含 symlink，自动走 `withWorkspace` 用 `cat` 读原始 `Buffer` |
| `write` | 在 `mutate` 队列内：若路径不含 symlink 且新文件无需特殊可执行位，调 `fs.apply(workBranch, [{op:"mkdir", path:dir}, {op:"write", path:p, bytes}], msg)` | 若 `fs.apply` 报 `NotFile`/`NotDirectory`（路径上有 symlink），自动回退到 `withWorkspace` 写入 + `commit` |
| `edit` | 先通过上面的无损 `readFile` 拿原始字节，用 Pi 的 `createEditTool` 完成匹配替换，再通过上面的 `writeFile` 原子写回为 1 个 Commit | 因 `readFile` 已对 `lineTruncated` 做字节校验兜底，超长行文件绝不会被截断写回 |
| `ls` | 直调 `fs.stat(workBranch, p)` + 分页 `fs.list(workBranch, p, 1000, pos)` | 若路径含 symlink 回退到 `withWorkspace` |
| `find` | 用 `fs.list` 从子目录根递归遍历（目录层直接跳过 `.git` 和 `node_modules`），客户端展开 `{a,b}` 并用 `matchesGlob` 匹配相对路径 | 0 容器开销，且完全对齐 Pi `find` 的子目录与花括号语义 |
| `grep` | 纯字面量且无 `-i`/上下文时直调分页 `fs.grep`（跳过 `.git`/`node_modules`）；正则、`-i` 或带上下文时走 `withWorkspace` 跑 `grep -P` | 100% 兼容正则表达式、忽略大小写与上下文行 |
| `bash` / `!cmd` | 在 `mutate` 队列内：`ws = workspace.mount(workBranch)` → `docker exec setsid`（命令内替换 `cwd` 为 `ws.path`）→ `workspace.commit(ws)` → `reapHolders` → `workspace.unmount(ws)` | 即使命令非零退出或被 abort，仍先 commit（或拉闸保留）再清理卸载 |
