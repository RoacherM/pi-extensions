import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface SeatbeltOptions {
  wsPath: string;
  hostCwd: string;
  scratchDir: string;
  configRoot?: string;
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
export function globToSbplRegex(glob: string, base?: string): string | null {
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
    if (c === "*" && pat[i + 1] === "*") {
      if (pat[i + 2] === "/") {
        rx += "(.*/)?";
        i += 2;
      } else {
        rx += ".*";
        i += 1;
      }
    } else if (c === "*") {
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

  if (base !== undefined) {
    const baseRx = esc(base);
    if (anchored) {
      return `^${baseRx}/${rx}($|/.*)`;
    } else {
      return `^${baseRx}/(.*/)?${rx}($|/.*)`;
    }
  }
  return rx;
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
  const { wsPath, hostCwd, scratchDir, configRoot, excludes, outsideSecrets, network, logTag } = options;

  const wsSpellings = bothSpellings(wsPath);
  const hostSpellings = bothSpellings(hostCwd);
  const scratchSpellings = bothSpellings(scratchDir);
  const homeSpellings = bothSpellings(homedir());
  const configSpellings = configRoot ? bothSpellings(configRoot) : [];

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const lines: string[] = [
    "(version 1)",
    logTag ? `;; Log tag: ${logTag}` : ";; Claude Code (srt)-style macOS Seatbelt Sandbox Policy",
    // 1. allow default
    "(allow default)",
    "",
  ];

  // Process Execution & Mount Syscall Lockdown (deny file-mount/file-unmount and mount binaries)
  lines.push(
    ";; --- Process Execution & Mount Syscall Lockdown ---",
    "(deny file-mount)",
    "(deny file-unmount)",
    "(deny process-exec",
    '  (literal "/sbin/mount_nfs")',
    '  (literal "/sbin/umount")',
    '  (literal "/usr/sbin/diskutil")',
    ")",
    "",
  );

  // Network Isolation
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

  // 2. If configRoot: (deny file-read* file-write* (subpath configRoot))
  if (configSpellings.length > 0) {
    lines.push(";; 2. Deny read & write on configRoot");
    const denies = configSpellings.map((r) => `  (subpath "${escapeLiteral(r)}")`);
    lines.push(`(deny file-read* file-write*\n${denies.join("\n")}\n)`);
  }

  // 3. (allow file-read* (subpath wsPath) (subpath scratchDir))
  if (configSpellings.length > 0) {
    lines.push(";; 3. Re-allow file-read* for wsPath and scratchDir inside configRoot");
    const readAllows: string[] = [];
    for (const w of wsSpellings) readAllows.push(`  (subpath "${escapeLiteral(w)}")`);
    for (const s of scratchSpellings) readAllows.push(`  (subpath "${escapeLiteral(s)}")`);
    lines.push(`(allow file-read*\n${readAllows.join("\n")}\n)`);
  }

  // 4. Filesystem Write Lockdown
  lines.push(";; 4. Deny all file writes");
  lines.push("(deny file-write*)");

  // 5. Allow standard write paths (/tmp, /var/folders, /dev/...)
  lines.push(";; 5. Allow standard temporary & device write paths");
  const stdWriteAllows = [
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
  ];
  lines.push(`(allow file-write*\n${stdWriteAllows.join("\n")}\n)`);

  // 6. If hostCwd !== "/": (deny file-write* (subpath hostCwd)) unconditionally!
  if (hostCwd !== "/") {
    lines.push(";; 6. Protect host cwd unconditionally against writes");
    const hostDenies = hostSpellings.map((h) => `  (subpath "${escapeLiteral(h)}")`);
    lines.push(`(deny file-write*\n${hostDenies.join("\n")}\n)`);
  }

  // 7. If configRoot: (deny file-write* (subpath configRoot))
  if (configSpellings.length > 0) {
    lines.push(";; 7. Protect configRoot against writes");
    const configDenies = configSpellings.map((r) => `  (subpath "${escapeLiteral(r)}")`);
    lines.push(`(deny file-write*\n${configDenies.join("\n")}\n)`);
  }

  // 8. (allow file-write* (subpath wsPath) (subpath scratchDir))
  lines.push(";; 8. Re-allow writes to wsPath and scratchDir");
  const wsScratchAllows: string[] = [];
  for (const w of wsSpellings) wsScratchAllows.push(`  (subpath "${escapeLiteral(w)}")`);
  for (const s of scratchSpellings) wsScratchAllows.push(`  (subpath "${escapeLiteral(s)}")`);
  lines.push(`(allow file-write*\n${wsScratchAllows.join("\n")}\n)`);

  // 9. Mandatory write denies inside wsPath: .lww, .git/hooks, .git/config, excludes, plus file-write-unlink on .git!
  lines.push(";; 9. Mandatory write denies inside wsPath");
  const hookLwwDenies: string[] = [];
  const hookLwwUnlinkDenies: string[] = [];
  for (const w of wsSpellings) {
    hookLwwDenies.push(
      `  (literal "${escapeLiteral(join(w, ".lww"))}")`,
      `  (subpath "${escapeLiteral(join(w, ".git", "hooks"))}")`,
      `  (literal "${escapeLiteral(join(w, ".git", "config"))}")`,
    );
    hookLwwUnlinkDenies.push(
      `  (literal "${escapeLiteral(join(w, ".git"))}")`,
      `  (literal "${escapeLiteral(join(w, ".git", "hooks"))}")`,
      `  (literal "${escapeLiteral(join(w, ".git", "config"))}")`,
      `  (literal "${escapeLiteral(join(w, ".git", "info"))}")`,
      `  (literal "${escapeLiteral(join(w, ".git", "info", "exclude"))}")`,
      `  (literal "${escapeLiteral(join(w, ".lww"))}")`,
    );
  }
  lines.push(
    `(deny file-write*\n${hookLwwDenies.join("\n")}\n)`,
    `(deny file-write-unlink\n${hookLwwUnlinkDenies.join("\n")}\n)`,
  );

  // 9b. Excludes inside wsPath: deny writing or unlinking
  const flatExcludes = excludes.flatMap(expandBraces).filter(Boolean);
  const wsExcludeRegexes: string[] = [];
  const wsUnlinkRegexes: string[] = [];
  for (const w of wsSpellings) {
    const escW = esc(w);
    for (const rawPat of flatExcludes) {
      const dirOnly = rawPat.trim().endsWith("/");
      const pat = rawPat.trim().replace(/\/+$/, "");
      const anchored = pat.startsWith("/") || pat.includes("/");
      const rx = globToSbplRegex(pat);
      if (rx) {
        const fullRx = anchored ? `^${escW}/${rx}($|/.*)` : `^${escW}/(.*/)?${rx}($|/.*)`;
        wsExcludeRegexes.push(`  (regex #"${fullRx}")`);
        if (dirOnly) {
          const dirRx = anchored ? `^${escW}/${rx}$` : `^${escW}/(.*/)?${rx}$`;
          wsUnlinkRegexes.push(`  (regex #"${dirRx}")`);
        }
      }
    }
  }
  if (wsExcludeRegexes.length > 0) {
    lines.push(
      `(deny file-write*\n${wsExcludeRegexes.join("\n")}\n)`,
      `(deny file-write-unlink\n${[...wsExcludeRegexes, ...wsUnlinkRegexes].join("\n")}\n)`,
    );
  }
  lines.push("");

  // 10. Read denies (deny file-read-data and deny file-write-unlink)
  lines.push(";; 10. Filesystem Read Denies & Move-Blocking ---");

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
    const escBase = esc(base);
    for (const rawPat of flatExcludes) {
      const dirOnly = rawPat.trim().endsWith("/");
      const pat = rawPat.trim().replace(/\/+$/, "");
      const anchored = pat.startsWith("/") || pat.includes("/");
      const rx = globToSbplRegex(pat);
      if (rx) {
        const fullRx = anchored ? `^${escBase}/${rx}($|/.*)` : `^${escBase}/(.*/)?${rx}($|/.*)`;
        allSecretRegexes.push(`  (regex #"${fullRx}")`);
        if (dirOnly) {
          const dirRx = anchored ? `^${escBase}/${rx}$` : `^${escBase}/(.*/)?${rx}$`;
          allSecretRegexes.push(`  (regex #"${dirRx}")`);
        }
      }
    }
  }

  // Global unanchored exclude patterns (e.g. .env, *.pem, *.key), carving out system CA certificate roots
  // so HTTPS tools (curl, git, pip, cargo) can still read /private/etc/ssl/cert.pem, Homebrew openssl certs, and certifi.
  const caCarveOut = [
    '(require-not (subpath "/private/etc"))',
    '(require-not (subpath "/etc"))',
    '(require-not (subpath "/System"))',
    '(require-not (subpath "/usr"))',
    '(require-not (subpath "/Library"))',
    '(require-not (subpath "/opt/homebrew"))',
    '(require-not (regex #"/certifi/cacert\\.[pP][eE][mM]$"))',
  ].join(" ");
  const globalUnanchoredRegexes: string[] = [];
  for (const rawPat of flatExcludes) {
    const dirOnly = rawPat.trim().endsWith("/");
    const pat = rawPat.trim().replace(/\/+$/, "");
    if (pat && !pat.includes("/") && !pat.startsWith("/")) {
      const rx = globToSbplRegex(pat);
      if (rx) {
        globalUnanchoredRegexes.push(`  (require-all (regex #"^/(.*/)?${rx}($|/.*)") ${caCarveOut})`);
        if (dirOnly) {
          globalUnanchoredRegexes.push(`  (require-all (regex #"^/(.*/)?${rx}$") ${caCarveOut})`);
        }
      }
    }
  }

  const allReadDenies = [...homeSecretDenies, ...allSecretRegexes, ...globalUnanchoredRegexes];
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
