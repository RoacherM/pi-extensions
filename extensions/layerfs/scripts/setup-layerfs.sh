#!/usr/bin/env bash
# Builds the LayerFS prerequisites pi-layerfs needs on macOS Native mode:
#   - layerfs-daemon and layerfs.node (macOS native arm64 build via cargo)
#   - zero Docker requirement
#   - bundle: ~/.cache/epi-layerfs/bundle-native/{layerfs-daemon, layerfs.node, sdk/js}
#
# Usage: scripts/setup-layerfs.sh [--ref <git ref>] [--bundle <dir>]
set -euo pipefail

REF="833acf7b12b206396381c0b5605fe861f7f7d5a0"
CHERRY_MOUNT="009931c56534d3c173618f00c5ef57e8ce96dc7a"
CHERRY_APPLEDOUBLE="a700af8f492ef360d150877e5d469031767e473f"
CHERRY_OVERLAY="c914d14baf99296f64c7e0a2266b66da4f5c7ae8"
BUNDLE="${HOME}/.cache/epi-layerfs/bundle-native"
SRC="${HOME}/.cache/epi-layerfs/src-native"

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=$2; shift 2 ;;
    --bundle) BUNDLE=$2; shift 2 ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export PATH="${HOME}/.cargo/bin:${PATH}"
command -v cargo >/dev/null || { echo "cargo not found: install Rust via https://rustup.rs" >&2; exit 1; }
command -v git >/dev/null || { echo "git not found" >&2; exit 1; }

echo "==> LayerFS source ${REF} -> ${SRC} (sparse checkout)"
if [ ! -d "${SRC}/.git" ]; then
  mkdir -p "$(dirname "${SRC}")"
  git clone --filter=blob:none --no-checkout https://github.com/Ephemeral-AI-Lab/layerfs.git "${SRC}"
fi
git -C "${SRC}" sparse-checkout set --no-cone '/core/' '!/core/docs/' '/sdk/js/' '/.cargo/'

for attempt in 1 2 3 4 5; do
  git -C "${SRC}" fetch --filter=blob:none origin "refs/pull/427/head" "${REF}" "${CHERRY_MOUNT}" "${CHERRY_APPLEDOUBLE}" "${CHERRY_OVERLAY}" && git -C "${SRC}" checkout --force --quiet "${REF}" && break
  echo "fetch/checkout failed (attempt ${attempt}); retrying in 5 s..." >&2
  sleep 5
  [ "${attempt}" = 5 ] && { echo "could not fetch LayerFS ${REF}; rerun this script to resume" >&2; exit 1; }
done

git -C "${SRC}" reset --hard "${REF}" && git -C "${SRC}" clean -fd
git -C "${SRC}" show "${CHERRY_MOUNT}" -- core/ | git -C "${SRC}" apply -
git -C "${SRC}" show "${CHERRY_APPLEDOUBLE}" -- core/ | git -C "${SRC}" apply -
git -C "${SRC}" show "${CHERRY_OVERLAY}" -- sdk/js/native/src/direct.rs | git -C "${SRC}" apply -

for f in core/Cargo.lock .cargo/config.toml sdk/js/src/index.js; do
  [ -f "${SRC}/${f}" ] || { echo "LayerFS checkout incomplete: missing ${f}; rerun to resume" >&2; exit 1; }
done

echo "==> Building layerfs-daemon + layerfs.node (macOS native, zero Docker)"
CARGO_PROFILE_RELEASE_STRIP=none cargo build --manifest-path "${SRC}/core/Cargo.toml" --release \
  -p layerfs-node --lib -p layerfs-daemon --bins

echo "==> Assembling native bundle -> ${BUNDLE}"
mkdir -p "${BUNDLE}/sdk/js/native"

TARGET_DIR="${SRC}/core/target/release"
if [ ! -d "${TARGET_DIR}" ] && [ -d "${SRC}/target/release" ]; then
  TARGET_DIR="${SRC}/target/release"
fi

cp "${TARGET_DIR}/layerfs-daemon" "${BUNDLE}/"
if [ -f "${TARGET_DIR}/liblayerfs_node.dylib" ]; then
  cp "${TARGET_DIR}/liblayerfs_node.dylib" "${BUNDLE}/layerfs.node"
  cp "${TARGET_DIR}/liblayerfs_node.dylib" "${BUNDLE}/sdk/js/native/layerfs.node"
elif [ -f "${TARGET_DIR}/liblayerfs_node.so" ]; then
  cp "${TARGET_DIR}/liblayerfs_node.so" "${BUNDLE}/layerfs.node"
  cp "${TARGET_DIR}/liblayerfs_node.so" "${BUNDLE}/sdk/js/native/layerfs.node"
fi
chmod +x "${BUNDLE}/layerfs-daemon" "${BUNDLE}/layerfs.node"

cp -R "${SRC}/sdk/js/src" "${SRC}/sdk/js/operator" "${SRC}/sdk/js/package.json" "${BUNDLE}/sdk/js/"

echo
echo "Done."
echo "  bundle: ${BUNDLE}"
