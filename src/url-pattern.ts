/**
 * One typed URL-pattern grammar shared by routing, Protection, and CLI filters.
 * Browser URLs are data. A pattern can never become a regex or executable glob.
 */

const MAX_PATTERN_BYTES = 4_096;

export type UrlPattern =
  | {
      readonly kind: "domain";
      readonly canonical: string;
      readonly hostname: string;
    }
  | {
      readonly kind: "subdomain_wildcard";
      readonly canonical: string;
      readonly hostnameSuffix: string;
    }
  | {
      readonly kind: "host_suffix";
      readonly canonical: string;
      readonly hostnameSuffix: string;
    }
  | {
      readonly kind: "url_prefix";
      readonly canonical: string;
      readonly protocol: "http:" | "https:";
      readonly origin: string;
      readonly pathname: string;
      readonly search: string;
      readonly hash: string;
    };

/** Parses, validates, and canonicalizes one user-authored pattern. */
export function defineUrlPattern(value: string): UrlPattern {
  if (typeof value !== "string") throw new Error("URL pattern must be a string");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("URL pattern must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_PATTERN_BYTES) {
    throw new Error(`URL pattern exceeds the ${MAX_PATTERN_BYTES}-byte limit`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    throw new Error("URL pattern contains a control character");
  }

  if (/^https?:\/\//iu.test(trimmed)) return defineUrlPrefix(trimmed);
  if (trimmed.startsWith("*.")) {
    const hostnameSuffix = canonicalHostname(trimmed.slice(2), "wildcard domain");
    return { kind: "subdomain_wildcard", canonical: `*.${hostnameSuffix}`, hostnameSuffix };
  }
  if (trimmed.startsWith(".")) {
    const hostnameSuffix = canonicalHostname(trimmed.slice(1), "host suffix");
    return { kind: "host_suffix", canonical: `.${hostnameSuffix}`, hostnameSuffix };
  }
  const hostname = canonicalHostname(trimmed, "domain");
  return { kind: "domain", canonical: hostname, hostname };
}

export function canonicalUrlPattern(value: string): string {
  return defineUrlPattern(value).canonical;
}

export function urlPatternSpecificity(pattern: string, urlOrDomain: string): number {
  const defined = defineUrlPattern(pattern);
  const candidate = parseCandidate(urlOrDomain);
  if (!candidate) return -1;
  if (defined.kind === "url_prefix") {
    if (!candidate.url || !matchesUrlPrefix(defined, candidate.url)) return -1;
    return 4_000_000 + defined.canonical.length;
  }
  const host = candidate.hostname;
  if (defined.kind === "subdomain_wildcard") {
    return host !== defined.hostnameSuffix && host.endsWith(`.${defined.hostnameSuffix}`)
      ? 2_000_000 + defined.canonical.length
      : -1;
  }
  if (defined.kind === "host_suffix") {
    return host !== defined.hostnameSuffix && host.endsWith(`.${defined.hostnameSuffix}`)
      ? 1_000_000 + defined.canonical.length
      : -1;
  }
  if (host === defined.hostname) return 3_000_000 + defined.canonical.length;
  return host.endsWith(`.${defined.hostname}`)
    ? 2_500_000 + defined.canonical.length
    : -1;
}

export function matchingUrlPatterns(
  urlOrDomain: string,
  patterns: readonly string[]
): readonly string[] {
  return Array.from(new Set(
    patterns
      .map(defineUrlPattern)
      .filter((pattern) => urlPatternSpecificity(pattern.canonical, urlOrDomain) >= 0)
      .map((pattern) => pattern.canonical)
  )).sort(compareText);
}

export function urlMatchesAnyPattern(urlOrDomain: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => urlPatternSpecificity(pattern, urlOrDomain) >= 0);
}

function defineUrlPrefix(value: string): Extract<UrlPattern, { readonly kind: "url_prefix" }> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid URL prefix pattern: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL prefix pattern must use http or https");
  }
  if (!parsed.hostname) throw new Error("URL prefix pattern requires a hostname");
  if (parsed.username || parsed.password) throw new Error("URL prefix pattern cannot contain credentials");
  const hostname = normalizeHostname(parsed.hostname);
  validateCanonicalHostname(hostname, "URL prefix");
  const origin = `${parsed.protocol}//${formatHostname(hostname)}${normalizedPort(parsed)}`;
  const pathname = parsed.pathname || "/";
  const canonical = `${origin}${pathname}${parsed.search}${parsed.hash}`;
  return {
    kind: "url_prefix",
    canonical,
    protocol: parsed.protocol,
    origin,
    pathname,
    search: parsed.search,
    hash: parsed.hash
  };
}

function canonicalHostname(value: string, label: string): string {
  if (!value || /[/?#@]/u.test(value)) throw new Error(`Invalid ${label} pattern: ${value}`);
  if ((!value.startsWith("[") && value.includes(":"))
    || (value.startsWith("[") && !/^\[[^\]]+\]\.?$/u.test(value))) {
    throw new Error(`Invalid ${label} pattern: ${value}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw new Error(`Invalid ${label} pattern: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Invalid ${label} pattern: ${value}`);
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) throw new Error(`Invalid ${label} pattern: ${value}`);
  validateCanonicalHostname(hostname, label);
  return hostname;
}

function validateCanonicalHostname(hostname: string, label: string): void {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return;
  if (hostname.length > 253) throw new Error(`Invalid ${label} hostname`);
  const labels = hostname.split(".");
  if (labels.some((part) => !part
    || part.length > 63
    || !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/u.test(part))) {
    throw new Error(`Invalid ${label} hostname`);
  }
}

function parseCandidate(value: string): { readonly url: URL | null; readonly hostname: string } | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PATTERN_BYTES * 4) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { url, hostname: normalizeHostname(url.hostname) };
  } catch {
    try {
      const url = new URL(`https://${value}`);
      return { url: null, hostname: normalizeHostname(url.hostname) };
    } catch {
      return null;
    }
  }
}

function matchesUrlPrefix(
  pattern: Extract<UrlPattern, { readonly kind: "url_prefix" }>,
  candidate: URL
): boolean {
  const hostname = normalizeHostname(candidate.hostname);
  const origin = `${candidate.protocol}//${formatHostname(hostname)}${normalizedPort(candidate)}`;
  if (candidate.protocol !== pattern.protocol || origin !== pattern.origin) return false;
  const pathMatches = pattern.pathname === "/"
    || candidate.pathname === pattern.pathname
    || (pattern.pathname.endsWith("/")
      ? candidate.pathname.startsWith(pattern.pathname)
      : candidate.pathname.startsWith(`${pattern.pathname}/`));
  if (!pathMatches) return false;
  if (pattern.search && candidate.search !== pattern.search) return false;
  if (pattern.hash && candidate.hash !== pattern.hash) return false;
  return true;
}

function normalizedPort(value: URL): string {
  if (!value.port) return "";
  if ((value.protocol === "http:" && value.port === "80")
    || (value.protocol === "https:" && value.port === "443")) return "";
  return `:${value.port}`;
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/u, "");
}

function formatHostname(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
