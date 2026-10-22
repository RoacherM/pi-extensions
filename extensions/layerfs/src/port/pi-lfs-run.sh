#!/bin/sh
# Runs one Pi bash command in a LayerFS Workspace (copied into each Sandbox, run as root).
# Usage: pi-lfs-run.sh <sid-file> <workspace-path> <host-project-root> <run-cwd> <uid> <gid> <command>
#
# - Private PID + mount namespace per command (`unshare -m -p -f --kill-child`): when the command
#   ends or is cancelled, every process it started (background jobs, nohup, daemons) is killed by
#   the kernel, so nothing keeps writing to the Workspace after its commit / unmount.
# - Records the unshare process id in <sid-file> (root-owned dir): killing it with SIGKILL makes
#   the kernel kill the whole namespace. SIGTERM is forwarded first for a graceful stop.
# - Bind-mounts the Workspace at the host's own project path, visible only inside this namespace,
#   so absolute host paths in commands work and nothing is rewritten.
# - Hides excluded secrets from `git status` (skip-worktree) and .lww (info/exclude).
# - Drops to the command identity and runs bash.
set -u
sid_file=$1 ws=$2 root=$3 run_cwd=$4 uid=$5 gid=$6 cmd=$7
case "$root" in
  /|/bin|/bin/*|/sbin|/sbin/*|/usr|/usr/*|/lib|/lib/*|/etc|/etc/*|/proc|/proc/*|/sys|/sys/*|/dev|/dev/*|/run|/run/*|/workspaces|/workspaces/*|/layerfs-store|/layerfs-store/*)
    echo "pi-layerfs: refusing project root $root (it would shadow a system path in the Sandbox)" >&2; exit 125 ;;
esac
mkdir -p "$(dirname "$sid_file")" || exit 125
# The namespace's PID 1 is `sh -c`, which forwards TERM to the command's process group.
PI_LFS_NS='
  ws=$1 root=$2 run_cwd=$3 uid=$4 gid=$5 cmd=$6
  mkdir -p "$root" && mount --rbind "$ws" "$root" || { echo "pi-layerfs: cannot bind the workspace (needs CAP_SYS_ADMIN)" >&2; exit 125; }
  cd "$run_cwd" 2>/dev/null || cd "$root" || exit 125
  setpriv --reuid="$uid" --regid="$gid" --clear-groups /bin/sh -c "
    if [ -d \"\$1/.git\" ] && command -v git >/dev/null 2>&1; then
      mkdir -p \"\$1/.git/info\" && { grep -qxF /.lww \"\$1/.git/info/exclude\" 2>/dev/null || echo /.lww >> \"\$1/.git/info/exclude\"; }
      if [ -n \"\${PI_LFS_EXCLUDES:-}\" ]; then
        printf %s \"\$PI_LFS_EXCLUDES\" | tr \"\\n\" \"\\n\" | while IFS= read -r pat; do
          [ -n \"\$pat\" ] || continue
          git -C \"\$1\" -c core.quotePath=false ls-files -v -- \":(glob,icase)\$pat\" \":(glob,icase)**/\$pat\" 2>/dev/null
        done | while IFS= read -r line; do
          t=\${line%% *}; f=\${line#* }
          [ \"\$t\" = S ] && continue
          [ -e \"\$1/\$f\" ] || git -C \"\$1\" update-index --skip-worktree -- \"\$f\" 2>/dev/null
        done
      fi
      unset PI_LFS_EXCLUDES
    fi
    exec bash -c \"\$0\"
  " "$cmd" "$root" &
  child=$!
  trap "kill -TERM $child 2>/dev/null" TERM
  wait $child; code=$?
  # a TERM interrupts the first wait: wait again for the real exit status
  while kill -0 $child 2>/dev/null; do wait $child; code=$?; done
  exit $code
'
export PI_LFS_NS
# Arguments travel in the environment, so the namespace's PID 1 shows only "pi-lfs-ns" in ps.
PI_LFS_A1=$ws PI_LFS_A2=$root PI_LFS_A3=$run_cwd PI_LFS_A4=$uid PI_LFS_A5=$gid PI_LFS_A6=$cmd \
  unshare -m -p -f --kill-child --mount-proc --propagation slave /bin/sh -c 'ns=$PI_LFS_NS; set -- "$PI_LFS_A1" "$PI_LFS_A2" "$PI_LFS_A3" "$PI_LFS_A4" "$PI_LFS_A5" "$PI_LFS_A6"; unset PI_LFS_NS PI_LFS_A1 PI_LFS_A2 PI_LFS_A3 PI_LFS_A4 PI_LFS_A5 PI_LFS_A6; eval "$ns"' pi-lfs-ns &
ns=$!
# The namespace init (sh) is unshare's child; it forwards TERM to the command. Record both pids:
# "<unshare-pid> <init-pid>" (TERM goes to init, KILL to unshare, which kills the whole namespace).
init=""
i=0
while [ -z "$init" ] && [ $i -lt 50 ]; do init=$(pgrep -P "$ns" 2>/dev/null | head -1); [ -n "$init" ] || sleep 0.02; i=$((i+1)); done
echo "$ns $init" > "$sid_file"
trap "kill -TERM $ns 2>/dev/null" TERM
wait $ns; code=$?
while kill -0 $ns 2>/dev/null; do wait $ns; code=$?; done
exit $code
