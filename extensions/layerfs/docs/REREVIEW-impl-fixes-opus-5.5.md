# HEAD `7762801` 复审报告（只看本次修复）

**结论：** 这次修复堵上了大部分原有漏洞。但还有三处要先处理：
- **exec 的 mount namespace 让 `reapHolders` 找不到命令进程**，这是本次修复引入的回退，见新问题 N1。
- **main 落后于宿主机的问题没有完全闭环。**
- **锁的回收逻辑还有一个竞态。**

我没有运行测试，结论都来自读代码。

## 一、逐项结论

| 项 | 结论 | 理由 |
|---|---|---|
| **P0-1** apply 进 mutex，固定快照 | **是** | `apply()` 已挂到 `this.mutex` 链上。diff、读取、新 base 的 fork 都基于同一个 `snapRef`，期间新增的改动会让 `unapplied` 保持为真。有个小问题：`a-*` 分支一直不删，泄漏。确认框里的 diff 是不是同一份快照，我没核对 index.ts。 |
| **P0-2** main 发布失败 | **部分** | publish 或 merge 失败时会设 `mainStale`，下次全量拿 `mainIndex()` 和宿主机比对，这部分是对的。还有三个缺口：<br>① **apply 写到一半失败时不设 `mainStale`**，hostIndex 却已逐个更新（见 N2）；<br>② **别的会话发布成功后会把 `mainStale` 清掉**（见 N3）；<br>③ 原报告指出的根因“publish/merge 包含 `.git/**`”没有处理。并发会话的 merge 在 `.git/index` 上仍然几乎必然冲突，结果是 `mainStale` 和警告成了常态。 |
| **P0-3** 项目锁 | **部分** | pid 存活判定、心跳续期、异步等待都对。但心跳不检查锁还归不归自己，两个回收方之间也还有竞态（见 N4、N5）。 |
| **P1-1** 写前复查 | **是** | 写之前重新调用 `hostState` 比对。哈希和 rename 之间仍有一个很小的窗口，可以接受。 |
| **P1-2** 中途失败 | **部分** | 逐个持久化 hostIndex、清理 tmp、扫描时忽略 `.pi-layerfs-`、向用户返回已写清单，这些都做了。缺的是：**没有设 `mainStale`**。 |
| **P1-3** 目录挡路 | **部分** | 删除从深到浅、写入从浅到深，文件变目录的情况可以了。反过来**目录变文件永远判为冲突**：宿主机上那个目录（即使里面的文件都在待删列表里）会被 `hostState` 判成 `"other"`，用户只能手动删目录。 |
| **P1-4** 权限位 | **是（待确认）** | `sameSig` 比较 `mode & 0o111`，宿主机和目标版本之间的对比是对的。需要确认 `readSigAtBranch` 返回的 base 签名带不带 mode。如果不带，宿主机上单独 `chmod` 不会被判为冲突。 |
| **P1-5** sync 吞错误 | **是** | `fs.apply` 不再 catch，`dexec` 检查返回码，发布成功之后才写 hostIndex。小问题：`sync-*` 和 `r-*` 分支泄漏。 |
| **P1-6** 读目录失败当成删除 | **是** | strict 模式下只有 ENOENT 当作空目录。代价是：一个读不了的目录或文件（EACCES）会让会话**启动失败**，报错应该提示用户把它加进 excludes。 |
| **P1-7** init 扫描顺序 | **是** | 改成对 staging 副本建索引。 |
| **P1-8** 两次读取 | **是** | 扫描时读到的 bytes 和计算签名共用同一份。 |
| **P1-10** 项目命名竞态 | **是** | 起名放进全局 `_init` 锁，拿锁后再查一次 `byFolder`。 |
| **P1-11** replaceAll | **是** | 字符串替换去掉了（只剩测试用的 `sh()` 还改参数）。但这个修法引入了 N1。 |
| **P1-12** 取消竞态 | **部分** | 注册监听后补查 `aborted`，sid 文件最多重试 5 秒，都对。还剩：killSession 失败时的兜底 `child.kill()` 只杀本地 docker 客户端，**容器里的命令照样在跑**，之后照常 commit 和 unmount；`stopping` 被缓存后也不会重试。 |
| **P1-15** grep 注入 | **是** | flags、pattern、目标路径都通过 argv（`"$@"`）传，前面有 `-e` 和 `--`，安全。 |
| **P1-16** 排除规则统一 | **部分** | JS 侧统一成一个匹配函数。`rsyncExcludeArgs` 还有两处语义偏差：<br>① `posix.matchesGlob` 支持 `{a,b}`，rsync 不支持。用户配 `*.{pem,key}` 时，JS 侧认为已排除，rsync 却在 init 时把密钥导进了 Store；<br>② `ci()` 会把 `[a-z]` 改坏成 `[[aA]-[zZ]]`。 |
| **P1-17** cwd 外的密钥 | **部分** | `OUTSIDE_SECRET_PATTERNS` 里含 `/` 的模式被当成**从根锚定**：`.docker/config.json` 和 `.config/gh/` 对 `/Users/x/.docker/config.json` **永远不生效**。也没有 `realpath`，例如 `/tmp/a` 这个软链指向 `~/.ssh/id_rsa` 就能绕过。`access`、`exists`、`readdir` 在 cwd 外不做过滤，只泄漏“文件存不存在”，属于小问题。 |
| **#26** WouldRevert | **部分** | 只检查“head 是不是 base 的祖先”。**`/tree` 回退后又做了新编辑**，head 就不再是 base 的祖先，于是不报错，apply 会一边回滚已应用的内容一边写新改动。另外，`isAncestorOfBase` 在 catch 里返回 false（出错时放行），而且最多只查 2000 条 commit。 |

