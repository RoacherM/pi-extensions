# pi-layerfs (`@roacherm/pi-layerfs`)

A **100% Native, Zero-Docker** [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) runtime and [Pi](https://pi.dev) / [Epi](https://github.com/Ephemeral-AI-Lab) extension that isolates agent file operations and shell commands on copy-on-write LayerFS branches, guarded at the OS kernel level by a Claude Code (`@anthropic-ai/sandbox-runtime` / `srt`)-inspired macOS Seatbelt (`sandbox-exec`) sandbox.

Your real project folder changes **only** when you run `/layerfs apply` (or `layerfs_apply`).

---

## Architecture: Two-Layer Design (Harness-Agnostic Core + Thin Adapters)

`@roacherm/pi-layerfs` is split into two layers so it can power **any** coding agent harness:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Upper Layer: Thin Harness Adapters                                      │
│  ├─ @roacherm/pi-layerfs       (src/index.ts)      -> Pi & Epi Adapter  │
│  └─ @roacherm/pi-layerfs/core  (src/core/index.ts) -> Claude Code /     │
│                                                       Codex / Cursor /  │
│                                                       DSH / MCP / CLI   │
├─────────────────────────────────────────────────────────────────────────┤
│ Lower Layer: Harness-Agnostic Native Workspace Engine (`src/core/`)     │
│  Zero Pi/Epi dependencies! Pure Node.js + Native LayerFS + OS Seatbelt. │
│  ├─ In-process APFS SQLite Store (`layerfs.node`)                       │
│  │    read / write / edit / ls / find / grep / diff / history in ~1–8ms │
│  ├─ Local NFSv3 Loopback Daemon (`layerfs-daemon` on 127.0.0.1)         │
│  │    Unprivileged `/sbin/mount_nfs` per-branch Workspace mounts        │
│  ├─ Claude Code (`srt`)-Style macOS Seatbelt Sandbox (`src/seatbelt.ts`)│
│  │    • Deny-by-default writes: only mounted branch & scratch writable  │
│  │    • Kernel write-lock on real host project folder & `.git/config`   │
│  │    • Kernel read-deny & move-blocking on `.env*`, `*.key`, `~/.ssh`  │
│  │    • Kernel `file-mount`/`file-unmount` & optional network lockdown  │
│  └─ Multi-Agent Team DAG (`merge`, 3-way fallback, `checkout`, `sync`)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Prerequisites (Once per Mac — Zero Docker, Zero Root, Zero macFUSE)

| Need | Why |
|---|---|
| macOS (Apple Silicon / Intel) | Uses macOS built-in `/sbin/mount_nfs` and `/usr/bin/sandbox-exec` |
| Rust (`cargo`) & `git` | Builds the native `layerfs-daemon` and `layerfs.node` once |

Build the native bundle (`~/.cache/epi-layerfs/bundle-native`, ~1 min):

```bash
git clone https://github.com/RoacherM/pi-extensions.git
pi-extensions/extensions/layerfs/scripts/setup-layerfs.sh
```

---

## 2. Install in Pi or Epi

### Epi

```bash
# Global install (~/.epi/epi.json)
epi install git:github.com/RoacherM/pi-extensions
# Or from a local clone
epi install ./pi-extensions/extensions/layerfs
# Or project-only (.epi/epi.json)
epi install -l --approve ./pi-extensions/extensions/layerfs
```

### Pi

```bash
pi install ./pi-extensions/extensions/layerfs
# Or for a single run
pi -e ./pi-extensions/extensions/layerfs
```

---

## 3. Using `@roacherm/pi-layerfs/core` in Other Harnesses (Claude Code, Codex, MCP, Custom Agents)

`src/core/index.ts` has **zero** `@earendil-works/pi-coding-agent` dependencies. Any Node.js harness can embed it directly:

```ts
import {
  LayerfsSession,
  resolveConfig,
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
  LAYERFS_TOOL_SCHEMA,
  LAYERFS_APPLY_TOOL_SCHEMA,
} from "@roacherm/pi-layerfs/core";

// 1. Open an isolated branch session for an agent or worker
const config = resolveConfig({ PI_LAYERFS_TEAM: "1", PI_LAYERFS_BRANCH_NAME: "worker-1" });
const session = new LayerfsSession(process.cwd(), "session-id-1", config);
await session.open();

// 2. Bind standard file & shell tools (read, write, edit, bash, ls, find, grep)
const ops = createHarnessOperations(session);
await session.mutate("call-1", "write", () => ops.write.writeFile("src/feature.ts", "export const ok = true;\n"));
await session.mutate("call-2", "bash", () =>
  ops.bash.exec("npm test", process.cwd(), { onData: (chunk) => process.stdout.write(chunk) }),
);

// 3. Multi-agent branch inspection, diff, checkout, sync, merge, and 3-way host apply
console.log(await executeLayerfsAction(session, { action: "status" }));
console.log(await executeLayerfsAction(session, { action: "diff" }));
console.log(await executeLayerfsApply(session));

await session.close();
```

---

## 4. Interactive Commands & Team Mode

| Command | Does |
|---|---|
| `/layerfs status` | branch, logical alias, checkpoints, blocked state |
| `/layerfs diff [branch] [base]` | files changed on this session's branch (or between any two branches) |
| `/layerfs history [n]` | checkpoints: tool, time, changed files, HEAD / applied |
| `/layerfs apply [--revert]` | 3-way checked write back to your host folder |
| `/layerfs sync [--full]` | sync external host edits into LayerFS `main` |
| `/layerfs branches` | active user/worker branches with logical aliases |
| `/layerfs merge <branch> [--ours\|--theirs]` | merge another branch into yours (with automatic path-wise fallback merge) |
| `/layerfs retry` | retry after a failed checkpoint |

### Team Mode (`PI_LAYERFS_TEAM=1`)

Exposes the `layerfs` tool (`status`, `diff`, `branches`, `ls`, `show`, `checkout`, `sync`, `merge`) to all sessions, and `layerfs_apply` to the lead session (`PI_SUBAGENT_CHILD !== "1"`).

---

## 5. Configuration

| Env | Default |
|---|---|
| `PI_LAYERFS` | on; `0` turns it off (`--no-layerfs` flag also disables for one run) |
| `PI_LAYERFS_BUNDLE` | `~/.cache/epi-layerfs/bundle-native` |
| `PI_LAYERFS_ROOT` | `~/.cache/pi-layerfs` (home, APFS Stores, local mounts, bindings) |
| `PI_LAYERFS_PREFIX` | `pi-lfs-` |
| `PI_LAYERFS_NETWORK` | `allow` \| `localhost` \| `deny` (`offline`) — Seatbelt outbound network policy inside `bash` |
| `PI_LAYERFS_EXCLUDES` | `.env,.env.*,*.pem,*.key,id_rsa*,id_ed25519*,.npmrc,.netrc,.pypirc` |
| `PI_LAYERFS_BRANCH_ONLY` | comma-separated build-output patterns (e.g. `target/,.cargo-home/`) kept only in branches |
| `PI_LAYERFS_TEAM` | `1` enables multi-agent `layerfs` / `layerfs_apply` tools |
| `PI_LAYERFS_BRANCH_NAME` | logical branch alias for this session (defaults to `lead` or `s-<shortId>`) |

---

## 6. Development & Tests

```bash
cd extensions/layerfs
npm test   # runs all 7 native suites (native-seatbelt, backend, review-fixes, pi, cli, rpc, scale) — zero Docker
```

## License

MIT.
