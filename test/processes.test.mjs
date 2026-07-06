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
