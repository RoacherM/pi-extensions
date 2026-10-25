# pi-layerfs

A [Pi](https://pi.dev) extension that runs the agent's file tools and shell commands in an
isolated [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) branch of your project. Your
folder changes only when you run `/layerfs apply`.

- `read`, `write`, `edit`, `ls`, `find`, `grep`, `bash` and your `!` commands work on a LayerFS
  Branch, not on your files.
- Every change is a checkpoint (a LayerFS Commit) tied to the tool call that made it.
- `/layerfs diff` shows what changed; `/layerfs apply` writes it to your folder, and refuses
  everything if you edited any of those files yourself meanwhile.
- `/tree`, `/fork` and `/resume` restore the files of that point in the conversation.
- Several sessions in one folder share one LayerFS project; each has its own Branch.

**It is optional.** It needs Docker and a local LayerFS build. Nothing loads it unless you
install it; machines without Docker are unaffected unless they enable it.

Status: v0.2. Tested with Pi 1.2.0 and 1.4.0, LayerFS `5fb68dd`, macOS arm64 + Docker Desktop.

---

## 1. Prerequisites (once per machine)

| Need | Why |
|---|---|
| Docker (Docker Desktop on macOS, Docker Engine on Linux), running | LayerFS's Store and Sandboxes are Linux containers |
| `git`, ~2 GB free disk | to fetch and build LayerFS |

Build LayerFS's daemon, native addon and runtime image (all inside Docker, ~5 min the first time):

```bash
git clone https://github.com/RoacherM/pi-extensions.git
pi-extensions/extensions/layerfs/scripts/setup-layerfs.sh
```

This writes `~/.cache/epi-layerfs/bundle-5fb68dd` and the image `epi-lfs-runtime:node24-5fb68dd`,
which are the extension's defaults, so no configuration is needed afterwards. LayerFS publishes
no binaries; the script pins the tested commit.

## 2. Install

### Pi

```bash
# from GitHub (pins a ref when you add @<tag-or-commit>)
pi install git:github.com/RoacherM/pi-extensions/extensions/layerfs   # see note below
# or from a local clone
pi install ./pi-extensions/extensions/layerfs
# or just for one run
pi -e ./pi-extensions/extensions/layerfs
```

> Pi installs a git source as a whole repository. Until the extension is published to npm, the
> simplest reliable form is a local path (clone the repo, then `pi install <path>`), or
> `pi -e <path>` per run.

Project-only: `pi install -l <path>` writes it to the project's `.pi/settings.json`.

### Epi

LayerFS is **not** an Epi built-in and is never enabled by default. Declare it in a Manifest:

```bash
epi install ./pi-extensions/extensions/layerfs        # all projects (~/.epi/epi.json)
epi install -l ./pi-extensions/extensions/layerfs     # this project only (must be trusted)
```

Restart Epi afterwards. The full contract (what Epi guarantees on machines without Docker, what
isolation does not cover, acceptance checks) is in [docs/EPI-INTEGRATION.md](docs/EPI-INTEGRATION.md).

### Turn it off

| Scope | How |
|---|---|
| This run | `PI_LAYERFS=0 pi …` or `pi --no-layerfs …` (put the flag before the prompt) |
| This machine (synced config, no Docker) | `export PI_LAYERFS=0` in your shell profile |
| Permanently | `pi remove <source>` / `epi remove <source>` |

## 3. Use

The status line shows `LFS <branch>` and `· N unapplied` once there are changes.

| Command | Does |
|---|---|
| `/layerfs status` | branch, checkpoints, blocked state |
| `/layerfs diff` | files this session changed |
| `/layerfs history [n]` | checkpoints: tool, time, changed files, HEAD / applied |
| `/layerfs apply` | write changes to your folder (confirm dialog). `--revert` allows going back after `/tree` |
| `/layerfs sync [--full]` | pull your own edits made outside Pi into LayerFS |
| `/layerfs branches` | all LayerFS branches of the project |
| `/layerfs merge <branch>` | merge another session's branch (e.g. a sub-agent's) into this one; on conflict nothing changes and the files are listed |
| `/layerfs retry` | retry after a failed checkpoint blocked changes |

Typical flow: ask the agent to change things → `/layerfs diff` → `/layerfs apply` → commit with git.

## 4. What it guarantees

- **Fail-closed.** If Docker, the image or the build is missing, file tools return an error.
  They never silently fall back to editing your folder.
- **Your folder is written only by `/layerfs apply`.** Apply is all-or-nothing on conflicts,
  re-checks each file just before writing it, never writes `.git/` internals, and never
  overwrites excluded secrets.
- **Secrets are not imported.** `.env`, `.env.*`, `*.pem`, `*.key`, SSH keys, `.npmrc`, `.netrc`,
  `.pypirc` (configurable). Files outside the project are read-only, and credential files under
  `$HOME` (`~/.ssh`, `~/.aws`, `~/.docker/config.json`, auth files) are not readable.
- **Commands are contained.** Each bash call runs in its own PID and mount namespace; every
  process it started (including `cmd &`) is killed when it ends or is cancelled. Host paths
  inside commands work unchanged.
- **No host environment leaks into commands.** Only `PI_*` and a short allowlist are passed.

## 5. What it does not cover

