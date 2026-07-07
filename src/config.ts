import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.js";

export interface ZtsConfig {
  defaults: {
    inbox: string;
    minConfidence: number;
    includePinned: boolean;
    includeEssentials: boolean;
    applyBackend: "auto" | "live" | "session";
  };
  sort: {
    from: string[];
    to: string[];
    notTo: string[];
    only: string[];
    except: string[];
  };
  protect: {
    workspaces: {
      from: string[];
      to: string[];
    };
    domains: {
      neverMove: string[];
    };
  };
  rules: {
    domains: Record<string, string>;
  };
  embeddings: {
    provider: "built-in" | "bge-small" | "hybrid";
    allowDownload: boolean;
    model: string;
    cacheDir: string;
    weights: {
      title: number;
      url: number;
      domain: number;
      description: number;
    };
  };
  semantic: {
    enabled: boolean;
    autoIndex: boolean;
    minConfidence: number;
    minMargin: number;
    reviewOnTie: boolean;
  };
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: ZtsConfig;
  contents: string;
}

export const DEFAULT_CONFIG: ZtsConfig = {
  defaults: {
    inbox: "Space",
    minConfidence: 0.8,
    includePinned: false,
    includeEssentials: false,
    applyBackend: "auto"
  },
  sort: {
    from: [],
    to: [],
    notTo: [],
    only: [],
    except: []
  },
  protect: {
    workspaces: {
      from: [],
      to: []
    },
    domains: {
      neverMove: []
    }
  },
  rules: {
    domains: {}
  },
  embeddings: {
    provider: "built-in",
    allowDownload: false,
    model: "Xenova/bge-small-en-v1.5",
    cacheDir: "~/.cache/zen-tab-steward/models",
    weights: { title: 1.0, url: 0.7, domain: 1.2, description: 0.6 }
  },
  semantic: {
    enabled: false,
    autoIndex: false,
    minConfidence: 0.78,
    minMargin: 0.1,
    reviewOnTie: true
  }
};

export async function loadConfig(): Promise<LoadedConfig> {
  const path = configPath();
  try {
    const contents = await readFile(path, "utf8");
    return { path, exists: true, config: parseConfig(contents), contents };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, config: structuredClone(DEFAULT_CONFIG), contents: "" };
    }
    throw error;
  }
}

export async function saveConfig(config: ZtsConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatConfig(config), "utf8");
  return path;
}

export async function saveConfigContents(contents: string): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
  return path;
}

export function parseConfig(contents: string): ZtsConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  let section = "";

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = unquote(line.slice(0, separator).trim());
    const value = parseValue(stripInlineComment(line.slice(separator + 1)).trim());

    if (section === "defaults") setDefault(config, key, value);
    if (section === "sort") setSort(config, key, value);
    if (section === "protect.workspaces") setProtectWorkspace(config, key, value);
    if (section === "protect.domains") setProtectDomain(config, key, value);
    if (section === "rules.domains" && typeof value === "string") config.rules.domains[key] = value;
    if (section === "embeddings") setEmbeddings(config, key, value);
    if (section === "embeddings.weights") setEmbeddingsWeights(config, key, value);
    if (section === "semantic") setSemantic(config, key, value);
  }

  return config;
}

