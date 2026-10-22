# `pi-layerfs v0.2` 架构审查报告

> 审查对象：`DESIGN-v0.2.md`（基于 LayerFS `5fb68dd` 与 `dsh/packages/host`）
> 审查范围：多会话写回一致性、宿主机漂移、`fs.*` 与 Pi 工具契约的差距、Sandbox 共享、网络拓扑、会话树边界
> 说明：本次没有拿到 `FINDINGS.md` 原文。第 7 点按设计文档中的矛盾和 Docker Desktop 的已知行为推断，结论需要对照实测记录确认。

---

## 0. 总体结论

v0.2 的“存、算、控分离”方向是对的：文件工具直通 Store、按需短挂载、聊天节点绑定 Commit。但设计里有一个前提和 LayerFS 的真实语义不一致：

**设计默认 `main` 是所有会话共同、稳定的基线，并且等于宿主机的状态。**

实际情况是：

- `branch.publish` 用整棵树覆盖 `main`，不做合并。
- `manifests/<project>.json` 是全项目共享的，并且会被最后一次 apply 改写。
- 宿主机会在 Pi 之外持续变化。

所以三方比对用到的 `base`（main、manifest、宿主机）在多会话下是三个互相漂移的量，比对会**失效而不报错**。另外，`fs.read`、`fs.write`、`fs.grep`、`fs.glob` 与 Pi 原生工具的契约差距会造成**内容被截断后写回**和**结果为空却不报错**。

| 级别 | 数量 | 代表问题 |
|---|---|---|
| **P0** | 6 | apply 与 publish 静默回滚、edit 截断长行、Sandbox 软链让工作区串写、`.env` 等排除文件被覆盖、写入时丢可执行位、宿主机漂移导致基线错位 |
| **P1** | 10 | grep 与 glob 契约不符、父目录与 symlink 语义、网络模式、`head:null`、`/tree` 与 bash 竞态、manifest 无锁写入等 |
| **P2** | 8 | 分支 GC、apply 中断恢复、端口漂移、观测性等 |

---

## P0：致命缺陷

### P0-1　多会话下 `apply` 与 `branch.publish` 静默回滚别人的写回（审查点 1）

**问题描述**

`/layerfs apply` 有三个问题叠加：

1. 用 `diff_branches("main", branch)` 计算改动。这里的 `main` 是**当前**的 main，而不是本会话 fork 时的 base。
2. `baseSig` 来自**共享且会被改写**的 `manifests/<project>.json`。
3. apply 之后用 `publish(branch)` 整树覆盖 `main`。

在“会话 A 和会话 B 都从 L1 fork”的场景下，B 的分支树里**没有 A 的改动**。overwrite 语义的 diff 会把 A 的改动当成“B 要撤销的改动”。同时 manifest 已被 A 更新，宿主机也已是 A 的内容，于是 `hostSig === baseSig` 成立，冲突检查判定“用户没手改”，直接放行。

**触发过程推演**

```text
初始：main@L1，宿主机 = L1，manifest = L1 指纹
A、B 都 fork 自 L1

A: 修改 src/x.ts (x1→x2)，新增 src/new.ts
A: /layerfs apply
   diff(main@L1, A)       → x.ts Modified, new.ts Added
   宿主机写入 x2、new.ts
   manifest[x.ts]=sig(x2)，manifest[new.ts]=sig(new)
   publish(A)             → main@L2 = A 的树

B: 只修改了 src/y.ts
B: /layerfs apply
   diff(main@L2, B) 整树比较：
     y.ts    Modified  (B 的真实改动)
     x.ts    Modified  (L2 中是 x2，B 中还是 x1)   ← 伪改动
     new.ts  Removed   (L2 有，B 没有)             ← 伪改动
   三方比对：
     x.ts:   hostSig=sig(x2), baseSig=sig(x2) → 相等 → "用户没改" → 写入 x1
     new.ts: hostSig=sig(new), baseSig=sig(new) → 相等 → 删除宿主机 new.ts
   publish(B) → main@L3 = B 的树，A 的成果在 main 里也消失
```

最终结果：A 写回宿主机的内容被**静默回退和删除**，main 也被覆盖。整个过程没有任何冲突提示。

