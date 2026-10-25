import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Runs a CLI command to completion. */
export function run(
  cmd: string,
  args: string[],
  options: { input?: Buffer | string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`cannot run ${cmd}: ${e.message}`)));

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
