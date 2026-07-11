import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalUrlPattern,
  matchingUrlPatterns,
  urlMatchesAnyPattern,
  urlPatternSpecificity
} from "../dist/url-pattern.js";

test("canonicalizes typed domain, suffix, wildcard, IDN, and URL-prefix patterns", () => {
  assert.equal(canonicalUrlPattern(" EXAMPLE.COM. "), "example.com");
  assert.equal(canonicalUrlPattern("*.Framer.COM."), "*.framer.com");
  assert.equal(canonicalUrlPattern(".AE"), ".ae");
  assert.equal(canonicalUrlPattern("bücher.example"), "xn--bcher-kva.example");
  assert.equal(canonicalUrlPattern("HTTPS://Example.COM:443/specific/page"), "https://example.com/specific/page");
});

test("rejects incomplete, credentialed, path-like, and port-bearing domain patterns", () => {
  for (const pattern of [
    "https://",
    "https://user:secret@example.com/",
    "example.com/path",
    "example.com:80",
    "foo.*.example.com",
    "foo..example.com",
    "-bad.example.com",
    "bad-.example.com",
    "*.",
    "."
  ]) {
    assert.throws(() => canonicalUrlPattern(pattern), /pattern|credentials|hostname/iu, pattern);
  }
});

test("full URL prefixes bind protocol and origin and respect path boundaries", () => {
  const pattern = "https://example.com/specific/page";
  assert.equal(urlMatchesAnyPattern("https://example.com/specific/page", [pattern]), true);
  assert.equal(urlMatchesAnyPattern("https://example.com/specific/page/child?q=1", [pattern]), true);
  assert.equal(urlMatchesAnyPattern("https://example.com/specific/page-two", [pattern]), false);
  assert.equal(urlMatchesAnyPattern("https://example.com.evil/specific/page", [pattern]), false);
  assert.equal(urlMatchesAnyPattern("http://example.com/specific/page", [pattern]), false);
});

test("domain, wildcard, and host-suffix matching retain their documented distinctions", () => {
  assert.equal(urlMatchesAnyPattern("https://github.com/openai", ["github.com"]), true);
  assert.equal(urlMatchesAnyPattern("https://docs.github.com/openai", ["github.com"]), true);
  assert.equal(urlMatchesAnyPattern("https://framer.com", ["*.framer.com"]), false);
  assert.equal(urlMatchesAnyPattern("https://www.framer.com", ["*.framer.com"]), true);
  assert.equal(urlMatchesAnyPattern("https://example.ae", [".ae"]), true);
  assert.equal(urlMatchesAnyPattern("https://ae", [".ae"]), false);
});

test("specificity and matching output are canonical and deterministic", () => {
  assert.ok(
    urlPatternSpecificity("https://example.com/path", "https://example.com/path")
      > urlPatternSpecificity("example.com", "https://example.com/path")
  );
  assert.deepEqual(
    matchingUrlPatterns("https://docs.example.com/path", [" EXAMPLE.COM ", "example.com", "*.EXAMPLE.com"]),
    ["*.example.com", "example.com"]
  );
});