**修复方案**

1. **diff 的基准改为本会话自己的 base**：用 `diff_branches(<fork 时的 baseRef 或上次成功 apply 的 commit>, branch)`，只拿“本会话自己做过的改动”。不要和当前 main 比较。
2. **`baseSig` 改为按 commit 计算，不再读共享 manifest**：直接从 Store 读 `baseRef` 快照里对应文件的内容来求指纹，或者把 manifest 改成按 commit 存储（`manifests/<project>/<commitId>.json`，内容不可变）。
3. **publish 前必须先跟上当前 main**：
   - 如果 main 已从 `baseRef` 前进，先把当前 main 合并进会话分支（用 LayerFS 的 merge 能力，`.lww` 规则就是为它准备的；冲突交给用户处理），或者直接拒绝 apply，提示用户先执行 `/layerfs sync`。
   - `publish` 必须做 CAS：带上 `expectedMainHead`。如果 LayerFS 没有提供，就在下面第 5 条的项目锁内先比对 `list_branches().main.head`，一致才 publish。
4. **补全判定表**，下面任意一行不满足就视为冲突：

   | branch 变更 | 宿主机状态 | 处理 |
   |---|---|---|
   | Modified / Removed | `hostSig === baseSig` | 写入或删除 |
   | Modified | `hostSig === newSig` | 跳过 |
   | Added | 宿主机不存在 | 写入 |
   | Added | 宿主机存在且 `≠ newSig` | **冲突** |
   | Removed | 宿主机已不存在 | 跳过 |
   | 类型变化（文件 ↔ 目录 ↔ symlink） | — | 一律视为冲突，人工确认 |

5. 整个 apply 流程（diff → 比对 → 落盘 → manifest → publish）放在**项目级锁**内执行（见 P1-9）。

---

### P0-2　`edit` 基于被截断的 `fs.read` 结果写回，截断长行并丢失数据（审查点 3）

**问题描述**

`fs.read` 遇到单行超长时只返回前缀，标记 `lineTruncated: true`，并且 `nextLine` 直接跳到下一行，没有续读同一行的接口。设计里的 `edit` 流程是“`read` 拼全文 → 在内存中替换 → `fs.write` 写回整份内容”。这会把每一条超长行**永久截断成前缀**，然后提交成一个“合法”的 Commit。

**触发过程推演**

```text
dist/bundle.min.js 共 3 行，其中第 2 行 900 KiB
edit 修改第 1 行的 "foo"→"bar"
  fs.read(1..)    → 第 1 行完整；第 2 行只返回前缀，lineTruncated=true，nextLine=3
  继续读取第 3 行，拼成 text（第 2 行只剩前缀）
  在内存中替换第 1 行
  fs.write(newContent) → Committed
结果：第 2 行丢失约 850 KiB，文件损坏
apply 时 hostSig === baseSig 成立，损坏文件被原子写回宿主机
```

同类风险还包括 `package-lock.json`、`pnpm-lock.yaml` 中的超长行、内联 SVG 或 base64、单行 JSON 等。另外，如果分页循环漏判 `truncated`，或者 48 KiB 边界正好落在多字节 UTF-8 字符中间，也会损坏内容。

**修复方案**

1. **硬性约束**：凡是会作为 `fs.write` 输入的内容，只要读取过程中出现过 `lineTruncated`，或分页结果不完整，就**禁止写回**。
2. **edit 的首选路径**：用服务端原子替换。用 `fs.edit` 或 `fs.apply([{ op:"edit", path, oldText, newText }...])` 让 Store 端精确匹配，长行不会经过客户端截断。
3. **模糊匹配需要全文时，必须走原始字节通道**：先尝试 SDK 的整文件字节读取接口（如果存在）；否则 `mount` 后 `cat` 读出原始 Buffer，在 Pi 端做匹配，再 `fs.write`。
4. **写前校验**：记录读取时的 `snapshot` 或 head，写入时校验 head 没有变化（类似乐观锁）；再校验写回后的 `byteLength` 与“原长度 + 替换差值”一致。
5. `read` 工具展示给模型的内容在截断处要明确标注，例如 `[行被截断，共 N 字节]`，避免模型据此再写回。
6. `fs.read` 抛出 `Binary`（非 UTF-8，例如 Latin-1 文件）时，edit 也要走原始字节通道，不能直接失败或按文本处理。

