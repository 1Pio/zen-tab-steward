import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(projectRoot, "dist");
if (outputRoot === projectRoot || !outputRoot.startsWith(`${projectRoot}/`)) {
  throw new Error("Refusing to clean a build output outside the project root");
}
await rm(outputRoot, { recursive: true, force: true });
