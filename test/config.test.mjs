import assert from "node:assert/strict";
import test from "node:test";
import {
  addDomainRule,
  addDomainRuleInContents,
  formatConfig,
  getConfigValue,
  parseConfig,
  setConfigValue,
  setConfigValueInContents
} from "../dist/config.js";

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
  assert.equal(config.rules.domains["example.com"], "Portfolio");
  assert.match(formatConfig(config), /from = \["Space"]/);
  assert.match(formatConfig(config), /"example.com" = "Portfolio"/);
});

test("gets, sets, and adds supported config values", () => {
  const withInbox = setConfigValue(parseConfig(""), "defaults.inbox", "Inbox");
  const withConfidence = setConfigValue(withInbox, "defaults.min_confidence", "0.7");
  const withSourceAllowlist = setConfigValue(withConfidence, "sort.from", "Space,Inbox");
  const withRule = addDomainRule(withSourceAllowlist, "docs.example.com", "Research");

  assert.equal(getConfigValue(withRule, "defaults.inbox"), "Inbox");
  assert.equal(getConfigValue(withRule, "defaults.min_confidence"), 0.7);
  assert.deepEqual(getConfigValue(withRule, "sort.from"), ["Space", "Inbox"]);
  assert.equal(getConfigValue(withRule, "rules.domains.docs.example.com"), "Research");
});

test("patches supported values without dropping comments or unknown sections", () => {
  const original = [
    "# keep me",
    "[defaults]",
    "inbox = \"Space\"",
    "",
    "[sort]",
    "from = [\"Space\"]",
    "to = [\"Portfolio\"]",
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
  assert.match(withRule, /"docs.example.com" = "Research"/);
});

test("parses and preserves inline comments on supported config values", () => {
  const original = [
    "[defaults]",
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
  assert.match(withRule, /min_confidence = 0.9 # conservative/);
  assert.match(withRule, /"docs.example.com" = "Research" # docs/);
  assert.match(withRule, /"github.com" = "Tool Development"/);
});
