/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventEmitter, TabBase, TabManagerBase, TabTrackerBase,
   WindowBase, WindowManagerBase, WindowTrackerBase, extensions,
   getCookieStoreIdForTab, global */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  });

  const { ExtensionCommon } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionCommon.sys.mjs"
  );
  const { ExtensionUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionUtils.sys.mjs"
  );

  const { ExtensionError } = ExtensionUtils;
  const { defineLazyGetter } = ExtensionCommon;

  const WINDOW_TYPE = "navis:browser";

  /** Tracks Navis Platform windows for the shared extension runtime. */
  class WindowTracker extends WindowTrackerBase {
    get topWindow() {
      return Services.wm.getMostRecentWindow(WINDOW_TYPE);
    }

    get topNonPBWindow() {
      const topWindow = this.topWindow;
      if (topWindow && !PrivateBrowsingUtils.isWindowPrivate(topWindow)) {
        return topWindow;
      }
      return (
        DesktopExtensionTabs.windows.find(
          window => !PrivateBrowsingUtils.isWindowPrivate(window)
        ) || null
      );
    }

    getTopNormalWindow(context) {
      return this.getTopWindow(context);
    }

    isBrowserWindow(window) {
      return (
        window.document.documentElement.getAttribute("windowtype") ===
        WINDOW_TYPE
      );
    }

    addProgressListener(window, listener) {
      DesktopExtensionTabs.addProgressListener(window, listener);
    }

    removeProgressListener(window, listener) {
      DesktopExtensionTabs.removeProgressListener(window, listener);
    }
  }

  /** Projects stable Navis Session-backed tab identities into WebExtensions. */
  class TabTracker extends TabTrackerBase {
    init() {
      if (this.initialized) {
        return;
      }
      this.initialized = true;

      DesktopExtensionTabs.on("tab-created", (_eventName, event) => {
        this.emit("tab-created", event);
      });
      DesktopExtensionTabs.on("tab-removed", (_eventName, event) => {
        this.emit("tab-removed", event);
      });
    }

    getId(nativeTab) {
      return nativeTab.id;
    }

    getTab(id, default_ = undefined) {
      const tab = DesktopExtensionTabs.getById(id, null);
      if (tab) {
        return tab;
      }
      if (default_ !== undefined) {
        return default_;
      }
      throw new ExtensionError(`Invalid tab ID: ${id}`);
    }

    getTabForBrowser(browser) {
      return DesktopExtensionTabs.getForBrowser(browser);
    }

    getBrowserData(browser) {
      const nativeTab = this.getTabForBrowser(browser);
      if (nativeTab) {
        return {
          tabId: nativeTab.id,
          windowId: windowTracker.getId(nativeTab.window),
        };
      }
      const window = browser.documentGlobal;
      if (window && windowTracker.isBrowserWindow(window)) {
        return { tabId: -1, windowId: windowTracker.getId(window) };
      }
      return { tabId: -1, windowId: -1 };
    }

    get activeTab() {
      return DesktopExtensionTabs.activeTab;
    }
  }

  const windowTracker = new WindowTracker();
  const tabTracker = new TabTracker();

  Object.assign(global, { tabTracker, windowTracker });

  /** Adapts a DesktopExtensionTab to Gecko's product-neutral TabBase. */
  class Tab extends TabBase {
    get _favIconUrl() {
      return this.nativeTab.session.state.favicon || undefined;
    }

    get attention() {
      return false;
    }

    get audible() {
      return undefined;
    }

    get browser() {
      return this.nativeTab.browser;
    }

    get discarded() {
      return false;
    }

    get cookieStoreId() {
      return getCookieStoreIdForTab(this, this.nativeTab);
    }

    get openerTabId() {
      return undefined;
    }

    get height() {
      return this.browser.clientHeight;
    }

    get incognito() {
      return PrivateBrowsingUtils.isBrowserPrivate(this.browser);
    }

    get index() {
      return this.nativeTab.index;
    }

    get mutedInfo() {
      return { muted: false };
    }

    get lastAccessed() {
      return this.nativeTab.createdAt;
    }

    get pinned() {
      return false;
    }

    get active() {
      return this.nativeTab.active;
    }

    get highlighted() {
      return this.active;
    }

    get status() {
      return this.browser.webProgress.isLoadingDocument
        ? "loading"
        : "complete";
    }

    get successorTabId() {
      return -1;
    }

    get groupId() {
      return -1;
    }

    get splitViewId() {
      return -1;
    }

    get width() {
      return this.browser.clientWidth;
    }

    get window() {
      return this.nativeTab.window;
    }

    get windowId() {
      return windowTracker.getId(this.window);
    }

    get isArticle() {
      return false;
    }

    get isInReaderMode() {
      return false;
    }

    get hidden() {
      return false;
    }

    get autoDiscardable() {
      return true;
    }

    get sharingState() {
      return {
        screen: undefined,
        microphone: false,
        camera: false,
      };
    }
  }

  /** Stores action state by stable Navis tab ID. */
  class TabContext extends EventEmitter {
    constructor(getDefaultPrototype) {
      super();
      this.getDefaultPrototype = getDefaultPrototype;
      this.tabData = new Map();
      this.onTabActivated = (_eventName, { nativeTab }) => {
        this.emit("tab-select", nativeTab);
      };
      this.onTabRemoved = (_eventName, { tabId }) => {
        this.clear(tabId);
      };
      windowTracker.addListener("progress", this);
      DesktopExtensionTabs.on("tab-activated", this.onTabActivated);
      DesktopExtensionTabs.on("tab-removed", this.onTabRemoved);
    }

    onLocationChange(browser, webProgress, request, locationURI, flags) {
      if (!webProgress.isTopLevel) {
        return;
      }
      const nativeTab = DesktopExtensionTabs.getForBrowser(browser);
      if (!nativeTab) {
        return;
      }
      const fromBrowse = !(
        flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
      );
      this.emit("location-change", nativeTab, fromBrowse);
    }

    get(target) {
      const tabId = target?.id ?? -1;
      if (!this.tabData.has(tabId)) {
        const data = Object.create(this.getDefaultPrototype(target));
        this.tabData.set(tabId, data);
      }
      return this.tabData.get(tabId);
    }

    clear(tabId) {
      this.tabData.delete(tabId?.id ?? tabId);
    }

    shutdown() {
      windowTracker.removeListener("progress", this);
      DesktopExtensionTabs.off("tab-activated", this.onTabActivated);
      DesktopExtensionTabs.off("tab-removed", this.onTabRemoved);
    }
  }

  /** Adapts a Navis chrome window to Gecko's product-neutral WindowBase. */
  class Window extends WindowBase {
    updateGeometry(options) {
      const { window } = this;
      if (options.left != null || options.top != null) {
        window.moveTo(
          options.left ?? window.screenX,
          options.top ?? window.screenY
        );
      }
      if (options.width != null || options.height != null) {
        window.resizeTo(
          Math.max(100, options.width ?? window.outerWidth),
          Math.max(100, options.height ?? window.outerHeight)
        );
      }
    }

    get _title() {
      return this.window.document.title;
    }

    get type() {
      return "normal";
    }

    get focused() {
      return this.window.document.hasFocus();
    }

    get top() {
      return this.window.screenY;
    }

    get left() {
      return this.window.screenX;
    }

    get width() {
      return this.window.outerWidth;
    }

    get height() {
      return this.window.outerHeight;
    }

    get incognito() {
      return PrivateBrowsingUtils.isWindowPrivate(this.window);
    }

    get alwaysOnTop() {
      return false;
    }

    get isLastFocused() {
      return this.window === windowTracker.topWindow;
    }

    get state() {
      return Window.getState(this.window);
    }

    static getState(window) {
      return (
        {
          [window.STATE_MAXIMIZED]: "maximized",
          [window.STATE_MINIMIZED]: "minimized",
          [window.STATE_FULLSCREEN]: "fullscreen",
          [window.STATE_NORMAL]: "normal",
        }[window.windowState] || "normal"
      );
    }

    async setState(state) {
      const { window } = this;
      if (window.fullScreen && state !== "fullscreen") {
        window.fullScreen = false;
      }
      switch (state) {
        case "normal":
          window.restore();
          break;
        case "minimized":
          window.minimize();
          break;
        case "maximized":
          window.maximize();
          break;
        case "fullscreen":
          window.fullScreen = true;
          break;
        default:
          throw new ExtensionError(`Unsupported Navis window state: ${state}`);
      }
    }

    *getTabs() {
      const { tabManager } = this.extension;
      for (const nativeTab of DesktopExtensionTabs.tabsForWindow(this.window)) {
        yield tabManager.getWrapper(nativeTab);
      }
    }

    *getHighlightedTabs() {
      const activeTab = this.activeTab;
      if (activeTab) {
        yield activeTab;
      }
    }

    get activeTab() {
      const nativeTab = DesktopExtensionTabs.activeTabForWindow(this.window);
      return nativeTab
        ? this.extension.tabManager.getWrapper(nativeTab)
        : undefined;
    }

    getTabAtIndex(index) {
      const nativeTab = DesktopExtensionTabs.tabsForWindow(this.window)[index];
      return nativeTab
        ? this.extension.tabManager.getWrapper(nativeTab)
        : undefined;
    }
  }

  Object.assign(global, { Tab, TabContext, Window });

  /** Resolves extension-visible tabs without exposing EngineSession objects. */
  class TabManager extends TabManagerBase {
    get(tabId, default_ = undefined) {
      const nativeTab = tabTracker.getTab(tabId, default_);
      return nativeTab ? this.getWrapper(nativeTab) : default_;
    }

    canAccessTab(nativeTab) {
      return (
        this.extension.privateBrowsingAllowed ||
        !PrivateBrowsingUtils.isBrowserPrivate(nativeTab.browser)
      );
    }

    wrapTab(nativeTab) {
      return new Tab(this.extension, nativeTab, nativeTab.id);
    }
  }

  /** Resolves extension-visible Navis windows. */
  class WindowManager extends WindowManagerBase {
    get(windowId, context) {
      return this.getWrapper(windowTracker.getWindow(windowId, context));
    }

    *getAll(context) {
      for (const window of windowTracker.browserWindows()) {
        if (this.canAccessWindow(window, context)) {
          yield this.getWrapper(window);
        }
      }
    }

    wrapWindow(window) {
      return new Window(this.extension, window, windowTracker.getId(window));
    }
  }

  extensions.on("startup", (_type, extension) => {
    defineLazyGetter(extension, "tabManager", () => new TabManager(extension));
    defineLazyGetter(
      extension,
      "windowManager",
      () => new WindowManager(extension)
    );
  });

  global.openOptionsPage = async extension => {
    const window = windowTracker.topWindow;
    if (!window) {
      throw new ExtensionError("Navis has no browser window for this page");
    }
    DesktopExtensionTabs.createTab(
      window,
      extension.optionsPageProperties.page,
      true,
      extension.principal
    );
  };
}
