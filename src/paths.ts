import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function zenAppSupportDir(): string {
  if (process.env.ZTS_ZEN_APP_SUPPORT_DIR) {
    return dedicatedAbsoluteOverride("ZTS_ZEN_APP_SUPPORT_DIR", process.env.ZTS_ZEN_APP_SUPPORT_DIR, "directory");
  }
  return join(homedir(), "Library", "Application Support", "zen");
}

export function stateDir(): string {
  if (process.env.ZTS_STATE_DIR) {
    return dedicatedAbsoluteOverride("ZTS_STATE_DIR", process.env.ZTS_STATE_DIR, "directory");
  }
  return join(homedir(), ".local", "state", "zen-tab-steward");
}

export function configPath(): string {
  if (process.env.ZTS_CONFIG_PATH) {
    return dedicatedAbsoluteOverride("ZTS_CONFIG_PATH", process.env.ZTS_CONFIG_PATH, "file");
  }
  return join(homedir(), ".config", "zen-tab-steward", "config.toml");
}

function dedicatedAbsoluteOverride(
  name: string,
  value: string,
  kind: "directory" | "file"
): string {
  if (value.includes("\0")) throw new Error(`${name} contains a null byte`);
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) throw new Error(`${name} must be an absolute path`);
  const normalized = resolve(expanded);
  const ownedDirectory = kind === "file" ? dirname(normalized) : normalized;
  const home = resolve(homedir());
  const dangerousRoots = new Set([
    resolve("/"),
    home,
    resolve(tmpdir()),
    resolve("/tmp"),
    resolve("/private/tmp"),
    resolve("/var/tmp"),
    ...[
      ".cache",
      ".config",
      ".local",
      "Desktop",
      "Developer",
      "Documents",
      "Downloads",
      "Library",
      "Movies",
      "Music",
      "Pictures",
      "Projects",
      "Public"
    ].map((segment) => resolve(home, segment))
  ]);
  if (dangerousRoots.has(ownedDirectory)) {
    throw new Error(`${name} must name a dedicated zts-owned ${kind === "file" ? "parent directory" : "directory"}`);
  }
  return normalized;
}
