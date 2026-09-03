/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const trackedWindows = [];
const windowListeners = new WeakMap();

function moveToFront(window) {
  const index = trackedWindows.indexOf(window);
  if (index >= 0) {
    trackedWindows.splice(index, 1);
  }
  trackedWindows.unshift(window);
}

function visibleBrowsers(window) {
  return [
    ...window.document.querySelectorAll("browser.desktop-engine-view"),
  ].filter(browser => browser.isConnected && !browser.hidden);
}

function orderedWindows() {
  return trackedWindows.filter(window => !window.closed);
}

export function registerDesktopWindow(window) {
  if (windowListeners.has(window)) {
    moveToFront(window);
    return;
  }

  const activate = () => moveToFront(window);
  const unload = () => unregisterDesktopWindow(window);
  window.addEventListener("activate", activate);
  window.addEventListener("unload", unload, { once: true });
  windowListeners.set(window, { activate, unload });
  moveToFront(window);
}

export function unregisterDesktopWindow(window) {
  const listeners = windowListeners.get(window);
  if (listeners) {
    window.removeEventListener("activate", listeners.activate);
    window.removeEventListener("unload", listeners.unload);
    windowListeners.delete(window);
  }
  const index = trackedWindows.indexOf(window);
  if (index >= 0) {
    trackedWindows.splice(index, 1);
  }
}

export const BrowserWindowTracker = {
  getTopWindow({ private: privateMode } = {}) {
    if (privateMode === true) {
      return null;
    }
    return orderedWindows()[0] || null;
  },

  get orderedWindows() {
    return orderedWindows();
  },

  get windowCount() {
    return orderedWindows().length;
  },

  getOrderedWindows({ private: privateMode } = {}) {
    return privateMode === true ? [] : orderedWindows();
  },

  getAllVisibleTabs() {
    return orderedWindows().flatMap(window =>
      visibleBrowsers(window).map(browser => ({
        contentTitle: browser.contentTitle || "",
        browserId: browser.browserId,
      }))
    );
  },

  getBrowserById(browserId) {
    for (const window of orderedWindows()) {
      const browser = [
        ...window.document.querySelectorAll("browser.desktop-engine-view"),
      ].find(candidate => candidate.browserId === browserId);
      if (browser) {
        return browser;
      }
    }
    return null;
  },
};
