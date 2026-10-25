import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DAEMON_HOST, ensureBox, storeName, storePathOf } from "../box.js";
import type { LayerfsConfig } from "../config.ts";
import { onUnreachable } from "./binding.js";

const BINDING_PATH = fileURLToPath(new URL("./binding.js", import.meta.url));
let sdkPromise: Promise<{ LayerFS: any; LayerFSError: any; isRefusal: any; CODES: any; LayerFSOperator: any }> | null = null;
let loadedBundle: string | null = null;
let unhookHeal: (() => void) | null = null;

export interface BoxSpec {
  docker: string;
  home: string;
  bundle: string;
  image: string;
  prefix: string;
  box: string;
  native?: boolean;
  localDir?: string;
  stores?: string;
  nfsMount?: string;
}

export function boxSpecOf(config: LayerfsConfig, imageId: string): BoxSpec {
  const home = join(config.root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (config.sandbox === "native") {
    const localDir = join(config.root, "local");
    mkdirSync(localDir, { recursive: true, mode: 0o755 });
    try { chmodSync(localDir, 0o755); } catch {}
    const stores = join(config.root, "stores");
    mkdirSync(stores, { recursive: true, mode: 0o700 });
    return {
      docker: "",
      home,
      bundle: config.bundle,
      image: "native",
      prefix: config.prefix,
      box: "",
      native: true,
      localDir,
      stores,
      nfsMount: config.nfsMount,
    };
  }
  return {
    docker: "/var/run/docker.sock",
    home,
    bundle: config.bundle,
    image: imageId,
    prefix: config.prefix,
    box: storeName(config.prefix),
  };
}

export async function ensureStoreBox(config: LayerfsConfig, imageId: string): Promise<BoxSpec> {
  const spec = boxSpecOf(config, imageId);
  if (config.sandbox === "native") {
    process.env.LAYERFS_NATIVE = join(config.bundle, "layerfs.node");
    process.env.LAYERFS_BUNDLE = config.bundle;
    process.env.LAYERFS_SANDBOX = "native";
    if (config.nfsMount) process.env.LAYERFS_NFS_MOUNT = config.nfsMount;
    return spec;
  }
  delete process.env.LAYERFS_SANDBOX;
  delete process.env.LAYERFS_NFS_MOUNT;
  process.env.LAYERFS_NATIVE = BINDING_PATH;
  process.env.LAYERFS_BUNDLE = spec.bundle;
  process.env.LAYERFS_STORE_CONTAINER = spec.box;
  await ensureBox(spec);
  if (unhookHeal) unhookHeal();
  let healing: Promise<void> | null = null;
  unhookHeal = onUnreachable(() => {
    healing ??= ensureBox(spec).catch(() => {}).finally(() => { healing = null; });
  });
  return spec;
}

async function loadSdk(bundle: string, isNative = false) {
  process.env.LAYERFS_NATIVE = isNative ? join(bundle, "layerfs.node") : BINDING_PATH;
  process.env.LAYERFS_BUNDLE = bundle;
  const key = `${bundle}:${isNative ? "native" : "docker"}`;
  if (!sdkPromise || loadedBundle !== key) {
    loadedBundle = key;
    const sdkUrl = pathToFileURL(join(bundle, "sdk/js/src/index.js")).href;
    const opUrl = pathToFileURL(join(bundle, "sdk/js/operator/index.js")).href;
    sdkPromise = Promise.all([import(sdkUrl), import(opUrl)]).then(([sdk, op]) => ({ ...sdk, ...op }));
  }
  return sdkPromise;
}

export async function createProjectClient(spec: BoxSpec, project: { name: string; volume: string; image?: string }) {
  const { LayerFS, LayerFSOperator, LayerFSError, isRefusal } = await loadSdk(spec.bundle, Boolean(spec.native));
  if (spec.native) {
    const storeDir = join(spec.stores!, project.volume);
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    const storePath = join(storeDir, "global", "store.sqlite");
    const envVars: Record<string, string> = {
      HOME: spec.home,
      SANDBOX: "native",
      DAEMON: join(spec.bundle, "layerfs-daemon"),
      LOCAL_DIR: spec.localDir!,
      VOLUME: project.volume,
      STORE_PATH: storePath,
      CONTAINER_PREFIX: spec.prefix,
    };
    if (spec.nfsMount) envVars.NFS_MOUNT = spec.nfsMount;
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

  process.env.LAYERFS_STORE_CONTAINER = spec.box;
  process.env.LAYERFS_BUNDLE = spec.bundle;
  const envVars: Record<string, string> = {
    HOME: spec.home,
    DOCKER: spec.docker,
    IMAGE: project.image ?? spec.image,
    DAEMON: join(spec.bundle, "layerfs-daemon"),
    VOLUME: project.volume,
    STORE_PATH: storePathOf(project.volume),
    CONTAINER_PREFIX: spec.prefix,
    DAEMON_HOST,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[`LAYERFS_${k}`];
    process.env[`LAYERFS_${k}`] = v;
  }
  try {
    const lfs = new LayerFS(project.name, {
      storePath: envVars.STORE_PATH,
      daemonHost: DAEMON_HOST,
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
