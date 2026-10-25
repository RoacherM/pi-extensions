import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface SeatbeltOptions {
  wsPath: string;
  hostCwd: string;
  scratchDir: string;
  excludes: string[];
  outsideSecrets: string[];
  network: "allow" | "localhost" | "deny";
  logTag?: string;
}

/**
 * Normalizes a path to include all macOS spellings (/tmp vs /private/tmp, /var vs /private/var,
 * symlink target vs realpath).
 */
export function bothSpellings(p: string): string[] {
  const resolved = resolve(p);
  const out = new Set<string>([resolved]);
  try {
    out.add(realpathSync(resolved));
  } catch {
    try {
      const parent = dirname(resolved);
      const realParent = realpathSync(parent);
      out.add(join(realParent, basename(resolved)));
    } catch {}
  }
  for (const s of [...out]) {
    if (s.startsWith("/private/tmp/")) {
      out.add(s.slice("/private".length));
    } else if (s.startsWith("/tmp/")) {
      out.add("/private" + s);
    } else if (s.startsWith("/private/var/")) {
      out.add(s.slice("/private".length));
    } else if (s.startsWith("/var/")) {
      out.add("/private" + s);
    }
  }
  return [...out];
}

export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  const prefix = pattern.slice(0, m.index);
  const suffix = pattern.slice(m.index + m[0].length);
  return m[1].split(",").flatMap((part) => expandBraces(`${prefix}${part}${suffix}`));
}

/**
 * Converts a glob pattern (e.g. ".env", ".env.*", "*.pem", "secrets/*.key") into an anchored
 * case-insensitive SBPL regex pattern under base.
 *
 * macOS Seatbelt regex does not support (?i) prefix, so letters are emitted as [aA] character
 * classes to ensure case-insensitivity at the kernel level.
 */
export function globToSbplRegex(glob: string, base: string): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let pat = glob.trim();
  if (!pat) return null;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  const anchored = pat.startsWith("/") || pat.includes("/");
  pat = pat.replace(/^\/+/, "");

  let rx = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      rx += "[^/]*";
    } else if (c === "?") {
      rx += "[^/]";
    } else if (/[a-zA-Z]/.test(c)) {
      rx += `[${c.toLowerCase()}${c.toUpperCase()}]`;
    } else if (/[.*+?^${}()|[\]\\]/.test(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
  }

  const baseRx = esc(base);
  if (anchored) {
    return `^${baseRx}/${rx}($|/.*)`;
  } else {
    return `^${baseRx}/(.*/)?${rx}($|/.*)`;
  }
}

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Builds a Claude Code (`srt`)-inspired macOS Seatbelt (`sandbox-exec`) SBPL profile.
 *
 * Rule evaluation order (last-match-wins):
 * 1. (version 1)
 * 2. (allow default)
 * 3. Network isolation: deny all or allow localhost/unix-socket only.
 * 4. Filesystem write lockdown: deny all file-write*, allow only wsPath, scratchDir, /tmp,
 *    /var/folders, /dev null/zero/tty/urandom/random; then mandatory write denies for hostCwd,
 *    wsPath/.lww, wsPath/.git/hooks, and wsPath excludes.
 * 5. Filesystem read denies & move-blocking: deny file-read-data and file-write-unlink on
 *    outside secrets under $HOME and excludes under hostCwd and wsPath, while keeping
 *    directory metadata traversal allowed.
 */
