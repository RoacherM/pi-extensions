# pi-layerfs v0.2 实现审查报告

审查范围：`src/workspace.ts`、`src/index.ts`、`src/bindings.ts`、`src/history.ts`、`src/port/{client.ts,binding.js,worker.mjs,call.mjs}`、`src/box.js`，另查了 SDK 的 merge/publish 签名。全程只读，没有改任何文件。

读取次数到了上限，`workspace.ts` 的行号没法逐条核对，所以下面用函数名加关键代码片段定位。标“需确认”的条目，我还没核实相关的 SDK 或 Pi 行为。

---

## P0

### P0-1 `apply()` 没有进入 mutation 队列，并发的改动会被静默丢弃
- **位置**：`workspace.ts` `apply()`：`if (this.blocked) …; await this.mutex; return this.bindings.withProjectLock(...)`
- **问题**：`await this.mutex` 只等待当前队尾，`apply` 自己并不在 `this.mutex` 链上。在 `withProjectLock` 内部 `await` 期间，agent 的 bash、write、edit 仍可以继续往 `workBranch` 提交。另外快照不一致：
  - `diff()` 先算出 `items`，之后才 `withMountedBranch(this.workBranch…)` 挂载**当时最新**的 head。
  - 结尾用 `fork(nextBase, this.headCommit ?? this.baseRef)` 推进 base。此时 `headCommit` 可能已被中途的 `finalizeCheckpoint` 更新。
- **触发**：agent 还在跑工具时，用户执行 `/layerfs apply`；或确认对话框打开期间 agent 又写了文件。
- **后果**：新改动没写到宿主机，baseBranch 却已推进到包含它的 commit。下次 diff 看不到这处改动，等于静默丢失。
- **修复**：整个 apply 放进 `this.mutex` 链，和 `mutate` 用同一种写法。开始时固定 `snap = headCommit`：diff、读取、推进 base 都基于 `snap`；挂载读取时 fork 一个指向 `snap` 的临时分支。

### P0-2 合并或发布 main 失败被吞掉，main 会永久落后于宿主机
- **位置**：`apply()` 中的 `try { diff_branches("main"…); merge; publish } catch { }`
- **问题**：
  - 宿主机已落盘，`writeHostIndex(hostIndex)` 也已执行。之后 merge 或 publish 失败（包括 `Unknown`、冲突、锁竞争）都被吞掉，用户看到的是“Applied”。
  - 下次启动时 `syncHostDriftIntoMain()` 对比的是 `hostIndex`，与宿主机一致，判定“无漂移”，所以 **main 永远不会被修正**。之后新会话的 baseBranch 和 workBranch 都从旧 main 分出，agent 会基于过期代码工作。
  - `branch.merge` 的返回值也没有检查是否有冲突或部分合并。
- **加剧因素（几乎必然触发）**：发布内容包含 `.git/`。两个会话只要都跑过 `git status`，就都会改 `.git/index`，merge 在 `.git/index`、`.git/logs/*` 上必然冲突（`.lww` 只 `%include .gitignore`）。因此并发会话场景下这条失败路径是常态。
- **修复**：
  - 失败时不要写 hostIndex，或在 manifest 里记录 `mainRef`/`mainStale=true`；下次 sync 强制全量对比 main 与宿主机，并在 UI 上报警。
  - publish 和 merge 前排除 `.git/**`，或在 `.lww` 里给 `.git/**` 设 LWW 规则。
  - 检查 merge 结果。

### P0-3 项目锁会在 15 秒后被抢走，且回收逻辑本身有竞态
- **位置**：`bindings.ts` `acquireDirLock()`、`withProjectLock()`
- **问题**：
  1. 只要锁目录的 mtime 超过 15 秒就视为陈旧并 `rmdir`，但持锁期间从不续期。`initProjectForFolder`（rsync 大仓库）、`syncHostDriftIntoMain`（大量文件）、`apply`（读写大量文件、merge、publish）都可能超过 15 秒，锁会被另一个进程**合法地抢走**。
  2. 回收存在竞态：A、B 同时判定陈旧，A `rmdir` 后 `mkdir` 成功，B 随后的 `rmdir` 删掉的是 A 刚建的锁，两边同时进入临界区。
  3. `Atomics.wait` 会阻塞事件循环，最长 60 秒。同一进程里如果一个 `/layerfs sync` 正在持锁并 await I/O，另一处再去拿锁，持锁方无法推进，只能等 15 秒后锁被“回收”，变成两边并发。