## 二、修复引入的新问题

### P1

**N1 `exec` 的进程用 `reapHolders` 再也找不到了（回退）**
- **位置：** `workspace.ts` 的 `exec`、`reapHolders`，以及 `pi-lfs-run.sh`。
- **原因：** 命令在自己的私有 mount namespace 里运行，cwd 实际是 `this.cwd`（宿主机路径）。内核对 `/proc/<pid>/cwd` 的 readlink 结果是按那个 namespace 拼出来的路径，所以是 `/Users/.../proj`，而 `reapHolders` 拿来比的是 `ws.path`，**永远对不上**。
- **触发：** `cmd &`、`nohup`、`setsid`、守护进程化等写法都会让进程逃出 `pkill -s`。以前这些进程按 cwd 能被杀掉，现在全部漏掉。
- **后果：**
  - commit 前那次 reap 没有效果。后台进程在 commit 时还在写，快照可能是半截的。
  - propagation 是 private，宿主机侧 unmount 不会报 EBUSY，所以看起来“成功”。泄漏的进程继续写一个已经卸载的工作区，**写入静默丢失**，挂载或 overlay 也一直被占着。如果 SDK 会复用 upper 目录，后果更难预料（待确认 SDK 的挂载类型）。
  - 不能简单改成按 `this.cwd` 匹配：同一项目的所有会话在各自 namespace 里都是这个路径，会误杀其它会话的进程。
- **建议：** 首选 `unshare -m -p -f --kill-child --mount-proc`（同时开 PID namespace），runner 一退出所有后代都会被杀。退一步的做法：在 runner 里由 root 把 `readlink /proc/self/ns/mnt` 记进 sid 文件，reap 时用 root 遍历 `/proc/*/ns/mnt` 按 namespace 匹配。

**N2 apply 中途失败时 main 会永久落后于宿主机**
- **位置：** `applyLocked` 的 catch。
- **原因：** 已写的文件已经进了 hostIndex，但没有设 `mainStale`。
- **触发：** 写入中途失败，用户之后放弃这个会话。
- **后果：** 下次增量 sync 认为“没有漂移”，新会话会基于缺了这些文件的 main 工作，和 P0-2 是同一种后果。
- **建议：** 在 catch 里调用 `setMainStale(name, true)`。

**N3 别的会话发布成功会清掉 `mainStale`**
- **位置：** `applyLocked` 发布成功后的 `setMainStale(false)`。
- **触发：**
  1. 会话 A 已写回宿主机，但 publish 失败，`stale` 被设为 true；
  2. 会话 B 的 apply 发布成功，把 `stale` 清成 false，而 B 的内容里不包含 A 的文件；
  3. 之后 hostIndex 和宿主机一致，A 的文件永远进不了 main。
- **建议：** apply 永远不清 stale，只在全量 sync 成功时清；或者改成记录 stale 的代数或会话，只由同一会话清除。

**N4 锁被回收之后，原持有者的心跳会覆盖新持有者的 owner.json**
- **位置：** `lock.ts` 的 `tryAcquire` 里的 `write`。
- **触发：** A 停顿超过 30 秒（笔记本合盖休眠、事件循环卡住），B 回收后拿到锁。A 醒来后定时器继续执行 `writeFileSync`（把 owner 改成 A 的 token）和 `utimes`。
- **后果：** A 和 B 同时在临界区里；B 的 `release()` 因为 token 不符不会删锁；之后的第三方看到心跳很新，一直等待。
- **建议：** 每次心跳前先读 owner，token 不是自己的就停止心跳并标记“锁已丢失”。`withProjectLock` 在关键写入（hostIndex、publish）之前检查这个标记，丢锁就中止。owner.json 改成先写临时文件再 rename。

**N5 两个回收方之间仍有竞态**
- **位置：** `acquireLock` 里的 `isStale`，以及 `tryReclaim`。
- **触发：**
  1. B 和 C 都判定旧锁陈旧；
  2. B 先 rename 走旧锁，再 mkdir 拿到新锁；
  3. C 这时才执行 rename，挪走的是 **B 的新锁**，接着 C 也 mkdir 成功；
  4. 两边同时持锁。
