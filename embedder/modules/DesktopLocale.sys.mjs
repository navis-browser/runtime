/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DESKTOP_LOCALE_PREF = "navis.platform.locale";

export const DESKTOP_LOCALE_SETTINGS = Object.freeze([
  "system",
  "en-US",
  "zh-CN",
]);

export const DESKTOP_AVAILABLE_LOCALES = Object.freeze(["en-US", "zh-CN"]);

let processLocale = null;

export function isDesktopLocaleSetting(value) {
  return DESKTOP_LOCALE_SETTINGS.includes(value);
}

export function resolveDesktopLocale(setting, systemLocale = "en-US") {
  if (setting === "en-US" || setting === "zh-CN") {
    return setting;
  }
  if (setting !== "system") {
    return "en-US";
  }
  try {
    return new Intl.Locale(systemLocale).language === "zh" ? "zh-CN" : "en-US";
  } catch {
    return "en-US";
  }
}

function getSystemLocale() {
  try {
    return Cc["@mozilla.org/intl/ospreferences;1"].getService(
      Ci.mozIOSPreferences
    ).systemLocale;
  } catch {
    return Services.locale.regionalPrefsLocales[0] || "en-US";
  }
}

function getSelectedSetting() {
  const value = Services.prefs.getStringPref(DESKTOP_LOCALE_PREF, "system");
  return isDesktopLocaleSetting(value) ? value : "en-US";
}

export function initializeDesktopLocale() {
  if (processLocale === null) {
    processLocale = resolveDesktopLocale(
      getSelectedSetting(),
      getSystemLocale(),
    );
    // Navis-owned UI reads processLocale, while upstream Gecko surfaces such
    // as DevTools read LocaleService. Keep both on one frozen process choice;
    // the packaged zh-CN resources become available during AddonManager
    // startup and LocaleService renegotiates before DevTools is loaded.
    Services.locale.requestedLocales = [processLocale];
  }
  return processLocale;
}

export function getDesktopLocaleState() {
  const selected = getSelectedSetting();
  const resolved = resolveDesktopLocale(selected, getSystemLocale());
  return Object.freeze({
    available: DESKTOP_AVAILABLE_LOCALES,
    settings: DESKTOP_LOCALE_SETTINGS,
    selected,
    active: processLocale ?? resolved,
    restartRequired: processLocale !== null && resolved !== processLocale,
  });
}

export function setDesktopLocaleSetting(setting) {
  if (!isDesktopLocaleSetting(setting)) {
    throw new TypeError("Unknown Navis display-language setting");
  }
  Services.prefs.setStringPref(DESKTOP_LOCALE_PREF, setting);
  return getDesktopLocaleState();
}
