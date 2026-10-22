import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export class DockerError extends Error {
  result?: RunResult;
  constructor(message: string, result?: RunResult) {
    super(message);
    this.result = result;
  }
}

/** Runs one docker CLI command to completion. Never inherits the host env beyond PATH/HOME/DOCKER_*. */
export function run(docker: string, args: string[], options: { input?: Buffer | string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, args, { stdio: ["pipe", "pipe", "pipe"], env: dockerEnv() });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new DockerError(`cannot run ${docker}: ${e.message}`)));
    const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? undefined);
  });
}

export async function ok(docker: string, args: string[], options?: Parameters<typeof run>[2]): Promise<Buffer> {
  const r = await run(docker, args, options);
  if (r.code !== 0) throw new DockerError(`docker ${args.slice(0, 2).join(" ")} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`, r);
  return r.stdout;
}

export function dockerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "PATH" || k === "HOME" || k === "USER" || k.startsWith("DOCKER_")) env[k] = v;
  }
  return env;
}
