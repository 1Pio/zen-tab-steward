import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PATCH_INPUT_MAX_BYTES, readPatchInput } from "../dist/manual.js";

test("manual Patch file input is rejected before an oversized payload is read", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-patch-input-"));
  const path = join(root, "oversized.json");
  try {
    await writeFile(path, Buffer.alloc(PATCH_INPUT_MAX_BYTES + 1, 0x20));
    await assert.rejects(
      () => readPatchInput(path),
      /Patch input exceeds the 1048576-byte limit/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual Patch stdin is rejected as soon as chunked input crosses the byte limit", () => {
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "--eval",
      'import { readPatchInput } from "./dist/manual.js"; await readPatchInput("-");'
    ],
    {
      cwd: process.cwd(),
      input: Buffer.alloc(PATCH_INPUT_MAX_BYTES + 1, 0x20),
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Patch input exceeds the 1048576-byte limit/);
});

test("bounded manual Patch reading preserves valid full-detail input", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-patch-input-"));
  const path = join(root, "valid.json");
  const input = {
    operations: [{
      op: "move",
      entityRef: "entity:root:tab-private",
      expectedSourceWorkspaceId: "workspace-inbox",
      destinationWorkspaceId: "workspace-research",
      reason: "Keep the complete agent-authored rationale, including Unicode: 研究 🔒"
    }]
  };
  try {
    await writeFile(path, JSON.stringify(input));
    assert.deepEqual(await readPatchInput(path), input);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual Patch input rejects malformed UTF-8 instead of replacing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-patch-input-"));
  const path = join(root, "invalid-utf8.json");
  try {
    await writeFile(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]));
    await assert.rejects(() => readPatchInput(path), /not valid UTF-8/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
