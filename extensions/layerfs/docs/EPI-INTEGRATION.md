# pi-layerfs × Epi 集成规范

状态：**规范（尚未实现，Epi 侧代码未改）**
适用版本：pi-layerfs v0.2（本仓库 `HEAD`）、Epi 0.1.x（锁定 Pi 1.1.0）

---

## 0. 一句话

**LayerFS 是 Epi 的可选能力，不是默认能力。** 只有用户在 Manifest 里显式声明 pi-layerfs，并且本机满足 Docker 和 LayerFS 构建产物这两个前提，它才会接管文件工具。没声明时 Epi 的行为和今天完全一样；声明了但本机不满足前提时，Epi 不能让用户在不知情的情况下直接改宿主机目录（见 §4）。

---

## 1. 原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | **显式启用** | Epi 不内置、不默认加载、不自动探测后开启 LayerFS。启用的唯一入口是 Manifest 的 `extensions` |
| P2 | **不依赖 Docker 的机器零影响** | 没声明 pi-layerfs 的机器上，Epi 不检查 Docker、不读 `~/.cache/pi-layerfs`、不改任何工具、不注入任何提示词 |
| P3 | **声明了就说到做到** | 用户声明了 LayerFS，就是在要求“文件改动先隔离”。前提不满足时 fail-closed（工具报错），不悄悄退回宿主机；放行要用户明确选择（§4.2） |
| P4 | **代码不互相引用** | Epi 不 import pi-layerfs，pi-layerfs 不 import Epi。两边只通过 Pi 的公开扩展接口，以及会话记录里带版本号的条目交互（§6） |
| P5 | **pi-layerfs 在原版 Pi 上照常工作** | 集成不能让 pi-layerfs 依赖 Epi 才能运行 |
| P6 | **Epi 的边界不变** | 不改 Manifest schema，不新增 `epi:*` 内置名字，不让 Epi 自己理解 Docker 或 LayerFS |

---

## 2. 启用方式

### 2.1 用户怎么开

和其他第三方 Pi 扩展一样，写进 Manifest：

```bash
git clone https://github.com/RoacherM/pi-extensions.git ~/pi-extensions
~/pi-extensions/extensions/layerfs/scripts/setup-layerfs.sh   # 一次性：构建 LayerFS 前置产物

# 全局：所有项目都隔离
epi install ~/pi-extensions/extensions/layerfs

# 只在某个项目里隔离（项目必须是 trusted），推荐
epi install -l ~/pi-extensions/extensions/layerfs
```

写入后的 `~/.epi/epi.json`（或项目 `.epi/epi.json`）：

```json
{
  "version": 1,
  "extensions": ["/Users/<you>/pi-extensions/extensions/layerfs"]
}
```

发布到 npm 之后，也可以写成 `npm:@roacherm/pi-layerfs@0.2.x`。**这里没有 `epi:layerfs`**：不新增内置名字（P6）。

### 2.2 用户怎么关

| 范围 | 方式 |
|---|---|
| 永久 | `epi remove <source>`（或 `-l`）从 Manifest 删掉 |
| 本次运行 | `PI_LAYERFS=0 epi`，或 `epi --no-layerfs …` |
| 某个项目不想要全局开的 LayerFS | 当前做不到（Manifest 合并是并集，`disable` 只接受内置名）。见 §9 未决问题 1 |

`--no-layerfs` 是 pi-layerfs 用 `pi.registerFlag` 注册的扩展参数。Epi 的参数表会把未知长参数交给已声明扩展的注册表校验（development.md §9.1），所以它在 Epi 里可以直接用；没声明扩展时，这个参数会按“未知参数”报错，这是正确的行为。

### 2.3 安装 LayerFS 本身

pi-layerfs 依赖三个本地产物，全部由用户自行准备，Epi 不负责安装：

| 产物 | 默认位置 | 覆盖 |
|---|---|---|
| Docker（含 `docker` CLI 和可用的 daemon） | 系统 | `PI_LAYERFS_DOCKER` |
| LayerFS 构建产物（`layerfs-daemon`、`layerfs.node`、`sdk/js`） | `~/.cache/epi-layerfs/bundle-5fb68dd` | `PI_LAYERFS_BUNDLE` |
| 运行时镜像 | `epi-lfs-runtime:node24-5fb68dd` | `PI_LAYERFS_IMAGE` |