export function formatConfig(config: ZtsConfig): string {
  const lines = [
    "[defaults]",
    `inbox = ${quote(config.defaults.inbox)}`,
    `min_confidence = ${formatPrimitive(config.defaults.minConfidence)}`,
    `include_pinned = ${formatPrimitive(config.defaults.includePinned)}`,
    `include_essentials = ${formatPrimitive(config.defaults.includeEssentials)}`,
    `apply_backend = ${quote(config.defaults.applyBackend)}`,
    "",
    "[sort]",
    `from = ${formatArray(config.sort.from)}`,
    `to = ${formatArray(config.sort.to)}`,
    `not_to = ${formatArray(config.sort.notTo)}`,
    `only = ${formatArray(config.sort.only)}`,
    `except = ${formatArray(config.sort.except)}`,
    "",
    "[protect.workspaces]",
    `from = ${formatArray(config.protect.workspaces.from)}`,
    `to = ${formatArray(config.protect.workspaces.to)}`,
    "",
    "[protect.domains]",
    `never_move = ${formatArray(config.protect.domains.neverMove)}`,
    "",
    "[embeddings]",
    `provider = ${quote(config.embeddings.provider)}`,
    `allow_download = ${formatPrimitive(config.embeddings.allowDownload)}`,
    `model = ${quote(config.embeddings.model)}`,
    `cache_dir = ${quote(config.embeddings.cacheDir)}`,
    "",
    "[embeddings.weights]",
    `title = ${formatPrimitive(config.embeddings.weights.title)}`,
    `url = ${formatPrimitive(config.embeddings.weights.url)}`,
    `domain = ${formatPrimitive(config.embeddings.weights.domain)}`,
    `description = ${formatPrimitive(config.embeddings.weights.description)}`,
    "",
    "[semantic]",
    `enabled = ${formatPrimitive(config.semantic.enabled)}`,
    `auto_index = ${formatPrimitive(config.semantic.autoIndex)}`,
    `min_confidence = ${formatPrimitive(config.semantic.minConfidence)}`,
    `min_margin = ${formatPrimitive(config.semantic.minMargin)}`,
    `review_on_tie = ${formatPrimitive(config.semantic.reviewOnTie)}`,
    "",
    "[rules.domains]"
  ];

  for (const [domain, workspace] of Object.entries(config.rules.domains).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${quote(domain)} = ${quote(workspace)}`);
  }

  return `${lines.join("\n")}\n`;
}

export function getConfigValue(config: ZtsConfig, keyPath: string): unknown {
  if (keyPath === "defaults.inbox") return config.defaults.inbox;
  if (keyPath === "defaults.min_confidence") return config.defaults.minConfidence;
  if (keyPath === "defaults.include_pinned") return config.defaults.includePinned;
  if (keyPath === "defaults.include_essentials") return config.defaults.includeEssentials;
  if (keyPath === "defaults.apply_backend") return config.defaults.applyBackend;
  if (keyPath === "sort.from") return config.sort.from;
  if (keyPath === "sort.to") return config.sort.to;
  if (keyPath === "sort.not_to") return config.sort.notTo;
  if (keyPath === "sort.only") return config.sort.only;
  if (keyPath === "sort.except") return config.sort.except;
  if (keyPath === "protect.workspaces.from") return config.protect.workspaces.from;
  if (keyPath === "protect.workspaces.to") return config.protect.workspaces.to;
  if (keyPath === "protect.domains.never_move") return config.protect.domains.neverMove;
  if (keyPath.startsWith("rules.domains.")) {
    return config.rules.domains[keyPath.slice("rules.domains.".length)];
  }
  if (keyPath === "embeddings.provider") return config.embeddings.provider;
  if (keyPath === "embeddings.allow_download") return config.embeddings.allowDownload;
  if (keyPath === "embeddings.model") return config.embeddings.model;
  if (keyPath === "embeddings.cache_dir") return config.embeddings.cacheDir;
  if (keyPath === "embeddings.weights.title") return config.embeddings.weights.title;
  if (keyPath === "embeddings.weights.url") return config.embeddings.weights.url;
  if (keyPath === "embeddings.weights.domain") return config.embeddings.weights.domain;
  if (keyPath === "embeddings.weights.description") return config.embeddings.weights.description;
  if (keyPath === "semantic.enabled") return config.semantic.enabled;
  if (keyPath === "semantic.auto_index") return config.semantic.autoIndex;
  if (keyPath === "semantic.min_confidence") return config.semantic.minConfidence;
  if (keyPath === "semantic.min_margin") return config.semantic.minMargin;
  if (keyPath === "semantic.review_on_tie") return config.semantic.reviewOnTie;
  throw new Error(`Unsupported config key: ${keyPath}`);
}

export function setConfigValue(config: ZtsConfig, keyPath: string, rawValue: string): ZtsConfig {
  const next = structuredClone(config);
  if (keyPath === "defaults.inbox") next.defaults.inbox = rawValue;
  else if (keyPath === "defaults.min_confidence") next.defaults.minConfidence = parseConfidence(rawValue);
  else if (keyPath === "defaults.include_pinned") next.defaults.includePinned = parseBoolean(rawValue);
  else if (keyPath === "defaults.include_essentials") next.defaults.includeEssentials = parseBoolean(rawValue);
  else if (keyPath === "defaults.apply_backend") next.defaults.applyBackend = parseBackend(rawValue);
  else if (keyPath === "sort.from") next.sort.from = parseStringArray(rawValue);
  else if (keyPath === "sort.to") next.sort.to = parseStringArray(rawValue);
  else if (keyPath === "sort.not_to") next.sort.notTo = parseStringArray(rawValue);
  else if (keyPath === "sort.only") next.sort.only = parseStringArray(rawValue);
  else if (keyPath === "sort.except") next.sort.except = parseStringArray(rawValue);
  else if (keyPath === "protect.workspaces.from") next.protect.workspaces.from = parseStringArray(rawValue);
  else if (keyPath === "protect.workspaces.to") next.protect.workspaces.to = parseStringArray(rawValue);
  else if (keyPath === "protect.domains.never_move") next.protect.domains.neverMove = parseStringArray(rawValue);
  else if (keyPath === "embeddings.provider") next.embeddings.provider = parseProvider(rawValue);
  else if (keyPath === "embeddings.allow_download") next.embeddings.allowDownload = parseBoolean(rawValue);
  else if (keyPath === "embeddings.model") next.embeddings.model = rawValue;
  else if (keyPath === "embeddings.cache_dir") next.embeddings.cacheDir = rawValue;
  else if (keyPath === "embeddings.weights.title") next.embeddings.weights.title = Number(rawValue);
  else if (keyPath === "embeddings.weights.url") next.embeddings.weights.url = Number(rawValue);
  else if (keyPath === "embeddings.weights.domain") next.embeddings.weights.domain = Number(rawValue);
  else if (keyPath === "embeddings.weights.description") next.embeddings.weights.description = Number(rawValue);
  else if (keyPath === "semantic.enabled") next.semantic.enabled = parseBoolean(rawValue);
  else if (keyPath === "semantic.auto_index") next.semantic.autoIndex = parseBoolean(rawValue);
  else if (keyPath === "semantic.min_confidence") next.semantic.minConfidence = parseConfidence(rawValue);
  else if (keyPath === "semantic.min_margin") next.semantic.minMargin = parseFraction(rawValue);
  else if (keyPath === "semantic.review_on_tie") next.semantic.reviewOnTie = parseBoolean(rawValue);
  else throw new Error(`Unsupported config key: ${keyPath}`);
  return next;
}

export function setConfigValueInContents(contents: string, keyPath: string, rawValue: string): string {
  const current = contents.trim().length > 0 ? contents : formatConfig(DEFAULT_CONFIG);
  const { section, key, value } = configPatchForSet(keyPath, rawValue);
  return setSectionValue(current, section, key, value);
}

export function addDomainRule(config: ZtsConfig, pattern: string, workspace: string): ZtsConfig {
  const next = structuredClone(config);
  next.rules.domains[pattern] = workspace;
  return next;
}

export function addDomainRuleInContents(contents: string, pattern: string, workspace: string): string {
  const current = contents.trim().length > 0 ? contents : formatConfig(DEFAULT_CONFIG);
  return setSectionValue(current, "rules.domains", quote(pattern), quote(workspace));
}

function configPatchForSet(keyPath: string, rawValue: string): { section: string; key: string; value: string } {
  if (keyPath === "defaults.inbox") return { section: "defaults", key: "inbox", value: quote(rawValue) };
  if (keyPath === "defaults.min_confidence") return { section: "defaults", key: "min_confidence", value: formatPrimitive(parseConfidence(rawValue)) };
  if (keyPath === "defaults.include_pinned") return { section: "defaults", key: "include_pinned", value: formatPrimitive(parseBoolean(rawValue)) };
  if (keyPath === "defaults.include_essentials") return { section: "defaults", key: "include_essentials", value: formatPrimitive(parseBoolean(rawValue)) };
  if (keyPath === "defaults.apply_backend") return { section: "defaults", key: "apply_backend", value: quote(parseBackend(rawValue)) };
  if (keyPath === "sort.from") return { section: "sort", key: "from", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.to") return { section: "sort", key: "to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.not_to") return { section: "sort", key: "not_to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.only") return { section: "sort", key: "only", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.except") return { section: "sort", key: "except", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "protect.workspaces.from") return { section: "protect.workspaces", key: "from", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "protect.workspaces.to") return { section: "protect.workspaces", key: "to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "protect.domains.never_move") return { section: "protect.domains", key: "never_move", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "embeddings.provider") return { section: "embeddings", key: "provider", value: quote(parseProvider(rawValue)) };
  if (keyPath === "embeddings.allow_download") return { section: "embeddings", key: "allow_download", value: formatPrimitive(parseBoolean(rawValue)) };
  if (keyPath === "embeddings.model") return { section: "embeddings", key: "model", value: quote(rawValue) };
  if (keyPath === "embeddings.cache_dir") return { section: "embeddings", key: "cache_dir", value: quote(rawValue) };
  if (keyPath === "embeddings.weights.title") return { section: "embeddings.weights", key: "title", value: formatPrimitive(Number(rawValue)) };
  if (keyPath === "embeddings.weights.url") return { section: "embeddings.weights", key: "url", value: formatPrimitive(Number(rawValue)) };
  if (keyPath === "embeddings.weights.domain") return { section: "embeddings.weights", key: "domain", value: formatPrimitive(Number(rawValue)) };
  if (keyPath === "embeddings.weights.description") return { section: "embeddings.weights", key: "description", value: formatPrimitive(Number(rawValue)) };
  if (keyPath === "semantic.enabled") return { section: "semantic", key: "enabled", value: formatPrimitive(parseBoolean(rawValue)) };
  if (keyPath === "semantic.auto_index") return { section: "semantic", key: "auto_index", value: formatPrimitive(parseBoolean(rawValue)) };
  if (keyPath === "semantic.min_confidence") return { section: "semantic", key: "min_confidence", value: formatPrimitive(parseConfidence(rawValue)) };
  if (keyPath === "semantic.min_margin") return { section: "semantic", key: "min_margin", value: formatPrimitive(parseFraction(rawValue)) };
  if (keyPath === "semantic.review_on_tie") return { section: "semantic", key: "review_on_tie", value: formatPrimitive(parseBoolean(rawValue)) };
  throw new Error(`Unsupported config key: ${keyPath}`);
}

function setSectionValue(contents: string, section: string, key: string, value: string): string {
  const lines = contents.split(/\r?\n/);
  const header = `[${section}]`;
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === header) {
      sectionStart = index;
      break;
    }
  }

  if (sectionStart === -1) {
    const prefix = contents.endsWith("\n") || contents.length === 0 ? "" : "\n";
    return `${contents}${prefix}${header}\n${key} = ${value}\n`;
  }

  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+]\s*$/.test(lines[index])) {
      sectionEnd = index;
      break;
    }
  }

  const targetKey = unquote(key);
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const separator = lines[index].indexOf("=");
    if (separator === -1) continue;
    if (unquote(lines[index].slice(0, separator).trim()) === targetKey) {
      lines[index] = `${key} = ${value}${trailingComment(lines[index])}`;
      return ensureTrailingNewline(lines.join("\n"));
    }
  }

  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return ensureTrailingNewline(lines.join("\n"));
}

function ensureTrailingNewline(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function setDefault(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "inbox" && typeof value === "string") config.defaults.inbox = value;
  if (key === "min_confidence") config.defaults.minConfidence = parseConfidence(String(value));
  if (key === "include_pinned") config.defaults.includePinned = parseBoolean(String(value));
  if (key === "include_essentials") config.defaults.includeEssentials = parseBoolean(String(value));
  if (key === "apply_backend" && typeof value === "string") config.defaults.applyBackend = parseBackend(value);
}

function setSort(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "from") config.sort.from = parseStringArray(value);
  if (key === "to") config.sort.to = parseStringArray(value);
  if (key === "not_to") config.sort.notTo = parseStringArray(value);
  if (key === "only") config.sort.only = parseStringArray(value);
  if (key === "except") config.sort.except = parseStringArray(value);
}

function setProtectWorkspace(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "from") config.protect.workspaces.from = parseStringArray(value);
  if (key === "to") config.protect.workspaces.to = parseStringArray(value);
}

function setProtectDomain(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "never_move") config.protect.domains.neverMove = parseStringArray(value);
}

function setEmbeddings(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "provider" && typeof value === "string") config.embeddings.provider = parseProvider(value);
  if (key === "allow_download") config.embeddings.allowDownload = parseBoolean(String(value));
  if (key === "model" && typeof value === "string") config.embeddings.model = value;
  if (key === "cache_dir" && typeof value === "string") config.embeddings.cacheDir = value;
}

function setEmbeddingsWeights(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "title") config.embeddings.weights.title = Number(value);
  if (key === "url") config.embeddings.weights.url = Number(value);
  if (key === "domain") config.embeddings.weights.domain = Number(value);
  if (key === "description") config.embeddings.weights.description = Number(value);
}

function setSemantic(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "enabled") config.semantic.enabled = parseBoolean(String(value));
  if (key === "auto_index") config.semantic.autoIndex = parseBoolean(String(value));
  if (key === "min_confidence") config.semantic.minConfidence = parseConfidence(String(value));
  if (key === "min_margin") config.semantic.minMargin = parseFraction(String(value));
  if (key === "review_on_tie") config.semantic.reviewOnTie = parseBoolean(String(value));
}

function parseProvider(value: string): ZtsConfig["embeddings"]["provider"] {
  if (value === "built-in" || value === "bge-small" || value === "hybrid") return value;
  throw new Error("embeddings.provider must be one of: built-in, bge-small, hybrid");
}

function parseFraction(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("fraction config values must be a number between 0 and 1");
  }
  return parsed;
}

function parseValue(value: string): string | number | boolean | string[] {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) return parseArrayLiteral(value);
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquote(value);
}

function parseArrayLiteral(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

function stripInlineComment(value: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "#" && !inString) {
      return value.slice(0, index);
    }
  }
  return value;
}

function trailingComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "#" && !inString) {
      return ` ${line.slice(index).trimEnd()}`;
    }
  }
  return "";
}

function parseConfidence(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("min_confidence must be a number between 0 and 1");
  }
  return parsed;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("boolean config values must be true or false");
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseArrayLiteral(trimmed);
    return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function parseBackend(value: string): ZtsConfig["defaults"]["applyBackend"] {
  if (value === "auto" || value === "live" || value === "session") return value;
  throw new Error("apply_backend must be one of: auto, live, session");
}

function formatPrimitive(value: number | boolean): string {
  return String(value);
}

function formatArray(values: string[]): string {
  return `[${values.map(quote).join(", ")}]`;
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}