- **后果**：两个 apply 都判定 `mainUnchanged`，先后 publish 各自的 workBranch，后发布的覆盖先发布的，main 丢掉一方的改动。hostIndex 也是读-改-写，会丢更新。结果与 P0-2 相同：main 静默落后于宿主机。
- **修复**：锁文件里写入 `pid + 进程启动时间 + hostname`，按“持有者进程是否还活着”判定陈旧，或持锁期间定期 `utimes` 续期；回收改成 rename 方式；用异步 `setTimeout` 轮询代替 `Atomics.wait`。

### P0-4（需确认）`!cmd` 的 fail-closed 依赖 Pi 的异常处理
- **位置**：`index.ts` 的 `pi.on("user_bash")` 中 `const s = await need();`
- **问题**：LayerFS 启动失败或尚未就绪时，handler 会抛异常。`runner.emitUserBash` 会重新抛出，`interactive-mode.js:5861` 的 `try { … } catch { … }` 接住了它，但我没读到 catch 分支的内容。如果 catch 之后回落到本地执行，`!rm -rf …` 就会直接作用在宿主机上，fail-open。
- **修复**：不要依赖异常。`need()` 失败时返回 `{ result: { output: "LayerFS failed…", exitCode: 1 } }`，或返回一个直接报错的 `operations.exec`。

---

## P1

### apply / 落盘
1. **检查与写入之间没有复查（TOCTOU）**（`apply()`）：冲突判定在挂载读取阶段完成，真正 rename 时不再比对宿主机。两者之间用户在编辑器保存的内容会被覆盖。**修复**：写入每个文件前重新计算 `signatureOfHost`，不一致就中止并报告冲突。
2. **中途失败没有任何补偿**：
   - for 循环里任何 `mkdir`、`writeFile`、`rename` 抛错（权限、磁盘满、类型冲突）都会让已写的文件留在宿主机，hostIndex 不保存，base 不推进。
   - 临时文件 `*.pi-layerfs-xxxx` 可能残留，下次 `scanHostDirectory` 会把它当成新文件**同步进 main**。
   - **修复**：每写一个文件就更新并持久化 hostIndex；在 catch 里清理 tmp；扫描时忽略 `.pi-layerfs-*`；向用户返回“部分已写入”的清单。
3. **类型变化（文件↔目录）没有处理**：
   - 宿主机上是目录、计划要写文件时，`signatureOfHost` 对目录返回 `null`；对 Added 项 `sameSig(null, null)` 为真，会被当作“未改动”放行，随后 rename 报 EISDIR，导致部分写入。
   - 文件改成目录时，plan 顺序可能先处理 `a/b`（mkdir 失败），后处理 `a` 的 Removed。
   - 删除文件后会留下空目录。
   - **修复**：宿主机上非文件、非软链的路径一律判为冲突；按“先删除（深→浅），后写入（浅→深）”的顺序排列 plan。
4. **`sameSig` 忽略 mode**：只改权限的变化（如 `chmod +x`）在 want 和 host 对比时被判为 unchanged，永远不会落盘；宿主机侧 chmod 也不算冲突。**修复**：签名里加入 `mode & 0o111`。

### syncHostDriftIntoMain()
5. **错误被吞，残缺结果仍被发布**：
   - `fs.apply(...).catch(async () => …)` 吞掉所有错误，包括 `Unknown`（可能其实已提交）；`fs.rm(...).catch(() => {})`。
   - mountJobs 里 `dexec` 的返回码**完全没检查**（例如 `rm -rf`、`ln -s`、`cat >` 失败）。
   - 之后照常 publish，再 `writeHostIndex(curr)` 标记为已同步，造成永久漂移。
   - **修复**：检查每一步结果，失败时不写 hostIndex，整体报错。