一条命令构建：`extensions/layerfs/scripts/setup-layerfs.sh`（见 README §1）。

---

## 3. 机器能力矩阵

| 机器状态 | Manifest 没声明 | Manifest 声明了 |
|---|---|---|
| 没装 Docker | 和今天一样 | 启动时预检失败 → §4 |
| 装了 Docker，没有 LayerFS 产物 | 和今天一样 | 预检失败 → §4 |
| Docker 没在运行（Desktop 未启动） | 和今天一样 | 预检失败 → §4 |
| 一切就绪 | 和今天一样 | 隔离生效：7 个文件工具和 `!cmd` 走 LayerFS |
| CI / 无 TTY | 和今天一样 | 同上；预检失败时按 §4.3 处理 |

**“和今天一样”是硬性要求**：没声明的机器上，`epi --dry-run`、`model-snapshot`、启动耗时、工具列表都不能有任何变化。

---

## 4. 声明了但本机不可用：怎么办

### 4.1 现状（pi-layerfs v0.2）

预检失败时扩展照常加载，`read/write/edit/bash/grep/find/ls` 和 `!cmd` 全部返回同一条错误：

```text
LayerFS failed to start: LayerFS is not available: Docker is not reachable (...)
File tools are disabled (no fallback to the host folder).
```

状态栏显示 `LFS FAILED`，交互模式下额外弹一次通知。这一行为已经测试覆盖（fail-closed）。

问题：在一台本来就没有 Docker 的机器上，用户会得到一个“文件工具全坏了”的 Epi。全局声明加上换机器（比如同步了 `~/.epi`）时最容易踩到。

### 4.2 规范行为（需要在 pi-layerfs 里实现）

预检失败时，按启动模式分开处理：

**交互模式（TUI，`ctx.hasUI && ctx.mode === "tui"`）**：在第一次工具调用之前，弹一次选择框：

```text
LayerFS 在这台机器上不可用：Docker is not reachable (…)
你在 Manifest 里启用了 LayerFS 隔离，所以文件改动默认不会直接写进项目目录。

  › 本次关闭隔离，直接操作项目目录
    保持隔离（文件工具在本次会话里不可用）
    退出 Epi
```

- 选“本次关闭隔离”：等价于本次运行设了 `PI_LAYERFS=0`。状态栏显示 `LFS off`，system prompt 不再注入隔离说明。**这个选择不写盘**，下次启动会再问。
- 选“保持隔离”：维持现状（fail-closed）。
- 选“退出”：调用 `ctx.shutdown()`。

**RPC 模式**：通过 RPC extension UI 发同样的 `select` 请求，客户端没有应答时按“保持隔离”处理。

**print / json 模式（`-p`、`--mode json`）**：不能弹窗，按 fail-closed 处理，并在 stderr 打印一行可操作的提示：

```text
pi-layerfs: LayerFS unavailable (Docker is not reachable). File tools are disabled.
Set PI_LAYERFS=0 to run without isolation, or remove pi-layerfs from your Manifest.
```

### 4.3 机器级“不可用”记忆（可选，第二阶段）

如果用户在同一台机器上连续 N 次选了“本次关闭隔离”，可以提示用户 `epi remove <source>`（或写本机覆盖，见 §9 未决问题 2）。**不要自动改 Manifest。**

### 4.4 明确禁止

- 预检失败后静默退回宿主机执行。
- 预检失败后不报错、不显示状态，看起来正常但其实没有隔离。
- 由 Epi 替 pi-layerfs 判断 Docker 是否可用、或决定是否加载它。

---

## 5. 运行期集成点

pi-layerfs 只用 Pi 的公开扩展接口。下表列出每个接口在 Epi 里的状态，Epi 侧代码都不需要改：

