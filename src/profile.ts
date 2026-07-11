import { lstat, open } from "node:fs/promises";
import { constants, realpathSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { sha256Canonical } from "./domain/digest.js";
import { iniSections, type IniData } from "./ini.js";
import { zenAppSupportDir } from "./paths.js";
import { findZenProcesses, type ZenProcess } from "./processes.js";

const PROFILE_INI_MAX_BYTES = 1_048_576;
const PROFILE_INI_MAX_LINES = 8_192;
const PROFILE_INI_MAX_LINE_BYTES = 32_768;
const PROFILE_INI_MAX_SECTIONS = 256;
const PROFILE_INI_MAX_TOTAL_KEYS = 4_096;
const PROFILE_INI_MAX_KEYS_PER_SECTION = 64;
const PROFILE_INI_MAX_SECTION_BYTES = 256;
const PROFILE_INI_MAX_KEY_BYTES = 256;
const PROFILE_INI_MAX_VALUE_BYTES = 16_384;

export interface ZenProfile {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  fromInstallDefault: boolean;
}

export interface SessionFileSource {
  kind: "zen-sessions" | "recovery" | "previous";
  path: string;
  exists: boolean;
  size: number;
  modifiedMs: number;
}

export interface ProfileContext {
  appSupportDir: string;
  profile: ZenProfile;
  running: boolean;
  runningProcesses: ZenProcess[];
  sessionFile: SessionFileSource;
}

export interface LegacyProfileIdentity {
  readonly profileId: string;
  readonly profilePath: string;
}

export interface ZenCompatibilityIdentity {
  readonly version: string;
  readonly buildId: string;
  readonly osAbi: string;
}

export interface ProfileDiscoveryHooks {
  /** Test-only interruption point after a no-follow INI handle has been validated. */
  afterIniStat?: (path: string) => void | Promise<void>;
}

export async function discoverProfileContext(): Promise<ProfileContext> {
  const appSupportDir = zenAppSupportDir();
  const profiles = await discoverProfiles(appSupportDir);
  if (profiles.length === 0) {
    throw new Error(`No Zen profiles found under ${appSupportDir}`);
  }

  const runningProcesses = await findZenProcesses();
  const profile = selectProfile(profiles, runningProcesses, process.env.ZTS_PROFILE);
  const runningProfileIds = new Set(runningProcesses.flatMap((process) =>
    process.profilePath ? [profileIdForPath(process.profilePath)] : []
  ));

  return {
    appSupportDir,
    profile,
    running:
      runningProcesses.some((process) => process.profilePath && profileIdForPath(process.profilePath) === profile.id) ||
      (runningProcesses.some((process) => !process.profilePath) && runningProfileIds.size === 0),
    runningProcesses,
    sessionFile: await findSessionFile(profile.path)
  };
}

/** Resolves one Profile only from explicit or unambiguous evidence. */
export function selectProfile(
  profiles: readonly ZenProfile[],
  runningProcesses: readonly ZenProcess[],
  explicitSelector?: string
): ZenProfile {
  const unique = uniqueProfiles(profiles);
  if (explicitSelector !== undefined) {
    const selector = explicitSelector.trim();
    if (!selector) throw new Error("ZTS_PROFILE must name one exact Profile id, path, or unique name");
    const exactIds = unique.filter((candidate) => candidate.id === selector);
    if (exactIds.length === 1) return exactIds[0]!;
    const exactPaths = unique.filter((candidate) => candidate.path === selector);
    if (exactPaths.length === 1) return exactPaths[0]!;
    const exactNames = unique.filter((candidate) => candidate.name === selector);
    if (exactNames.length === 1) return exactNames[0]!;
    throw new Error(
      exactNames.length > 1
        ? `ZTS_PROFILE name is ambiguous; use one exact Profile id: ${exactNames.map((candidate) => candidate.id).join(", ")}`
        : `ZTS_PROFILE did not match a discovered Profile: ${selector}`
    );
  }

  const knownIds = new Set(unique.map((profile) => profile.id));
  const runningIds = new Set(runningProcesses.flatMap((process) => {
    if (!process.profilePath) return [];
    const id = profileIdForPath(process.profilePath);
    return knownIds.has(id) ? [id] : [];
  }));
  if (runningIds.size === 1) return unique.find((candidate) => runningIds.has(candidate.id))!;
  if (runningIds.size > 1) {
    throw new Error(
      `Multiple running Zen Profiles match this installation (${[...runningIds].join(", ")}); set ZTS_PROFILE to one exact id`
    );
  }

  const installDefaults = uniqueProfiles(profiles.filter((candidate) => candidate.fromInstallDefault));
  if (installDefaults.length === 1) return installDefaults[0]!;
  if (installDefaults.length > 1) {
    throw new Error(
      `Multiple Zen install-default Profiles are configured (${installDefaults.map((candidate) => candidate.id).join(", ")}); set ZTS_PROFILE to one exact id`
    );
  }
  const defaults = uniqueProfiles(profiles.filter((candidate) => candidate.isDefault));
  if (defaults.length === 1) return defaults[0]!;
  if (defaults.length > 1) {
    throw new Error(
      `Multiple default Zen Profiles are configured (${defaults.map((candidate) => candidate.id).join(", ")}); set ZTS_PROFILE to one exact id`
    );
  }
  if (unique.length === 1) return unique[0]!;
  throw new Error(
    `Multiple Zen Profiles are eligible (${unique.map((candidate) => candidate.id).join(", ")}); set ZTS_PROFILE to one exact id or unique name`
  );
}

function uniqueProfiles(profiles: readonly ZenProfile[]): ZenProfile[] {
  return [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
}

export async function discoverProfiles(
  appSupportDir = zenAppSupportDir(),
  hooks: ProfileDiscoveryHooks = {}
): Promise<ZenProfile[]> {
  const profilesIniPath = join(appSupportDir, "profiles.ini");
  const installsIniPath = join(appSupportDir, "installs.ini");
  const profilesIni = await readBoundedProfileIni(profilesIniPath, "profiles.ini", hooks);
  const installDefaults = await readInstallDefaults(installsIniPath, hooks);
  const profiles: ZenProfile[] = [];

  for (const [section, values] of iniSections(profilesIni)) {
    if (!section.startsWith("Profile")) continue;
    const relativePath = values.get("Path");
    if (!relativePath) continue;

    const profilePath = values.get("IsRelative") === "1"
      ? join(appSupportDir, relativePath)
      : relativePath;
    const normalizedPath = canonicalProfilePath(
      isAbsolute(profilePath) ? profilePath : join(appSupportDir, profilePath)
    );

    profiles.push({
      id: profileIdForPath(normalizedPath),
      name: values.get("Name") ?? basename(normalizedPath),
      path: normalizedPath,
      isDefault: values.get("Default") === "1",
      fromInstallDefault: installDefaults.has(relativePath) || installDefaults.has(normalizedPath)
    });
  }

  profiles.sort((a, b) => Number(b.fromInstallDefault) - Number(a.fromInstallDefault));
  return profiles;
}

export function profileIdForPath(profilePath: string): string {
  const canonicalPath = canonicalProfilePath(profilePath);
  return `profile:${sha256Canonical({ profilePath: canonicalPath }).slice("sha256:".length)}`;
}

export function profilePathsMatch(left: string, right: string): boolean {
  try {
    return profileIdForPath(left) === profileIdForPath(right);
  } catch {
    return false;
  }
}

export function zenProcessMayOwnProfile(process: ZenProcess, profile: ZenProfile): boolean {
  if (process.profilePath === undefined) return true;
  try {
    return profileIdForPath(process.profilePath) === profile.id;
  } catch {
    // An unreadable or otherwise unresolvable process path is not proof that the
    // running browser is unrelated to the target Profile. Mutation must fail safe.
    return true;
  }
}

export function canonicalProfilePath(profilePath: string): string {
  const resolvedPath = resolve(profilePath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(resolvedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalPath = resolvedPath;
  }
  return canonicalPath;
}

export function legacyProfileIdForPath(profilePath: string): string {
  return basename(profilePath);
}

export async function discoverLegacyProfileIdentities(
  appSupportDir: string,
  profile: ZenProfile
): Promise<LegacyProfileIdentity[]> {
  assertProfileIdentity(profile);
  const identities = new Map<string, LegacyProfileIdentity>();
  const remember = (profilePath: string) => {
    if (profileIdForPath(profilePath) !== profile.id) return;
    const identity = { profileId: legacyProfileIdForPath(profilePath), profilePath };
    identities.set(`${identity.profileId}\0${identity.profilePath}`, identity);
  };

  // The canonical path covers profiles that were never configured through an
  // alias. The configured paths reconstruct the exact pre-migration lock keys.
  remember(profile.path);
  const profilesIni = await readBoundedProfileIni(join(appSupportDir, "profiles.ini"), "profiles.ini");
  for (const [section, values] of iniSections(profilesIni)) {
    if (!section.startsWith("Profile")) continue;
    const configured = values.get("Path");
    if (!configured) continue;
    const legacyPath = values.get("IsRelative") === "1"
      ? join(appSupportDir, configured)
      : isAbsolute(configured)
        ? configured
        : join(appSupportDir, configured);
    remember(legacyPath);
  }
  return [...identities.values()].sort((left, right) =>
    left.profilePath.localeCompare(right.profilePath)
  );
}

export function assertProfileIdentity(profile: ZenProfile): void {
  const expected = profileIdForPath(profile.path);
  if (profile.id !== expected) {
    throw new Error("Zen Profile identity is not bound to its canonical path");
  }
}

/** Reads Firefox/Zen's Profile-bound compatibility identity without following links. */
export async function readZenCompatibilityIdentity(
  profilePath: string
): Promise<ZenCompatibilityIdentity | null> {
  const contents = await readBoundedProfileIni(
    join(canonicalProfilePath(profilePath), "compatibility.ini"),
    "compatibility.ini",
    {},
    true
  );
  if (!contents) return null;
  const compatibility = iniSections(contents).find(([section]) => section === "Compatibility")?.[1];
  const lastVersion = compatibility?.get("LastVersion") ?? "";
  const osAbi = compatibility?.get("LastOSABI") ?? "";
  const match = /^([^_/\s]{1,128})_([0-9]{14})\/([0-9]{14})$/u.exec(lastVersion);
  if (!match || match[2] !== match[3] || !/^[A-Za-z0-9_.-]{1,128}$/u.test(osAbi)) return null;
  return { version: match[1]!, buildId: match[2]!, osAbi };
}

async function readInstallDefaults(path: string, hooks: ProfileDiscoveryHooks = {}): Promise<Set<string>> {
  const installsIni = await readBoundedProfileIni(path, "installs.ini", hooks, true);
  if (!installsIni) return new Set();
  const defaults = new Set<string>();
  for (const [, values] of iniSections(installsIni)) {
    const defaultPath = values.get("Default");
    if (defaultPath) defaults.add(defaultPath);
  }
  return defaults;
}

async function readBoundedProfileIni(
  path: string,
  label: string,
  hooks?: ProfileDiscoveryHooks
): Promise<IniData>;
async function readBoundedProfileIni(
  path: string,
  label: string,
  hooks: ProfileDiscoveryHooks,
  missingIsEmpty: true
): Promise<IniData | null>;
async function readBoundedProfileIni(
  path: string,
  label: string,
  hooks: ProfileDiscoveryHooks = {},
  missingIsEmpty = false
): Promise<IniData | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (missingIsEmpty && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    assertBoundedIniMetadata(before, path);
    await assertIniPathNamesHandle(path, before);
    await hooks.afterIniStat?.(path);

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(bytes, offset, before.size - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} truncated while being read: ${path}`);
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, before.size)).bytesRead !== 0) {
      throw new Error(`${label} grew while being read: ${path}`);
    }

    const after = await handle.stat();
    assertBoundedIniMetadata(after, path);
    if (!sameIniFileState(before, after)) {
      throw new Error(`${label} changed while being read: ${path}`);
    }
    await assertIniPathNamesHandle(path, after);

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${label} is not valid UTF-8: ${path}`);
    }
    return parseBoundedProfileIni(contents, label);
  } finally {
    await handle.close();
  }
}