- Tools from other extensions and MCP servers, and hooks, act on your real folder.
- Sub-agents: pi-subagents **background** children (`async: true`) load the parent's extensions,
  so each gets its own LayerFS branch; merge them with `/layerfs merge`. Foreground children and
  Epi's `task` workers do not load extensions and act on your real folder.
- Background processes do not survive across bash calls: start and use a server in one call.
- Commands run in Linux; native modules built for macOS in your `node_modules` will not load.
- LayerFS keeps history without crash durability (its own "Disposable" profile): treat it as a
  scratch layer, keep your real history in git.
- Branches are not garbage-collected yet; a force-killed Pi can leave containers behind
  (`docker ps -a --filter name=pi-lfs-`).

## 6. Configuration

| Env | Default |
|---|---|
| `PI_LAYERFS` | on; `0` turns it off |
| `PI_LAYERFS_SANDBOX` | `docker`. Set `native` on macOS to run with **zero Docker** (built-in NFSv3 loopback + `/sbin/mount_nfs` + Claude Code `srt`-style Seatbelt `sandbox-exec`). |
| `PI_LAYERFS_NETWORK` | `allow` (in `native` mode). Set `localhost` or `deny` (`offline`) to block outbound network access inside `bash` via Seatbelt while keeping LayerFS NFSv3 mounts active. |
| `PI_LAYERFS_BUNDLE` | `~/.cache/epi-layerfs/bundle-5fb68dd` (`docker`) or `~/.cache/epi-layerfs/bundle-native` (`native`) |
| `PI_LAYERFS_IMAGE` | `epi-lfs-runtime:node24-5fb68dd` |
| `PI_LAYERFS_ROOT` | `~/.cache/pi-layerfs` (LayerFS home, bindings, manifests) |
| `PI_LAYERFS_PREFIX` | `pi-lfs-` (container and volume names) |
| `PI_LAYERFS_EXCLUDES` | comma-separated gitignore-style patterns (default list in §4) |
| `PI_LAYERFS_ENV_ALLOW` | extra env vars passed into commands besides `PI_*` |
| `PI_LAYERFS_KILL_GRACE_MS` | `2000`: TERM → KILL grace on cancel |
| `PI_LAYERFS_BRANCH_ONLY` | none. Comma-separated patterns (e.g. `target/,.cargo-home/`) that live only in branches and `main`: never imported, synced or applied, newer side wins on merge (merged source files are touched before the next `bash` run so build tools rebuild). |
| `PI_LAYERFS_TEAM` | off. `1` turns on team mode (below). |
| `PI_LAYERFS_BRANCH_NAME` | optional logical branch alias for this session (defaults to `lead` for the top-level team session, or `s-<shortId>`). |

### Team mode (multi-agent)

With `PI_LAYERFS_TEAM=1` the agent gets a `layerfs` tool (`status`, `diff [branch]`,
`branches`, `ls [branch] [path]`, `show branch path [offset] [limit]`,
`checkout branch path|paths`, `sync [branch] [strategy]`, `merge branch [strategy]`).
The top-level session also gets `layerfs_apply`, which writes its branch to your folder
and advances `main`. pi-subagents children (`PI_SUBAGENT_CHILD=1`) never get `layerfs_apply`.

Typical round: the lead starts workers with `subagent({ async: true })`. Each worker
gets its own branch, forked from `main`, with a stable alias (`s-<shortId>` or
`PI_LAYERFS_BRANCH_NAME`) that continues to resolve even after merges rotate the
underlying branch name. The lead inspects or merges each branch (automatically falling
back to a path-wise 3-way merge if native serial merge encounters an `InvalidRecord`),
runs the checks, and calls `layerfs_apply`. Workers can also sync directly from `lead`
via `layerfs(action="sync", branch="lead")` before `lead` applies to disk.

Workers must be background children: foreground children don't load extensions, so
they'd act on your folder.

## 7. How it works

```
Pi (macOS) ──SDK calls──▶ <prefix>store container (--network host, layerfs.node)
   │                        └─ Store: one SQLite + content store per project, in a Docker volume
   └─ bash / fallbacks ──▶ Sandbox container: workspace mounted per call (FUSE),
                            command in its own PID+mount namespace at your project's path
```

- File tools call LayerFS's `fs.*` on the Store directly (milliseconds, no Sandbox); binary,
  symlinked or >48 KiB-line files fall back to a short Workspace mount for exact bytes.
- Each session has a base anchor branch and a work branch. `apply` diffs base → work only,
  merges into `main` if another session moved it, then publishes.

Design and reviews: [docs/DESIGN-v0.2.md](docs/DESIGN-v0.2.md), [docs/](docs/).

## 8. Development

```bash
cd extensions/layerfs
mkdir -p node_modules/@earendil-works && ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" node_modules/@earendil-works/pi-coding-agent
npm run test:fixes     # regression suite (real LayerFS, ~2 min)
npm test               # all suites (~6 min); needs Docker and the setup above
```

Tests create their own containers/volumes (`pi-lfs-*-<id>-`) and remove them afterwards.

## License

MIT. `src/box.js` and `src/port/*` are adapted from LayerFS's `dsh/packages/host`
(MIT, © 2026 Ephemeral-AI); see [NOTICE](NOTICE).
