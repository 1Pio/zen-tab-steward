import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configPath } from "./paths.js";
import { sha256Canonical } from "./domain/digest.js";
import { acquireExclusiveFileControl } from "./exclusive-control.js";
import { canonicalUrlPattern } from "./url-pattern.js";
import {
  AtomicFileMismatchError,
  readBoundedFileState,
  type AtomicFileFingerprint
} from "./atomic-file-cas.js";
import {
  assertPrivateDirectory,
  compareAndReplacePrivateBytes,
  ensurePrivateDirectory
} from "./private-store.js";

import type { Sha256Digest } from "./domain/digest.js";

export const CONFIG_FILE_MAX_BYTES = 1024 * 1024;
export const CONFIG_MAX_MOVES = 1000;
export const CONFIG_MAX_STRING_BYTES = 4096;
export const CONFIG_MAX_ARRAY_ITEMS = 256;
export const CONFIG_MAX_DOMAIN_RULES = 1024;

const CONFIG_SECTIONS = new Set([
  "defaults",
  "sort",
  "semantic",
  "protect.workspaces",
  "protect.domains",
  "rules.domains"
]);

const FIXED_SECTION_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  defaults: new Set(["inbox", "min_confidence", "include_pinned", "include_essentials", "apply_backend"]),
  sort: new Set(["from", "to", "not_to", "only", "except"]),
  semantic: new Set([
    "enabled",
    "engine",
    "suggestion_threshold",
    "auto_apply",
    "auto_apply_threshold",
    "minimum_margin",
    "max_moves"
  ]),
  "protect.workspaces": new Set(["from", "to"]),
  "protect.domains": new Set(["never_move"])
};

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
  semantic: {
    enabled: boolean;
    engine: "lexical" | "bge-small" | "hybrid";
    suggestionThreshold: number;
    autoApply: boolean;
    autoApplyThreshold: number;
    minimumMargin: number;
    maxMoves: number;
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
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: ZtsConfig;
  contents: string;
  /** Digest of parsed defaults plus user configuration, never comments or formatting. */
  revision: Sha256Digest;
}

export interface ConfigWriteExpectation {
  readonly exists: boolean;
  readonly contents: string;
}

export interface ConfigWriteHooks {
  /** Internal fault-injection hook at the exact atomic exchange boundary. */
  readonly afterSourceValidation?: () => void | Promise<void>;
}

export class ConfigChangedError extends Error {
  constructor() {
    super("Config changed after it was loaded; reload it and retry the intended edit");
    this.name = "ConfigChangedError";
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ConfigValidationError";
  }
}

export class ConfigPermissionsError extends Error {
  constructor(kind: "directory" | "file", path: string, expectedMode: number, actualMode: number) {
    const expected = formatMode(expectedMode);
    const actual = formatMode(actualMode);
    const chmodMode = expected.slice(1);
    super(
      `Config ${kind} permissions are unsafe at ${path}: expected mode ${expected}, found ${actual}. `
      + `Review its ownership and contents, then set mode ${expected} (chmod ${chmodMode}) and retry`
    );
    this.name = "ConfigPermissionsError";
  }
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
  semantic: {
    enabled: false,
    engine: "bge-small",
    suggestionThreshold: 0.72,
    autoApply: false,
    autoApplyThreshold: 0.92,
    minimumMargin: 0.18,
    maxMoves: 5
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
  }
};

export async function inspectConfigLocation(): Promise<{ readonly path: string; readonly exists: boolean }> {
  const path = configPath();
  try {
    await lstat(path);
    return { path, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false };
    throw error;
  }
}

export async function loadConfig(): Promise<LoadedConfig> {
  const location = await inspectConfigLocation();
  const path = location.path;
  if (!location.exists) {
    const config = structuredClone(DEFAULT_CONFIG);
    return { path, exists: false, config, contents: "", revision: effectiveConfigRevision(config) };
  }
  await assertConfigDirectoryPermissions(dirname(path));
  const state = await readConfigFileState(path);
  const contents = decodeConfig(state.bytes, path);
  const config = parseConfig(contents);
  return { path, exists: true, config, contents, revision: effectiveConfigRevision(config) };
}

