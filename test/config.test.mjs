import assert from "node:assert/strict";
import { chmod, link, mkdtemp, mkdir, open, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_FILE_MAX_BYTES,
  CONFIG_MAX_ARRAY_ITEMS,
  CONFIG_MAX_DOMAIN_RULES,
  CONFIG_MAX_STRING_BYTES,
  addDomainRule,
  addDomainRuleInContents,
  effectiveConfigRevision,
  formatConfig,
  getConfigValue,
  inspectConfigLocation,
  loadConfig,
  parseConfig,
  saveConfigContents,
  setConfigValue,
  setConfigValueInContents
} from "../dist/config.js";

test("effective config revision ignores source formatting but binds parsed policy", () => {
  const compact = parseConfig('[protect.domains]\nnever_move = ["github.com"]\n');
  const commented = parseConfig([
    "# formatting and comments are not effective policy",
    "[protect.domains]",
    'never_move = ["github.com"] # keep private work fixed',
    ""
  ].join("\n"));
  const changed = parseConfig('[protect.domains]\nnever_move = ["framer.com"]\n');

  assert.equal(effectiveConfigRevision(compact), effectiveConfigRevision(commented));
  assert.notEqual(effectiveConfigRevision(compact), effectiveConfigRevision(changed));
});

test("parses and formats the supported config shape", () => {
  const config = parseConfig(`
[defaults]
inbox = "Space"
min_confidence = 0.9
include_pinned = true
apply_backend = "session"

[sort]
from = ["Space"]
to = ["Portfolio"]
not_to = ["Stash"]
only = ["github.com"]
except = ["youtube.com"]

[semantic]
enabled = true
engine = "hybrid"
suggestion_threshold = 0.75
auto_apply = true
auto_apply_threshold = 0.93
minimum_margin = 0.21
max_moves = 3

[rules.domains]
"example.com" = "Portfolio"
`);

  assert.equal(config.defaults.inbox, "Space");
  assert.equal(config.defaults.minConfidence, 0.9);
  assert.equal(config.defaults.includePinned, true);
  assert.equal(config.defaults.applyBackend, "session");
  assert.deepEqual(config.sort.from, ["Space"]);
  assert.deepEqual(config.sort.to, ["Portfolio"]);
  assert.deepEqual(config.sort.notTo, ["Stash"]);
  assert.deepEqual(config.sort.only, ["github.com"]);
  assert.deepEqual(config.sort.except, ["youtube.com"]);
  assert.equal(config.semantic.enabled, true);
  assert.equal(config.semantic.engine, "hybrid");
  assert.equal(config.semantic.suggestionThreshold, 0.75);
  assert.equal(config.semantic.autoApply, true);
  assert.equal(config.semantic.autoApplyThreshold, 0.93);
  assert.equal(config.semantic.minimumMargin, 0.21);
  assert.equal(config.semantic.maxMoves, 3);
  assert.equal(config.rules.domains["example.com"], "Portfolio");
  assert.match(formatConfig(config), /from = \["Space"]/);
  assert.match(formatConfig(config), /\[semantic]/);
  assert.match(formatConfig(config), /auto_apply_threshold = 0.93/);
  assert.match(formatConfig(config), /"example.com" = "Portfolio"/);
});

test("rejects unsupported sections and assignments outside a section", () => {
  assert.throws(
    () => parseConfig('[future]\nenabled = true\n'),
    /unsupported config section.*future/iu
  );
  assert.throws(
    () => parseConfig('inbox = "Space"\n'),
    /assignment outside a supported section/iu
  );
});

