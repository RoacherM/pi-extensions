# Real LayerFS probe: findings (2026-10-21)

Pinned build: LayerFS `5fb68ddc1acc3163e3ac3486133bde014c5fbed3` (built from source, no
published artifacts), bundle `~/.cache/epi-layerfs/bundle-5fb68dd`, runtime image
`epi-lfs-runtime:node24-5fb68dd` (from `dsh/tools/history/runtime`). Host: macOS arm64,
Docker Desktop 29.8.2 (linux/aarch64, 15 CPU). Cold release build ~4 min.

Rerun: `node probes/real/run.mjs` (modes: `EPI_LFS_MODE=matrix|race`, `EPI_LFS_KEEP=1`,
`EPI_LFS_ONLY=1,3`, `LFS_ROUNDS`, `LFS_PREWARM=1`). Reports in `~/.cache/epi-layerfs/runs/<id>/report.json`.
Only touches resources named `epi-lfs-probe-<id>-*`; never the existing `layerfs-store`/DSH setup.

## Verified with the real native binding

| Area | Result |
|---|---|
| init / fork / list_branches / list_commits | OK, ms-level |
| fs.read text, CRLF preserved, 200 KB line | OK (long line → prefix, `lineTruncated`) |
| fs.read binary | refused `Binary` (as documented) → need another byte path |
| symlink | imported as symlink, preserved in Workspace |
| `.env` | **imported** (Init ignores .gitignore) |
| fs.write / fs.edit / fs.apply batch | OK, one Commit each |
| merge different files + different hunks of same file | clean `Merged` |
| merge same hunk | `Conflict`, nothing created |
| mount / native exec / status / commit | OK; exec ~10 ms; mount ~100 ms cold, 3 ms warm |
| unmount with uncommitted change | refused `Dirty` |
| fs.write after mount | **not visible** in the existing mount; a later Workspace commit still merges (different paths) |
| source dir on host | unchanged in every run |

## `docker exec` executor into the Sandbox (closes the §3.4 executor gap)

Native exec = Docker exec `bash -c` as uid 501:20, `HOME=/tmp`, cwd `/workspaces/N`.
Doing the same from the host with `docker exec -i -u 501:20 -e HOME=/tmp -w /workspaces/N`:

- live streaming: first chunk 28 ms, chunks spread over time ✔
- env passthrough, exit codes ✔
- writes land in the Workspace; `workspace.status` sees them; `workspace.commit` saves them; `fs.read` on the branch reads them ✔
- binary stdout byte-exact (sha256) ✔ → full-Buffer `readFile` path
- killing the local `docker exec` client does **not** stop the remote command (expected) → must kill remotely
- cancel: run under `setsid -w`, the script itself reports `$$` (the new SID; inside docker exec the process is already a session leader so setsid forks — don't look up the SID from the wrapper). `pkill -TERM -s SID`, wait, `pkill -KILL -s SID` reaps TERM-ignoring child + background grandchild ✔

## Problems found

1. **Client container on the default bridge network cannot mount** (`sandbox create stopped at Connect: ConnectionRefused`, via `host.docker.internal`). Plain container→host published-port traffic works, so the cause is specific to the binding's single connect. **`--network host` (VM loopback, no daemonHost) works.** Not root-caused.
2. A process left with cwd inside the Workspace makes unmount `Busy` (correct). Detecting holders must run **as the command uid** (container root lacks CAP_SYS_PTRACE and cannot read other uids' `/proc/*/cwd`).
3. After a `Busy`, killing holders and unmounting again detached the kernel mount but returned `Failed … Retained(TeardownCustody { stage: Join })`.
4. **Intermittent unmount failure `Failed … stage: Join` (5 s timeout), concentrated on the first Workspace of a fresh Sandbox** that is still mounted ~1–2 s after Sandbox start. 1/30 without prewarm (round 0); with one throwaway prewarm Workspace (which itself failed) 0/60. Retry and discard-retry keep failing; a fresh mount of the same Branch works and unmounts cleanly. Committed state is safe in the Store; the failed Workspace is a leaked slot. No matching upstream issue found. Candidate upstream report.

## Design consequences for the Pi extension

- Linux worker runs on `--network host`.
- All project tool I/O goes through **one mounted Workspace** via `docker exec` (read = `cat` bytes, write = stdin → file, bash = streamed exec). One view, no stale-mount split.
- Commit after each mutating tool call; on commit failure gate further mutations.
- Cancel/timeout = session-kill TERM→KILL; before unmount reap holders (as uid 501) and only then unmount.
- Prewarm each new Sandbox with a throwaway Workspace; treat unmount `Failed/Retained` as a leaked slot: remount fresh, report, recycle the Sandbox at shutdown.
- `.env` and other secrets are imported by Init → need an explicit import policy (exclude list / pre-filtered copy).
- Not yet tested: Docker restart / daemon crash mid-call, Store container loss, very large outputs, concurrent Pi sessions on one project, idle-exit with a leaked Workspace.