async function readConfigFileState(path: string): Promise<Awaited<ReturnType<typeof readBoundedFileState>>> {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink()
    && metadata.isFile()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())) {
    const actualMode = metadata.mode & 0o777;
    if (actualMode !== 0o600) {
      throw new ConfigPermissionsError("file", path, 0o600, actualMode);
    }
    if (metadata.size > CONFIG_FILE_MAX_BYTES) {
      throw new ConfigValidationError(`Config exceeds the ${CONFIG_FILE_MAX_BYTES}-byte read limit: ${path}`);
    }
  }
  const state = await readBoundedFileState(path, CONFIG_FILE_MAX_BYTES);
  if (state.fingerprint.mode !== 0o600) {
    throw new ConfigPermissionsError("file", path, 0o600, state.fingerprint.mode);
  }
  return state;
}

function formatMode(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

/**
 * The one revision contract used by every Plan and Apply Transaction. It binds
 * effective parsed values, including defaults, while ignoring TOML comments
 * and formatting. Records are ordered to make construction independent of
 * JavaScript insertion order.
 */
export function effectiveConfigRevision(config: ZtsConfig): Sha256Digest {
  return sha256Canonical({
    schemaVersion: "zts.effective-config.provisional-1",
    config: {
      defaults: config.defaults,
      sort: config.sort,
      semantic: config.semantic,
      protect: config.protect,
      rules: { domains: orderedRecord(config.rules.domains) }
    }
  });
}

export async function saveConfig(config: ZtsConfig): Promise<string> {
  const loaded = await loadConfig();
  return saveConfigContents(formatConfig(config), loaded);
}

export async function saveConfigContents(
  contents: string,
  expected: ConfigWriteExpectation,
  hooks: ConfigWriteHooks = {}
): Promise<string> {
  const encoded = Buffer.from(contents, "utf8");
  if (encoded.byteLength > CONFIG_FILE_MAX_BYTES) {
    throw new ConfigValidationError(`Config exceeds the ${CONFIG_FILE_MAX_BYTES}-byte write limit`);
  }
  parseConfig(contents);
  const path = configPath();
  const parent = dirname(path);
  await prepareConfigDirectoryForWrite(path, parent, expected);
  const expectedTarget = await expectedConfigTarget(path, expected);
  const control = await acquireExclusiveFileControl(
    join(parent, ".config-write-control.json"),
    "zts config writer",
    { timeoutSeconds: 15 }
  );
  try {
    await control.assertHeld();
    try {
      await compareAndReplacePrivateBytes(path, encoded, expectedTarget, CONFIG_FILE_MAX_BYTES, {
        afterSourceValidation: hooks.afterSourceValidation
      });
    } catch (error) {
      if (error instanceof AtomicFileMismatchError) throw new ConfigChangedError();
      throw error;
    }
    await control.assertHeld();
  } finally {
    await control.release();
  }
  return path;
}

async function prepareConfigDirectoryForWrite(
  path: string,
  parent: string,
  expected: ConfigWriteExpectation
): Promise<void> {
  if (expected.exists) {
    try {
      await assertConfigDirectoryPermissions(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigChangedError();
      throw error;
    }
    return;
  }

  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await assertConfigDirectoryPermissions(parent);
      return;
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code !== "ENOENT") throw directoryError;
      await ensurePrivateDirectory(parent);
      return;
    }
  }
  throw new ConfigChangedError();
}

async function assertConfigDirectoryPermissions(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink()
    && metadata.isDirectory()
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())) {
    const actualMode = metadata.mode & 0o777;
    if (actualMode !== 0o700) {
      throw new ConfigPermissionsError("directory", path, 0o700, actualMode);
    }
  }
  await assertPrivateDirectory(path);
}

async function expectedConfigTarget(
  path: string,
  expected: ConfigWriteExpectation
): Promise<AtomicFileFingerprint | null> {
  if (!expected.exists) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    throw new ConfigChangedError();
  }

  let current: Awaited<ReturnType<typeof readBoundedFileState>>;
  try {
    current = await readConfigFileState(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigChangedError();
    throw error;
  }
  if (decodeConfig(current.bytes, path) !== expected.contents) {
    throw new ConfigChangedError();
  }
  return current.fingerprint;
}

function decodeConfig(contents: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch {
    throw new ConfigValidationError(`Config is not valid UTF-8: ${path}`);
  }
}