test("rejects unknown keys and duplicate sections, keys, and domain rules", () => {
  assert.throws(
    () => parseConfig('[defaults]\nfuture = true\n'),
    /unsupported config key.*defaults\.future/iu
  );
  assert.throws(
    () => parseConfig('[defaults]\ninbox = "Space"\n[defaults]\nmin_confidence = 0.9\n'),
    /duplicate config section.*defaults/iu
  );
  assert.throws(
    () => parseConfig('[semantic]\nenabled = true\nenabled = false\n'),
    /duplicate config key.*semantic\.enabled/iu
  );
  assert.throws(
    () => parseConfig('[rules.domains]\n"example.com" = "One"\n"example.com" = "Two"\n'),
    /duplicate domain rule.*example\.com/iu
  );
});

test("rejects malformed literals, comments, statements, and value types", () => {
  const invalid = [
    ['[defaults]\ninbox = "unterminated\n', /unclosed string/iu],
    ['[sort]\nfrom = ["Space"\n', /unclosed array/iu],
    ['[sort]\nfrom = ["Space",]\n', /array.*trailing comma/iu],
    ['[defaults]\ninbox = "Space" trailing\n', /malformed string/iu],
    ['[defaults]\ninclude_pinned = "true"\n', /must be a boolean/iu],
    ['[defaults]\ninbox = Space\n', /must be a quoted string/iu],
    ['[sort]\nfrom = [true]\n', /array.*quoted strings/iu],
    ['[defaults]\nthis is not an assignment\n', /malformed config statement/iu],
    ['[defaults]\ninbox = "Space\\ # comment never starts\n', /unclosed string/iu]
  ];

  for (const [contents, expected] of invalid) {
    assert.throws(() => parseConfig(contents), expected);
  }
});

test("enforces finite numeric ranges and coherent semantic thresholds", () => {
  const invalid = [
    ['[defaults]\nmin_confidence = NaN\n', /finite.*between 0 and 1|finite non-negative/iu],
    ['[defaults]\nmin_confidence = Infinity\n', /finite.*between 0 and 1|finite non-negative/iu],
    ['[defaults]\nmin_confidence = 1.01\n', /between 0 and 1/iu],
    ['[semantic]\nmax_moves = 1.5\n', /whole number/iu],
    ['[semantic]\nmax_moves = 1001\n', /at most 1000/iu],
    [
      '[semantic]\nsuggestion_threshold = 0.95\nauto_apply_threshold = 0.9\n',
      /suggestion_threshold.*less than or equal to.*auto_apply_threshold/iu
    ]
  ];

  for (const [contents, expected] of invalid) {
    assert.throws(() => parseConfig(contents), expected);
  }

  const partial = parseConfig('[semantic]\nauto_apply_threshold = 0.95\n');
  assert.equal(partial.semantic.suggestionThreshold, 0.72);
  assert.equal(partial.semantic.autoApplyThreshold, 0.95);
  assert.equal(partial.defaults.inbox, "Space");

  const strictMargin = parseConfig('[semantic]\nsuggestion_threshold = 0.7\nminimum_margin = 0.8\n');
  assert.equal(strictMargin.semantic.minimumMargin, 0.8);

  assert.throws(
    () => parseConfig('[semantic]\nsuggestion_threshold = 1.1\n'),
    /semantic\.suggestion_threshold at line 2 must be a number between 0 and 1/iu
  );
});

test("uses one strict public scalar grammar and canonical semantic Engine spelling", () => {
  const configured = parseConfig('[semantic]\nengine = "bge-small"\nmax_moves = 1000\n');
  assert.equal(configured.semantic.engine, "bge-small");
  assert.equal(getConfigValue(configured, "semantic.engine"), "bge-small");
  assert.match(formatConfig(configured), /engine = "bge-small"/u);

  assert.throws(() => parseConfig('[semantic]\nengine = "bge_small"\n'), /bge-small/iu);
  assert.throws(() => setConfigValue(configured, "defaults.min_confidence", ""), /finite non-negative decimal/iu);
  assert.throws(() => setConfigValue(configured, "defaults.min_confidence", "1e-1"), /finite non-negative decimal/iu);
  assert.throws(() => setConfigValue(configured, "semantic.max_moves", "1e3"), /finite non-negative decimal/iu);
  assert.equal(setConfigValue(configured, "defaults.min_confidence", "0.1").defaults.minConfidence, 0.1);
});

