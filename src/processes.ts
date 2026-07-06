import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ZenProcess {
  pid: number;
  args: string;
  profilePath?: string;
}

export async function findZenProcesses(): Promise<ZenProcess[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,args="], {
    maxBuffer: 10 * 1024 * 1024
  });
  return parseZenProcesses(stdout);
}

export function parseZenProcesses(stdout: string): ZenProcess[] {
  const processes: ZenProcess[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("/Zen.app/Contents/MacOS/")) continue;
    if (trimmed.includes(" rg ") || trimmed.includes(" rg -")) continue;

    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;

    const args = match[2] ?? "";
    processes.push({
      pid: Number(match[1]),
      args,
      profilePath: extractProfilePath(args)
    });
  }

  return processes;
}

function extractProfilePath(args: string): string | undefined {
  const marker = " -profile ";
  const index = args.indexOf(marker);
  if (index === -1) return undefined;
  const value = args.slice(index + marker.length).trim();
  const mozillaIndex = value.indexOf(" org.mozilla.");
  if (mozillaIndex !== -1) return value.slice(0, mozillaIndex);
  return value;
}
