import assert from "node:assert/strict";
import test from "node:test";
import { parseZenProcesses } from "../dist/processes.js";

test("detects the main Zen process and extracts profile path with spaces", () => {
  const output = `
  101 /Applications/Zen.app/Contents/MacOS/zen -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)
  102 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)
  103 /Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release) org.mozilla.machname.123 1 socket
  `;

  assert.deepEqual(parseZenProcesses(output), [
    {
      pid: 101,
      args: "/Applications/Zen.app/Contents/MacOS/zen -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)",
      profilePath: "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)"
    },
    {
      pid: 102,
      args: "/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)",
      profilePath: "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)"
    },
    {
      pid: 103,
      args: "/Applications/Zen.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -profile /Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release) org.mozilla.machname.123 1 socket",
      profilePath: "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)"
    }
  ]);
});

test("extracts profile path before later launch flags", () => {
  const profilePath = "/Users/main/Library/Application Support/zen/Profiles/4le6r9n3.Default (release)";
  const output = `101 /Applications/Zen.app/Contents/MacOS/zen -profile ${profilePath} --remote-debugging-port=9222 --remote-allow-system-access --remote-allow-hosts localhost --remote-allow-origins http://127.0.0.1:9222`;

  assert.deepEqual(parseZenProcesses(output), [
    {
      pid: 101,
      args: output.slice("101 ".length),
      profilePath
    }
  ]);
});