test("bounds config strings, arrays, rules, and rejects empty policy entries", () => {
  assert.throws(
    () => parseConfig("#".repeat(CONFIG_FILE_MAX_BYTES + 1)),
    new RegExp(`${CONFIG_FILE_MAX_BYTES}-byte`, "iu")
  );
  assert.throws(
    () => parseConfig(`[defaults]\ninbox = "${"x".repeat(CONFIG_MAX_STRING_BYTES + 1)}"\n`),
    new RegExp(`string.*${CONFIG_MAX_STRING_BYTES}.*byte`, "iu")
  );
  const excessiveArray = Array.from(
    { length: CONFIG_MAX_ARRAY_ITEMS + 1 },
    (_, index) => `"Workspace ${index}"`
  ).join(", ");
  assert.throws(
    () => parseConfig(`[sort]\nfrom = [${excessiveArray}]\n`),
    new RegExp(`array.*${CONFIG_MAX_ARRAY_ITEMS}`, "iu")
  );
  const excessiveRules = Array.from(
    { length: CONFIG_MAX_DOMAIN_RULES + 1 },
    (_, index) => `"site-${index}.example" = "Workspace"`
  ).join("\n");
  assert.throws(
    () => parseConfig(`[rules.domains]\n${excessiveRules}\n`),
    new RegExp(`domain rules.*${CONFIG_MAX_DOMAIN_RULES}`, "iu")
  );
  assert.throws(
    () => parseConfig('[rules.domains]\n"   " = "Research"\n'),
    /domain rule pattern.*must not be empty/iu
  );
  assert.throws(
    () => parseConfig('[rules.domains]\n"example.com" = ""\n'),
    /domain rule destination.*must not be empty/iu
  );
  assert.throws(
    () => parseConfig('[protect.domains]\nnever_move = [""]\n'),
    /array.*empty/iu
  );
  assert.throws(
    () => parseConfig('[sort]\nfrom = ["Space", "Space"]\n'),
    /array.*duplicate entry/iu
  );
});

test("canonicalizes and validates every configured URL-pattern surface", () => {
  const configured = parseConfig([
    "[sort]",
    'only = [" EXAMPLE.COM ", "*.Framer.com"]',
    'except = ["HTTPS://EXAMPLE.COM/Private"]',
    "",
    "[protect.domains]",
    'never_move = [" .EXAMPLE.AE "]',
    "",
    "[rules.domains]",
    '" Docs.Example.com " = "Research"',
    ""
  ].join("\n"));

  assert.deepEqual(configured.sort.only, ["example.com", "*.framer.com"]);
  assert.deepEqual(configured.sort.except, ["https://example.com/Private"]);
  assert.deepEqual(configured.protect.domains.neverMove, [".example.ae"]);
  assert.deepEqual(configured.rules.domains, { "docs.example.com": "Research" });
  assert.equal(addDomainRule(parseConfig(""), " DOCS.EXAMPLE.COM ", "Research").rules.domains["docs.example.com"], "Research");
  assert.deepEqual(
    setConfigValue(parseConfig(""), "protect.domains.never_move", " EXAMPLE.COM ,*.Framer.com").protect.domains.neverMove,
    ["example.com", "*.framer.com"]
  );

  assert.throws(
    () => parseConfig('[rules.domains]\n"example.com" = "One"\n" EXAMPLE.COM " = "Two"\n'),
    /duplicate domain rule.*example\.com.*line 3/iu
  );
  assert.throws(
    () => parseConfig('[protect.domains]\nnever_move = ["https://"]\n'),
    /protect\.domains\.never_move at line 2.*invalid URL prefix pattern/iu
  );
});

