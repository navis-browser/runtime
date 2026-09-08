/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const NAVIS_SEARCH_PROVIDERS_PREF = "navis.search.providers";
export const NAVIS_DEFAULT_SEARCH_PROVIDER_PREF = "navis.search.defaultProvider";
export const NAVIS_DEFAULT_ACCENT = "#0b57d0";
export const NAVIS_BUILTIN_SEARCH_PROVIDERS = Object.freeze([
  { id: "google", name: "Google", template: "https://www.google.com/search?q={searchTerms}", builtIn: true },
  { id: "bing", name: "Bing", template: "https://www.bing.com/search?q={searchTerms}", builtIn: true },
  { id: "baidu", name: "Baidu", template: "https://www.baidu.com/s?wd={searchTerms}", builtIn: true },
  { id: "duckduckgo", name: "DuckDuckGo", template: "https://duckduckgo.com/?q={searchTerms}", builtIn: true },
].map(Object.freeze));
const BUILTIN_IDS = new Set(NAVIS_BUILTIN_SEARCH_PROVIDERS.map(item => item.id));
export const NAVIS_SETTINGS_PREFS = Object.freeze({
  theme: "navis.appearance.theme",
  accent: "navis.appearance.accent",
  bookmarkBar: "navis.bookmarks.bar.mode",
  historyButton: "navis.history.button.visible",
  askBeforeSaving: "navis.downloads.askBeforeSaving",
  deletePrivateOnExit: "navis.downloads.deletePrivateOnExit",
  openWhenComplete: "navis.downloads.openWhenComplete",
});

export function validateSearchProvider(value) {
  if (!value || typeof value !== "object" || typeof value.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(value.id) || typeof value.name !== "string" ||
      !value.name.trim() || value.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(value.name) ||
      typeof value.template !== "string" || value.template.length > 4096 ||
      !value.template.includes("{searchTerms}")) {
    throw new TypeError("Invalid search provider");
  }
  const url = new URL(value.template.replaceAll("{searchTerms}", "navis-query"));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.hostname.includes("navis-query") || /[\u0000-\u0020\u007f]/u.test(value.template)) {
    throw new TypeError("Search templates require an HTTP(S) URL and query placeholder outside the host");
  }
  return Object.freeze({ id: value.id, name: value.name.trim(), template: value.template, builtIn: BUILTIN_IDS.has(value.id) });
}

export function readSearchProviders(prefs) {
  try {
    const raw = JSON.parse(prefs.getStringPref(NAVIS_SEARCH_PROVIDERS_PREF, "null"));
    if (!Array.isArray(raw) || raw.length > 64) {
      return NAVIS_BUILTIN_SEARCH_PROVIDERS;
    }
    const records = raw.map(validateSearchProvider);
    const ids = new Set(records.map(record => record.id));
    if (ids.size !== records.length || [...BUILTIN_IDS].some(id => !ids.has(id))) {
      return NAVIS_BUILTIN_SEARCH_PROVIDERS;
    }
    return Object.freeze(records);
  } catch {
    return NAVIS_BUILTIN_SEARCH_PROVIDERS;
  }
}

export function readDefaultSearchProvider(prefs) {
  const records = readSearchProviders(prefs);
  const selected = prefs.getStringPref(NAVIS_DEFAULT_SEARCH_PROVIDER_PREF, "google");
  return records.some(record => record.id === selected) ? selected : "google";
}

export function setDefaultSearchProvider(prefs, id) {
  if (!readSearchProviders(prefs).some(record => record.id === id)) {
    throw new TypeError("Unknown search provider");
  }
  prefs.setStringPref(NAVIS_DEFAULT_SEARCH_PROVIDER_PREF, id);
}

