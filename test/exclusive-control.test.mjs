import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireExclusiveFileControl } from "../dist/exclusive-control.js";

test("parent descriptor retains kernel control after the lockf helper exits", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-exclusive-control-"));
  try {
    const path = join(root, "control.lock");
    const first = await acquireExclusiveFileControl(path, "first fixture", { timeoutSeconds: 1 });
    await assert.rejects(
      () => acquireExclusiveFileControl(path, "contending fixture", { timeoutSeconds: 0 }),
      /could not be acquired/
    );
    await first.release();
    const successor = await acquireExclusiveFileControl(path, "successor fixture", { timeoutSeconds: 1 });
    await successor.release();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native Profile control conflicts with Gecko-compatible fcntl and preserves its mode", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-native-profile-control-"));
  const path = join(root, ".parentlock");
  await writeFile(path, "");
  await chmod(path, 0o644);
  const original = await stat(path);
  const holder = spawn("/usr/bin/python3", ["-c", [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_WRONLY)",
    "fcntl.lockf(fd, fcntl.LOCK_EX)",
    "sys.stdout.write('ready\\n'); sys.stdout.flush()",
    "sys.stdin.buffer.read()",
    "os.close(fd)"
  ].join("; "), path], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout.once("data", (chunk) => chunk.toString() === "ready\n"
        ? resolve()
        : reject(new Error("fcntl fixture did not become ready")));
    });
    await assert.rejects(
      () => acquireExclusiveFileControl(path, "native Profile fixture", {
        timeoutSeconds: 0,
        fileKind: "native_profile"
      }),
      /could not be acquired/
    );
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    holder.stdin.end();
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fcntl fixture exited ${String(code)}`)));
    });
    const control = await acquireExclusiveFileControl(path, "native Profile fixture", {
      timeoutSeconds: 1,
      fileKind: "native_profile"
    });
    assert.equal((await stat(path)).ino, original.ino);
    await control.release();
    assert.equal((await stat(path)).mode & 0o777, 0o644);
  } finally {
    holder.stdin.end();
    if (holder.exitCode === null) holder.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

test("zts-held native control blocks fcntl until release", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-native-reverse-"));
  const path = join(root, ".parentlock");
  await writeFile(path, "");
  const contender = [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_WRONLY)",
    "try:",
    " fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    " sys.exit(75)",
    "os.close(fd)"
  ].join("\n");
  try {
    const control = await acquireExclusiveFileControl(path, "zts native holder", {
      timeoutSeconds: 1,
      fileKind: "native_profile"
    });
    assert.equal(spawnSync("/usr/bin/python3", ["-c", contender, path]).status, 75);
    await control.release();
    assert.equal(spawnSync("/usr/bin/python3", ["-c", contender, path]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path replacement is detected and release still closes the held descriptor", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-exclusive-replaced-"));
  const path = join(root, "control.lock");
  try {
    const control = await acquireExclusiveFileControl(path, "replace fixture", { timeoutSeconds: 1 });
    await rename(path, `${path}.replaced`);
    await writeFile(path, `${JSON.stringify({ schemaVersion: "zts.kernel-lock-file.provisional-1" })}\n`, { mode: 0o600 });
    await assert.rejects(() => control.assertHeld(), /canonical path no longer names/);
    await assert.rejects(() => control.release(), /canonical path no longer names/);
    const successor = await acquireExclusiveFileControl(path, "replacement successor", { timeoutSeconds: 1 });
    await successor.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process death releases parent-owned kernel control", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-exclusive-parent-death-"));
  const path = join(root, "control.lock");
  const script = [
    'import { acquireExclusiveFileControl } from "./dist/exclusive-control.js";',
    `await acquireExclusiveFileControl(${JSON.stringify(path)}, "child holder", { timeoutSeconds: 1 });`,
    'process.stdout.write("ready\\n");',
    "setInterval(() => {}, 1000);",
    "await new Promise(() => {});"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => chunk.toString() === "ready\n"
        ? resolve()
        : reject(new Error("child holder did not become ready")));
    });
    await assert.rejects(
      () => acquireExclusiveFileControl(path, "parent contender", { timeoutSeconds: 0 }),
      /could not be acquired/
    );
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const successor = await acquireExclusiveFileControl(path, "post-death successor", { timeoutSeconds: 1 });
    await successor.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("existing private control acquisition creates no temp and does not scan a large history parent", {
  skip: process.platform !== "darwin"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zts-existing-control-fast-path-"));
  const path = join(root, "history.lock");
  try {
    const bootstrap = await acquireExclusiveFileControl(path, "history bootstrap", { timeoutSeconds: 1 });
    await bootstrap.release();
    for (let index = 0; index < 4_100; index += 1) {
      await writeFile(join(root, `${String(index).padStart(5, "0")}.node.json`), "{}\n", { mode: 0o600 });
    }
    const script = [
      'import { acquireExclusiveFileControl } from "./dist/exclusive-control.js";',
      `await acquireExclusiveFileControl(${JSON.stringify(path)}, "existing history control", { timeoutSeconds: 1 });`,
      "process.exit(106);"
    ].join("\n");
    const crashed = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    assert.equal(crashed.status, 106, `${crashed.stdout}\n${crashed.stderr}`);
    assert.equal((await readdir(root)).some((entry) => entry.startsWith(".tmp-")), false);
    const successor = await acquireExclusiveFileControl(path, "history successor", { timeoutSeconds: 1 });
    await successor.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