---

### P0-3　同一 Sandbox 内的全局软链 `ln -sfn` 被并发覆盖，导致跨分支串写（审查点 6）

**问题描述**

`ln -sfn /workspaces/N <宿主机cwd>` 修改的是容器的**全局文件系统**。同一项目的多个会话，或同一会话里并行的 `bash` 调用，会挂载到同一个容器的不同 `/workspaces/N`，但共用同一个 `<cwd>` 软链。

**触发过程推演**

```text
会话 A：mount → /workspaces/1；ln -sfn /workspaces/1 /Users/you/repo
会话 B：mount → /workspaces/2；ln -sfn /workspaces/2 /Users/you/repo   ← 覆盖 A 的软链
A 正在执行 `make` 或 `sed -i /Users/you/repo/src/x.ts`（脚本里写的是绝对路径）
  → 实际写入 /workspaces/2，也就是 B 的工作区
A commit /workspaces/1 → 缺少自己的改动
B commit /workspaces/2 → 混入 A 的改动
```

后果：两条分支都被污染，checkpoint 绑定的快照与对话不符。apply 时还会把 A 的改动当作 B 的写回。另外，A 结束后的 `finally` 清理可能删掉 B 正在使用的软链。

**修复方案**

1. **每次 exec 使用私有挂载命名空间**（推荐）：
   ```sh
   docker exec ... unshare -m --propagation private sh -c \
     'mkdir -p "$CWD" && mount --bind /workspaces/N "$CWD" && cd "$CWD" && exec setsid -w bash -c "$CMD"'
   ```
   这需要容器具备 `CAP_SYS_ADMIN`，或者改用 `bwrap --bind /workspaces/N $CWD`。绑定只在这个进程树内可见，并发之间完全隔离。
2. 如果拿不到相应权限，就**放弃“绝对路径可用”这个承诺**：只 `cd /workspaces/N`，并设置 `PWD`、`PI_PROJECT_ROOT`。在工具描述里告诉模型使用相对路径。
3. 作为兜底，同一 `(容器, cwd)` 上的 exec 做**进程间串行化**：在宿主机加锁，例如 `bindings.lock` 同级的 `exec-<project>.lock`。代价是失去并发。
4. 附带修正两点：
   - `/tmp/pi-lfs-<tag>.sid` 的 `tag` 必须包含 `sessionId + toolCallId`。
   - unmount 前的“杀残留进程”只能按本次 SID 或本工作区 cwd 精确匹配，不能误杀其他会话的进程。
   - 文档里“跑完立刻卸载（除非有后台常驻进程）”和“杀干净后卸载”互相矛盾，需要明确采用哪种策略。

---

### P0-4　被排除的敏感文件（`.env` 等）会被 apply 静默覆盖

**问题描述**

staging 阶段排除了 `.env`、`*.pem`、`*.key`，manifest 中也不会有这些文件的记录。模型或 bash 在分支里新建 `.env` 时，diff 结果是 `Added`。现有判定规则只写了“`hostSig !== baseSig` 为冲突”，而 `baseSig` 为空（undefined）时的行为没有定义。实现上很容易落到“没有基线 → 直接写入”。

**触发过程推演**

```text
宿主机有真实的 .env（含生产密钥），被排除，没有进入 Store
bash 执行 `cp .env.example .env` → 分支中新增 .env
apply：.env 是 Added，baseSig 为空，hostSig 有值
  若实现为“没有基线就写入” → 真实 .env 被示例内容覆盖
```

**修复方案**

1. 判定表里明确：`Added` 且宿主机已存在且内容不同 → 冲突（见 P0-1 的判定表）。
2. 排除列表中的路径在 apply 阶段**一律跳过并给出提示**，无论 diff 结果是什么。
3. 在 manifest 中记录 `excluded: true`，供 diff 和 apply 统一过滤。

---

### P0-5　`fs.write` 默认 0644，会冲掉已有文件的可执行位，并随 apply 写回宿主机（审查点 4）

