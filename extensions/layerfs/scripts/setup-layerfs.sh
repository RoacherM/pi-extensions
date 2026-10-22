#!/usr/bin/env bash
# Builds the LayerFS prerequisites pi-layerfs needs, entirely inside Docker:
#   - layerfs-daemon and the SDK native addon (Linux build, Rust 1.85.1 image)
#   - the runtime image Sandboxes and the Store container run
#   - a bundle folder: <bundle>/{layerfs-daemon, layerfs.node, sdk/js}
#
# Usage: scripts/setup-layerfs.sh [--ref <layerfs commit>] [--bundle <dir>] [--image <tag>]
# Defaults match pi-layerfs's built-in defaults, so no env vars are needed afterwards.
# Needs: docker (daemon running), git. Takes ~4-6 min on a first run (arm64 Mac).
set -euo pipefail

REF=5fb68ddc1acc3163e3ac3486133bde014c5fbed3
SHORT=5fb68dd
BUNDLE="${HOME}/.cache/epi-layerfs/bundle-${SHORT}"
IMAGE="epi-lfs-runtime:node24-${SHORT}"
SRC="${HOME}/.cache/epi-layerfs/src-${SHORT}"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; SHORT=${2:0:7}; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null || { echo "docker not found: install Docker Desktop (macOS) or Docker Engine (Linux)" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running: start Docker Desktop / dockerd first" >&2; exit 1; }
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }

echo "==> LayerFS source ${REF} -> ${SRC} (sparse checkout: core, sdk/js, dsh runtime Dockerfile)"
if [ ! -d "${SRC}/.git" ]; then
  mkdir -p "$(dirname "${SRC}")"
  git clone --filter=blob:none --no-checkout https://github.com/Ephemeral-AI-Lab/layerfs.git "${SRC}"
fi
git -C "${SRC}" sparse-checkout set --no-cone '/core/' '!/core/docs/' '/sdk/js/' '/.cargo/' '/dsh/tools/history/runtime/'
# The upstream repo is large (~850 MB); blobless + sparse fetches only what is needed.
# GitHub transfers can drop on slow links: retry, and rerunning the script resumes.
for attempt in 1 2 3 4 5; do
  git -C "${SRC}" fetch --depth 1 --filter=blob:none origin "${REF}" && git -C "${SRC}" checkout --quiet "${REF}" && break
  echo "fetch/checkout failed (attempt ${attempt}); retrying in 5 s..." >&2
  sleep 5
  [ "${attempt}" = 5 ] && { echo "could not fetch LayerFS ${REF}; rerun this script to resume" >&2; exit 1; }
done
for f in core/Cargo.lock .cargo/config.toml sdk/js/src/index.js dsh/tools/history/runtime/Dockerfile; do
  [ -f "${SRC}/${f}" ] || { echo "LayerFS checkout incomplete: missing ${f}; rerun to resume" >&2; exit 1; }
done

echo "==> Building layerfs-daemon + layerfs.node (rust:1.85.1-bookworm)"
docker volume create pi-layerfs-cargo >/dev/null
docker volume create pi-layerfs-target >/dev/null
docker run --rm -v "${SRC}":/work:ro -v pi-layerfs-cargo:/usr/local/cargo/registry -w /work \
  rust:1.85.1-bookworm cargo fetch --manifest-path core/Cargo.toml --locked
docker run --rm -v "${SRC}":/work:ro -v pi-layerfs-target:/tgt -v pi-layerfs-cargo:/usr/local/cargo/registry:ro \
  -e CARGO_TARGET_DIR=/tgt -w /work rust:1.85.1-bookworm \
  cargo build --manifest-path core/Cargo.toml --offline --locked --release -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" \
  -p layerfs-node --lib -p layerfs-daemon --bins

echo "==> Bundle -> ${BUNDLE}"
mkdir -p "${BUNDLE}/sdk/js"
docker run --rm -v pi-layerfs-target:/t:ro -v "${BUNDLE}":/out rust:1.85.1-bookworm sh -c \
  "cp /t/release/layerfs-daemon /out/ && cp /t/release/liblayerfs_node.so /out/layerfs.node && chown $(id -u):$(id -g) /out/layerfs-daemon /out/layerfs.node"
cp -R "${SRC}/sdk/js/src" "${SRC}/sdk/js/operator" "${SRC}/sdk/js/package.json" "${BUNDLE}/sdk/js/"

echo "==> Runtime image ${IMAGE}"
docker build -q -t "${IMAGE}" "${SRC}/dsh/tools/history/runtime" >/dev/null

echo
echo "Done."
echo "  bundle: ${BUNDLE}"
echo "  image:  ${IMAGE} ($(docker image inspect -f '{{.Id}}' "${IMAGE}" | cut -c1-19))"
if [ "${BUNDLE}" != "${HOME}/.cache/epi-layerfs/bundle-5fb68dd" ] || [ "${IMAGE}" != "epi-lfs-runtime:node24-5fb68dd" ]; then
  echo "Non-default locations: export PI_LAYERFS_BUNDLE=${BUNDLE} PI_LAYERFS_IMAGE=${IMAGE}"
fi
echo "Optional: docker volume rm pi-layerfs-cargo pi-layerfs-target  # build caches"