6. **扫描错误被当成删除**：`scanHostDirectory` 中 `readdir(...).catch(() => [])`。子目录权限不足、EMFILE 或扫描瞬间被 rename，都会让整棵子树被判为 removed，并在 main 里**批量删除**。**修复**：只有 ENOENT 才视为空目录，其它错误中止 sync。
7. **初始化时 rsync 与扫描的顺序有竞态**（`initProjectForFolder`）：先 rsync 进 staging，后 `scanHostDirectory`。两步之间被修改的文件，hostIndex 记录的是新签名，Store 里存的是旧内容，之后永远检测不到。**修复**：先扫描再 rsync，或 rsync 之后基于 staging 计算签名。
8. **扫描期间宿主机仍在修改**：签名用第一次读取，写入 Store 用第二次 `readFile`，两次内容可能不同。按 mtime 下次还能发现，但 hostIndex 里的 sig 与 main 的内容不一致。**修复**：一次读出 bytes，sig 和写入共用。
9. **mtime+size 缓存会漏检**：`cp -p`、`rsync -t`、`tar x`、部分 IDE 的“保留时间戳”保存，会导致漂移检测不到。至少要在 `/layerfs sync` 时提供全量哈希选项。
10. **项目命名竞态**：`freeProjectName` 在锁外调用，锁按名字加。两个 basename 相同的目录同时首次启动时会拿到同名 project，`addProject` 互相覆盖。**修复**：拿到锁后重新确认名字，或用全局锁。

### exec()
11. **`command.replaceAll(this.cwd, ws.path)` 会损坏内容**：
    - 命令里出现的宿主机路径字面量全部被替换，包括 heredoc、`echo`、`sed`、配置文件内容。apply 后宿主机文件里会写进 `/…/ws-xxx` 这样的容器路径，属于静默数据损坏。
    - 前缀会误伤：cwd 为 `/a/proj` 时，`/a/proj-old/x` 也被替换。
    - 输出里出现容器路径，agent 拿这个路径去调 read/write，会遇到 ENOENT 或写入被拒。
    - **修复**：在容器里让工作区出现在与宿主机 cwd **相同的路径**（per-exec mount namespace、bind 或软链），去掉字符串替换。
12. **取消/超时有竞态**：
    - abort 监听在 mount 和 spawn 之后才注册，期间触发的 abort 会丢失。
    - `killSession` 读不到 sid 文件（脚本还没执行 `echo $$`）时 `exit 0`，而 `stopping` 已被缓存，之后的 kill 都变成 no-op，命令会**无视超时或取消一直跑完**。
    - **修复**：注册监听后检查 `signal.aborted`；sid 不存在时重试，或在 `killSession` 结束后 `stopping = null`；兜底直接 `child.kill()`。
13. **`checkSandbox` 误判**：只要退出码是 1、125 或 126，并且 stderr 里出现 “is not running” 就抛出 `SandboxGone`（例如用户命令 `systemctl status x`）。这一抛跳过了 commit，finally 里的 `unmount(ws)` 可能丢弃本次改动。**修复**：先 `docker inspect` 确认容器状态再判断；任何情况下都先尝试 commit。
14. **多个挂载共用同一工作区与 reapHolders（需确认 SDK 语义）**：读路径（`readBytesViaMount`、`isDirectory`、`exists`、正则 grep）不在 mutex 内，会和正在运行的 bash 同时挂载 `workBranch`。如果 SDK 对同一分支返回同一个 `ws.path`，或拒绝重复挂载，读路径结束时的 `reapHolders` 加 `unmount` 会 **kill 掉正在运行的 bash** 并卸载工作区。另外：
    - 所有会话在共享容器里使用同一个 uid；
    - `case "$c" in ${wsPath}|…` 里的 wsPath 没有转义 glob 字符；
    - 只按 cwd 判定，fd 持有者杀不掉，导致 unmount 静默失败、挂载泄漏。
    - **修复**：读路径 fork 临时分支（`r-*`）后再挂载；reap 按 sid 或进程组判定。
15. **grep 存在 shell 注入**（`grepWorkspace`）：`flags.map((f) => \`'${f}'\`)`，其中 `--include=${g}` 来自 agent 传入的 `params.glob`，含 `'` 就能逃逸，例如 `glob: "x';kill -9 -1;'"`。命令在共享容器里以同一 uid 执行，可以杀掉其它会话的进程。**修复**：flags 作为 `"$@"` 参数传入，不要拼接字符串。

### 文件工具
16. **`isExcludedPath` 与 rsync 的语义不一致**：初始化用 rsync `--exclude`（含 `/` 的模式锚定在根，`dir/` 表示目录），之后 sync 用 `matchesGlob(basename)||matchesGlob(rel)`。
    - 结尾带 `/` 的目录模式在 JS 侧永远匹配不上，被排除的目录在**第一次 sync 时就会被导入 main**。
    - `config/*.key` 这类模式在 rsync 侧会匹配嵌套路径，JS 侧只匹配根目录。
    - APFS 默认大小写不敏感，`.ENV` 能绕过 `.env*`。
    - **修复**：统一成一个实现，rsync 用 `--exclude-from` 和同一份规则，或初始化也走 JS 扫描后再 `--files-from`。