**问题描述**

`fs.write` 不支持设置权限位，默认 0644。如果它在**覆盖已有文件**时也重置为 0644（需要验证），那么对 `scripts/*.sh`、`gradlew`、`bin/*` 做一次 edit，就会让文件失去 `+x`。apply 阶段设计里会执行 `chmod`，于是宿主机文件也会变成 0644。

**触发过程推演**

```text
edit scripts/build.sh（原权限 0755）
  → fs.write → 新 Commit 中该文件为 0644
bash ./scripts/build.sh → Permission denied
/layerfs apply → 写临时文件 + chmod 0644 + rename → 宿主机脚本失去可执行位
```

**修复方案**

1. 先写测试确认 `fs.write` 覆盖已有文件时是否保留原有权限位。
2. 如果不保留：
   - 写入前用 `fs.stat` 取得 mode。
   - 如果原文件权限不是 0644，改用 `fs.apply`（如果支持 mode 字段），或者在一次短挂载里执行 `chmod` 并 commit，使“写入 + 恢复权限”属于同一次工具调用。
3. apply 阶段只有在 branch 的 mode 与 base 的 mode **确实不同**时才执行 `chmod`。mode 也纳入三方比对。

---

### P0-6　宿主机在会话外变更导致 `main` 过期，产生“幽灵改动”和基线错位（审查点 2）

**问题描述**

新会话直接从 Store 中旧的 `main` fork，宿主机上的 `git pull`、`git checkout`、编辑器修改都不会自动同步进来。后果有三层：

1. 模型基于旧代码推理、修改和测试，bash 跑出来的结果与宿主机实际状态不符。
2. apply 时，凡是本会话碰过、宿主机也改过的文件都会报冲突。这一点是好的，但会大面积误报，比如 checkout 之后几乎全部冲突。
3. 结合 P0-1：一旦用户把 manifest 或 main “修好”，例如有人 apply 并 publish 了一份旧树，宿主机上更新的内容就可能被当成“未改动”而被覆盖。如果 manifest 被其他会话写成旧内容的指纹，旧代码也可能被写回宿主机。

**触发过程推演**

```text
昨天：init，main@L1 = 宿主机 commit C1
今天：用户 git pull → 宿主机 = C5（大量文件变化，新增 src/feat.ts）
新会话 fork main@L1：Store 中看不到 feat.ts，模型重新实现一份“feat.ts”
apply：feat.ts Added，宿主机已存在
  若没有 P0-4 的判定规则 → 覆盖用户 pull 下来的版本
  若有该规则           → 冲突，但模型的整轮工作已建立在过时代码上
```

**修复方案**

1. `session_start` 时做**漂移检测**：
   - 快速信号：比对 `git rev-parse HEAD` 与 `git status --porcelain` 的哈希，以及 manifest 中记录的 `hostHead`。
   - 慢速信号：遍历 `mtime + size`，只对可疑文件计算哈希。
2. 检测到漂移时执行 **host → Store 同步**：
   - 在项目锁内，从 main fork 出 `import-<ts>` 分支。
   - 用 `fs.apply` 批量写入或删除漂移的文件。
   - CAS 方式 publish 为新的 main，并更新 manifest，记录新 commit 与 `hostHead`。
   - 漂移量过大时（例如超过 30% 的文件，或者切换了 git 分支），改为重新 `project.init`。
3. 新会话**在同步完成之后**再 fork。已有会话通过 `/layerfs sync` 显式把新 main 合并进自己的分支。

---

## P1：重要缺陷

### P1-1　`fs.grep` 是字面量匹配，Pi 的 `grep` 是正则，导致“查不到”却不报错（审查点 5）

**问题**：模型传入 `foo\(.*\)`、`^export`、`a|b` 这类模式，会被当成字面量，返回空结果。模型会据此得出“代码里没有”的错误结论。另外，`fs.grep` 不跳过 `node_modules` 和 `.gitignore` 中的路径，在大仓库里很快打满 `limit`，真正的结果被挤掉；Pi `grep` 的 `ignoreCase`、上下文行数、`glob` 过滤参数也都没有对应实现。

