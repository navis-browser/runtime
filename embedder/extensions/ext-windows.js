/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals DesktopExtensionTabs, EventManager, ExtensionAPIPersistent,
   ExtensionError, ExtensionUtils, PrivateBrowsingUtils, Window, tabTracker,
   windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    clearTimeout: "resource://gre/modules/Timer.sys.mjs",
    setTimeout: "resource://gre/modules/Timer.sys.mjs",
  });

  const WINDOW_READY_TIMEOUT_MS = 30 * 1000;
  const WINDOW_CHROME_URI = "chrome://navis/content/main.xhtml";

  function ensureAccessibleWindow(context, windowId) {
    const window = windowTracker.getWindow(windowId, context);
    if (!window || !context.canAccessWindow(window)) {
      throw new ExtensionError(`Invalid Navis window ID: ${windowId}`);
    }
    return window;
  }

  function normalizeURLs(context, value) {
    if (value == null) {
      return Object.freeze([]);
    }
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.length > 128) {
      throw new ExtensionError("A Navis window requires 1 to 128 URLs");
    }
    return Object.freeze(
      values.map(candidate => {
        const url = context.uri.resolve(candidate);
        if (
          !ExtensionUtils.isExtensionUrl(url) &&
          !context.checkLoadURL(url, { dontReportErrors: true })
        ) {
          throw new ExtensionError(`Illegal URL: ${url}`);
        }
        return url;
      })
    );
  }

  function waitForFirstTab(window) {
    const existing = DesktopExtensionTabs.activeTabForWindow(window);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      let timeout = null;
      const finish = (tab, error = null) => {
        DesktopExtensionTabs.off("tab-created", onCreated);
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve(tab);
        }
      };
      const onCreated = (_eventName, event) => {
        if (event.nativeTab.window === window) {
          finish(event.nativeTab);
        }
      };
      DesktopExtensionTabs.on("tab-created", onCreated);
      timeout = setTimeout(
        () =>
          finish(null, new ExtensionError("Navis window startup timed out")),
        WINDOW_READY_TIMEOUT_MS
      );
    });
  }

  function assertCreateOptions(createData) {
    if (createData.tabId != null) {
      throw new ExtensionError("Navis 1.0 does not adopt tabs between windows");
    }
    if (createData.type != null && createData.type !== "normal") {
      throw new ExtensionError("Navis 1.0 creates normal browser windows only");
    }
    if (createData.cookieStoreId != null) {
      throw new ExtensionError("Navis 1.0 has no extension container stores");
    }
    if (createData.titlePreface) {
      throw new ExtensionError("Navis 1.0 does not expose title prefaces");
    }
    const hasGeometry = ["left", "top", "width", "height"].some(
      key => createData[key] != null
    );
    if (
      hasGeometry &&
      createData.state != null &&
      createData.state !== "normal"
    ) {
      throw new ExtensionError(
        "Window geometry cannot be combined with a non-normal state"
      );
    }
  }

  this.windows = class extends ExtensionAPIPersistent {
    windowEventRegistrar(event, listener) {
      const { extension } = this;
      return ({ fire }) => {
        const routed = (window, ...args) => {
          if (extension.canAccessWindow(window)) {
            listener(fire, window, ...args);
          }
        };
        windowTracker.addListener(event, routed);
        return {
          unregister: () => windowTracker.removeListener(event, routed),
          convert(newFire) {
            fire = newFire;
          },
        };
      };
    }

    PERSISTENT_EVENTS = {
      onCreated: this.windowEventRegistrar(
        "domwindowopened",
        (fire, window) => {
          fire.async(this.extension.windowManager.convert(window));
        }
      ),
      onRemoved: this.windowEventRegistrar(
        "domwindowclosed",
        (fire, window) => {
          fire.async(windowTracker.getId(window));
        }
      ),
      onFocusChanged({ fire }) {
        const { extension } = this;
        let previous = null;
        const listener = () => {
          Promise.resolve().then(() => {
            const window = Services.focus.activeWindow;
            const id =
              window && extension.canAccessWindow(window)
                ? windowTracker.getId(window)
                : Window.WINDOW_ID_NONE;
            if (id !== previous) {
              previous = id;
              fire.async(id);
            }
          });
        };
        windowTracker.addListener("focus", listener);
        windowTracker.addListener("blur", listener);
        return {
          unregister() {
            windowTracker.removeListener("focus", listener);
            windowTracker.removeListener("blur", listener);
          },
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    getAPI(context) {
      const { extension } = context;
      const { windowManager } = extension;
      return {
        windows: {
          onCreated: new EventManager({
            context,
            module: "windows",
            event: "onCreated",
            extensionApi: this,
          }).api(),
          onRemoved: new EventManager({
            context,
            module: "windows",
            event: "onRemoved",
            extensionApi: this,
          }).api(),
          onFocusChanged: new EventManager({
            context,
            module: "windows",
            event: "onFocusChanged",
            extensionApi: this,
          }).api(),

          async get(windowId, getInfo) {
            return windowManager.convert(
              ensureAccessibleWindow(context, windowId),
              getInfo
            );
          },

          async getCurrent(getInfo) {
            const window = windowTracker.getCurrentWindow(context);
            if (!window || !context.canAccessWindow(window)) {
              throw new ExtensionError("Navis has no current browser window");
            }
            return windowManager.convert(window, getInfo);
          },

          async getLastFocused(getInfo) {
            const window = windowTracker.getTopWindow(context);
            if (!window || !context.canAccessWindow(window)) {
              throw new ExtensionError(
                "Navis has no accessible browser window"
              );
            }
            return windowManager.convert(window, getInfo);
          },

          async getAll(getInfo) {
            return [...windowManager.getAll(context)]
              .filter(window =>
                getInfo?.windowTypes?.length
                  ? getInfo.windowTypes.includes(window.type)
                  : true
              )
              .map(window => window.convert(getInfo));
          },

          async create(createData = {}) {
            assertCreateOptions(createData);
            if (createData.incognito && !context.privateBrowsingAllowed) {
              throw new ExtensionError(
                "Extension does not have private-window access"
              );
            }
            const urls = normalizeURLs(context, createData.url);
            const ownerWindow = windowTracker.getCurrentWindow(context);
            const features = `chrome,dialog=no,all,resizable=yes,minimizable=yes${
              createData.incognito ? ",private" : ""
            }`;
            const opened = Services.ww.openWindow(
              ownerWindow,
              WINDOW_CHROME_URI,
              "_blank",
              features,
              null
            );
            try {
              const firstTab = await waitForFirstTab(opened);
              if (urls.length) {
                DesktopExtensionTabs.updateTab(firstTab, { url: urls[0] });
                for (const url of urls.slice(1)) {
                  DesktopExtensionTabs.createTab(
                    opened,
                    url,
                    false,
                    context.principal
                  );
                }
              }
              const wrapped = windowManager.getWrapper(opened);
              wrapped.updateGeometry(createData);
              if (createData.state && createData.state !== "normal") {
                await wrapped.setState(createData.state);
              }
              if (createData.focused === false) {
                ownerWindow?.focus();
              } else {
                opened.focus();
              }
              return wrapped.convert({ populate: true });
            } catch (error) {
              opened.close();
              throw error;
            }
          },

          async update(windowId, updateInfo) {
            const window = ensureAccessibleWindow(context, windowId);
            const wrapped = windowManager.getWrapper(window);
            const hasGeometry = ["left", "top", "width", "height"].some(
              key => updateInfo[key] != null
            );
            if (
              hasGeometry &&
              updateInfo.state != null &&
              updateInfo.state !== "normal"
            ) {
              throw new ExtensionError(
                "Window geometry cannot be combined with a non-normal state"
              );
            }
            if (updateInfo.titlePreface) {
              throw new ExtensionError(
                "Navis 1.0 does not expose title prefaces"
              );
            }
            wrapped.updateGeometry(updateInfo);
            if (updateInfo.state != null) {
              await wrapped.setState(updateInfo.state);
            }
            if (updateInfo.drawAttention) {
              wrapped.appWindow.getAttention();
            }
            if (updateInfo.focused === true) {
              window.focus();
            } else if (updateInfo.focused === false) {
              const replacement = [...windowManager.getAll(context)].find(
                candidate => candidate.window !== window
              );
              replacement?.window.focus();
            }
            return wrapped.convert();
          },

          async remove(windowId) {
            ensureAccessibleWindow(context, windowId).close();
          },
        },
      };
    }
  };
}
