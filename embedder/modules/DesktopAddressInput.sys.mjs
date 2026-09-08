/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const DESKTOP_SEARCH_PROVIDERS = Object.freeze(
  [
    ["google", "Google", "https://www.google.com/search?q={searchTerms}"],
    ["baidu", "Baidu", "https://www.baidu.com/s?wd={searchTerms}"],
    ["bing", "Bing", "https://www.bing.com/search?q={searchTerms}"],
    ["duckduckgo", "DuckDuckGo", "https://duckduckgo.com/?q={searchTerms}"],
  ].map(([id, name, template]) => Object.freeze({ id, name, template }))
);

const PROVIDERS_BY_ID = new Map(
  DESKTOP_SEARCH_PROVIDERS.map(provider => [provider.id, provider])
);

const ADDRESSABLE_SCHEMES = new Set([
  "about",
  "http",
  "https",
  "moz-extension",
  "navis",
]);

export function projectSelectionSearch({text, password, hasSelection}, provider) {
  if (password || !hasSelection || typeof text !== "string" || text.length > 8192 ||
      !text.trim() || !provider || typeof provider.id !== "string" ||
      typeof provider.name !== "string") return null;
  const query = text.trim();
  const display = Array.from(query.replace(/\s+/gu, " "));
  return Object.freeze({text: query, providerId: provider.id, providerName: provider.name,
    excerpt: display.slice(0, 40).join("") + (display.length > 40 ? "…" : "")});
}

function validIPv4(value) {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every(octet => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function loopbackIPv6(value) {
  const normalized = value.toLowerCase();
  return normalized === "::1" || /^(?:0{1,4}:){7}0{0,3}1$/u.test(normalized);
}

function requireValidURL(value) {
  try {
    // The scheme allowlist is a capability boundary, not a syntax check.
    // Reject malformed values synchronously so Platform never reports a
    // successful omnibox submission that Gecko later rejects asynchronously.
    new URL(value);
  } catch {
    throw new TypeError("The address is malformed");
  }
  return value;
}

export function classifyAddressInput(value) {
  if (typeof value !== "string") {
    throw new TypeError("Address input must be a string");
  }
  const candidate = value.trim();
  if (!candidate || candidate.length > 8192) {
    throw new TypeError("A bounded address or search term is required");
  }

  const localHost = candidate.match(
    /^(localhost|[^/]+\.localhost)(?::\d+)?(?:\/|$)/iu
  );
  const bracketedIPv6 = candidate.match(/^\[([0-9a-f:]+)\](?::\d+)?(?:\/|$)/iu);
  const bareIPv6 = /^[0-9a-f]*:[0-9a-f:]+$/iu.test(candidate);
  const ipv4 = candidate.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:\/|$)/u);
  const validIPv4Host = Boolean(ipv4 && validIPv4(ipv4[1]));
  const domain = candidate.match(/^([^/:]+(?:\.[^/:]+)+)(?::\d+)?(?:\/|$)/u);
  const validDomain = Boolean(domain && !/^[\d.]+$/u.test(domain[1]));
  const looksLikeHost =
    !/\s/u.test(candidate) &&
    (Boolean(localHost) ||
      Boolean(bracketedIPv6) ||
      validIPv4Host ||
      validDomain);
  const schemePrefix = candidate.match(/^([a-z][a-z0-9+.-]*):/iu);
  const hasSchemePrefix = Boolean(schemePrefix);
  const explicitScheme = hasSchemePrefix && !looksLikeHost && !bareIPv6;

  if (
    explicitScheme &&
    !ADDRESSABLE_SCHEMES.has(schemePrefix[1].toLowerCase())
  ) {
    throw new TypeError("The address scheme is not available in Navis 1.0");
  }

  if (explicitScheme || looksLikeHost || bareIPv6) {
    const localIPv4 = Boolean(ipv4 && Number(ipv4[1].split(".")[0]) === 127);
    const localIPv6 = loopbackIPv6(bracketedIPv6?.[1] ?? candidate);
    const resolvedURL = explicitScheme
      ? candidate
      : bareIPv6
        ? `${localIPv6 ? "http" : "https"}://[${candidate}]`
        : `${localHost || localIPv4 || localIPv6 ? "http" : "https"}://${candidate}`;
    return Object.freeze({
      kind: "url",
      providerId: "",
      url: requireValidURL(resolvedURL),
    });
  }

  return Object.freeze({kind: "search", query: candidate});
}

// Compatibility helper for independent consumers. Product runtime search
// submissions use the shared Gecko SearchService after classifying input.
export function resolveDesktopAddressInput(value, providerId, providers = DESKTOP_SEARCH_PROVIDERS) {
  const classified = classifyAddressInput(value);
  if (classified.kind === "url") {
    return classified;
  }
  const provider =
    providers.find(item => item.id === providerId) ?? DESKTOP_SEARCH_PROVIDERS[0];
  return Object.freeze({
    kind: "search",
    providerId: provider.id,
    url: provider.template.replaceAll(
      "{searchTerms}",
      encodeURIComponent(classified.query)
    ),
  });
}
