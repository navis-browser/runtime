/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "resource://gre/modules/EventEmitter.sys.mjs";
import { getDesktopProfileStore } from "resource://gre/modules/DesktopProfileStore.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const MAX_SESSION_VALUE_BYTES = 64 * 1024;

function checkedSessionValue(extensionId, key, value) {
  if (typeof extensionId !== "string" || !extensionId) {
    throw new TypeError("A session value requires an extension ID");
  }
  if (typeof key !== "string" || !key || key.length > 256) {
    throw new TypeError("A session value key must contain 1 to 256 characters");
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("A session value must be JSON serializable");
  }
  if (new TextEncoder().encode(serialized).length > MAX_SESSION_VALUE_BYTES) {
    throw new RangeError("A session value cannot exceed 64 KiB");
  }
  return JSON.parse(serialized);
}

/** Private adapter joining one EngineSession, browser, and Platform window. */
class DesktopExtensionTab {
  constructor(id, session, runtime, browser, window) {
    this.id = id;
    this.session = session;
    this.runtime = runtime;
    this.browser = browser;
    this.window = window;
    this.createdAt = Date.now();
  }

  get linkedBrowser() {
    return this.browser;
  }

  get userContextId() {
    return Number(this.browser.getAttribute("usercontextid")) || 0;
  }

  get active() {
    return DesktopExtensionTabs.activeTabForWindow(this.window) === this;
  }

  get selected() {
    return this.active;
  }

  get index() {
    return DesktopExtensionTabs.tabsForWindow(this.window).indexOf(this);
  }
}

/** Maintains stable native-tab identities for WebExtensions and WebDriver. */
class DesktopExtensionTabRegistry extends EventEmitter {
  #nextId = 1;
  #bySession = new WeakMap();
  #byBrowser = new WeakMap();
  #byId = new Map();
  #tabsByWindow = new WeakMap();
  #activeByWindow = new WeakMap();
  #progressListeners = new WeakMap();
  #tabValues = new WeakMap();
  #windowValues = new WeakMap();

  registerSession(session, runtime, browser) {
    const window = browser.documentGlobal;
    if (!window) {
      throw new Error("A Navis extension tab requires a live owner window");
    }
    let tab = this.#bySession.get(session);
    if (tab) {
      if (tab.browser !== browser) {
        this.#byBrowser.delete(tab.browser);
        tab.browser = browser;
        tab.window = window;
        this.#byBrowser.set(browser, tab);
        this.emit("tab-browser-changed", { nativeTab: tab });
      }
      return tab;
    }

    tab = new DesktopExtensionTab(
      this.#nextId++,
      session,
      runtime,
      browser,
      window
    );
    this.#bySession.set(session, tab);
    this.#byBrowser.set(browser, tab);
    this.#byId.set(tab.id, tab);
    let tabs = this.#tabsByWindow.get(window);
    if (!tabs) {
      tabs = [];
      this.#tabsByWindow.set(window, tabs);
    }
    tabs.push(tab);
    this.emit("tab-created", { nativeTab: tab });
    return tab;
  }

  unregisterSession(session, isWindowClosing = false) {
    const tab = this.#bySession.get(session);
    if (!tab) {
      return false;
    }
    const windowId = tab.window?.docShell?.outerWindowID ?? -1;
    this.#bySession.delete(session);
    this.#byBrowser.delete(tab.browser);
    this.#byId.delete(tab.id);
    const tabs = this.#tabsByWindow.get(tab.window);
    const index = tabs?.indexOf(tab) ?? -1;
    const state = tab.session.state;
    if (
      !isWindowClosing &&
      !state.private &&
      /^https?:/iu.test(state.url || "")
    ) {
      getDesktopProfileStore()
        .addClosedTab({
          windowId,
          position: Math.max(0, index),
          url: state.url,
          title: state.title,
        })
        .catch(error => {
          console.error("Navis could not record a recently closed tab", error);
        });
    }
    if (index >= 0) {
      tabs.splice(index, 1);
    }
    if (this.#activeByWindow.get(tab.window) === tab) {
      this.#activeByWindow.delete(tab.window);
    }
    this.#tabValues.delete(tab);
    this.emit("tab-removed", {
      nativeTab: tab,
      tabId: tab.id,
      windowId,
      isWindowClosing,
    });
    return true;
  }

  activateSession(session) {
    const tab = this.#bySession.get(session);
    if (!tab || this.#activeByWindow.get(tab.window) === tab) {
      return false;
    }
    const previous = this.#activeByWindow.get(tab.window) || null;
    this.#activeByWindow.set(tab.window, tab);
    this.emit("tab-activated", {
      nativeTab: tab,
      tabId: tab.id,
      previousTabId: previous?.id,
      windowId: tab.window.docShell.outerWindowID,
      isPrivate: PrivateBrowsingUtils.isBrowserPrivate(tab.browser),
    });
    return true;
  }

