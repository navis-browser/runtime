/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError, tabTracker,
   windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    getDesktopProfileStore:
      "resource://gre/modules/DesktopProfileStore.sys.mjs",
  });

  const MAX_SESSION_RESULTS = 25;

  function closedTab(record) {
    return {
      active: false,
      highlighted: false,
      incognito: false,
      index: record.index,
      pinned: false,
      sessionId: record.sessionId,
      title: record.title,
      url: record.url,
      windowId: record.windowId,
    };
  }

  function accessibleWindow(context, id = null) {
    const candidates = DesktopExtensionTabs.windows.filter(window =>
      context.canAccessWindow(window)
    );
    return (
      candidates.find(window => windowTracker.getId(window) === id) ||
      windowTracker.getCurrentWindow(context) ||
      candidates[0] ||
      null
    );
  }

  this.sessions = class extends ExtensionAPIPersistent {
    PERSISTENT_EVENTS = {
      onChanged({ fire }) {
        const store = getDesktopProfileStore();
        const listener = () => fire.async();
        store.on("closed-session-changed", listener);
        return {
          unregister() {
            store.off("closed-session-changed", listener);
          },
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    getAPI(context) {
      const { extension } = context;
      const store = getDesktopProfileStore();

      const getTab = tabId => {
        const tab = tabTracker.getTab(tabId);
        if (!tab || !context.canAccessWindow(tab.window)) {
          throw new ExtensionError(`Invalid Navis tab ID: ${tabId}`);
        }
        return tab;
      };

      const getWindow = windowId => {
        const window = windowTracker.getWindow(windowId, context);
        if (!window || !context.canAccessWindow(window)) {
          throw new ExtensionError(`Invalid Navis window ID: ${windowId}`);
        }
        return window;
      };

      return {
        sessions: {
          async getRecentlyClosed(filter = {}) {
            const records = await store.listClosedTabs(
              Math.min(
                filter.maxResults ?? MAX_SESSION_RESULTS,
                MAX_SESSION_RESULTS
              )
            );
            return records.map(record => ({
              lastModified: record.closedAt,
              tab: closedTab(record),
            }));
          },

          async forgetClosedTab(windowId, sessionId) {
            const record = await store.takeClosedTab(sessionId, {
              remove: false,
            });
            if (!record || record.windowId !== windowId) {
              throw new ExtensionError(
                `Could not find closed tab using sessionId ${sessionId}.`
              );
            }
            await store.takeClosedTab(sessionId);
          },

          async forgetClosedWindow(sessionId) {
            throw new ExtensionError(
              `Could not find closed window using sessionId ${sessionId}.`
            );
          },

          async restore(sessionId) {
            let record = null;
            if (sessionId) {
              record = await store.takeClosedTab(sessionId, { remove: false });
            } else {
              [record] = await store.listClosedTabs(1);
            }
            if (!record) {
              throw new ExtensionError(
                `Could not restore object using sessionId ${sessionId || "latest"}.`
              );
            }
            const window = accessibleWindow(context, record.windowId);
            if (!window) {
              throw new ExtensionError(
                "Navis has no accessible browser window"
              );
            }
            const nativeTab = DesktopExtensionTabs.createTab(
              window,
              record.url,
              true,
              context.principal
            );
            await store.takeClosedTab(record.sessionId);
            return {
              lastModified: Date.now(),
              tab: extension.tabManager.convert(nativeTab),
            };
          },

          async setTabValue(tabId, key, value) {
            DesktopExtensionTabs.setTabValue(
              getTab(tabId),
              extension.id,
              key,
              value
            );
          },

          async getTabValue(tabId, key) {
            return DesktopExtensionTabs.getTabValue(
              getTab(tabId),
              extension.id,
              key
            );
          },

          async removeTabValue(tabId, key) {
            DesktopExtensionTabs.removeTabValue(
              getTab(tabId),
              extension.id,
              key
            );
          },

          async setWindowValue(windowId, key, value) {
            DesktopExtensionTabs.setWindowValue(
              getWindow(windowId),
              extension.id,
              key,
              value
            );
          },

          async getWindowValue(windowId, key) {
            return DesktopExtensionTabs.getWindowValue(
              getWindow(windowId),
              extension.id,
              key
            );
          },

          async removeWindowValue(windowId, key) {
            DesktopExtensionTabs.removeWindowValue(
              getWindow(windowId),
              extension.id,
              key
            );
          },

          onChanged: new EventManager({
            context,
            module: "sessions",
            event: "onChanged",
            extensionApi: this,
          }).api(),
        },
      };
    }
  };
}
