import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { currentProcessOwner } from "../dist/process-owner.js";

const execFileAsync = promisify(execFile);

test("process owner identity remains active across caller timezones", {
  skip: process.platform !== "darwin"
}, async () => {
  const owner = await currentProcessOwner();
  assert.match(owner.processStartIdentity ?? "", /^darwin-ps-lstart-utc:/u);
  const script = [
    'import { processOwnerIsActive } from "./dist/process-owner.js";',
    `process.stdout.write(String(await processOwnerIsActive(${JSON.stringify(owner)})));`
  ].join("\n");
  for (const timezone of ["UTC", "Asia/Dubai", "America/New_York"]) {
    const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: timezone }
    });
    assert.equal(result.stdout, "true", `owner was misclassified under ${timezone}`);
  }
});