17. **cwd 外的读取没有任何过滤**：`readFile`、`readdir`、`exists` 在 `!sp` 时直接读宿主机，`~/.ssh/id_rsa`、隔壁项目的 `.env` 都能读到。设计上说“cwd 外只读”，但密钥文件至少要套用 excludes。
18. **`readBytesAtRef` 的回退**：长度校验可以兜住大部分情况。但如果 SDK 对非 UTF-8 字节做替换，替换后字节数又恰好相同，就会返回损坏的内容（概率低）。建议直接按 `st.size` 走字节读取接口，或对比 hash。
19. **`writeFile` 走 `fs.apply`（需确认 SDK）**：
    - 覆盖已有可执行文件时 mode 是否保留，需要确认；如果重置为 0644，`edit` 一个脚本就会丢掉 +x，而且 P1-4 让 apply 也发现不了。
    - 链尾是指向工作区外绝对路径的软链时，挂载路径的 `cat >` 会写到容器内的其它位置，不会进 commit，但工具仍返回成功。
20. **`Unknown` 被当作普通失败**：`writeFile` 遇到 `Unknown` 时没有 checkpoint，`headCommit` 也不更新。resume 时 `(wb.head ?? wb.base) === targetRef` 不成立，会从旧 commit 重新 fork，这次可能已经提交的写入就丢了。**修复**：遇到 `Unknown` 时重新 `list_branches` 校准 head，或进入 blocked 状态。

### 共享状态 / port
21. **`ensureStoreBox` 的自愈逻辑会误删别人的容器**（`box.js` `start()`）：worker 版本或 build 标签不一致时会直接 `docker rm -f` Store 容器。两个 Pi 进程装着不同版本的扩展时（升级的那一刻），双方会互相删除、重建，所有在途调用都变成 `Unknown`，`onUnreachable` 还会持续触发重建。**修复**：按版本区分容器名，或版本不一致时拒绝启动而不是删除。
22. **Docker 端点可能不一致**：`box.js` 固定用 `-H unix:///var/run/docker.sock`，而 `workspace.ts`（`config.docker`）、`binding.js`、`connectBoxSocket` 用的是默认 context。在 Colima、Podman、自定义 context 下会连到不同的 daemon。另外两个进程首次并发 `docker run --name` 时，后者会失败（fail-closed，但启动报错）。
23. **binding.js 的 Failed/Unknown 判定**：greeting 之前是 Failed，之后是 Unknown，语义正确。但 worker 在调用方断开后会继续执行（`socket.on("error", () => {})`），对 `Unknown` 应引导用户核对，而不是像 P0-2、P1-20 那样吞掉。

### index.ts 生命周期
24. **reload 泄漏旧会话**：`session_shutdown` 遇到 `reason === "reload"` 直接 return。如果 reload 会重新实例化扩展模块（闭包里的 `session` 变回 null），`session_start(reload)` 会再 `new LayerfsSession` 并复用同一个 workBranch。旧实例的挂载、连接、仍在运行的 bash 都没有关闭，两个实例各持一个 mutex，**并发提交同一分支**。**修复**：模块级 `globalThis` 注册表，reload 时复用或先关闭旧实例。
25. **`switchToRef()` 直接丢弃 `blocked.heldWs`**：没有 commit 也没有 unmount，就把 `this.blocked = null`。commit 失败后保留挂载的那份 bash 改动会被静默丢弃，挂载也泄漏。`retry()` 也不在 mutex 内，可能与 mutate 交错。
26. **`/tree` 回到 apply 之前的节点后，下一次 apply 会回滚宿主机**：baseBranch 仍是 apply 之后的状态，workBranch 回到旧 commit，diff 会显示“把刚 apply 的内容改回去”。host==base 不算冲突，于是直接写入。用户只是想“看看历史”，结果确认 apply 就把文件改回去了。**修复**：switchToRef 时如果目标早于 base，要明确提示；或者在 apply 确认框里标出“将回退已应用的改动”。
27. **fork 拿不到 ref 时会共用父会话的分支**：`forkRef` 为 null（父会话分支上没有 checkpoint 或 session entry，且 `pendingForkRef` 为空），而 `resumeBinding` 又存在时，`setupBranches` 会走“复用 saved workBranch”分支，父子两个会话写同一个分支。**修复**：`reason === "fork"` 时一律新建分支。
28. **apply 后没有追加 `SESSION_ENTRY`**：会话日志里的 `baseRef` 还停在 apply 之前，`/resume` 和 `/tree` 用 `resumeBinding` 恢复时 base 会回退，又会出现 P1-26 的问题。

