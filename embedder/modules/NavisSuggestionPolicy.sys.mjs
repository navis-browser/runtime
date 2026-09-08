/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const SOURCE_PRIORITY = Object.freeze({tab: 3, bookmark: 2, history: 1});
const MAX_CANDIDATES = 500;
const normalize = value => value.normalize("NFKC").toLowerCase();
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function candidate(value, privateMode) {
  if (!value || !Object.hasOwn(SOURCE_PRIORITY, value.kind) ||
      privateMode && value.kind === "history" ||
      typeof value.id !== "string" || !value.id || value.id.length > 8192 ||
      typeof value.url !== "string" || value.url.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value.url)) {
    return null;
  }
  let uri;
  try {
    uri = new URL(value.url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "navis:"].includes(uri.protocol) ||
      uri.username || uri.password || !uri.hostname) {
    return null;
  }
  const title = typeof value.title === "string"
    ? value.title.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512)
    : "";
  return {
    kind: value.kind,
    id: value.id,
    title: title || uri.hostname,
    url: uri.href,
    lastVisit: Number.isFinite(value.lastVisit) ? Math.max(0, value.lastVisit) : 0,
    visitCount: Number.isFinite(value.visitCount) ? Math.max(0, Math.min(value.visitCount, 1000)) : 0,
  };
}

/**
 * Rank bounded, already-authorized current-Profile records without storage,
 * networking, locale globals or wall-clock dependencies. Callers must supply
 * only same-privacy-mode tabs; history is additionally excluded in private mode.
 */
export function rankLocalSuggestions(query, candidates, {maxResults = 6, privateMode = false} = {}) {
  if (typeof query !== "string" || query.length > 8192 || !Array.isArray(candidates)) {
    return Object.freeze([]);
  }
  const term = normalize(query.trim());
  const limit = Number.isInteger(maxResults) ? Math.max(0, Math.min(maxResults, 12)) : 6;
  if (!term || !limit) {
    return Object.freeze([]);
  }
  const terms = term.split(/\s+/u);
  const matches = new Map();
  for (const raw of candidates.slice(0, MAX_CANDIDATES)) {
    const record = candidate(raw, privateMode);
    if (!record) {
      continue;
    }
    const title = normalize(record.title);
    const address = normalize(record.url).replace(/^https?:\/\/(?:www\.)?/u, "");
    const searchable = `${title} ${address}`;
    if (!terms.every(part => searchable.includes(part))) {
      continue;
    }
    const score = (title === term ? 100 : title.startsWith(term) ? 70 : 0) +
      (address.startsWith(term) ? 60 : 0) + SOURCE_PRIORITY[record.kind] * 5;
    const entry = {...record, score};
    const old = matches.get(record.url);
    // A matched open tab is the actionable representation of its bookmark or
    // history record. Never return duplicate rows for the same canonical URL.
    if (!old || SOURCE_PRIORITY[entry.kind] > SOURCE_PRIORITY[old.kind] ||
        SOURCE_PRIORITY[entry.kind] === SOURCE_PRIORITY[old.kind] && compare(entry, old) < 0) {
      matches.set(record.url, entry);
    }
  }
  return Object.freeze([...matches.values()].sort(compare).slice(0, limit).map(
    ({kind, id, title, url}) => Object.freeze({kind, id, title, url}),
  ));
}

function compare(left, right) {
  return right.score - left.score || right.lastVisit - left.lastVisit ||
    right.visitCount - left.visitCount || compareText(left.url, right.url) ||
    compareText(left.id, right.id);
}