export function mutateSearchProviders(prefs, operation, value, createId) {
  const records = [...readSearchProviders(prefs)];
  const index = records.findIndex(record => record.id === value?.id);
  if (operation === "add") {
    if (records.length >= 64) {
      throw new RangeError("Search provider limit reached");
    }
    const record = validateSearchProvider({ ...value, id: createId() });
    if (records.some(item => item.id === record.id)) {
      throw new TypeError("Duplicate provider ID");
    }
    records.push(record);
  } else if (index < 0) {
    throw new TypeError("Unknown search provider");
  } else if (operation === "update") {
    records[index] = validateSearchProvider({ ...value, id: records[index].id });
  } else if (operation === "remove") {
    if (records[index].builtIn) {
      throw new TypeError("Built-in search providers cannot be removed");
    }
    records.splice(index, 1);
  } else if (operation === "move") {
    if (!Number.isInteger(value.position) || value.position < 0 || value.position >= records.length) {
      throw new RangeError("Invalid search provider position");
    }
    records.splice(value.position, 0, records.splice(index, 1)[0]);
  } else {
    throw new TypeError("Unknown provider operation");
  }
  prefs.setStringPref(NAVIS_SEARCH_PROVIDERS_PREF, JSON.stringify(records));
  if (!records.some(item => item.id === prefs.getStringPref(NAVIS_DEFAULT_SEARCH_PROVIDER_PREF, "google"))) {
    prefs.setStringPref(NAVIS_DEFAULT_SEARCH_PROVIDER_PREF, "google");
  }
  return Object.freeze(records);
}

export function readAppearanceSettings(prefs) {
  const theme = prefs.getStringPref(NAVIS_SETTINGS_PREFS.theme, "system");
  const accent = prefs.getStringPref(NAVIS_SETTINGS_PREFS.accent, NAVIS_DEFAULT_ACCENT);
  const bookmarkBar = prefs.getStringPref(NAVIS_SETTINGS_PREFS.bookmarkBar,
    prefs.getBoolPref("navis.bookmarks.bar.visible", true) ? "always" : "never");
  return Object.freeze({
    theme: ["system", "light", "dark"].includes(theme) ? theme : "system",
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent.toLowerCase() : NAVIS_DEFAULT_ACCENT,
    defaultAccent: NAVIS_DEFAULT_ACCENT,
    bookmarkBar: ["newtab", "always", "never"].includes(bookmarkBar) ? bookmarkBar : "always",
    // Preserve an existing visibility choice, not the old automatic sidebar
    // opening behavior. New writes use the toolbar-specific preference only.
    historyButton: prefs.getBoolPref(NAVIS_SETTINGS_PREFS.historyButton,
      prefs.getBoolPref("navis.history.sidebar.visible", false)),
  });
}

export function setAppearanceSetting(prefs, key, value) {
  if (key === "theme" && ["system", "light", "dark"].includes(value) ||
      key === "bookmarkBar" && ["newtab", "always", "never"].includes(value) ||
      key === "accent" && typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
    prefs.setStringPref(NAVIS_SETTINGS_PREFS[key], value);
    if (key === "theme") {
      prefs.setIntPref("layout.css.prefers-color-scheme.content-override", { dark: 0, light: 1, system: 2 }[value]);
      prefs.setIntPref("ui.systemUsesDarkTheme", value === "dark" ? 1 : 0);
      if (value === "system") {
        prefs.clearUserPref("ui.systemUsesDarkTheme");
      }
    }
    if (key === "bookmarkBar") {
      prefs.setBoolPref("navis.bookmarks.bar.visible", value !== "never");
    }
  } else if (key === "historyButton" && typeof value === "boolean") {
    prefs.setBoolPref(NAVIS_SETTINGS_PREFS[key], value);
  } else {
    throw new TypeError("Invalid appearance setting");
  }
  return readAppearanceSettings(prefs);
}

export function readDownloadSettings(prefs) {
  return Object.freeze({
    askBeforeSaving: prefs.getBoolPref(NAVIS_SETTINGS_PREFS.askBeforeSaving, !prefs.getBoolPref("browser.download.useDownloadDir", false)),
    deletePrivateOnExit: prefs.getBoolPref(NAVIS_SETTINGS_PREFS.deletePrivateOnExit, false),
    openWhenComplete: prefs.getBoolPref(NAVIS_SETTINGS_PREFS.openWhenComplete, false),
  });
}

export function setDownloadSetting(prefs, key, value) {
  if (!["askBeforeSaving", "deletePrivateOnExit", "openWhenComplete"].includes(key) || typeof value !== "boolean") {
    throw new TypeError("Invalid download setting");
  }
  prefs.setBoolPref(NAVIS_SETTINGS_PREFS[key], value);
  if (key === "askBeforeSaving") {
    prefs.setBoolPref("browser.download.useDownloadDir", !value);
  }
  return readDownloadSettings(prefs);
}