---

## P2

- **分支泄漏**：`r-*`（每次读历史 ref 都新建）、`b-*`（每次 apply）、`m-*`、`sync-*`、`h-*` 都不回收；`bindings.sessions` 无限增长；每个 checkpoint 都整体重写 `bindings.json` 并加锁。
- **history.ts**：`appliedCommits` 假设 `list_commits(baseBranch)` 会包含继承来的 commit，而且只取 100 条；`switchToRef` 之后新分支没有自己的 commit，历史显示为空。`pinBranch` 用 20 位前缀命名，存在理论上的碰撞。
- **工具契约**：正则 grep 的 `--include` 只匹配 basename，而 Pi 的 glob 是路径语义，`src/**/*.ts` 在字面量模式和正则模式下结果不同。`findFiles` 和字面量 grep 不遵守 `.gitignore`（Pi 原生工具遵守），会搜出 dist、build 产物。
- **`gitHidePrelude`**：没有发现注入。`q()` 正确转义了 `'`，excludes 来自本地配置，脚本作为 `bash -c` 的 `$0` 以 argv 传入。剩下的问题：
  - `ls-files` 默认 `core.quotePath`，非 ASCII 文件名会带引号，`[ -e "$2/$f" ]` 判断失效；
  - 工作区目录属主与 ident 不一致时，`safe.directory` 会让 git 静默拒绝；
  - 改动的 `.git/index` 会被提交并发布，加剧 P0-2。
- **`killSession`**：sid 文件放在共享的 `/tmp`，同一 uid 的其它会话可以篡改，再由 root 执行 `pkill -s` 误杀。sid 文件应放到 root 拥有的目录。
- **敏感信息出现在命令行**：`-e K=V` 让 envAllow/PI_* 变量出现在宿主机 `ps` 里；`DSH_BOX_SECRET` 通过 `docker run -e` 传入，`docker inspect` 可见。后者对能访问 docker.sock 的人无意义，可以接受，但要写进文档。
- **manifest**：写入不 fsync；损坏时返回 `{}`，触发全量重新同步（不丢数据，但慢）。
- **其它体验问题**：`before_agent_start` 在启动失败时仍注入“已隔离”的提示词；`/layerfs apply` 确认框里的 diff 可能与实际执行的不同（P0-1 修复后自然解决）；sync 把大文件整个读进内存再经 IPC 传输；rsync 把整个 `.git` 拷进 Store。

---

## 建议优先修复的前 5 项

1. **把 apply 放进 mutex 并固定 commit 快照**（P0-1）。diff、读取、推进 base 都基于同一个 commit，否则会静默丢改动。
2. **main 推进失败不能吞**（P0-2）。失败时不写 hostIndex，或标记 `mainStale`，下次强制全量校正并告警。publish/merge 排除 `.git/**`，或给它设 LWW 规则；检查 merge 结果。
3. **重写项目锁**（P0-3）。基于持有者进程是否存活（或续期）判定陈旧，修复回收竞态，用异步等待代替 `Atomics.wait`。
4. **加固 apply 落盘和 sync 的错误处理**（P1-1 到 P1-6）。
   - apply：写前逐文件复查签名，签名加入 mode，宿主机上的目录或特殊文件判为冲突，按“先删后写”排序；中途失败时持久化已写部分并清理 tmp。
   - sync：检查 dexec 和 rm 的结果；readdir 只有 ENOENT 才视为空目录。
5. **修复 exec 和 grep 的安全与正确性问题**（P1-11、P1-12、P1-15）。去掉 `replaceAll(cwd, ws.path)`，改为让工作区在容器里出现在与宿主机相同的路径；grep 参数通过 `"$@"` 传递；修复 abort/timeout 竞态。另外请尽快确认 P0-4（`!cmd` 的 fail-closed）。