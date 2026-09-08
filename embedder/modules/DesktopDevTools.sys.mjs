/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";
import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";

let firefoxBrowserLifecycleDetached = false;

function detachFirefoxBrowserLifecycle(gDevToolsBrowser) {
  if (firefoxBrowserLifecycleDetached) {
    return;
  }
  // Docked hosts and Responsive Design Mode use gDevToolsBrowser's shared
  // stylesheet service, so the module cannot simply stay unloaded. Its
  // top-level Firefox integration also observes browser-window startup and
  // quit-application, however. Navis owns neither Firefox's menu document nor
  // that shutdown order: letting the observer destroy gDevTools before our
  // toolboxes have finished closing leaves DevToolsProcess actors and theme
  // observers half torn down during eRestart.
  for (const topic of [
    "browser-delayed-startup-finished",
    "quit-application",
    "devtools:loader:destroy",
  ]) {
    try {
      Services.obs.removeObserver(gDevToolsBrowser, topic);
    } catch {}
  }
  firefoxBrowserLifecycleDetached = true;
}

class DesktopTabContainerFacade {
  #listeners = new Map();

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
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    if ([...listeners].some((entry) => entry.listener === listener)) {
      return;
    }
    const entry = {
      listener,
      once: Boolean(normalized.once),
      signal: normalized.signal || null,
      abort: null,
    };
    if (entry.signal) {
      entry.abort = () => this.#remove(type, entry);
      entry.signal.addEventListener("abort", entry.abort, { once: true });
    }
    listeners.add(entry);
  }

  removeEventListener(type, listener) {
    const entry = [...(this.#listeners.get(type) || [])].find(
      (candidate) => candidate.listener === listener,
    );
    if (entry) {
      this.#remove(type, entry);
    }
  }

  emit(type, target) {
    const event = Object.freeze({ type, target, currentTarget: this });
    for (const entry of [...(this.#listeners.get(type) || [])]) {
      try {
        if (typeof entry.listener === "function") {
          entry.listener.call(this, event);
        } else {
          entry.listener.handleEvent(event);
        }
      } catch (error) {
        console.error(`Navis tab-container ${type} listener failed`, error);
      }
      if (entry.once) {
        this.#remove(type, entry);
      }
    }
  }

  clear() {
    for (const [type, listeners] of this.#listeners) {
      for (const entry of [...listeners]) {
        this.#remove(type, entry);
      }
    }
  }

  #remove(type, entry) {
    const listeners = this.#listeners.get(type);
    if (!listeners?.delete(entry)) {
      return;
    }
    if (entry.signal && entry.abort) {
      entry.signal.removeEventListener("abort", entry.abort);
    }
    if (!listeners.size) {
      this.#listeners.delete(type);
    }
  }
}

class DesktopBrowserFacade {
  #window;
  #tabContainer;
  #onTabActivated;
  #onTabCreated;
  #onTabRemoved;
  #notifications = new WeakMap();

  constructor(window) {
    this.#window = window;
    this.#tabContainer = new DesktopTabContainerFacade();
    this.#onTabActivated = (_eventName, { nativeTab }) => {
      if (nativeTab.window === this.#window) {
        this.#tabContainer.emit("TabSelect", nativeTab);
      }
    };
    this.#onTabCreated = (_eventName, { nativeTab }) => {
      if (nativeTab.window === this.#window) {
        this.#tabContainer.emit("TabOpen", nativeTab);
      }
    };
    this.#onTabRemoved = (_eventName, { nativeTab }) => {
      if (nativeTab.window === this.#window) {
        this.#tabContainer.emit("TabClose", nativeTab);
      }
    };
    DesktopExtensionTabs.on("tab-activated", this.#onTabActivated);
    DesktopExtensionTabs.on("tab-created", this.#onTabCreated);
    DesktopExtensionTabs.on("tab-removed", this.#onTabRemoved);
  }

  get isNavisDevToolsFacade() {
    return true;
  }

  get selectedTab() {
    return DesktopExtensionTabs.activeTabForWindow(this.#window);
  }

  set selectedTab(tab) {
    if (!tab || tab.window !== this.#window) {
      throw new TypeError(
        "The selected DevTools tab must belong to this window",
      );
    }
    DesktopExtensionTabs.updateTab(tab, { active: true });
  }

  get selectedBrowser() {
    return this.selectedTab?.linkedBrowser || null;
  }

  get currentURI() {
    return (
      this.selectedBrowser?.currentURI || Services.io.newURI("about:blank")
    );
  }

  get contentPrincipal() {
    return (
      this.selectedBrowser?.contentPrincipal ||
      Services.scriptSecurityManager.getSystemPrincipal()
    );
  }

  get tabs() {
    return DesktopExtensionTabs.tabsForWindow(this.#window);
  }

  get browsers() {
    return this.tabs.map((tab) => tab.linkedBrowser);
  }

  get tabContainer() {
    return this.#tabContainer;
  }

  getTabForBrowser(browser) {
    const tab = DesktopExtensionTabs.getForBrowser(browser);
    return tab?.window === this.#window ? tab : null;
  }

  getBrowserForTab(tab) {
    return tab?.window === this.#window ? tab.linkedBrowser : null;
  }

  getBrowserContainer(browser) {
    const stack = browser?.closest?.(".browserStack");
    const container = stack?.parentElement;
    if (!container?.classList.contains("browserContainer")) {
      throw new Error("The Session has no DevTools browser container");
    }
    return container;
  }

  getPanel(browser) {
    const panel = this.getBrowserContainer(browser).parentElement;
    if (!panel?.classList.contains("browserSidebarContainer")) {
      throw new Error("The Session has no DevTools browser panel");
    }
    return panel;
  }

  addWebTab(url, options = {}) {
    const principal =
      options.triggeringPrincipal || this.selectedBrowser?.contentPrincipal;
    return DesktopExtensionTabs.createTab(
      this.#window,
      url,
      false,
      principal || Services.scriptSecurityManager.getSystemPrincipal(),
    );
  }

  addTrustedTab(url) {
    return DesktopExtensionTabs.createTab(
      this.#window,
      url,
      false,
      Services.scriptSecurityManager.getSystemPrincipal(),
    );
  }

  getNotificationBox(browser) {
    let box = this.#notifications.get(browser);
    if (box) {
      return box;
    }
    const notifications = new Map();
    box = Object.freeze({
      PRIORITY_INFO_MEDIUM: 1,
      PRIORITY_WARNING_MEDIUM: 2,
      PRIORITY_CRITICAL_MEDIUM: 3,
      getNotificationWithValue: (value) => notifications.get(value) || null,
      appendNotification: (value, options = {}) => {
        const notification = Object.freeze({ value, ...options });
        notifications.set(value, notification);
        return notification;
      },
      removeNotification: (notification) =>
        notifications.delete(notification?.value),
    });
    this.#notifications.set(browser, box);
    return box;
  }

  destroy() {
    DesktopExtensionTabs.off("tab-activated", this.#onTabActivated);
    DesktopExtensionTabs.off("tab-created", this.#onTabCreated);
    DesktopExtensionTabs.off("tab-removed", this.#onTabRemoved);
    this.#tabContainer.clear();
  }
}

function defineWindowValue(window, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  Object.defineProperty(window, name, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? false,
    writable: true,
    value,
  });
  return descriptor;
}

export class DesktopDevTools {
  #toolboxes = new Map();
  #pending = new Map();
  #targetEpochs = new WeakMap();
  #transferTeardowns = new Map();
  #windows = new Map();
  #loaded = null;
  #closed = false;
  #closing = null;
  #shutdownBlocker;

  constructor() {
    this.#shutdownBlocker = () => {
      this.close();
      return this.#closing;
    };
    AsyncShutdown.profileBeforeChange.addBlocker(
      "Desktop DevTools: close Navis page toolboxes",
      this.#shutdownBlocker,
      {
        fetchState: () => ({
          closed: this.#closed,
          pendingOperations: this.#pending.size,
          toolboxes: this.#toolboxes.size,
        }),
      },
    );
  }

  getState(session) {
    const toolbox = this.#toolboxes.get(session) || null;
    return Object.freeze({
      available: !this.#closed,
      open: Boolean(toolbox),
      host: toolbox?.hostType || null,
      tool: toolbox?.currentToolId || null,
    });
  }

  async toggle(session, { toolId = null } = {}) {
    if (this.#closed) {
      throw new Error("Desktop DevTools is closed");
    }
    const transferTeardown = this.#transferTeardowns.get(session);
    if (transferTeardown) {
      await transferTeardown;
    }
    if (this.#closed) {
      throw new Error("Desktop DevTools is closed");
    }
    const pending = this.#pending.get(session);
    if (pending) {
      return pending;
    }
    const operation = this.#toggleSession(
      session,
      toolId,
      this.#targetEpoch(session),
    );
    this.#pending.set(session, operation);
    try {
      return await operation;
    } finally {
      if (this.#pending.get(session) === operation) {
        this.#pending.delete(session);
      }
    }
  }

  async inspect(session, domReference) {
    if (this.#closed) {
      throw new Error("Desktop DevTools is closed");
    }
    if (
      !domReference ||
      !Number.isSafeInteger(domReference.browsingContextId) ||
      !Number.isFinite(domReference.id)
    ) {
      throw new TypeError(
        "Element inspection requires a content DOM reference",
      );
    }
    const transferTeardown = this.#transferTeardowns.get(session);
    if (transferTeardown) {
      await transferTeardown;
    }
    const pending = this.#pending.get(session);
    if (pending) {
      await pending;
    }
    if (this.#closed) {
      throw new Error("Desktop DevTools is closed");
    }
    const operation = this.#inspectSession(session, domReference);
    this.#pending.set(session, operation);
    try {
      return await operation;
    } finally {
      if (this.#pending.get(session) === operation) {
        this.#pending.delete(session);
      }
    }
  }

  async #inspectSession(session, domReference) {
    const tab = DesktopExtensionTabs.getForSession(session);
    if (!tab?.linkedBrowser?.browsingContext) {
      throw new Error("The Session has no live Gecko target");
    }
    const targetBrowser = tab.linkedBrowser;
    const targetWindow = tab.window;
    const targetEpoch = this.#targetEpoch(session);
    this.#installWindow(targetWindow);
    const { gDevTools } = this.#load();
    await gDevTools.inspectNode(tab, domReference, ChromeUtils.now());
    const toolbox = gDevTools.getToolboxForTab(tab);
    if (!toolbox) {
      throw new Error(
        "Gecko did not create an Inspector toolbox for the Session",
      );
    }
    if (
      !this.#isCurrentTarget(
        session,
        tab,
        targetBrowser,
        targetWindow,
        targetEpoch,
      )
    ) {
      await toolbox.destroy();
      return this.getState(session);
    }
    this.#trackToolbox(session, toolbox);
    return this.getState(session);
  }

  async #toggleSession(session, toolId, targetEpoch) {
    const tab = DesktopExtensionTabs.getForSession(session);
    if (!tab?.linkedBrowser?.browsingContext) {
      throw new Error("The Session has no live Gecko target");
    }
    const targetBrowser = tab.linkedBrowser;
    const targetWindow = tab.window;
    this.#installWindow(tab.window);
    const { gDevTools } = this.#load();
    const toolDefinition = toolId ? gDevTools.getToolDefinition(toolId) : null;
    const existing = this.#toolboxes.get(session);
    if (existing) {
      if (toolId) {
        const toolIsSelected =
          existing.currentToolId === toolId ||
          (toolId === "webconsole" && existing.splitConsole);
        if (!toolIsSelected) {
          await existing.selectTool(toolId, "key_shortcut");
        }
        if (
          !this.#isCurrentTarget(
            session,
            tab,
            targetBrowser,
            targetWindow,
            targetEpoch,
          )
        ) {
          await this.#retireToolbox(session, existing);
          return this.getState(session);
        }
        existing.fireCustomKey(toolId);
        if (
          !toolIsSelected ||
          toolDefinition?.preventClosingOnKey ||
          existing.hostType === "window"
        ) {
          if (!toolDefinition?.preventRaisingOnKey) {
            await existing.raise();
          }
          return this.getState(session);
        }
      }
      if (existing.hostType === "window") {
        await existing.raise();
        return this.getState(session);
      }
      await existing.destroy();
      return this.getState(session);
    }

    const toolbox = await gDevTools.showToolboxForTab(tab, {
      toolId: toolId || undefined,
      raise: !toolDefinition?.preventRaisingOnKey,
      reason: "key_shortcut",
    });
    if (!toolbox) {
      throw new Error("Gecko did not create a toolbox for the Session");
    }
    if (
      !this.#isCurrentTarget(
        session,
        tab,
        targetBrowser,
        targetWindow,
        targetEpoch,
      )
    ) {
      await this.#retireToolbox(session, toolbox);
      if (!this.#closed) {
        return this.getState(session);
      }
      throw new Error("Desktop DevTools closed while opening a toolbox");
    }
    this.#trackToolbox(session, toolbox);
    if (toolId) {
      toolbox.fireCustomKey(toolId);
    }
    return this.getState(session);
  }

  closeForBrowserTransfer(session) {
    if (this.#closed) {
      return Promise.resolve(false);
    }

    this.#targetEpochs.set(session, this.#targetEpoch(session) + 1);
    const previousTeardown = this.#transferTeardowns.get(session) || null;
    const pending = this.#pending.get(session) || null;
    const toolbox = this.#toolboxes.get(session) || null;
    const destruction = toolbox ? this.#retireToolbox(session, toolbox) : null;
    const work = [previousTeardown, pending, destruction].filter(Boolean);
    const teardown = Promise.allSettled(work).then(() =>
      Boolean(pending || toolbox),
    );
    this.#transferTeardowns.set(session, teardown);
    teardown.then(() => {
      if (this.#transferTeardowns.get(session) === teardown) {
        this.#transferTeardowns.delete(session);
      }
    });
    return teardown;
  }

  async closeSession(session) {
    const transferTeardown = this.#transferTeardowns.get(session);
    if (transferTeardown) {
      await transferTeardown;
    }
    const pending = this.#pending.get(session);
    if (pending) {
      try {
        await pending;
      } catch {
        return false;
      }
    }
    const toolbox = this.#toolboxes.get(session);
    if (!toolbox) {
      return false;
    }
    await toolbox.destroy();
    return true;
  }

  #targetEpoch(session) {
    return this.#targetEpochs.get(session) || 0;
  }

  #isCurrentTarget(session, tab, browser, window, targetEpoch) {
    return (
      !this.#closed &&
      this.#targetEpoch(session) === targetEpoch &&
      DesktopExtensionTabs.getForSession(session) === tab &&
      tab.linkedBrowser === browser &&
      tab.window === window &&
      Boolean(browser.browsingContext)
    );
  }

  async #retireToolbox(session, toolbox) {
    if (this.#toolboxes.get(session) === toolbox) {
      this.#toolboxes.delete(session);
    }
    try {
      await toolbox.destroy();
      return true;
    } catch (error) {
      console.error(
        "Navis could not retire a transferred DevTools toolbox",
        error,
      );
      return false;
    }
  }

  #trackToolbox(session, toolbox) {
    if (this.#toolboxes.get(session) === toolbox) {
      return;
    }
    this.#toolboxes.set(session, toolbox);
    toolbox.once("destroyed", () => {
      if (this.#toolboxes.get(session) === toolbox) {
        this.#toolboxes.delete(session);
      }
    });
  }

  close() {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    const work = new Set([
      ...this.#pending.values(),
      ...this.#transferTeardowns.values(),
    ]);
    for (const [session, toolbox] of this.#toolboxes) {
      this.#toolboxes.delete(session);
      work.add(
        toolbox.destroy().catch((error) => {
          console.error("Navis could not close a DevTools toolbox", error);
        }),
      );
    }
    this.#closing = Promise.allSettled([...work]).then(() => {
      this.#pending.clear();
      this.#transferTeardowns.clear();
      for (const [window, state] of this.#windows) {
        state.themeMedia.removeEventListener("change", state.updateTheme);
        Services.prefs.removeObserver("devtools.theme", state.updateTheme);
        state.facade.destroy();
        for (const [name, descriptor] of state.descriptors) {
          if (descriptor) {
            Object.defineProperty(window, name, descriptor);
          } else {
            delete window[name];
          }
        }
      }
      this.#windows.clear();
      try {
        AsyncShutdown.profileBeforeChange.removeBlocker(
          this.#shutdownBlocker,
        );
      } catch {}
    });
    return true;
  }

  async closeAndWait() {
    this.close();
    await this.#closing;
  }

  #load() {
    if (this.#loaded) {
      return this.#loaded;
    }
    const { require } = ChromeUtils.importESModule(
      "resource://devtools/shared/loader/Loader.sys.mjs",
    );
    const { gDevTools } = require("devtools/client/framework/devtools");
    const { gDevToolsBrowser } = require(
      "devtools/client/framework/devtools-browser"
    );
    const { DevToolsServer } = require("devtools/server/devtools-server");
    DevToolsServer.chromeWindowType = "navis:browser";
    gDevTools.chromeWindowType = "navis:browser";
    detachFirefoxBrowserLifecycle(gDevToolsBrowser);
    this.#loaded = Object.freeze({ gDevTools, gDevToolsBrowser });
    return this.#loaded;
  }

  #installWindow(window) {
    const current = this.#windows.get(window);
    if (current) {
      return current.facade;
    }
    if (window.gBrowser && !window.gBrowser.isNavisDevToolsFacade) {
      throw new Error("The Platform window already has a browser facade");
    }
    const facade = new DesktopBrowserFacade(window);
    const descriptors = new Map();
    const define = (name, value) => {
      descriptors.set(name, defineWindowValue(window, name, value));
    };
    define("gBrowser", facade);
    define("gFissionBrowser", true);
    define(
      "gBrowserInit",
      Object.freeze({
        delayedStartupFinished: true,
        isAdoptingTab: () => false,
      }),
    );
    define("openWebLinkIn", (url, where = "tab", options = {}) => {
      const tab = facade.addWebTab(url, options);
      if (where !== "tabshifted") {
        facade.selectedTab = tab;
      }
      return tab;
    });
    define("openTrustedLinkIn", (url, where = "tab") => {
      const tab = facade.addTrustedTab(url);
      if (where !== "tabshifted") {
        facade.selectedTab = tab;
      }
      return tab;
    });
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      const preference = Services.prefs.getCharPref("devtools.theme", "auto");
      const dark = preference === "dark" ||
        (preference === "auto" && themeMedia.matches);
      window.document.documentElement.setAttribute(
        "devtoolstheme",
        dark ? "dark" : "light",
      );
    };
    themeMedia.addEventListener("change", updateTheme);
    Services.prefs.addObserver("devtools.theme", updateTheme);
    updateTheme();
    this.#windows.set(window, {
      facade,
      descriptors,
      themeMedia,
      updateTheme,
    });
    return facade;
  }
}