function assertBoundedIniMetadata(
  metadata: Stats,
  path: string
): void {
  if (!metadata.isFile()) throw new Error(`Profile INI source is not a regular file: ${path}`);
  if (metadata.nlink !== 1) throw new Error(`Profile INI source has an unexpected hardlink count: ${path}`);
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error(`Profile INI source is not owned by the current user: ${path}`);
  }
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    throw new Error(`Profile INI source has an invalid byte size: ${path}`);
  }
  if (metadata.size > PROFILE_INI_MAX_BYTES) {
    throw new Error(`Profile INI source exceeds the ${PROFILE_INI_MAX_BYTES}-byte limit: ${path}`);
  }
}

async function assertIniPathNamesHandle(
  path: string,
  held: Stats
): Promise<void> {
  const canonical = await lstat(path);
  if (canonical.isSymbolicLink()
    || !canonical.isFile()
    || canonical.dev !== held.dev
    || canonical.ino !== held.ino) {
    throw new Error(`Profile INI path is not one canonical no-follow file: ${path}`);
  }
}

function sameIniFileState(
  before: Stats,
  after: Stats
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mode === after.mode
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function parseBoundedProfileIni(contents: string, label: string): IniData {
  const lines = contents.split(/\r?\n/);
  if (lines.length > PROFILE_INI_MAX_LINES) {
    throw new Error(`${label} exceeds the ${PROFILE_INI_MAX_LINES}-line limit`);
  }

  const data: IniData = new Map([["", new Map()]]);
  let section = "";
  let sectionCount = 0;
  let totalKeyCount = 0;

  for (const [lineIndex, rawLine] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (Buffer.byteLength(rawLine, "utf8") > PROFILE_INI_MAX_LINE_BYTES) {
      throw new Error(`${label} line ${lineNumber} exceeds the ${PROFILE_INI_MAX_LINE_BYTES}-byte limit`);
    }
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      const candidate = sectionMatch[1] ?? "";
      assertIniStringBound(candidate, "section", PROFILE_INI_MAX_SECTION_BYTES, label, lineNumber);
      sectionCount += 1;
      if (sectionCount > PROFILE_INI_MAX_SECTIONS) {
        throw new Error(`${label} exceeds the ${PROFILE_INI_MAX_SECTIONS}-section limit`);
      }
      if (data.has(candidate)) {
        throw new Error(`${label} repeats section "${candidate}" at line ${lineNumber}`);
      }
      section = candidate;
      data.set(section, new Map());
      continue;
    }

    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`${label} has malformed input at line ${lineNumber}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) throw new Error(`${label} has an empty key at line ${lineNumber}`);
    assertIniStringBound(key, "key", PROFILE_INI_MAX_KEY_BYTES, label, lineNumber);
    assertIniStringBound(value, "value", PROFILE_INI_MAX_VALUE_BYTES, label, lineNumber);

    totalKeyCount += 1;
    if (totalKeyCount > PROFILE_INI_MAX_TOTAL_KEYS) {
      throw new Error(`${label} exceeds the ${PROFILE_INI_MAX_TOTAL_KEYS}-key limit`);
    }
    const values = data.get(section);
    if (!values) throw new Error(`${label} has no active section at line ${lineNumber}`);
    if (values.size >= PROFILE_INI_MAX_KEYS_PER_SECTION) {
      throw new Error(`${label} section "${section}" exceeds the ${PROFILE_INI_MAX_KEYS_PER_SECTION}-key limit`);
    }
    if (values.has(key)) throw new Error(`${label} repeats key "${key}" at line ${lineNumber}`);
    values.set(key, value);
  }

  return data;
}

function assertIniStringBound(
  value: string,
  kind: "section" | "key" | "value",
  maxBytes: number,
  label: string,
  lineNumber: number
): void {
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte at line ${lineNumber}`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} ${kind} exceeds the ${maxBytes}-byte limit at line ${lineNumber}`);
  }
}

export async function findSessionFile(profilePath: string): Promise<SessionFileSource> {
  const candidates: Array<{ kind: SessionFileSource["kind"]; path: string }> = [
    { kind: "zen-sessions", path: join(profilePath, "zen-sessions.jsonlz4") },
    { kind: "recovery", path: join(profilePath, "sessionstore-backups", "recovery.jsonlz4") },
    { kind: "previous", path: join(profilePath, "sessionstore-backups", "previous.jsonlz4") }
  ];

  for (const candidate of candidates) {
    let handle;
    try {
      handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const details = await handle.stat();
      const canonical = await lstat(candidate.path);
      if (!details.isFile()
        || details.nlink !== 1
        || canonical.isSymbolicLink()
        || canonical.dev !== details.dev
        || canonical.ino !== details.ino) {
        throw new Error(`Zen session source is not one canonical no-follow regular file: ${candidate.path}`);
      }
      return {
        ...candidate,
        exists: true,
        size: details.size,
        modifiedMs: details.mtimeMs
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
  }

  throw new Error(`No readable Zen session file found under ${profilePath}`);
}