| pi-layerfs 用到的接口 | 用途 | Epi 是否支持 | 说明 |
|---|---|---|---|
| `pi.registerTool`（覆盖同名内置工具） | 7 个文件工具走 LayerFS | ✅ | Epi 的工具卡片按工具名渲染，工具名不变 |
| `pi.on("user_bash")` | `!cmd` 进 LayerFS | ✅ | `src/tui/bash-block.ts` 已转发 `user_bash` |
| `pi.on("before_agent_start")` 追加 system prompt | 告诉模型“改动是隔离的” | ⚠️ 需验证 | Epi 的 `epi:runtime` 最后组装 system prompt，要确认扩展追加的段落被保留 |
| `ctx.ui.setStatus("layerfs", …)` | 状态栏 `LFS …` | ✅ | Epi 的状态栏（`chrome.ts`）右侧显示扩展状态 |
| `pi.events.emit("notify:status")` | 给第三方 statusline 用 | 无副作用 | Epi 没有监听者，事件被忽略 |
| `ctx.ui.notify` / `confirm` / `select` | 启动失败通知、apply 确认 | ✅ | `src/tui/ext-host.ts` 实现了扩展 UI 接口 |
| `pi.registerCommand("layerfs")` + 参数补全 | `/layerfs …` | ✅ | 名字不与 Epi 内置命令冲突（Epi 有 `/review`、`/preview`、`/trace`） |
| `pi.registerFlag("no-layerfs")` | 本次关闭 | ✅ | 见 §2.2 |
| `pi.appendEntry("layerfs-checkpoint" / "layerfs-session")` | 保存点与会话绑定 | ✅ | 写入会话 JSONL；`/trace` 会显示成一行 `custom · layerfs-checkpoint`，见 §6 |
| `session_start(reason)`、`session_tree`、`session_before_fork`、`session_shutdown` | resume、tree、fork、reload | ✅ | Epi 用 Pi 的 session runtime，事件照常触发 |

### 5.1 与 Epi 内置能力的边界

| Epi 能力 | 和 LayerFS 的关系 | 规范 |
|---|---|---|
| **`epi:task` 子任务** | Task worker 是独立进程，用 `noExtensions: true` 和显式的 factory 列表（`src/worker.ts`），**不继承** pi-layerfs | 子任务**直接改宿主机目录**，不经过 LayerFS。这必须写进 pi-layerfs 的 README 和 Epi 的 Task 文档。是否让 worker 也装上 LayerFS 属于第二阶段（§8） |
| **`/review`** | 看的是宿主机的 git 工作区或会话变更账 | LayerFS 里还没 apply 的改动在 `/review` 里看不到。用户要用 `/layerfs diff`，或者先 apply 再 review |
| **`/trace`** | 投影会话记录 | `layerfs-checkpoint` 显示为普通 custom 行。结合方式见 §6，第一阶段不做 |
| **`/preview`** | 只读宿主机文件 | 看到的是宿主机内容，不是 LayerFS 分支内容。不需要改 |
| **`epi:hooks`** | hook handler 在宿主机上执行 | hook 里的命令直接操作宿主机，不经过 LayerFS。文档里写明即可 |
| **`epi:mcp`** | MCP 工具在各自进程里运行 | 同上：MCP 工具的文件读写不受 LayerFS 隔离 |
| **Project Trust** | 项目 Manifest 里声明的 pi-layerfs | 只有 trusted 项目的声明才生效，这是 Epi 现有规则，不需要改 |

### 5.2 不能覆盖的东西

pi-layerfs 只隔离 7 个内置文件工具和 `!cmd`。下面这些照常直接作用于宿主机，集成时**不得宣传为“完全隔离”**：

- Task 子 agent（§5.1）
- hooks、MCP 工具、其他第三方扩展的工具
- 用户自己在终端里的操作

---

## 6. 与 `/trace` 的关系（第一阶段：分离）

用户已明确：**先分离**。第一阶段的约定：

- pi-layerfs 只写自己的条目（`layerfs-checkpoint`、`layerfs-session`），格式由 pi-layerfs 负责，带上 `v` 字段（下一版补上）。
- Epi `/trace` 不读、不解析这些条目，维持现在的通用显示。
- 文件历史用 `/layerfs history` 查看，和 `/trace` 是两个独立入口。

以后要结合时，采用 `docs/` 里讨论过的方案 D：Epi 定义一个中立的 `epi.trace.annotation.v1` 条目，pi-layerfs 只作为写入方。届时单独设计，并需要用户批准对 `trace-design.md` 的改动。

---

## 7. 版本兼容

| 项 | 要求 |
|---|---|
| Pi 版本 | Epi 锁定 Pi **1.1.0**。pi-layerfs 目前只在 Pi 1.2.0 和 1.4.0 上测过。**接入 Epi 之前必须在 Epi 内实测一遍**（§10 验收），重点是 `before_agent_start` 返回值、`session_tree` 事件和 `ctx.sessionManager.getBranch()` 在 1.1.0 上的形状 |
| pi-layerfs 的 `peerDependencies` | `"*"`（Pi 包规范要求，宿主提供）。最低实测版本写在 README |
| LayerFS 版本 | 固定 `5fb68dd`。bundle、镜像、Store 格式三者成组锁定，升级要成组替换 |
| 状态目录 | `~/.cache/pi-layerfs`，和 Epi 的 `~/.epi` 分开。Epi 不读写它 |

