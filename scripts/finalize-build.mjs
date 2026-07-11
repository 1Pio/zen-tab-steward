import { chmod, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(projectRoot, "dist", "cli.js");
const firstLine = (await readFile(cliPath, "utf8")).split("\n", 1)[0];
if (firstLine !== "#!/usr/bin/env node") {
  throw new Error("Built zts CLI is missing its executable Node shebang");
}
await chmod(cliPath, 0o755);
