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
    throw new TypeError("The address scheme is not available in Navis");
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

// Adapted from the pinned Gecko UrlbarInput.mjs losslessDecodeURI. Native
// IDN display policy is applied by Runtime before passing the displaySpec here.
export function decodeDesktopAddressForDisplay(value, scheme) {

  // Try to decode as UTF-8 if there's no encoding sequence that we would break.
  if (!/%25(?:3B|2F|3F|3A|40|26|3D|2B|24|2C|23)/i.test(value)) {
    let decodeASCIIOnly = !["https", "http", "file", "ftp"].includes(scheme);
    if (decodeASCIIOnly) {
      // This only decodes ascii characters (hex) 20-7e, except 25 (%).
      // This avoids both cases stipulated below (%-related issues, and \r, \n
      // and \t, which would be %0d, %0a and %09, respectively) as well as any
      // non-US-ascii characters.
      value = value.replace(
        /%(2[0-4]|2[6-9a-f]|[3-6][0-9a-f]|7[0-9a-e])/g,
        decodeURI
      );
    } else {
      try {
        value = decodeURI(value)
          // decodeURI decodes %25 to %, which creates unintended encoding
          // sequences. Re-encode it, unless it's part of a sequence that
          // survived decodeURI, i.e. one for:
          // ';', '/', '?', ':', '@', '&', '=', '+', '$', ',', '#'
          // (RFC 3987 section 3.2)
          .replace(
            /%(?!3B|2F|3F|3A|40|26|3D|2B|24|2C|23)/gi,
            encodeURIComponent
          );
      } catch (e) {}
    }
  }

  // IMPORTANT: The following regular expressions are Unicode-aware due to /v.
  // Avoid matching high or low surrogate pairs directly, always work with
  // full Unicode scalar values.

  // Encode potentially invisible characters:
  //   U+0000-001F: C0/C1 control characters
  //   U+007F-009F: commands
  //   U+00A0, U+1680, U+2000-200A, U+202F, U+205F, U+3000: other spaces
  //   U+2028-2029: line and paragraph separators
  //   U+2800: braille empty pattern
  //   U+FFFC: object replacement character
  // Encode any trailing whitespace that may be part of a pasted URL, so that it
  // doesn't get eaten away by the location bar (bug 410726).
  // Encode all adjacent space chars (U+0020), to prevent spoofing attempts
  // where they would push part of the URL to overflow the location bar
  // (bug 1395508). A single space, or the last space if the are many, is
  // preserved to maintain readability of certain urls if it's not followed by a
  // control or separator character. We only do this for the common space,
  // because others may be eaten when copied to the clipboard,so it's safer to
  // preserve them encoded.
  value = value.replace(
    // eslint-disable-next-line no-control-regex
    /[[\p{Separator}--\u{0020}]\p{Control}\u{2800}\u{FFFC}]|\u{0020}(?=[\p{Other}\p{Separator}])|\s$/gv,
    encodeURIComponent
  );

  // Encode characters that are ignorable, can't be rendered usefully, or may
  // confuse users.
  //
  // Default ignorable characters; ZWNJ (U+200C) and ZWJ (U+200D) are excluded
  // per bug 582186:
  //   U+00AD, U+034F, U+06DD, U+070F, U+115F-1160, U+17B4, U+17B5, U+180B-180E,
  //   U+2060, U+FEFF, U+200B, U+2060-206F, U+3164, U+FE00-FE0F, U+FFA0,
  //   U+FFF0-FFFB, U+1D173-1D17A, U+E0000-E0FFF
  // Bidi control characters (RFC 3987 sections 3.2 and 4.1 paragraph 6):
  //   U+061C, U+200E, U+200F, U+202A-202E, U+2066-2069
  // Other format characters in the Cf category that are unlikely to be rendered
  // usefully:
  //   U+0600-0605, U+08E2, U+110BD, U+110CD, U+13430-13438, U+1BCA0-1BCA3
  // Mimicking UI parts:
  //   U+1F50F-1F513, U+1F6E1
  // Unassigned codepoints, sometimes shown as empty glyphs.
  value = value.replace(
    // eslint-disable-next-line no-misleading-character-class
    /[[\p{Format}--[\u{200C}\u{200D}]]\u{034F}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180D}\u{3164}\u{FE00}-\u{FE0F}\u{FFA0}\u{FFF0}-\u{FFFB}\p{Unassigned}\p{Private_Use}\u{E0000}-\u{E0FFF}\u{1F50F}-\u{1F513}\u{1F6E1}]/gv,
    encodeURIComponent
  );
  return value;
}
