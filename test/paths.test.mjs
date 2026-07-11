import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, stateDir, zenAppSupportDir } from "../dist/paths.js";

test("built CLI remains directly executable for linked installs", async () => {
  const cliPath = join(process.cwd(), "dist", "cli.js");
  await access(cliPath, constants.X_OK);
  assert.equal((await stat(cliPath)).mode & 0o111, 0o111);
});

test("path overrides require dedicated absolute locations", () => {
  withEnvironment("ZTS_STATE_DIR", "relative-state", () => {
    assert.throws(() => stateDir(), /absolute/);
  });
  withEnvironment("ZTS_CONFIG_PATH", "config.toml", () => {
    assert.throws(() => configPath(), /absolute/);
  });
  withEnvironment("ZTS_ZEN_APP_SUPPORT_DIR", "relative-zen", () => {
    assert.throws(() => zenAppSupportDir(), /absolute/);
  });
  withEnvironment("ZTS_STATE_DIR", tmpdir(), () => {
    assert.throws(() => stateDir(), /dedicated/);
  });
  withEnvironment("ZTS_CONFIG_PATH", join(homedir(), "config.toml"), () => {
    assert.throws(() => configPath(), /dedicated/);
  });
  withEnvironment("ZTS_STATE_DIR", join(homedir(), "Documents"), () => {
    assert.throws(() => stateDir(), /dedicated/);
  });
  withEnvironment("ZTS_CONFIG_PATH", join(homedir(), "Documents", "config.toml"), () => {
    assert.throws(() => configPath(), /dedicated/);
  });
});

test("home expansion produces normalized absolute overrides", () => {
  withEnvironment("ZTS_STATE_DIR", "~/.zts-test-state", () => {
    assert.equal(stateDir(), join(homedir(), ".zts-test-state"));
  });
  withEnvironment("ZTS_CONFIG_PATH", "~/.zts-test-config/config.toml", () => {
    assert.equal(configPath(), join(homedir(), ".zts-test-config", "config.toml"));
  });
});

function withEnvironment(name, value, action) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    action();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
