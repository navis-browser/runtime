/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError, TabContext,
   global, tabTracker, windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionActions:
      "resource://gre/modules/DesktopExtensionActions.sys.mjs",
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
  });

  const { BrowserActionBase } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionActions.sys.mjs"
  );

  const browserActionMap = new WeakMap();

  /** Implements a generic Navis toolbar action over Gecko's action state. */
  class BrowserAction extends BrowserActionBase {
    constructor(extension, clickDelegate) {
      const tabContext = new TabContext(() => this.getContextData(null));
      super(tabContext, extension);
      this.clickDelegate = clickDelegate;
      const options =
        extension.manifest.browser_action || extension.manifest.action;
      this.browserStyle = Boolean(options?.browser_style);
    }

    updateOnChange(tab) {
      DesktopExtensionActions.notify(this.extension.id, tab || null);
    }

    openPopup(tab, openPopupWithoutUserInteraction = false) {
      const popup = openPopupWithoutUserInteraction
        ? this.getPopupUrl(tab)
        : this.triggerClickOrPopup(tab);
      if (popup) {
        DesktopExtensionActions.requestPopup(this.extension.id, popup, tab);
      }
    }

    triggerClickOrPopup(tab = tabTracker.activeTab) {
      return super.triggerClickOrPopup(tab);
    }

    getTab(tabId) {
      return tabTracker.getTab(tabId);
    }

    getWindow(windowId) {
      return windowTracker.getWindow(windowId);
    }

    dispatchClick(tab, clickInfo) {
      this.clickDelegate.onClick(tab, clickInfo);
    }

    isPanelShownBlockingOpenPopup(window) {
      return DesktopExtensionActions.isPopupOpen(window);
    }
  }

  this.browserAction = class extends ExtensionAPIPersistent {
    async onManifestEntry() {
      const { extension } = this;
      this.action = new BrowserAction(extension, this);
      await this.action.loadIconData();
      browserActionMap.set(extension, this);
      DesktopExtensionActions.register(extension, this.action);
    }

    onShutdown() {
      browserActionMap.delete(this.extension);
      this.action.onShutdown();
      DesktopExtensionActions.unregister(this.extension.id);
    }

    onClick(tab, clickInfo) {
      this.emit("click", tab, clickInfo);
    }

    triggerAction(window) {
      const nativeTab = DesktopExtensionTabs.activeTabForWindow(window);
      const result = DesktopExtensionActions.trigger(
        this.extension.id,
        nativeTab
      );
      if (result?.popup) {
        DesktopExtensionActions.requestPopup(
          this.extension.id,
          result.popup,
          nativeTab
        );
      }
    }

    PERSISTENT_EVENTS = {
      onClicked({ fire }) {
        const { tabManager } = this.extension;
        const listener = async (_eventName, tab, clickInfo) => {
          if (fire.wakeup) {
            await fire.wakeup();
          }
          fire.sync(tabManager.convert(tab), clickInfo);
        };
        this.on("click", listener);
        return {
          unregister: () => this.off("click", listener),
          convert(newFire) {
            fire = newFire;
          },
        };
      },

      onUserSettingsChanged({ fire }) {
        const extensionId = this.extension.id;
        const listener = (_eventName, snapshot) => {
          if (snapshot.extensionId === extensionId) {
            fire.async({ isOnToolbar: snapshot.toolbarPinned });
          }
        };
        DesktopExtensionActions.on("action-changed", listener);
        return {
          unregister() {
            DesktopExtensionActions.off("action-changed", listener);
          },
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    getAPI(context) {
      const { action } = this;
      const namespace =
        this.extension.manifestVersion < 3 ? "browserAction" : "action";

      return {
        [namespace]: {
          ...action.api(context),

          onClicked: new EventManager({
            context,
            module: "browserAction",
            event: "onClicked",
            inputHandling: true,
            extensionApi: this,
          }).api(),

          onUserSettingsChanged: new EventManager({
            context,
            module: "browserAction",
            event: "onUserSettingsChanged",
            extensionApi: this,
          }).api(),

          getUserSettings: () => ({
            isOnToolbar: DesktopExtensionActions.isPinned(this.extension.id),
          }),

          openPopup: options => {
            const isHandlingUserInput =
              context.callContextData?.isHandlingUserInput;
            if (
              !Services.prefs.getBoolPref(
                "extensions.openPopupWithoutUserGesture.enabled",
                false
              ) &&
              !isHandlingUserInput
            ) {
              throw new ExtensionError("openPopup requires a user gesture");
            }
            const window =
              typeof options?.windowId === "number"
                ? windowTracker.getWindow(options.windowId, context)
                : windowTracker.getTopNormalWindow(context);
            if (
              Services.focus.activeWindow !== window ||
              window.windowState === window.STATE_MINIMIZED
            ) {
              throw new ExtensionError(BrowserActionBase.ERROR_WIN_NOT_FOCUSED);
            }
            const nativeTab = DesktopExtensionTabs.activeTabForWindow(window);
            if (nativeTab && action.getPopupUrl(nativeTab, true)) {
              action.throwIfOpenPopupIsBlockedByAnyAction(window);
              action.openPopup(nativeTab, !isHandlingUserInput);
            }
          },
        },
      };
    }
  };

  global.browserActionFor = extension => browserActionMap.get(extension);
}
