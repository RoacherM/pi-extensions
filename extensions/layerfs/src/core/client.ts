import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LayerfsConfig } from "../config.ts";

export interface NativeSpec {
  home: string;
  bundle: string;
  prefix: string;
  localDir: string;
  stores: string;
  nfsMount?: string;
}

export function ensureNativeDirs(config: LayerfsConfig): NativeSpec {
  const home = join(config.root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const localDir = join(config.root, "local");
  mkdirSync(localDir, { recursive: true, mode: 0o755 });
  try { chmodSync(localDir, 0o755); } catch {}
  const stores = join(config.root, "stores");
  mkdirSync(stores, { recursive: true, mode: 0o700 });
  return {
    home,
    bundle: config.bundle,
    prefix: config.prefix,
    localDir,
    stores,
    nfsMount: config.nfsMount,
  };
}

let sdkPromise: Promise<{ LayerFS: any; LayerFSError: any; isRefusal: any; CODES: any; LayerFSOperator: any }> | null = null;
let loadedBundle: string | null = null;

async function loadNativeSdk(bundle: string) {
  process.env.LAYERFS_NATIVE = join(bundle, "layerfs.node");
  process.env.LAYERFS_BUNDLE = bundle;
  process.env.LAYERFS_SANDBOX = "native";
  if (!sdkPromise || loadedBundle !== bundle) {
    loadedBundle = bundle;
    const sdkUrl = pathToFileURL(join(bundle, "sdk/js/src/index.js")).href;
    const opUrl = pathToFileURL(join(bundle, "sdk/js/operator/index.js")).href;
    sdkPromise = Promise.all([import(sdkUrl), import(opUrl)]).then(([sdk, op]) => ({ ...sdk, ...op }));
  }
  return sdkPromise;
}

export async function createProjectClient(spec: NativeSpec, project: { name: string; volume: string }) {
  const { LayerFS, LayerFSOperator, LayerFSError, isRefusal } = await loadNativeSdk(spec.bundle);
  const storeDir = join(spec.stores, project.volume);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const storePath = join(storeDir, "global", "store.sqlite");
  if (spec.nfsMount) process.env.LAYERFS_NFS_MOUNT = spec.nfsMount;
  else delete process.env.LAYERFS_NFS_MOUNT;
  const envVars: Record<string, string> = {
    HOME: spec.home,
    SANDBOX: "native",
    DAEMON: join(spec.bundle, "layerfs-daemon"),
    LOCAL_DIR: spec.localDir,
    VOLUME: project.volume,
    STORE_PATH: storePath,
    CONTAINER_PREFIX: spec.prefix,
  };

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[`LAYERFS_${k}`];
    process.env[`LAYERFS_${k}`] = v;
  }
  try {
    const lfs = new LayerFS(project.name, {
      storePath,
      sandbox: "native",
      localDir: spec.localDir,
      daemon: join(spec.bundle, "layerfs-daemon"),
      containerPrefix: spec.prefix,
    });
    const operator = new LayerFSOperator(lfs);
    return { lfs, operator, LayerFSError, isRefusal };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[`LAYERFS_${k}`];
      else process.env[`LAYERFS_${k}`] = v;
    }
  }
}