  getById(id, fallback = undefined) {
    const tab = this.#byId.get(id);
    if (tab) {
      return tab;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Invalid Navis tab ID: ${id}`);
  }

  getForBrowser(browser) {
    return this.#byBrowser.get(browser) || null;
  }

  tabsForWindow(window) {
    return [...(this.#tabsByWindow.get(window) || [])];
  }

  activeTabForWindow(window) {
    return this.#activeByWindow.get(window) || null;
  }

  get activeTab() {
    const window = Services.wm.getMostRecentWindow("navis:browser");
    return window ? this.activeTabForWindow(window) : null;
  }

  get windows() {
    return [...Services.wm.getEnumerator("navis:browser")].filter(
      window => !window.closed
    );
  }

  addProgressListener(window, listener) {
    let listeners = this.#progressListeners.get(window);
    if (!listeners) {
      listeners = new Set();
      this.#progressListeners.set(window, listeners);
    }
    listeners.add(listener);
  }

  removeProgressListener(window, listener) {
    this.#progressListeners.get(window)?.delete(listener);
  }

  notifyLocation(browser, webProgress, request, locationURI, flags) {
    const tab = this.getForBrowser(browser);
    if (!tab) {
      return;
    }
    for (const listener of this.#progressListeners.get(tab.window) || []) {
      listener.onLocationChange?.(
        browser,
        webProgress,
        request,
        locationURI,
        flags
      );
    }
    this.emit("tab-location", {
      nativeTab: tab,
      browser,
      webProgress,
      request,
      locationURI,
      flags,
    });
  }

  notifyState(browser, webProgress, request, stateFlags, status) {
    const tab = this.getForBrowser(browser);
    if (!tab) {
      return;
    }
    for (const listener of this.#progressListeners.get(tab.window) || []) {
      listener.onStateChange?.(
        browser,
        webProgress,
        request,
        stateFlags,
        status
      );
    }
  }

  notifyTitle(browser) {
    const tab = this.getForBrowser(browser);
    if (tab) {
      this.emit("tab-title", { nativeTab: tab });
    }
  }

  notifyFavicon(browser) {
    const tab = this.getForBrowser(browser);
    if (tab) {
      this.emit("tab-favicon", { nativeTab: tab });
    }
  }

  createTab(window, url, active, principal) {
    const where = active
      ? Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_FOREGROUND
      : Ci.nsIBrowserDOMWindow.OPEN_NEWTAB_BACKGROUND;
    const browsingContext = window.browserDOMWindow.openURI(
      Services.io.newURI(url || "about:blank"),
      null,
      where,
      Ci.nsIBrowserDOMWindow.OPEN_NEW,
      principal,
      null
    );
    if (!browsingContext) {
      throw new Error("Navis rejected extension tab creation");
    }
    const tab = this.tabsForWindow(window).find(
      candidate => candidate.browser.browsingContext === browsingContext
    );
    if (!tab) {
      throw new Error("Navis did not register the created extension tab");
    }
    return tab;
  }

  updateTab(tab, { active = null, url = null } = {}) {
    if (url !== null) {
      tab.session.loadUri(url);
    }
    if (active) {
      tab.runtime.activateSession(tab.session);
      tab.window.dispatchEvent(
        new tab.window.CustomEvent("NavisBindingTabActivated", {
          detail: { session: tab.session },
        })
      );
    }
    return tab;
  }

  closeTab(tab) {
    tab.window.dispatchEvent(
      new tab.window.CustomEvent("NavisBindingTabCloseRequested", {
        detail: { session: tab.session },
      })
    );
  }

  setTabValue(tab, extensionId, key, value) {
    const normalized = checkedSessionValue(extensionId, key, value);
    let extensions = this.#tabValues.get(tab);
    if (!extensions) {
      extensions = new Map();
      this.#tabValues.set(tab, extensions);
    }
    let values = extensions.get(extensionId);
    if (!values) {
      values = new Map();
      extensions.set(extensionId, values);
    }
    values.set(key, normalized);
  }

  getTabValue(tab, extensionId, key) {
    const value = this.#tabValues.get(tab)?.get(extensionId)?.get(key);
    return value === undefined
      ? undefined
      : checkedSessionValue(extensionId, key, value);
  }

  removeTabValue(tab, extensionId, key) {
    const extensions = this.#tabValues.get(tab);
    const values = extensions?.get(extensionId);
    const removed = values?.delete(key) || false;
    if (values && !values.size) {
      extensions.delete(extensionId);
    }
    return removed;
  }

  setWindowValue(window, extensionId, key, value) {
    const normalized = checkedSessionValue(extensionId, key, value);
    let extensions = this.#windowValues.get(window);
    if (!extensions) {
      extensions = new Map();
      this.#windowValues.set(window, extensions);
    }
    let values = extensions.get(extensionId);
    if (!values) {
      values = new Map();
      extensions.set(extensionId, values);
    }
    values.set(key, normalized);
  }

  getWindowValue(window, extensionId, key) {
    const value = this.#windowValues
      .get(window)
      ?.get(extensionId)
      ?.get(key);
    return value === undefined
      ? undefined
      : checkedSessionValue(extensionId, key, value);
  }

  removeWindowValue(window, extensionId, key) {
    const extensions = this.#windowValues.get(window);
    const values = extensions?.get(extensionId);
    const removed = values?.delete(key) || false;
    if (values && !values.size) {
      extensions.delete(extensionId);
    }
    return removed;
  }
}

export const DesktopExtensionTabs = new DesktopExtensionTabRegistry();
