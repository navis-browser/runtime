/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError,
   ExtensionUtils, tabTracker, windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
  });

  this.tabs = class extends ExtensionAPIPersistent {
    tabEventRegistrar({ event, listener }) {
      const { extension } = this;
      const { tabManager } = extension;
      return ({ fire }) => {
        const listener2 = (_eventName, eventData, ...args) => {
          if (!tabManager.canAccessTab(eventData.nativeTab)) {
            return;
          }
          listener(fire, eventData, ...args);
        };
        tabTracker.on(event, listener2);
        return {
          unregister() {
            tabTracker.off(event, listener2);
          },
          convert(newFire) {
            fire = newFire;
          },
        };
      };
    }

    PERSISTENT_EVENTS = {
      onActivated({ fire, context }) {
        const listener = (_eventName, event) => {
          if (event.isPrivate && !context.privateBrowsingAllowed) {
            return;
          }
          const result = {
            windowId: event.windowId,
            tabId: event.tabId,
          };
          if (event.previousTabId !== undefined) {
            result.previousTabId = event.previousTabId;
          }
          fire.async(result);
        };
        DesktopExtensionTabs.on("tab-activated", listener);
        return {
          unregister() {
            DesktopExtensionTabs.off("tab-activated", listener);
          },
          convert(newFire, newContext) {
            fire = newFire;
            context = newContext;
          },
        };
      },

      onHighlighted({ fire, context }) {
        const listener = (_eventName, event) => {
          if (event.isPrivate && !context.privateBrowsingAllowed) {
            return;
          }
          fire.async({
            windowId: event.windowId,
            tabIds: [event.tabId],
          });
        };
        DesktopExtensionTabs.on("tab-activated", listener);
        return {
          unregister() {
            DesktopExtensionTabs.off("tab-activated", listener);
          },
          convert(newFire, newContext) {
            fire = newFire;
            context = newContext;
          },
        };
      },

      onCreated: this.tabEventRegistrar({
        event: "tab-created",
        listener: (fire, event) => {
          fire.async(this.extension.tabManager.convert(event.nativeTab));
        },
      }),

      onRemoved: this.tabEventRegistrar({
        event: "tab-removed",
        listener: (fire, event) => {
          fire.async(event.tabId, {
            windowId: event.windowId,
            isWindowClosing: event.isWindowClosing,
          });
        },
      }),

      onUpdated({ fire }) {
        const { tabManager } = this.extension;
        const restricted = ["url", "favIconUrl", "title"];

        const fireForTab = (tab, changed) => {
          const changeInfo = {};
          for (const [property, value] of Object.entries(changed)) {
            if (!restricted.includes(property) || tab.hasTabPermission) {
              changeInfo[property] = value;
            }
          }
          if (Object.keys(changeInfo).length) {
            fire.async(tab.id, changeInfo, tab.convert());
          }
        };

        const statusListener = ({ browser, status, url }) => {
          const nativeTab = DesktopExtensionTabs.getForBrowser(browser);
          if (!nativeTab) {
            return;
          }
          const changed = { status };
          if (url) {
            changed.url = url;
          }
          fireForTab(tabManager.getWrapper(nativeTab), changed);
        };
        const titleListener = (_eventName, { nativeTab }) => {
          const tab = tabManager.getWrapper(nativeTab);
          fireForTab(tab, { title: tab.title });
        };
        const faviconListener = (_eventName, { nativeTab }) => {
          const tab = tabManager.getWrapper(nativeTab);
          fireForTab(tab, { favIconUrl: tab.favIconUrl });
        };

        windowTracker.addListener("status", statusListener);
        DesktopExtensionTabs.on("tab-title", titleListener);
        DesktopExtensionTabs.on("tab-favicon", faviconListener);
        return {
          unregister() {
            windowTracker.removeListener("status", statusListener);
            DesktopExtensionTabs.off("tab-title", titleListener);
            DesktopExtensionTabs.off("tab-favicon", faviconListener);
          },
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    getAPI(context) {
      const { extension } = context;
      const { tabManager } = extension;
      const extensionApi = this;
      const module = "tabs";

      const getTabOrActive = tabId => {
        const nativeTab =
          tabId !== null ? tabTracker.getTab(tabId) : tabTracker.activeTab;
        if (!nativeTab) {
          throw new ExtensionError("Navis has no active tab");
        }
        return nativeTab;
      };

      const promiseTabWhenReady = async tabId => {
        const nativeTab = getTabOrActive(tabId);
        await tabTracker.awaitTabReady(nativeTab);
        return tabManager.getWrapper(nativeTab);
      };

      return {
        tabs: {
          onActivated: new EventManager({
            context,
            module,
            event: "onActivated",
            extensionApi,
          }).api(),

          onHighlighted: new EventManager({
            context,
            module,
            event: "onHighlighted",
            extensionApi,
          }).api(),

          onCreated: new EventManager({
            context,
            module,
            event: "onCreated",
            extensionApi,
          }).api(),

          onRemoved: new EventManager({
            context,
            module,
            event: "onRemoved",
            extensionApi,
          }).api(),

          onUpdated: new EventManager({
            context,
            module,
            event: "onUpdated",
            extensionApi,
          }).api(),

          onAttached: new EventManager({
            context,
            name: "tabs.onAttached",
            register: () => () => {},
          }).api(),

          onDetached: new EventManager({
            context,
            name: "tabs.onDetached",
            register: () => () => {},
          }).api(),

          onMoved: new EventManager({
            context,
            name: "tabs.onMoved",
            register: () => () => {},
          }).api(),

          onReplaced: new EventManager({
            context,
            name: "tabs.onReplaced",
            register: () => () => {},
          }).api(),

          async create({ active, url, windowId } = {}) {
            active ??= true;
            const useNewTabPage = url == null;
            url ??= "navis://newtab/";
            url = context.uri.resolve(url);
            if (
              !useNewTabPage &&
              !ExtensionUtils.isExtensionUrl(url) &&
              !context.checkLoadURL(url, { dontReportErrors: true })
            ) {
              throw new ExtensionError(`Illegal URL: ${url}`);
            }
            const window =
              windowId == null
                ? windowTracker.getCurrentWindow(context)
                : windowTracker.getWindow(windowId, context);
            if (!window) {
              throw new ExtensionError("Navis has no browser window");
            }
            const nativeTab = DesktopExtensionTabs.createTab(
              window,
              url,
              active,
              useNewTabPage
                ? Services.scriptSecurityManager.getSystemPrincipal()
                : context.principal
            );
            return tabManager.convert(nativeTab);
          },

          async remove(tabIds) {
            for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
              DesktopExtensionTabs.closeTab(tabTracker.getTab(tabId));
            }
          },

          async update(tabId, { active, highlighted, url } = {}) {
            const nativeTab = getTabOrActive(tabId);
            // Gecko's schema normalizes an omitted optional URL to null.  An
            // active-only update (for example uBO re-selecting the tab after
            // injecting its element picker) must therefore leave the current
            // document untouched.  Resolving null against an extension
            // context URI would otherwise turn it into the background-page
            // URL and navigate the user's tab there.
            if (url != null) {
              url = context.uri.resolve(url);
              if (
                !ExtensionUtils.isExtensionUrl(url) &&
                !context.checkLoadURL(url, { dontReportErrors: true })
              ) {
                throw new ExtensionError(`Illegal URL: ${url}`);
              }
            }
            DesktopExtensionTabs.updateTab(nativeTab, {
              active: active || highlighted,
              url: url ?? null,
            });
            return tabManager.convert(nativeTab);
          },

          async move(tabIds) {
            const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
            const converted = ids.map(id =>
              tabManager.convert(tabTracker.getTab(id))
            );
            return Array.isArray(tabIds) ? converted : converted[0];
          },

          async reload(tabId, reloadProperties) {
            const nativeTab = getTabOrActive(tabId);
            let flags = Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
            if (reloadProperties?.bypassCache) {
              flags |= Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE;
            }
            nativeTab.browser.reloadWithFlags(flags);
          },

          async get(tabId) {
            return tabManager.get(tabId).convert();
          },

          async getCurrent() {
            if (context.tabId >= 0) {
              return tabManager.get(context.tabId).convert();
            }
            return undefined;
          },

          async query(queryInfo) {
            return Array.from(tabManager.query(queryInfo, context), tab =>
              tab.convert()
            );
          },

          async captureTab(tabId, options) {
            const nativeTab = getTabOrActive(tabId);
            await tabTracker.awaitTabReady(nativeTab);
            const tab = tabManager.getWrapper(nativeTab);
            return tab.capture(context, nativeTab.browser.fullZoom, options);
          },

          async captureVisibleTab(windowId, options) {
            const window =
              windowId == null
                ? windowTracker.getTopWindow(context)
                : windowTracker.getWindow(windowId, context);
            const nativeTab = DesktopExtensionTabs.activeTabForWindow(window);
            if (!nativeTab) {
              throw new ExtensionError(
                "Navis has no active tab in this window"
              );
            }
            const tab = tabManager.getWrapper(nativeTab);
            if (
              !extension.hasPermission("<all_urls>") &&
              !tab.hasActiveTabPermission
            ) {
              throw new ExtensionError("Missing activeTab permission");
            }
            await tabTracker.awaitTabReady(nativeTab);
            return tab.capture(context, nativeTab.browser.fullZoom, options);
          },

          async detectLanguage(tabId) {
            const tab = await promiseTabWhenReady(tabId);
            const results = await tab.queryContent("DetectLanguage", {});
            return results[0];
          },

          async executeScript(tabId, details) {
            return (await promiseTabWhenReady(tabId)).executeScript(
              context,
              details
            );
          },

          async insertCSS(tabId, details) {
            return (await promiseTabWhenReady(tabId)).insertCSS(
              context,
              details
            );
          },

          async removeCSS(tabId, details) {
            return (await promiseTabWhenReady(tabId)).removeCSS(
              context,
              details
            );
          },

          goForward(tabId) {
            getTabOrActive(tabId).browser.goForward(false);
          },

          goBack(tabId) {
            getTabOrActive(tabId).browser.goBack(false);
          },
        },
      };
    }
  };
}
