import { homedir } from "node:os";
import { join } from "node:path";

export interface LayerfsConfig {
  /** false only when the user explicitly opts out with PI_LAYERFS=0 */
  enabled: boolean;
  /** folder with layerfs-daemon, layerfs.node and sdk/js (built from source) */
  bundle: string;
  /** runtime image tag or id for the Store container and Sandboxes */
  image: string;
  docker: string;
  /** private state: LayerFS home, bindings, manifests, staging */
  root: string;
  /** container / volume name prefix (Store container is <prefix>store) */
  prefix: string;
  /** host paths never imported into a session or overwritten by apply */
  excludes: string[];
  /** TERM -> KILL grace when cancelling a command */
  killGraceMs: number;
  /** env vars forwarded into commands (besides PI_*) */
  envAllow: string[];
}

export const DEFAULT_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", ".pypirc",
];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LayerfsConfig {
  const list = (value: string | undefined, fallback: string[]) =>
    value === undefined ? fallback : value.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    enabled: env.PI_LAYERFS !== "0",
    bundle: env.PI_LAYERFS_BUNDLE ?? join(homedir(), ".cache/epi-layerfs/bundle-5fb68dd"),
    image: env.PI_LAYERFS_IMAGE ?? "epi-lfs-runtime:node24-5fb68dd",
    docker: env.PI_LAYERFS_DOCKER ?? "docker",
    root: env.PI_LAYERFS_ROOT ?? join(homedir(), ".cache/pi-layerfs"),
    prefix: env.PI_LAYERFS_PREFIX ?? "pi-lfs-",
    excludes: list(env.PI_LAYERFS_EXCLUDES, DEFAULT_EXCLUDES),
    killGraceMs: Number(env.PI_LAYERFS_KILL_GRACE_MS ?? 2000),
    envAllow: list(env.PI_LAYERFS_ENV_ALLOW, ["TERM", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR"]),
  };
}