export function parseConfig(contents: string): ZtsConfig {
  try {
    return parseConfigUnchecked(contents);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError(error instanceof Error ? error.message : String(error), error);
  }
}

function parseConfigUnchecked(contents: string): ZtsConfig {
  const byteLength = Buffer.byteLength(contents, "utf8");
  if (byteLength > CONFIG_FILE_MAX_BYTES) {
    throw new Error(`Config exceeds the ${CONFIG_FILE_MAX_BYTES}-byte parse limit`);
  }
  const config = structuredClone(DEFAULT_CONFIG);
  let section = "";
  let domainRuleCount = 0;
  const seenSections = new Set<string>();
  const seenKeys = new Set<string>();
  const locations = new Map<string, number>();

  for (const [lineIndex, rawLine] of contents.split(/\r?\n/).entries()) {
    const lineNumber = lineIndex + 1;
    const line = stripConfigComment(rawLine, lineNumber).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([a-z][a-z0-9.]*)]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      if (!CONFIG_SECTIONS.has(section)) {
        throw new Error(`Unsupported config section "${section}" at line ${lineNumber}`);
      }
      if (seenSections.has(section)) {
        throw new Error(`Duplicate config section "${section}" at line ${lineNumber}`);
      }
      seenSections.add(section);
      continue;
    }

    const separator = findAssignmentSeparator(line);
    if (separator === -1) {
      throw new Error(`Malformed config statement at line ${lineNumber}`);
    }
    if (!section) throw new Error(`Config assignment outside a supported section at line ${lineNumber}`);
    const keyToken = line.slice(0, separator).trim();
    const key = section === "rules.domains"
      ? canonicalConfigUrlPattern(
          parseQuotedConfigString(keyToken, `Domain rule pattern at line ${lineNumber}`),
          `Domain rule pattern at line ${lineNumber}`
        )
      : parseFixedKey(keyToken, section, lineNumber);
    const fixedKeys = FIXED_SECTION_KEYS[section];
    if (fixedKeys && !fixedKeys.has(key)) {
      throw new Error(`Unsupported config key "${section}.${key}" at line ${lineNumber}`);
    }
    const qualifiedKey = `${section}.${key}`;
    if (seenKeys.has(qualifiedKey)) {
      const label = section === "rules.domains" ? "Duplicate domain rule" : "Duplicate config key";
      throw new Error(`${label} "${qualifiedKey}" at line ${lineNumber}`);
    }
    seenKeys.add(qualifiedKey);
    locations.set(qualifiedKey, lineNumber);
    const value = parseConfigValue(section, key, line.slice(separator + 1).trim(), lineNumber);

    if (section === "defaults") setDefault(config, key, value);
    if (section === "sort") setSort(config, key, value);
    if (section === "semantic") setSemantic(config, key, value);
    if (section === "protect.workspaces") setProtectWorkspace(config, key, value);
    if (section === "protect.domains") setProtectDomain(config, key, value);
    if (section === "rules.domains") {
      domainRuleCount += 1;
      if (domainRuleCount > CONFIG_MAX_DOMAIN_RULES) {
        throw new Error(`Config domain rules exceed the ${CONFIG_MAX_DOMAIN_RULES}-rule limit`);
      }
      Object.defineProperty(config.rules.domains, key, {
        value: value as string,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }

  validateConfig(config, locations);
  return config;
}

export function formatConfig(config: ZtsConfig): string {
  validateConfig(config);
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
    "[semantic]",
    `enabled = ${formatPrimitive(config.semantic.enabled)}`,
    `engine = ${quote(config.semantic.engine)}`,
    `suggestion_threshold = ${formatPrimitive(config.semantic.suggestionThreshold)}`,
    `auto_apply = ${formatPrimitive(config.semantic.autoApply)}`,
    `auto_apply_threshold = ${formatPrimitive(config.semantic.autoApplyThreshold)}`,
    `minimum_margin = ${formatPrimitive(config.semantic.minimumMargin)}`,
    `max_moves = ${formatPrimitive(config.semantic.maxMoves)}`,
    "",
    "[protect.workspaces]",
    `from = ${formatArray(config.protect.workspaces.from)}`,
    `to = ${formatArray(config.protect.workspaces.to)}`,
    "",
    "[protect.domains]",
    `never_move = ${formatArray(config.protect.domains.neverMove)}`,
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
  if (keyPath === "semantic.enabled") return config.semantic.enabled;
  if (keyPath === "semantic.engine") return config.semantic.engine;
  if (keyPath === "semantic.suggestion_threshold") return config.semantic.suggestionThreshold;
  if (keyPath === "semantic.auto_apply") return config.semantic.autoApply;
  if (keyPath === "semantic.auto_apply_threshold") return config.semantic.autoApplyThreshold;
  if (keyPath === "semantic.minimum_margin") return config.semantic.minimumMargin;
  if (keyPath === "semantic.max_moves") return config.semantic.maxMoves;
  if (keyPath === "protect.workspaces.from") return config.protect.workspaces.from;
  if (keyPath === "protect.workspaces.to") return config.protect.workspaces.to;
  if (keyPath === "protect.domains.never_move") return config.protect.domains.neverMove;
  if (keyPath.startsWith("rules.domains.")) {
    const key = keyPath.slice("rules.domains.".length);
    return Object.hasOwn(config.rules.domains, key) ? config.rules.domains[key] : undefined;
  }
  throw new ConfigValidationError(`Unsupported config key: ${keyPath}`);
}

export function setConfigValue(config: ZtsConfig, keyPath: string, rawValue: string): ZtsConfig {
  const next = structuredClone(config);
  if (keyPath === "defaults.inbox") next.defaults.inbox = rawValue;
  else if (keyPath === "defaults.min_confidence") next.defaults.minConfidence = parseConfidence(rawValue, keyPath);
  else if (keyPath === "defaults.include_pinned") next.defaults.includePinned = parseBoolean(rawValue, keyPath);
  else if (keyPath === "defaults.include_essentials") next.defaults.includeEssentials = parseBoolean(rawValue, keyPath);
  else if (keyPath === "defaults.apply_backend") next.defaults.applyBackend = parseBackend(rawValue.trim(), keyPath);
  else if (keyPath === "sort.from") next.sort.from = parseStringArray(rawValue);
  else if (keyPath === "sort.to") next.sort.to = parseStringArray(rawValue);
  else if (keyPath === "sort.not_to") next.sort.notTo = parseStringArray(rawValue);
  else if (keyPath === "sort.only") next.sort.only = canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath);
  else if (keyPath === "sort.except") next.sort.except = canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath);
  else if (keyPath === "semantic.enabled") next.semantic.enabled = parseBoolean(rawValue, keyPath);
  else if (keyPath === "semantic.engine") next.semantic.engine = parseSemanticEngine(rawValue.trim(), keyPath);
  else if (keyPath === "semantic.suggestion_threshold") next.semantic.suggestionThreshold = parseConfidence(rawValue, keyPath);
  else if (keyPath === "semantic.auto_apply") next.semantic.autoApply = parseBoolean(rawValue, keyPath);
  else if (keyPath === "semantic.auto_apply_threshold") next.semantic.autoApplyThreshold = parseConfidence(rawValue, keyPath);
  else if (keyPath === "semantic.minimum_margin") next.semantic.minimumMargin = parseConfidence(rawValue, keyPath);
  else if (keyPath === "semantic.max_moves") next.semantic.maxMoves = parseMoveCap(rawValue, keyPath);
  else if (keyPath === "protect.workspaces.from") next.protect.workspaces.from = parseStringArray(rawValue);
  else if (keyPath === "protect.workspaces.to") next.protect.workspaces.to = parseStringArray(rawValue);
  else if (keyPath === "protect.domains.never_move") {
    next.protect.domains.neverMove = canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath);
  }
  else throw new ConfigValidationError(`Unsupported config key: ${keyPath}`);
  validateConfig(next);
  return next;
}

