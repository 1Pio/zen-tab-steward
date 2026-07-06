import { homedir } from "node:os";
import { join } from "node:path";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function zenAppSupportDir(): string {
  if (process.env.ZTS_ZEN_APP_SUPPORT_DIR) return expandHome(process.env.ZTS_ZEN_APP_SUPPORT_DIR);
  return join(homedir(), "Library", "Application Support", "zen");
}

export function stateDir(): string {
  if (process.env.ZTS_STATE_DIR) return expandHome(process.env.ZTS_STATE_DIR);
  return join(homedir(), ".local", "state", "zen-tab-steward");
}

export function configPath(): string {
  if (process.env.ZTS_CONFIG_PATH) return expandHome(process.env.ZTS_CONFIG_PATH);
  return join(homedir(), ".config", "zen-tab-steward", "config.toml");
}