**推演**：`grep("useState\\(")` 用字面量查找 `useState\(`，0 条结果 → 模型重写已有逻辑。

**修复**：

1. 模式里没有正则元字符时，直接走 `fs.grep`。
2. 否则从正则中提取最长的字面量作为预筛条件，用 `fs.grep` 拿到候选行，再在客户端用 JS RegExp 精确过滤。实在提取不到字面量时，降级为短挂载执行 `rg`。
3. 默认按 `.gitignore` 加 `node_modules` 过滤，与 ripgrep 的行为一致。
4. 用 `hasMore` 分页取满结果，并在客户端实现上下文行和忽略大小写。

### P1-2　`fs.glob` 语义不一致：不支持花括号展开，且 `subPath` 不会改变匹配基准（审查点 5）

**问题**：

- `**/*.{ts,tsx}` 返回空结果。
- 传入 `subPath="src"` 加 `*.ts` 时，pattern 仍然针对仓库根路径匹配，结果为空或与预期不符。
- gitignore 语义中，不带 `/` 的模式可以匹配任意深度，和 fd 或 glob 的语义也不同。

**修复**：

1. 客户端先做花括号展开，拆成多个 pattern 并对结果去重。
2. 把 `subPath` 拼接进 pattern（`/<subPath>/<pattern>`），或者先按 `subPath` 前缀过滤，再对相对路径做匹配，使匹配基准与 Pi `find` 一致。
3. 不带 `/` 的 pattern 在客户端统一改写成 `**/<pattern>`，明确采用 fd/glob 语义，不再依赖 gitignore 的“任意深度”隐式规则。
4. 和 grep 一样，默认排除 `.gitignore` 与 `node_modules`，并补齐测试：花括号、`subPath`、无斜杠模式、隐藏文件各覆盖一个用例。

### P1-3　`fs.write` 遇到父目录不存在时返回 `NoSuchPath`，且丢失权限位与 symlink 语义（审查点 3）

**问题**：

- Pi `write` 的约定是自动创建父目录。`fs.write("src/new/a.ts")` 在 `src/new` 不存在时直接失败，模型会反复重试或改用 bash `mkdir`，绕过 Store。
- 覆盖写入时不保留原文件 mode，`chmod +x` 过的脚本被改回 `0644`，物化后执行报 `Permission denied`。
- 目标是 symlink 时，`fs.write` 替换掉链接本身，而不是写入链接指向的文件；与宿主文件系统行为相反。

**推演**：模型编辑 `scripts/build.sh`（`0755`）→ 物化 → CI 调用失败，且 diff 只显示 mode 变化，难以定位。

**修复**：

1. 写入前对父路径逐级 `stat`，缺失的用 `fs.mkdir -p` 语义补齐（放进同一 `fs.apply` 批次，保证原子性）。
2. 覆盖写入默认继承原 entry 的 mode；新建文件用 `0644`，显式传入时才覆盖。
3. 对 symlink 先解析到最终目标（限制跳数，防环），写目标文件；目标越出项目根时拒绝并报错。

### P1-4　`fs.read` / `fs.stat` 不跟随 symlink（审查点 3）

**问题**：读取 symlink 返回的是链接文本（目标路径字符串），`stat` 报告类型为 `symlink`。工具层把它当文件内容交给模型，模型看到的是一行路径；monorepo 中 `packages/*/node_modules/@scope/x -> ../../x` 这类结构全部失真。

**修复**：

1. `read`/`stat` 默认跟随（等价 `stat` 而非 `lstat`），提供 `noFollow` 选项给 `ls` 之类需要展示链接的场景。
2. 解析时检测环与越界，越界返回明确错误而不是静默返回链接文本。
3. `ls` 输出中标注 `-> target`，让模型知道这是链接。

### P1-5　`/tree`、`/fork`、`/resume` 遇到 `head: null` 以及与 `mutate` 队列的竞态（审查点 4）

**问题**：

- 会话在第一次写入之前 `head` 为 `null`。`/fork` 直接用 `head` 作为 base，得到 `null`，新分支变成空树；`/tree` 渲染时报错。
- `mutate` 是异步队列。`/fork` 或 `/resume` 在队列未排空时读取 `head`，拿到的是旧 commit，最近几次写入在新分支里“消失”；`/resume` 切换分支时队列中的待写操作还会落到错误分支上。

