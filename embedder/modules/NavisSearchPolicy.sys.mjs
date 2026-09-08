/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Product policy is offline data. Gecko owns engine interpretation and storage.
export const NAVIS_SEARCH_CATALOGUE = Object.freeze([
  { id: "google", name: "Google", template: "https://www.google.com/search?q={searchTerms}", suggestionTemplate: "https://suggestqueries.google.com/complete/search?client=firefox&q={searchTerms}" },
  { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={searchTerms}", suggestionTemplate: "https://www.bing.com/osjson.aspx?query={searchTerms}" },
  { id: "baidu", name: "Baidu", template: "https://www.baidu.com/s?wd={searchTerms}", suggestionTemplate: "https://www.baidu.com/su?ie=utf-8&action=opensearch&wd={searchTerms}" },
  { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q={searchTerms}", suggestionTemplate: "https://duckduckgo.com/ac/?q={searchTerms}&type=list" },
].map(provider => Object.freeze({ ...provider, builtIn: true })));

const BUILTIN_IDS = new Set(NAVIS_SEARCH_CATALOGUE.map(provider => provider.id));

function validateTemplate(template, optional = false) {
  if (optional && (template === undefined || template === "" || template === null)) {
    return "";
  }
  if (typeof template !== "string" || template.length > 4096 ||
      !template.includes("{searchTerms}") || /[\u0000-\u0020\u007f]/u.test(template)) {
    throw new TypeError("Invalid search template");
  }
  const url = new URL(template.replaceAll("{searchTerms}", "navis-query"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.hostname.includes("navis-query")) {
    throw new TypeError("Search templates require an HTTP(S) URL with no credentials");
  }
  return template;
}

export function validateNavisSearchProvider(value) {
  if (!value || typeof value.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.id) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 ||
      /[\u0000-\u001f\u007f]/u.test(value.name)) {
    throw new TypeError("Invalid search provider");
  }
  return Object.freeze({
    id: value.id, name: value.name.trim(),
    template: validateTemplate(value.template),
    suggestionTemplate: validateTemplate(value.suggestionTemplate, true),
    builtIn: BUILTIN_IDS.has(value.id),
  });
}

// Fail closed before a suggestion controller exists. Paths and addresses never
// become network search terms; navigation classification remains the backend's job.
export function isNavisSuggestionQuery(value) {
  if (typeof value !== "string") return false;
  const query = value.trim();
  return query.length >= 2 && query.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(query) &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(query) &&
    !/[\\/@]/u.test(query) && !/^(?:~|\.{1,2})(?:$|[\\/])/u.test(query) &&
    !/(?:^|\s)(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d+)?(?:$|\s)/iu.test(query) &&
    !/(?:^|\s)[^\s.]+\.[^\s.]+(?::\d+)?(?:$|\s)/u.test(query);
}