test("gets, sets, and adds supported config values", () => {
  const withInbox = setConfigValue(parseConfig(""), "defaults.inbox", "Inbox");
  const withConfidence = setConfigValue(withInbox, "defaults.min_confidence", "0.7");
  const withSourceAllowlist = setConfigValue(withConfidence, "sort.from", "Space,Inbox");
  const withSemantic = setConfigValue(withSourceAllowlist, "semantic.auto_apply_threshold", "0.94");
  const withRule = addDomainRule(withSemantic, "docs.example.com", "Research");

  assert.equal(getConfigValue(withRule, "defaults.inbox"), "Inbox");
  assert.equal(getConfigValue(withRule, "defaults.min_confidence"), 0.7);
  assert.deepEqual(getConfigValue(withRule, "sort.from"), ["Space", "Inbox"]);
  assert.equal(getConfigValue(withRule, "semantic.auto_apply_threshold"), 0.94);
  assert.equal(getConfigValue(withRule, "rules.domains.docs.example.com"), "Research");
});

test("treats every quoted domain-rule key as data without prototype lookup", () => {
  const parsed = parseConfig('[rules.domains]\n"__proto__" = "Research"\n');
  const added = addDomainRule(parseConfig(""), "__proto__", "Research");

  assert.equal(getConfigValue(parsed, "rules.domains.__proto__"), "Research");
  assert.equal(getConfigValue(added, "rules.domains.__proto__"), "Research");
  assert.equal(Object.getPrototypeOf(parsed.rules.domains), Object.prototype);
  assert.equal(Object.getPrototypeOf(added.rules.domains), Object.prototype);
});

test("patches supported values without dropping valid comments or formatting", () => {
  const original = [
    "# keep me",
    "[defaults]",
    "inbox = \"Space\"",
    "",
    "[sort]",
    "from = [\"Space\"]",
    "to = [\"Portfolio\"]",
    "",
    "[semantic]",
    "auto_apply = false # gated",
    "",
    "[rules.domains]",
    "\"github.com\" = \"Tool Development\"",
    ""
  ].join("\n");

  const withConfidence = setConfigValueInContents(original, "defaults.min_confidence", "0.9");
  const withRule = addDomainRuleInContents(withConfidence, "docs.example.com", "Research");

  assert.match(withRule, /# keep me/);
  assert.match(withRule, /\[sort]/);
  assert.match(withRule, /from = \["Space"]/);
  assert.match(withRule, /to = \["Portfolio"]/);
  assert.match(withRule, /min_confidence = 0.9/);
  const withSemantic = setConfigValueInContents(withRule, "semantic.auto_apply", "true");
  assert.match(withSemantic, /auto_apply = true # gated/);
  assert.match(withRule, /"docs.example.com" = "Research"/);
});

test("validates existing and resulting config before preserving edit formatting", () => {
  const hiddenInvalid = '[future]\nenabled = true\n[defaults]\ninbox = "Space"\n';
  assert.throws(
    () => setConfigValueInContents(hiddenInvalid, "defaults.inbox", "Inbox"),
    /unsupported config section/iu
  );
  assert.throws(
    () => addDomainRuleInContents(hiddenInvalid, "example.com", "Research"),
    /unsupported config section/iu
  );

  const coherent = [
    "[semantic]",
    "suggestion_threshold = 0.8 # suggestion",
    "auto_apply_threshold = 0.9 # unattended",
    ""
  ].join("\n");
  assert.throws(
    () => setConfigValueInContents(coherent, "semantic.auto_apply_threshold", "0.7"),
    /suggestion_threshold.*less than or equal to.*auto_apply_threshold/iu
  );
  assert.throws(
    () => addDomainRuleInContents(coherent, "", "Research"),
    /domain rule pattern.*must not be empty/iu
  );
});

test("parses and preserves inline comments on supported config values", () => {
  const original = [
    "[defaults] # core defaults",
    "inbox = \"Stash\" # user inbox",
    "min_confidence = 0.8 # conservative",
    "",
    "[rules.domains]",
    "\"docs.example.com\" = \"Research\" # docs",
    ""
  ].join("\n");

  const parsed = parseConfig(original);
  const patched = setConfigValueInContents(original, "defaults.min_confidence", "0.9");
  const withRule = addDomainRuleInContents(patched, "github.com", "Tool Development");

  assert.equal(parsed.defaults.inbox, "Stash");
  assert.equal(parsed.defaults.minConfidence, 0.8);
  assert.equal(parsed.rules.domains["docs.example.com"], "Research");
  assert.match(withRule, /\[defaults] # core defaults/);
  assert.match(withRule, /min_confidence = 0.9 # conservative/);
  assert.match(withRule, /"docs.example.com" = "Research" # docs/);
  assert.match(withRule, /"github.com" = "Tool Development"/);
});

test("config storage is owner-private even under a permissive umask", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-umask-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const contents = "[defaults]\ninbox = \"Private\"\n";

  await withConfigPath(path, async () => {
    const previousUmask = process.umask(0);
    try {
      await saveConfigContents(contents, { exists: false, contents: "" });
    } finally {
      process.umask(previousUmask);
    }
    assert.equal(await readFile(path, "utf8"), contents);
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(parent)).sort(), [".config-write-control.json", "config.toml"]);
  });
});

test("loading unsafe config permissions fails closed without changing the file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-unsafe-load-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const contents = "# preserve exactly\n[defaults]\ninbox = \"Private\"\n";
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, contents, { mode: 0o644 });
  await chmod(path, 0o644);

  await withConfigPath(path, async () => {
    const before = await stat(path);
    await assert.rejects(
      () => loadConfig(),
      /config file permissions are unsafe.*expected mode 0600.*found 0644.*chmod 600.*retry/iu
    );
    const after = await stat(path);
    assert.equal(await readFile(path, "utf8"), contents);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o644);
    assert.deepEqual(await readdir(parent), ["config.toml"]);
  });
});