export function setConfigValueInContents(contents: string, keyPath: string, rawValue: string): string {
  try {
    const current = contents.trim().length > 0 ? contents : formatConfig(DEFAULT_CONFIG);
    parseConfig(current);
    const { section, key, value } = configPatchForSet(keyPath, rawValue);
    const updated = setSectionValue(current, section, key, value);
    parseConfig(updated);
    return updated;
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError(error instanceof Error ? error.message : String(error), error);
  }
}

export function addDomainRule(config: ZtsConfig, pattern: string, workspace: string): ZtsConfig {
  const next = structuredClone(config);
  const canonicalPattern = canonicalConfigUrlPattern(pattern, "Domain rule pattern");
  Object.defineProperty(next.rules.domains, canonicalPattern, {
    value: workspace,
    enumerable: true,
    configurable: true,
    writable: true
  });
  validateConfig(next);
  return next;
}

export function addDomainRuleInContents(contents: string, pattern: string, workspace: string): string {
  try {
    const current = contents.trim().length > 0 ? contents : formatConfig(DEFAULT_CONFIG);
    parseConfig(current);
    const canonicalPattern = canonicalConfigUrlPattern(pattern, "Domain rule pattern");
    validateConfigString(workspace, "Domain rule destination", false);
    const updated = setSectionValue(current, "rules.domains", quote(canonicalPattern), quote(workspace));
    parseConfig(updated);
    return updated;
  } catch (error) {
    if (error instanceof ConfigValidationError) throw error;
    throw new ConfigValidationError(error instanceof Error ? error.message : String(error), error);
  }
}