- **建议：** rename 之后读出被挪走目录里的 owner，如果不是自己判定陈旧时看到的那一个（比较 token），就放回去或者放弃；或者用一个 `.reclaim` 子锁把回收串行化。

**N6 WouldRevert 漏掉“回退后又做了新编辑”的情况**
- **位置：** `isAncestorOfBase`，见上表 #26 一行。
- **建议：** 改成正向判定：`baseRef` 必须是 `snapRef` 的祖先（`list_commits(snapBranch)` 里包含 `baseRef`），否则一律 WouldRevert。查询出错时拒绝 apply，而不是放行。

### P2

- **runner 覆盖竞态（`ensureRunner`）：** 两个不同版本的 Pi 进程共用同一个 Sandbox 时，`cat >` 会先把文件截断。恰好这时启动的 exec 读到空脚本，**退出码 0、没有输出**，看起来像成功了。建议先写临时文件再 `mv`，文件名带内容哈希。
- **`--propagation private`：** 长时间运行的命令会占住它 unshare 那一刻已存在的所有挂载，包括其它会话的工作区，宿主机侧卸载不会传播进来。建议改成 `slave`。
- **`mount --bind` 不是递归的：** 如果 `ws.path` 下面还有子挂载要用 `--rbind`（待确认 SDK）。另外，`mkdir -p "$root"` 落在容器共享的 rootfs 上，cwd 很浅时（`/`、`/tmp`、`/usr/...`）会遮住容器里的系统目录，建议拒绝这类 cwd。
- **runner 退出码 125：** 和用户命令自己返回的 125 分不开。Sandbox 缺 `CAP_SYS_ADMIN` 时，每条命令都会以 125 失败（失败时拒绝，安全），但报错不够清楚。
- **`PI_LFS_EXCLUDES` 用逗号分隔：** `*.{a,b}` 这类模式会被拆坏。这个变量还会传给用户命令。`options.env` 里以 `PI_` 开头的键排在后面，会覆盖它。
- **每次 exec 都按每条排除规则跑一遍 `git ls-files`：** 大仓库会慢；`update-index` 还会改 `.git/index`，加重 `.git` 的 merge 冲突。
- **全量 sync 两侧的过滤规则不一样：** `mainIndex` 只跳过根目录的 `.lww`，宿主机扫描则跳过任何深度的 `.lww` 和名字里含 `.pi-layerfs-` 的文件。main 里如果有这样的文件，全量 sync 会把它当成“已删除”。
- **分支泄漏：** `a-*`、`m-*`、`r-*`、`sync-*`、旧的 `b-*` 分支都没有清理。

## 三、专项检查

1. **pi-lfs-run.sh 的引号和注入：安全。**
   - 外层是 `sh -c '…' _ "$ws" …`，内层是 `sh -c "…" "$cmd" "$root"`。所有值都作为位置参数传进去，转义后的 `\$1` 和 `\$0` 在第二层展开，没有把值拼进脚本文本。
   - 最后执行 `bash -c "$0"`，`$0` 就是 cmd，本来就是要执行的内容。
   - `$pat` 只出现在双引号里的 pathspec 里，来源是用户配置，不受 agent 控制。
   - `.git/config` 里的 `core.fsmonitor` 等配置会被 runner 里的 git 执行，但运行身份和用户命令是同一个 uid，不会提权。
   - `setpriv` 降权以后能力集被清空，命令没法 remount。
   - `$$`：`unshare` 没有 `--fork`，它和后面的 `setpriv`、`bash` 都是 exec 下去的，pid 一直不变，所以 sid 正确。

2. **mount namespace 下 `reapHolders` 还能找到进程吗：找不到。** 见 N1。

3. **lock.ts 的 token、续期、回收：**
   - token 只在 `release` 时检查，心跳不检查（N4），回收存在双重回收竞态（N5）。
   - owner.json 不是原子写入。但读到半截 JSON 时会回退为看心跳年龄，而心跳很新，所以不会误判陈旧，影响很小。
   - `acquireLockSync` 最多空转 10 秒，比 30 秒的陈旧阈值短，可以接受。

4. **applyLocked 失败路径的状态：**
   - 冲突时提前返回、WouldRevert、读阶段失败：宿主机和状态都不变，只泄漏 `snapBranch`。没问题。
   - 写到一半失败：hostIndex 已部分更新，base 没推进，下次重试时已写的文件判为 unchanged，可以继续。但 **main 不会被标记为 stale**（N2）。
   - publish 失败：base 推进了，`mainStale` 设为 true，没问题。但这个标记可能被别的会话清掉（N3）。

**建议的修复顺序：** N1 → N2/N3 → N4/N5 → N6 → 把 `.git/**` 排除出 publish/merge → P1-17 的锚定和软链问题 → P1-16 的 brace 问题。