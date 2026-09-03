/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const NAVIS_PROCESS_ISOLATION_PREF = "navis.processIsolation.mode";
const GECKO_PROCESS_ISOLATION_PREF = "fission.webContentIsolationStrategy";

export const DESKTOP_PROCESS_ISOLATION_MODES = Object.freeze([
  "full",
  "selective",
  "shared",
]);

const MODE_STRATEGIES = Object.freeze({
  full: 1,
  selective: 2,
  shared: 0,
});

let processMode = null;

export function isDesktopProcessIsolationMode(value) {
  return DESKTOP_PROCESS_ISOLATION_MODES.includes(value);
}

export function desktopProcessIsolationStrategy(mode) {
  return MODE_STRATEGIES[mode] ?? MODE_STRATEGIES.full;
}

function getSelectedMode() {
  const value = Services.prefs.getStringPref(
    NAVIS_PROCESS_ISOLATION_PREF,
    "full"
  );
  return isDesktopProcessIsolationMode(value) ? value : "full";
}

export function initializeDesktopProcessIsolation() {
  if (processMode !== null) {
    return processMode;
  }
  processMode = getSelectedMode();
  Services.prefs.setIntPref(
    GECKO_PROCESS_ISOLATION_PREF,
    desktopProcessIsolationStrategy(processMode)
  );
  return processMode;
}

export function getDesktopProcessIsolationState() {
  const selected = getSelectedMode();
  const active = processMode ?? selected;
  return Object.freeze({
    available: DESKTOP_PROCESS_ISOLATION_MODES,
    selected,
    active,
    strategy: desktopProcessIsolationStrategy(active),
    restartRequired: processMode !== null && selected !== processMode,
  });
}

export function setDesktopProcessIsolationMode(mode) {
  if (!isDesktopProcessIsolationMode(mode)) {
    throw new TypeError("Unknown Navis process-isolation mode");
  }
  Services.prefs.setStringPref(NAVIS_PROCESS_ISOLATION_PREF, mode);
  return getDesktopProcessIsolationState();
}