test("loading an unsafe config directory fails closed without repairing it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-unsafe-directory-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const contents = '[defaults]\ninbox = "Private"\n';
  await mkdir(parent, { mode: 0o755 });
  await chmod(parent, 0o755);
  await writeFile(path, contents, { mode: 0o600 });

  await withConfigPath(path, async () => {
    await assert.rejects(
      () => loadConfig(),
      /config directory permissions are unsafe.*expected mode 0700.*found 0755.*chmod 700.*retry/iu
    );
    assert.equal((await stat(parent)).mode & 0o777, 0o755);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), contents);
    assert.deepEqual(await readdir(parent), ["config.toml"]);
  });
});

test("loading accepts and removes a UTF-8 byte-order mark", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-bom-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const contents = '[defaults]\ninbox = "Private"\n';
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(contents)]), { mode: 0o600 });

  await withConfigPath(path, async () => {
    const loaded = await loadConfig();
    assert.equal(loaded.config.defaults.inbox, "Private");
    assert.equal(loaded.contents, contents);
  });
});

test("config location inspection remains available for malformed contents", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-location-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, "[future]\nenabled = true\n", { mode: 0o600 });

  await withConfigPath(path, async () => {
    assert.deepEqual(await inspectConfigLocation(), { path, exists: true });
    await assert.rejects(() => loadConfig(), /unsupported config section/iu);
  });
});