---

## 8. 分阶段计划

| 阶段 | 内容 | 改哪个仓库 |
|---|---|---|
| **1. 可选扩展** | 本规范 §2～§6：用户 `epi install` 后可用；§4.2 的“不可用时询问”；在 Epi（Pi 1.1.0）里跑完 §10 验收；README 写清边界 | 只改 pi-layerfs |
| 2. 更好的降级 | 机器级“不可用”记忆（§4.3）；Epi 侧支持本机或项目级覆盖（§9 未决问题 1、2） | pi-layerfs；Epi 需要设计变更 |
| 3. Task 子任务隔离 | 让 `epi:task` 的 worker 可选择装上 pi-layerfs，每个子任务一个 LayerFS 分支 | Epi（`worker.ts`、task capsule）+ pi-layerfs |
| 4. Trace 结合 | `epi.trace.annotation.v1`（§6） | Epi + pi-layerfs |

阶段 1 **不需要改 Epi 的任何代码**。

---

## 9. 未决问题（需要用户决定）

1. **项目级关闭全局开启的 LayerFS。** Manifest 是并集合并，`disable` 只接受 `epi:*`。选项：(a) 不支持，用户全局不开、按项目开；(b) 让 `disable` 接受第三方 source（Manifest 语义变更）；(c) pi-layerfs 自己读一个项目文件（比如 `.epi/layerfs.json { "enabled": false }`），但要遵守 Project Trust，只在 trusted 项目里读。**建议 (a)**，也就是默认推荐 `epi install -l` 按项目开启。
2. **机器级覆盖。** 同一份 `~/.epi` 同步到多台机器、其中有的没有 Docker 时，需要一个“本机不启用”的开关。选项：环境变量 `PI_LAYERFS=0` 写进 shell profile（现在就能用），或者 pi-layerfs 在 `~/.cache/pi-layerfs/machine.json` 记一个本机开关。**建议先用环境变量**。
3. **Task 子任务要不要隔离**（阶段 3）。它决定了“启用 LayerFS”能不能对外宣称“agent 的改动都先隔离”。

---

## 10. 接入 Epi 的验收清单（阶段 1）

在 Epi 里（锁定的 Pi 1.1.0），用临时 `EPI_HOME`、临时项目执行：

**没声明 pi-layerfs**
- [ ] `epi --dry-run` 输出与基线完全一致
- [ ] `scripts/model-snapshot.mjs` 无差异（工具列表、system prompt）
- [ ] 不创建 `~/.cache/pi-layerfs`，不调用 `docker`

**声明了，本机就绪**
- [ ] 启动后状态栏显示 `LFS <branch>`
- [ ] read/write/edit/bash/grep/find/ls 在分支里执行，宿主机不变
- [ ] `!cmd` 进入 LayerFS
- [ ] `/layerfs diff`、`/layerfs apply`（确认框在 Epi 的对话框里正常显示）、`/layerfs history`
- [ ] system prompt 里有隔离说明（验证 `epi:runtime` 组装后仍保留）
- [ ] `/resume`、`/tree`、`/fork`、`/reload` 行为与原版 Pi 上一致
- [ ] Esc 取消正在运行的 bash
- [ ] `epi -p` 非交互模式正常

**声明了，本机不可用（停掉 Docker 或改错 `PI_LAYERFS_IMAGE`）**
- [ ] 交互模式弹 §4.2 的选择框，三个选项分别符合预期
- [ ] `epi -p`：工具 fail-closed，stderr 有可操作的提示，宿主机不变
- [ ] 选“本次关闭隔离”后，工具直接作用于宿主机，状态栏显示 `LFS off`

**边界**
- [ ] `task` 子任务直接写宿主机（行为符合文档，不是 bug）
- [ ] `--no-layerfs` 在 Epi 的参数表里被识别；没声明扩展时它按未知参数报错
- [ ] 未 trusted 项目里的 `.epi/epi.json` 声明的 pi-layerfs 不加载