function configPatchForSet(keyPath: string, rawValue: string): { section: string; key: string; value: string } {
  if (keyPath === "defaults.inbox") return { section: "defaults", key: "inbox", value: quote(rawValue) };
  if (keyPath === "defaults.min_confidence") return { section: "defaults", key: "min_confidence", value: formatPrimitive(parseConfidence(rawValue, keyPath)) };
  if (keyPath === "defaults.include_pinned") return { section: "defaults", key: "include_pinned", value: formatPrimitive(parseBoolean(rawValue, keyPath)) };
  if (keyPath === "defaults.include_essentials") return { section: "defaults", key: "include_essentials", value: formatPrimitive(parseBoolean(rawValue, keyPath)) };
  if (keyPath === "defaults.apply_backend") return { section: "defaults", key: "apply_backend", value: quote(parseBackend(rawValue.trim(), keyPath)) };
  if (keyPath === "sort.from") return { section: "sort", key: "from", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.to") return { section: "sort", key: "to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.not_to") return { section: "sort", key: "not_to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "sort.only") return { section: "sort", key: "only", value: formatArray(canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath)) };
  if (keyPath === "sort.except") return { section: "sort", key: "except", value: formatArray(canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath)) };
  if (keyPath === "semantic.enabled") return { section: "semantic", key: "enabled", value: formatPrimitive(parseBoolean(rawValue, keyPath)) };
  if (keyPath === "semantic.engine") return { section: "semantic", key: "engine", value: quote(parseSemanticEngine(rawValue.trim(), keyPath)) };
  if (keyPath === "semantic.suggestion_threshold") return { section: "semantic", key: "suggestion_threshold", value: formatPrimitive(parseConfidence(rawValue, keyPath)) };
  if (keyPath === "semantic.auto_apply") return { section: "semantic", key: "auto_apply", value: formatPrimitive(parseBoolean(rawValue, keyPath)) };
  if (keyPath === "semantic.auto_apply_threshold") return { section: "semantic", key: "auto_apply_threshold", value: formatPrimitive(parseConfidence(rawValue, keyPath)) };
  if (keyPath === "semantic.minimum_margin") return { section: "semantic", key: "minimum_margin", value: formatPrimitive(parseConfidence(rawValue, keyPath)) };
  if (keyPath === "semantic.max_moves") return { section: "semantic", key: "max_moves", value: formatPrimitive(parseMoveCap(rawValue, keyPath)) };
  if (keyPath === "protect.workspaces.from") return { section: "protect.workspaces", key: "from", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "protect.workspaces.to") return { section: "protect.workspaces", key: "to", value: formatArray(parseStringArray(rawValue)) };
  if (keyPath === "protect.domains.never_move") return {
    section: "protect.domains",
    key: "never_move",
    value: formatArray(canonicalConfigUrlPatterns(parseStringArray(rawValue), keyPath))
  };
  throw new ConfigValidationError(`Unsupported config key: ${keyPath}`);
}