**推演**：模型连续 `edit` 三次后用户立刻 `/fork` → 新分支缺最后一到两次修改 → 两个分支看似分叉却实为丢数据。

**修复**：

1. 定义 `effectiveHead = head ?? sessionBase`（会话创建时 fork 的 main commit），所有命令只读 `effectiveHead`。
2. `/fork`、`/resume`、`/tree` 先 `await mutateQueue.drain()`，再读取 head；队列条目绑定 `branchId`，切换分支后旧条目仍写入原分支或被拒绝，绝不跨分支落地。
3. 补一个并发测试：写入未完成时触发 `/fork`，断言新分支包含全部写入。

### P1-6　共享 `manifest` 无锁并发写入（审查点 6）

**问题**：多个 Pi 会话（或会话加 `/layerfs sync`）同时读改写 `manifest.json`，后写者覆盖先写者：新分支记录丢失、`main` 指针回退，孤立的 commit 之后被 GC 回收。

**修复**：

1. 所有 manifest 写入走项目级锁（`proper-lockfile` 或 `flock`），锁内执行“读取 → 修改 → 写临时文件 → `rename`”。
2. `main` 指针更新改成 CAS：携带期望旧值，不匹配则重读重试或提示用户 sync。
3. 会话私有状态（各自分支的 head）拆到 `sessions/<id>.json`，只在 publish 时触碰共享 manifest，缩小冲突面。
4. GC 只回收所有 manifest 与 session 文件都不再引用、且超过宽限期的 commit。

---

## P2：改进建议

### P2-1　`bash` 短挂载的开销与一致性
每次 bash 调用都完整挂载/物化代价高。建议缓存最近一次物化目录，按 commit diff 增量更新；bash 结束后用 `mtime` 扫描回收改动，而非整树比对。

### P2-2　错误信息对模型不友好
`NoSuchPath`、`Conflict` 等内部错误码直接透传给模型。建议工具层翻译为与 Pi 原生工具一致的文案（如 `ENOENT: no such file or directory`），避免模型误判为工具故障而换路绕行。

### P2-3　大文件与二进制
`fs.read` 无大小上限、不检测二进制。建议与 Pi `read` 对齐：超过阈值截断并提示 offset/limit，二进制文件返回摘要而非乱码。

### P2-4　可观测性
增加 `/layerfs status`：显示当前分支、`effectiveHead`、待写队列长度、与 main 的差异文件数、上次漂移检测结果，方便排查上述竞态与漂移问题。

### P2-5　测试矩阵
设计文档缺测试章节。建议以“Pi 原生工具 vs LayerFS 工具”做差分测试：同一组操作分别在真实目录和 Store 上执行，比对输出，覆盖 grep/glob/symlink/mode/父目录等全部 P1 场景。

---

## 总体结论

v0.2 的分层与 fork 模型方向正确，但目前**不能作为 Pi 内置文件工具的透明替代**：P0 的漂移问题会让 Store 与磁盘悄然分叉，P1 的语义差异会让模型在“查不到 / 写不进 / 读错内容”时得出错误结论，且大多不报错，难以察觉。建议修完 P0 与 P1 后再进入实现阶段。

**必改清单**：

1. [P0] `session_start` 漂移检测 + host→Store 同步，新会话在同步后 fork。
2. [P1-1] grep 支持正则（预筛 + 客户端过滤），默认遵守 `.gitignore`。
3. [P1-2] glob 支持花括号、`subPath` 作为匹配基准、无斜杠模式语义明确。
4. [P1-3] write 自动建父目录、保留 mode、写穿 symlink。
5. [P1-4] read/stat 默认跟随 symlink，检测环与越界。
6. [P1-5] `effectiveHead` 兜底 `head: null`；分支操作前排空 `mutate` 队列，队列条目绑定分支。
7. [P1-6] manifest 加锁 + 原子 rename + `main` CAS，会话状态拆分存储。
8. [P2-5] 建立 Pi 原生 vs LayerFS 差分测试，作为上述修复的验收标准。
