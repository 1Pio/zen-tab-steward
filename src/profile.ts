import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { iniSections, parseIni } from "./ini.js";
import { zenAppSupportDir } from "./paths.js";
import { findZenProcesses, ZenProcess } from "./processes.js";

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

export async function discoverProfileContext(): Promise<ProfileContext> {
  const appSupportDir = zenAppSupportDir();
  const profiles = await discoverProfiles(appSupportDir);
  if (profiles.length === 0) {
    throw new Error(`No Zen profiles found under ${appSupportDir}`);
  }

  const runningProcesses = await findZenProcesses();
  const runningProfilePath = runningProcesses.find((process) => process.profilePath)?.profilePath;
  const profile =
    (runningProfilePath && profiles.find((candidate) => candidate.path === runningProfilePath)) ??
    profiles.find((candidate) => candidate.fromInstallDefault) ??
    profiles.find((candidate) => candidate.isDefault) ??
    profiles[0];

  if (!profile) {
    throw new Error(`No usable Zen profile found under ${appSupportDir}`);
  }

  return {
    appSupportDir,
    profile,
    running:
      runningProcesses.some((process) => process.profilePath === profile.path) ||
      (runningProcesses.some((process) => !process.profilePath) && !runningProfilePath),
    runningProcesses,
    sessionFile: await findSessionFile(profile.path)
  };
}

export async function discoverProfiles(appSupportDir = zenAppSupportDir()): Promise<ZenProfile[]> {
  const profilesIniPath = join(appSupportDir, "profiles.ini");
  const installsIniPath = join(appSupportDir, "installs.ini");
  const profilesIni = parseIni(await readFile(profilesIniPath, "utf8"));
  const installDefaults = await readInstallDefaults(installsIniPath);
  const profiles: ZenProfile[] = [];

  for (const [section, values] of iniSections(profilesIni)) {
    if (!section.startsWith("Profile")) continue;
    const relativePath = values.get("Path");
    if (!relativePath) continue;

    const profilePath = values.get("IsRelative") === "1"
      ? join(appSupportDir, relativePath)
      : relativePath;
    const normalizedPath = isAbsolute(profilePath) ? profilePath : join(appSupportDir, profilePath);

    profiles.push({
      id: basename(normalizedPath),
      name: values.get("Name") ?? basename(normalizedPath),
      path: normalizedPath,
      isDefault: values.get("Default") === "1",
      fromInstallDefault: installDefaults.has(relativePath) || installDefaults.has(normalizedPath)
    });
  }

  profiles.sort((a, b) => Number(b.fromInstallDefault) - Number(a.fromInstallDefault));
  return profiles;
}

async function readInstallDefaults(path: string): Promise<Set<string>> {
  try {
    const installsIni = parseIni(await readFile(path, "utf8"));
    const defaults = new Set<string>();
    for (const [, values] of iniSections(installsIni)) {
      const defaultPath = values.get("Default");
      if (defaultPath) defaults.add(defaultPath);
    }
    return defaults;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

export async function findSessionFile(profilePath: string): Promise<SessionFileSource> {
  const candidates: Array<{ kind: SessionFileSource["kind"]; path: string }> = [
    { kind: "zen-sessions", path: join(profilePath, "zen-sessions.jsonlz4") },
    { kind: "recovery", path: join(profilePath, "sessionstore-backups", "recovery.jsonlz4") },
    { kind: "previous", path: join(profilePath, "sessionstore-backups", "previous.jsonlz4") }
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate.path, constants.R_OK);
      const details = await stat(candidate.path);
      return {
        ...candidate,
        exists: true,
        size: details.size,
        modifiedMs: details.mtimeMs
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  throw new Error(`No readable Zen session file found under ${profilePath}`);
}