test("config storage refuses symlink and hardlink targets without touching them", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-links-"));
  const parent = join(temp, "zts");
  const outside = join(temp, "outside.toml");
  const path = join(parent, "config.toml");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(outside, "[defaults]\ninbox = \"Outside\"\n", { mode: 0o644 });
  await chmod(outside, 0o644);
  await symlink(outside, path);

  await withConfigPath(path, async () => {
    await assert.rejects(() => loadConfig(), /ELOOP|symbolic link|too many levels/iu);
    await assert.rejects(
      () => saveConfigContents("[defaults]\ninbox = \"Changed\"\n", { exists: true, contents: "" }),
      /ELOOP|symbolic link|too many levels/iu
    );
    assert.equal(await readFile(outside, "utf8"), "[defaults]\ninbox = \"Outside\"\n");
    assert.equal((await stat(outside)).mode & 0o777, 0o644);
  });

  const outsideDirectory = join(temp, "outside-directory");
  const linkedParent = join(temp, "linked-parent");
  const redirectedPath = join(linkedParent, "config.toml");
  await mkdir(outsideDirectory, { mode: 0o700 });
  await writeFile(join(outsideDirectory, "config.toml"), "[defaults]\ninbox = \"Redirected\"\n", { mode: 0o600 });
  await symlink(outsideDirectory, linkedParent);
  await withConfigPath(redirectedPath, async () => {
    await assert.rejects(() => loadConfig(), /not a real directory/);
    await assert.rejects(
      () => saveConfigContents("[defaults]\ninbox = \"Changed\"\n", { exists: true, contents: "" }),
      /not a real directory/
    );
    assert.equal(
      await readFile(join(outsideDirectory, "config.toml"), "utf8"),
      "[defaults]\ninbox = \"Redirected\"\n"
    );
  });

  const hardlinkSource = join(temp, "hardlink-source.toml");
  const hardlinkPath = join(parent, "hardlink-config.toml");
  await writeFile(hardlinkSource, "[defaults]\ninbox = \"Linked\"\n", { mode: 0o644 });
  await chmod(hardlinkSource, 0o644);
  await link(hardlinkSource, hardlinkPath);
  await withConfigPath(hardlinkPath, async () => {
    await assert.rejects(() => loadConfig(), /unexpected hardlink count/);
    await assert.rejects(
      () => saveConfigContents("[defaults]\ninbox = \"Changed\"\n", { exists: true, contents: "" }),
      /unexpected hardlink count/
    );
    assert.equal(await readFile(hardlinkSource, "utf8"), "[defaults]\ninbox = \"Linked\"\n");
    assert.equal((await stat(hardlinkSource)).mode & 0o777, 0o644);
  });
});

test("config storage enforces its read and write size bound", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-bound-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, Buffer.alloc(CONFIG_FILE_MAX_BYTES + 1, 0x23), { mode: 0o600 });

  await withConfigPath(path, async () => {
    await assert.rejects(() => loadConfig(), new RegExp(`${CONFIG_FILE_MAX_BYTES}-byte read limit`));
    const previous = "[defaults]\ninbox = \"Unchanged\"\n";
    await writeFile(path, previous, { mode: 0o600 });
    await assert.rejects(
      () => saveConfigContents("x".repeat(CONFIG_FILE_MAX_BYTES + 1), { exists: true, contents: previous }),
      new RegExp(`${CONFIG_FILE_MAX_BYTES}-byte write limit`)
    );
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await readdir(parent), ["config.toml"]);
  });
});

test("config storage refuses invalid schema before replacing a valid file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-invalid-write-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const previous = '[defaults]\ninbox = "Unchanged"\n';
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, previous, { mode: 0o600 });

  await withConfigPath(path, async () => {
    await assert.rejects(
      () => saveConfigContents('[future]\nenabled = true\n', { exists: true, contents: previous }),
      /unsupported config section/iu
    );
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await readdir(parent), ["config.toml"]);
  });
});

test("config replacement is atomic and leaves no temporary residue", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-atomic-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const previous = "[defaults]\ninbox = \"Before\"\n";
  const replacement = "[defaults]\ninbox = \"After\"\n";
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, previous, { mode: 0o600 });

  await withConfigPath(path, async () => {
    const oldHandle = await open(path, "r");
    try {
      const before = await oldHandle.stat();
      await saveConfigContents(replacement, { exists: true, contents: previous });
      const after = await stat(path);
      assert.notEqual(after.ino, before.ino);
      assert.equal((await oldHandle.readFile()).toString("utf8"), previous);
      assert.equal(await readFile(path, "utf8"), replacement);
      assert.equal(after.mode & 0o777, 0o600);
      assert.deepEqual((await readdir(parent)).sort(), [".config-write-control.json", "config.toml"]);
    } finally {
      await oldHandle.close();
    }
  });
});