function setSectionValue(contents: string, section: string, key: string, value: string): string {
  const lines = contents.split(/\r?\n/);
  let sectionStart = -1;
  let sectionEnd = lines.length;

  for (let index = 0; index < lines.length; index += 1) {
    if (editableSectionName(lines[index] ?? "", index + 1) === section) {
      sectionStart = index;
      break;
    }
  }

  if (sectionStart === -1) {
    const prefix = contents.endsWith("\n") || contents.length === 0 ? "" : "\n";
    return `${contents}${prefix}[${section}]\n${key} = ${value}\n`;
  }

  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (editableSectionName(lines[index] ?? "", index + 1) !== null) {
      sectionEnd = index;
      break;
    }
  }

  const targetKey = section === "rules.domains"
    ? canonicalConfigUrlPattern(parseQuotedConfigString(key, "Domain rule pattern"), "Domain rule pattern")
    : key;
  for (let index = sectionStart + 1; index < sectionEnd; index += 1) {
    const code = stripConfigComment(lines[index] ?? "", index + 1).trim();
    const separator = findAssignmentSeparator(code);
    if (separator === -1) continue;
    const candidateToken = code.slice(0, separator).trim();
    const candidateKey = section === "rules.domains"
      ? canonicalConfigUrlPattern(
          parseQuotedConfigString(candidateToken, `Domain rule pattern at line ${index + 1}`),
          `Domain rule pattern at line ${index + 1}`
        )
      : candidateToken;
    if (candidateKey === targetKey) {
      lines[index] = `${key} = ${value}${trailingComment(lines[index])}`;
      return ensureTrailingNewline(lines.join("\n"));
    }
  }

  lines.splice(sectionEnd, 0, `${key} = ${value}`);
  return ensureTrailingNewline(lines.join("\n"));
}

function editableSectionName(line: string, lineNumber: number): string | null {
  const code = stripConfigComment(line, lineNumber).trim();
  const match = code.match(/^\[([a-z][a-z0-9.]*)]$/);
  return match?.[1] ?? null;
}

function ensureTrailingNewline(contents: string): string {
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function setDefault(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "inbox" && typeof value === "string") config.defaults.inbox = value;
  if (key === "min_confidence") config.defaults.minConfidence = value as number;
  if (key === "include_pinned") config.defaults.includePinned = value as boolean;
  if (key === "include_essentials") config.defaults.includeEssentials = value as boolean;
  if (key === "apply_backend") config.defaults.applyBackend = value as ZtsConfig["defaults"]["applyBackend"];
}

function setSort(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "from") config.sort.from = value as string[];
  if (key === "to") config.sort.to = value as string[];
  if (key === "not_to") config.sort.notTo = value as string[];
  if (key === "only") config.sort.only = value as string[];
  if (key === "except") config.sort.except = value as string[];
}

function setSemantic(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "enabled") config.semantic.enabled = value as boolean;
  if (key === "engine") config.semantic.engine = value as ZtsConfig["semantic"]["engine"];
  if (key === "suggestion_threshold") config.semantic.suggestionThreshold = value as number;
  if (key === "auto_apply") config.semantic.autoApply = value as boolean;
  if (key === "auto_apply_threshold") config.semantic.autoApplyThreshold = value as number;
  if (key === "minimum_margin") config.semantic.minimumMargin = value as number;
  if (key === "max_moves") config.semantic.maxMoves = value as number;
}

function setProtectWorkspace(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "from") config.protect.workspaces.from = value as string[];
  if (key === "to") config.protect.workspaces.to = value as string[];
}

function setProtectDomain(config: ZtsConfig, key: string, value: unknown): void {
  if (key === "never_move") config.protect.domains.neverMove = value as string[];
}

