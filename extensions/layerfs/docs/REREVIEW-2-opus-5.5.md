# bac985a 复审结果（只看本次修复，没有运行测试）

## 1. 上一轮问题逐项结论

| 项 | 结论 | 说明 |
|---|---|---|
| **N1** 命令进程逃逸 / reapHolders 找不到进程 | **已解决** | 外层 runner 现在用 `unshare -m -p -f --kill-child --mount-proc` 起命令，sid 文件里记的是 unshare 进程的 pid。命令正常结束或者被 SIGKILL 时，PID namespace 的 init 进程退出，内核会杀掉 namespace 里的所有进程，`&`、`nohup`、`setsid` 都逃不出去。exec 里也不再调用 reapHolders。传播模式改成 `slave`，宿主机侧的卸载会传进来。kill 失败时 `keepMounted` 加 `blocked`，不会在命令还在跑的时候 commit 或卸载。<br>还剩一个小问题，见 P2-1。 |
| **N2** apply 写到一半失败不标记 stale | **已解决** | catch 里只要已经写过文件，就调用 `setMainStale(true)`。 |
| **N3** 别的会话把 stale 清掉 | **已解决** | apply 不再清 stale。增量 sync 也不清。只有 full sync 成功时才清，包括 full sync 发现没有变化、直接返回的那条路径。 |
| **N4** 心跳覆盖新持有者 | **基本解决** | 心跳前先比对 token。`lost` 的 getter 每次都实时读 owner。写 owner 改成 tmp 加 rename。`guard()` 加在每个文件写入前和两处 publish 前。<br>还剩一个读 token 和写 owner 之间的窄窗口，见 P2-3。 |
| **N5** 两个回收方的竞态 | **已解决** | 回收改成先拿 `.reclaim` 子锁（mkdir），挪锁前再核对一次 token。我推演了 B 回收后、mkdir 之前 C 插进来的情况：C 读到的 owner 为空，和它之前看到的 token 不符，会放弃。 |
| **N6** WouldRevert 漏判 | **已解决（有一处待确认）** | 改成正向判定：base 是 Commit 时，它必须出现在快照的历史里；base 是 Layer 时，快照的所有 Commit 都必须落在这个 Layer 上。出错时拒绝 apply。“回退后又编辑”的情况会被拒。<br>**待确认：** 这依赖 `list_commits(forkBranch)` 会沿着祖先往回列。旧代码也做了同样的假设，所以大概率没问题。 |
| `.lww` 加 `.git/` | **已解决（新项目）** | 只在新建 `.lww` 时写入。已有项目不会自动补上，见 P2-5。 |
| **P1-17** cwd 外的密钥 | **已解决** | 按 home 相对路径匹配，`.docker/config.json` 这类带 `/` 的模式现在能生效。`abs` 和 `realpath` 两者都要检查，最后读的是 `real`，堵住了软链绕过。 |
| **P1-16** 排除规则 / brace | **已解决** | 由 JS 算文件清单，rsync 用 `--files-from --from0` 照单复制，不会再有两套模式语法不一致。brace 统一展开。`ci()` 不再改坏 `[...]`。 |
| runner 覆盖竞态 | **已解决** | 文件名带内容哈希，先写 tmp 再 `mv`，已经存在就跳过。 |
| P2 遗留：`PI_LFS_EXCLUDES` 被 `options.env` 覆盖 / 用逗号分隔 | **已解决** | 现在排在 `envArgs` 之后，并且改用换行分隔。 |

## 2. 本次修复引入的新问题

**P0 / P1：无。**

**P2（最多 5 条）：**
1. **取消命令时没有真正的“优雅退出”。** util-linux 的 `unshare -f` 父进程通常会屏蔽或忽略 SIGTERM，不会转发给子进程，所以 `killSession` 发的 TERM 很可能没有效果。结果是每次取消都要等满 `killGraceMs`，再走 SIGKILL。不影响正确性。建议 TERM 直接发给 namespace 里的 init（`sh`）；或者在 sid 文件里记 init 的 pid，用来发 TERM。
2. **行为变化：后台进程不能跨命令存活。** 比如先 `npm run dev &`，下一条命令再 `curl`，这种 agent 常见的写法现在行不通了。这是 N1 修复的代价，本身是合理的，但需要写进文档或工具描述里，告诉 agent。
3. **锁心跳还有一个窄窗口。** 心跳在“读到 token 还是自己的”和“写 owner”之间不是原子的，可能把新持有者的 `owner.json` 覆盖掉，导致新持有者被误判为丢锁。另外，丢锁后 catch 路径仍然会在不持锁的情况下写 hostIndex 和 stale 标记。要同时满足“进程冻结超过 30 秒”和“时序恰好交错”才会触发，后果只是多做几次 sync 和多出警告。
4. **`baseIsCommit` 会把查询出错的结果缓存下来。** 一次 docker 偶发错误会被缓存成“base 是 Layer”，之后本会话的每次 apply 都报 WouldRevert，而且提示用户加 `--revert`，有误导性。建议出错时不缓存，报错也和 WouldRevert 区分开。
5. **init 和迁移的小问题：**
   - `listImportable` 不会跳进排除目录本身：像 `node_modules/` 这种以 `/` 结尾的模式，在目录这一层不命中，所以会遍历整个 `node_modules`，大仓库 init 很慢。
   - 空目录不导入，目录权限也会丢。
   - 扫描到复制之间如果有文件被删，rsync 返回 24，init 会直接失败。
   - 已有项目的 `.lww` 没有补上 `.git/`。
   - home 本身是软链时，按 home 相对路径的匹配可能失效。建议对 `homedir()` 也取一次 `realpath`。

## 3. 结论

**单用户、本地、多会话的场景下，可以日常使用。** 上一轮的 P1（N1～N6）都已经修掉，失败路径现在都是“出错时拒绝”或者“标记后由下次全量 sync 恢复”，没有发现会静默丢数据或写坏宿主机文件的路径。

上线前建议：
- 实际跑一次“取消正在运行的命令”和“后台进程”两个场景，确认 P2-1 的 TERM 行为和 `--kill-child` 在目标镜像的 util-linux 版本上可用；
- 跑一下 `npm run test:fixes`；
- 在文档里写明“后台进程不能跨命令存活”。