export function buildSeatbeltProfile(options: SeatbeltOptions): string {
  const { wsPath, hostCwd, scratchDir, excludes, outsideSecrets, network, logTag } = options;

  const wsSpellings = bothSpellings(wsPath);
  const hostSpellings = bothSpellings(hostCwd);
  const scratchSpellings = bothSpellings(scratchDir);
  const homeSpellings = bothSpellings(homedir());

  const lines: string[] = [
    "(version 1)",
    logTag ? `;; Log tag: ${logTag}` : ";; Claude Code (srt)-style macOS Seatbelt Sandbox Policy",
    "(allow default)",
    "",
  ];

  // 3. Network Isolation
  lines.push(";; --- Network Isolation ---");
  if (network === "deny") {
    lines.push("(deny network-outbound)");
  } else if (network === "localhost") {
    lines.push(
      "(deny network-outbound)",
      '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
    );
  }
  lines.push("");

  // 4. Filesystem Write Lockdown
  lines.push(";; --- Filesystem Write Lockdown ---");
  lines.push("(deny file-write*)");

  const writeAllows: string[] = [];
  for (const w of wsSpellings) writeAllows.push(`  (subpath "${escapeLiteral(w)}")`);
  for (const s of scratchSpellings) writeAllows.push(`  (subpath "${escapeLiteral(s)}")`);
  writeAllows.push(
    '  (subpath "/private/tmp")',
    '  (subpath "/tmp")',
    '  (subpath "/private/var/folders")',
    '  (subpath "/var/folders")',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/dtracehelper")',
    '  (literal "/dev/urandom")',
    '  (literal "/dev/random")',
  );
  lines.push(`(allow file-write*\n${writeAllows.join("\n")}\n)`);

  // Mandatory write denies:
  lines.push(";; Mandatory write denies (last-match-wins over allow)");

  // 4a. Protect user's real project folder on the host
  const wsInsideHost = wsSpellings.some((w) => hostSpellings.some((h) => w.startsWith(`${h}/`)));
  if (!wsInsideHost) {
    const hostDenies = hostSpellings.map((h) => `  (subpath "${escapeLiteral(h)}")`);
    lines.push(`(deny file-write*\n${hostDenies.join("\n")}\n)`);
  }

  // 4b. Protect .lww and .git/hooks inside wsPath
  const hookLwwDenies: string[] = [];
  for (const w of wsSpellings) {
    hookLwwDenies.push(`  (literal "${escapeLiteral(join(w, ".lww"))}")`);
    hookLwwDenies.push(`  (subpath "${escapeLiteral(join(w, ".git", "hooks"))}")`);
  }
  lines.push(`(deny file-write*\n${hookLwwDenies.join("\n")}\n)`);

  // 4c. Deny writing or unlinking excludes in workspace
  const flatExcludes = excludes.flatMap(expandBraces).filter(Boolean);
  const wsExcludeRegexes: string[] = [];
  for (const w of wsSpellings) {
    for (const pat of flatExcludes) {
      const rx = globToSbplRegex(pat, w);
      if (rx) wsExcludeRegexes.push(`  (regex #"${rx}")`);
    }
  }
  if (wsExcludeRegexes.length > 0) {
    lines.push(
      `(deny file-write*\n${wsExcludeRegexes.join("\n")}\n)`,
      `(deny file-write-unlink\n${wsExcludeRegexes.join("\n")}\n)`,
    );
  }
  lines.push("");

  // 5. Filesystem Read Denies & Move-Blocking
  lines.push(";; --- Filesystem Read Denies & Move-Blocking ---");

  // Outside secrets under $HOME
  const homeSecretDenies: string[] = [];
  for (const h of homeSpellings) {
    for (const sec of outsideSecrets) {
      const p = join(h, sec);
      homeSecretDenies.push(`  (subpath "${escapeLiteral(p)}")`);
      homeSecretDenies.push(`  (literal "${escapeLiteral(p)}")`);
    }
  }

  // Excludes under hostCwd and wsPath
  const allSecretRegexes: string[] = [];
  for (const base of [...new Set([...hostSpellings, ...wsSpellings])]) {
    for (const pat of flatExcludes) {
      const rx = globToSbplRegex(pat, base);
      if (rx) allSecretRegexes.push(`  (regex #"${rx}")`);
    }
  }

  const allReadDenies = [...homeSecretDenies, ...allSecretRegexes];
  if (allReadDenies.length > 0) {
    lines.push(
      `(deny file-read-data\n${allReadDenies.join("\n")}\n)`,
      `(deny file-write-unlink\n${allReadDenies.join("\n")}\n)`,
    );
  }

  // Allow directory traversal so realpath() / pwd / opendir always work
  lines.push(
    ";; Directory metadata traversal",
    "(allow file-read-metadata (vnode-type DIRECTORY))",
    "",
  );

  return lines.join("\n");
}