function orderedRecord(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function validateConfig(config: ZtsConfig, locations?: ReadonlyMap<string, number>): void {
  if (config.semantic.suggestionThreshold > config.semantic.autoApplyThreshold) {
    const suggestion = locatedLabel("semantic.suggestion_threshold", locations);
    const autoApply = locatedLabel("semantic.auto_apply_threshold", locations);
    throw new Error(`${suggestion} must be less than or equal to effective ${autoApply}`);
  }
  validateConfigString(config.defaults.inbox, "defaults.inbox", false);
  for (const [label, values] of [
    ["sort.from", config.sort.from],
    ["sort.to", config.sort.to],
    ["sort.not_to", config.sort.notTo],
    ["sort.only", config.sort.only],
    ["sort.except", config.sort.except],
    ["protect.workspaces.from", config.protect.workspaces.from],
    ["protect.workspaces.to", config.protect.workspaces.to],
    ["protect.domains.never_move", config.protect.domains.neverMove]
  ] as const) {
    validateConfigArray(values, label);
  }
  for (const [label, values] of [
    ["sort.only", config.sort.only],
    ["sort.except", config.sort.except],
    ["protect.domains.never_move", config.protect.domains.neverMove]
  ] as const) {
    for (const value of values) assertCanonicalConfigUrlPattern(value, `${label} array entry`);
  }
  const domainRules = Object.entries(config.rules.domains);
  if (domainRules.length > CONFIG_MAX_DOMAIN_RULES) {
    throw new Error(`Config domain rules exceed the ${CONFIG_MAX_DOMAIN_RULES}-rule limit`);
  }
  for (const [pattern, destination] of domainRules) {
    validateConfigString(pattern, "Domain rule pattern", false);
    assertCanonicalConfigUrlPattern(pattern, "Domain rule pattern");
    validateConfigString(destination, "Domain rule destination", false);
  }
}

function canonicalConfigUrlPatterns(values: readonly string[], label: string): string[] {
  return values.map((value, index) => canonicalConfigUrlPattern(value, `${label} entry ${index + 1}`));
}

function canonicalConfigUrlPattern(value: string, label: string): string {
  try {
    return canonicalUrlPattern(value);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCanonicalConfigUrlPattern(value: string, label: string): void {
  const canonical = canonicalConfigUrlPattern(value, label);
  if (canonical !== value) throw new Error(`${label} must use canonical pattern ${canonical}`);
}

function validateConfigArray(values: readonly string[], label: string): void {
  if (values.length > CONFIG_MAX_ARRAY_ITEMS) {
    throw new Error(`${label} array exceeds the ${CONFIG_MAX_ARRAY_ITEMS}-entry limit`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    validateConfigString(value, `${label} array entry`, false);
    if (seen.has(value)) throw new Error(`${label} array contains duplicate entry "${value}"`);
    seen.add(value);
  }
}

function validateConfigString(value: string, label: string, allowEmpty: boolean): void {
  if (!allowEmpty && value.trim().length === 0) throw new Error(`${label} must not be empty`);
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength > CONFIG_MAX_STRING_BYTES) {
    throw new Error(`${label} string exceeds the ${CONFIG_MAX_STRING_BYTES}-byte limit`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} contains a control character`);
  }
}

function stripConfigComment(value: string, lineNumber: number): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
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
  if (escaped || inString) throw new Error(`Unclosed string at line ${lineNumber}`);
  return value;
}

function findAssignmentSeparator(line: string): number {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === "=" && !inString) return index;
  }
  return -1;
}

function parseFixedKey(value: string, section: string, lineNumber: number): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Malformed config key in section "${section}" at line ${lineNumber}`);
  }
  return value;
}

function parseConfigValue(section: string, key: string, value: string, lineNumber: number): unknown {
  const label = `${section}.${key} at line ${lineNumber}`;
  if (section === "rules.domains") return parseQuotedConfigString(value, `Domain rule destination at line ${lineNumber}`);
  if (section === "defaults") {
    if (key === "inbox") return parseQuotedConfigString(value, label);
    if (key === "apply_backend") return parseBackend(parseQuotedConfigString(value, label), label);
    if (key === "min_confidence") return parseConfidence(value, label);
    return parseConfigBoolean(value, label);
  }
  if (section === "sort" || section === "protect.workspaces" || section === "protect.domains") {
    const values = parseConfigStringArray(value, label);
    return (section === "protect.domains" || (section === "sort" && (key === "only" || key === "except")))
      ? canonicalConfigUrlPatterns(values, label)
      : values;
  }
  if (section === "semantic") {
    if (key === "engine") return parseSemanticEngine(parseQuotedConfigString(value, label), label);
    if (key === "enabled" || key === "auto_apply") return parseConfigBoolean(value, label);
    if (key === "max_moves") return parseMoveCap(value, label);
    return parseConfidence(value, label);
  }
  throw new Error(`Unsupported config section "${section}" at line ${lineNumber}`);
}

function parseConfigBoolean(value: string, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be a boolean (true or false)`);
}

function parseConfigNumber(value: string, label: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a finite non-negative decimal number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite non-negative decimal number`);
  return parsed;
}

function locatedLabel(key: string, locations?: ReadonlyMap<string, number>): string {
  const line = locations?.get(key);
  return line === undefined ? key : `${key} at line ${line}`;
}

function parseQuotedConfigString(value: string, label: string): string {
  const parsed = parseQuotedStringAt(value, 0, label);
  if (parsed.next !== value.length) throw new Error(`Malformed string for ${label}`);
  validateConfigString(parsed.value, label, false);
  return parsed.value;
}

function parseQuotedStringAt(
  source: string,
  start: number,
  label: string
): { value: string; next: number } {
  if (source[start] !== '"') throw new Error(`${label} must be a quoted string`);
  let result = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') return { value: result, next: index + 1 };
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped !== '"' && escaped !== "\\") {
        throw new Error(`Unsupported string escape for ${label}; only \\" and \\\\ are supported`);
      }
      result += escaped;
      index += 1;
      continue;
    }
    if (char !== undefined && /[\u0000-\u001f\u007f-\u009f]/u.test(char)) {
      throw new Error(`${label} contains a control character`);
    }
    result += char;
  }
  throw new Error(`Unclosed string for ${label}`);
}