test("a stale save never repairs unsafe config permissions before CAS", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-stale-permissions-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const loadedContents = '[defaults]\ninbox = "Loaded"\n';
  const externalContents = '[defaults]\ninbox = "External"\n';
  const replacement = '[defaults]\ninbox = "Replacement"\n';
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, externalContents, { mode: 0o644 });
  await chmod(path, 0o644);

  await withConfigPath(path, async () => {
    const before = await stat(path);
    await assert.rejects(
      () => saveConfigContents(replacement, { exists: true, contents: loadedContents }),
      /config file permissions are unsafe.*expected mode 0600.*found 0644.*chmod 600.*retry/iu
    );
    const after = await stat(path);
    assert.equal(await readFile(path, "utf8"), externalContents);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o644);
    assert.deepEqual(await readdir(parent), ["config.toml"]);
  });
});

test("concurrent config writers compare the exact loaded state and never lose an update silently", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-cas-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const initial = '[defaults]\ninbox = "Before"\n';
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, initial, { mode: 0o600 });

  await withConfigPath(path, async () => {
    const firstLoaded = await loadConfig();
    const secondLoaded = await loadConfig();
    const first = setConfigValueInContents(firstLoaded.contents, "defaults.inbox", "First");
    const second = setConfigValueInContents(secondLoaded.contents, "defaults.inbox", "Second");
    const results = await Promise.allSettled([
      saveConfigContents(first, firstLoaded),
      saveConfigContents(second, secondLoaded)
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.match(String(rejected?.reason), /config changed after it was loaded/iu);
    assert.match(await readFile(path, "utf8"), /inbox = "(?:First|Second)"/u);
    assert.deepEqual((await readdir(parent)).sort(), [".config-write-control.json", "config.toml"]);
  });
});

test("config CAS preserves an external edit made after source validation at the atomic exchange boundary", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-external-cas-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const initial = '[defaults]\ninbox = "Before"\n';
  const external = '[defaults]\ninbox = "External"\n';
  const replacement = '[defaults]\ninbox = "Zts"\n';
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, initial, { mode: 0o600 });

  await withConfigPath(path, async () => {
    const loaded = await loadConfig();
    await assert.rejects(
      () => saveConfigContents(replacement, loaded, {
        afterSourceValidation: async () => {
          await writeFile(path, external, { mode: 0o600 });
        }
      }),
      /config changed after it was loaded/iu
    );

    assert.equal(await readFile(path, "utf8"), external);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(parent)).sort(), [".config-write-control.json", "config.toml"]);
  });
});

test("config CAS never overwrites an external first save when its loaded target was absent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zts-config-external-create-"));
  const parent = join(temp, "zts");
  const path = join(parent, "config.toml");
  const external = '[defaults]\ninbox = "External"\n';
  const replacement = '[defaults]\ninbox = "Zts"\n';

  await withConfigPath(path, async () => {
    const loaded = await loadConfig();
    assert.equal(loaded.exists, false);
    await assert.rejects(
      () => saveConfigContents(replacement, loaded, {
        afterSourceValidation: async () => {
          await writeFile(path, external, { mode: 0o600 });
        }
      }),
      /config changed after it was loaded/iu
    );

    assert.equal(await readFile(path, "utf8"), external);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(parent)).sort(), [".config-write-control.json", "config.toml"]);
  });
});

async function withConfigPath(path, action) {
  const previous = process.env.ZTS_CONFIG_PATH;
  process.env.ZTS_CONFIG_PATH = path;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.ZTS_CONFIG_PATH;
    else process.env.ZTS_CONFIG_PATH = previous;
  }
}
