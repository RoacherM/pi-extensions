import { homedir } from "node:os";
import { join } from "node:path";

export interface LayerfsConfig {
  /** false only when the user explicitly opts out with PI_LAYERFS=0 */
  enabled: boolean;
  /** runtime sandbox mode: docker (default) or native (built-in NFSv3 loopback on macOS) */
  sandbox: "docker" | "native";
  /** outbound network access policy inside bash: allow (default), localhost, or deny */
  network: "allow" | "localhost" | "deny";
  /** optional custom mount helper / script for native NFS loopback */
  nfsMount?: string;
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
  /**
   * Paths that live only in LayerFS branches (build output, caches: e.g. target/, .cargo-home/):
   * never imported from the host, never seen by host sync (so a full sync does not delete them
   * from main), never written by apply. Visible to the agent inside its branch. Empty by default.
   */
  branchOnly: string[];
  /** team mode: agent-facing `layerfs` tool (+ `layerfs_apply` for the top-level session) */
  team: boolean;
  /** logical branch name alias (e.g. lead, or from PI_LAYERFS_BRANCH_NAME) */
  branchName?: string;
}

export const DEFAULT_EXCLUDES = [
  ".env", ".env.*", "*.pem", "*.key", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc", ".pypirc",
];

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): LayerfsConfig {
  const list = (value: string | undefined, fallback: string[]) =>
    value === undefined ? fallback : value.split(",").map((s) => s.trim()).filter(Boolean);
  const sandbox: "docker" | "native" = env.PI_LAYERFS_SANDBOX === "native" ? "native" : "docker";
  const network: "allow" | "localhost" | "deny" =
    env.PI_LAYERFS_NETWORK === "deny" || env.PI_LAYERFS_NETWORK === "offline"
      ? "deny"
      : env.PI_LAYERFS_NETWORK === "localhost"
        ? "localhost"
        : "allow";
  const defaultBundle = sandbox === "native"
    ? join(homedir(), ".cache/epi-layerfs/bundle-native")
    : join(homedir(), ".cache/epi-layerfs/bundle-5fb68dd");
  return {
    enabled: env.PI_LAYERFS !== "0",
    sandbox,
    network,
    nfsMount: env.PI_LAYERFS_NFS_MOUNT || undefined,
    bundle: env.PI_LAYERFS_BUNDLE ?? defaultBundle,
    image: env.PI_LAYERFS_IMAGE ?? "epi-lfs-runtime:node24-5fb68dd",
    docker: env.PI_LAYERFS_DOCKER ?? "docker",
    root: env.PI_LAYERFS_ROOT ?? join(homedir(), ".cache/pi-layerfs"),
    prefix: env.PI_LAYERFS_PREFIX ?? "pi-lfs-",
    excludes: list(env.PI_LAYERFS_EXCLUDES, DEFAULT_EXCLUDES),
    killGraceMs: Number(env.PI_LAYERFS_KILL_GRACE_MS ?? 2000),
    envAllow: list(env.PI_LAYERFS_ENV_ALLOW, ["TERM", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR"]),
    branchOnly: list(env.PI_LAYERFS_BRANCH_ONLY, []),
    team: env.PI_LAYERFS_TEAM === "1",
    branchName: env.PI_LAYERFS_BRANCH_NAME || undefined,
  };
}
