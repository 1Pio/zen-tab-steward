export type IniData = Map<string, Map<string, string>>;

export function parseIni(contents: string): IniData {
  const data: IniData = new Map();
  let section = "";
  data.set(section, new Map());

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      if (!data.has(section)) data.set(section, new Map());
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    data.get(section)?.set(key, value);
  }

  return data;
}

export function iniSections(data: IniData): Array<[string, Map<string, string>]> {
  return Array.from(data.entries()).filter(([section]) => section.length > 0);
}