function parseConfigStringArray(value: string, label: string): string[] {
  if (!value.startsWith("[")) throw new Error(`${label} must be an array of quoted strings`);
  const result: string[] = [];
  let index = 1;
  const skipSpace = (): void => {
    while (index < value.length && /\s/u.test(value[index] ?? "")) index += 1;
  };
  skipSpace();
  if (value[index] === "]") {
    index += 1;
    if (index !== value.length) throw new Error(`Malformed array for ${label}`);
    return result;
  }
  if (index >= value.length) throw new Error(`Unclosed array for ${label}`);

  while (index < value.length) {
    if (value[index] !== '"') throw new Error(`${label} array must contain only quoted strings`);
    const parsed = parseQuotedStringAt(value, index, label);
    validateConfigString(parsed.value, `${label} array entry`, false);
    result.push(parsed.value);
    if (result.length > CONFIG_MAX_ARRAY_ITEMS) {
      throw new Error(`${label} array exceeds the ${CONFIG_MAX_ARRAY_ITEMS}-entry limit`);
    }
    index = parsed.next;
    skipSpace();
    if (value[index] === "]") {
      index += 1;
      if (index !== value.length) throw new Error(`Malformed array for ${label}`);
      return result;
    }
    if (value[index] !== ",") {
      if (index >= value.length) throw new Error(`Unclosed array for ${label}`);
      throw new Error(`Malformed array for ${label}`);
    }
    index += 1;
    skipSpace();
    if (value[index] === "]") throw new Error(`Array for ${label} has a trailing comma`);
    if (index >= value.length) throw new Error(`Unclosed array for ${label}`);
  }
  throw new Error(`Unclosed array for ${label}`);
}

function parseArrayLiteral(value: string): string[] {
  return parseConfigStringArray(value, "config value");
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

function parseConfidence(value: string, label: string): number {
  const parsed = parseConfigNumber(value.trim(), label);
  if (parsed > 1) throw new Error(`${label} must be a number between 0 and 1`);
  return parsed;
}

function parseBoolean(value: string, label: string): boolean {
  return parseConfigBoolean(value.trim(), label);
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

function parseBackend(value: string, label: string): ZtsConfig["defaults"]["applyBackend"] {
  if (value === "auto" || value === "live" || value === "session") return value;
  throw new Error(`${label} must be one of: auto, live, session`);
}

function parseSemanticEngine(value: string, label: string): ZtsConfig["semantic"]["engine"] {
  if (value === "lexical" || value === "bge-small" || value === "hybrid") return value;
  throw new Error(`${label} must be one of: lexical, bge-small, hybrid`);
}

function parseMoveCap(value: string, label: string): number {
  const parsed = parseConfigNumber(value.trim(), label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be a whole number greater than or equal to 0`);
  if (parsed > CONFIG_MAX_MOVES) throw new Error(`${label} must be at most ${CONFIG_MAX_MOVES}`);
  return parsed;
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
