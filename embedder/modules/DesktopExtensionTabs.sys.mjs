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

function dispatchBrowserTabEvent(tab, type, detail = {}) {
  const { browser, window } = tab;
  if (
    !browser?.isConnected ||
    browser.ownerDocument?.defaultView !== window
  ) {
    return false;
  }
  browser.dispatchEvent(
    new window.CustomEvent(type, {
      bubbles: true,
      cancelable: false,
      detail,
    })
  );
  return true;
}

/** Private adapter joining one EngineSession, browser, and Platform window. */
class DesktopExtensionTab {
  #eventListeners = new Map();

  constructor(id, session, runtime, browser, window) {
    this.id = id;
    this.session = session;
    this.runtime = runtime;
    this.browser = browser;
    this.window = window;
    this.closing = false;
    this.createdAt = Date.now();
  }

  get linkedBrowser() {
    return this.browser;
  }

  get tagName() {
    return "tab";
  }

  get ownerDocument() {
    return this.window.document;
  }

  get documentGlobal() {
    return this.window;
  }

  get ownerGlobal() {
    return this.window;
  }

  get label() {
    return this.session.state.title || this.session.state.url;
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

  focus() {
    return this.session.view?.focus() || false;
  }

  addEventListener(type, listener, options = undefined) {
    if (
      typeof type !== "string" ||
      (!listener?.handleEvent && typeof listener !== "function")
    ) {
      return;
    }
    const normalized = typeof options === "object" && options ? options : {};
    if (normalized.signal?.aborted) {
      return;
    }
    const entry = {
      listener,
      once: Boolean(normalized.once),
      signal: normalized.signal || null,
      abort: null,
    };
    let listeners = this.#eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#eventListeners.set(type, listeners);
    }
    if ([...listeners].some(candidate => candidate.listener === listener)) {
      return;
    }
    if (entry.signal) {
      entry.abort = () => this.#removeEventEntry(type, entry);
      entry.signal.addEventListener("abort", entry.abort, { once: true });
    }
    listeners.add(entry);
  }

  removeEventListener(type, listener) {
    const entry = [...(this.#eventListeners.get(type) || [])].find(
      candidate => candidate.listener === listener
    );
    if (entry) {
      this.#removeEventEntry(type, entry);
    }
  }

  dispatchBindingEvent(type) {
    const event = Object.freeze({
      type,
      target: this,
      currentTarget: this,
    });
    for (const entry of [...(this.#eventListeners.get(type) || [])]) {
      try {
        if (typeof entry.listener === "function") {
          entry.listener.call(this, event);
        } else {
          entry.listener.handleEvent(event);
        }
      } catch (error) {
        console.error(`Navis tab ${type} listener failed`, error);
      }
      if (entry.once) {
        this.#removeEventEntry(type, entry);
      }
    }
  }

  #removeEventEntry(type, entry) {
    const listeners = this.#eventListeners.get(type);
    if (!listeners?.delete(entry)) {
      return;
    }
    if (entry.signal && entry.abort) {
      entry.signal.removeEventListener("abort", entry.abort);
    }
    if (!listeners.size) {
      this.#eventListeners.delete(type);
    }
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
        const previousBrowser = tab.browser;
        const previousWindow = tab.window;
        const windowChanged = previousWindow !== window;
        const wasActive = this.#activeByWindow.get(previousWindow) === tab;
        this.#byBrowser.delete(previousBrowser);
        if (windowChanged) {
          const previousTabs = this.#tabsByWindow.get(previousWindow);
          const previousIndex = previousTabs?.indexOf(tab) ?? -1;
          if (previousIndex >= 0) {
            previousTabs.splice(previousIndex, 1);
          }
          if (previousTabs && !previousTabs.length) {
            this.#tabsByWindow.delete(previousWindow);
          }

          let destinationTabs = this.#tabsByWindow.get(window);
          if (!destinationTabs) {
            destinationTabs = [];
            this.#tabsByWindow.set(window, destinationTabs);
          }
          if (!destinationTabs.includes(tab)) {
            destinationTabs.push(tab);
          }

          if (wasActive) {
            this.#activeByWindow.delete(previousWindow);
            this.#activeByWindow.set(window, tab);
          }
        }
        tab.browser = browser;
        tab.window = window;
        this.#byBrowser.set(browser, tab);
        tab.dispatchBindingEvent("TabRemotenessChange");
        this.emit("tab-browser-changed", {
          nativeTab: tab,
          previousBrowser,
          previousWindow,
          windowChanged,
        });
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
    dispatchBrowserTabEvent(tab, "TabOpen");
    return tab;
  }

  notifySessionClosing(session) {
    const tab = this.#bySession.get(session);
    if (!tab || tab.closing) {
      return false;
    }
    // Both local TabDescriptorFront and server BrowserTabList must observe the
    // close while the target browser is still connected and registered.
    tab.closing = true;
    tab.dispatchBindingEvent("TabClose");
    dispatchBrowserTabEvent(tab, "TabClose");
    return true;
  }

  unregisterSession(session, isWindowClosing = false) {
    const tab = this.#bySession.get(session);
    if (!tab) {
      return false;
    }
    const windowId = tab.window?.docShell?.outerWindowID ?? -1;
    this.notifySessionClosing(session);
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
    tab.dispatchBindingEvent("TabSelect");
    dispatchBrowserTabEvent(tab, "TabSelect", { previousTab: previous });
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

  getForSession(session) {
    return this.#bySession.get(session) || null;
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
