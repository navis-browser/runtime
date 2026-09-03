/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, TabContext, global,
   tabTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionActions:
      "resource://gre/modules/DesktopExtensionActions.sys.mjs",
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
  });

  const { PageActionBase } = ChromeUtils.importESModule(
    "resource://gre/modules/ExtensionActions.sys.mjs"
  );

  const pageActionMap = new WeakMap();

  /** Implements address-bar page actions without importing Firefox frontend UI. */
  class PageAction extends PageActionBase {
    constructor(extension, clickDelegate) {
      const tabContext = new TabContext(() => this.getContextData(null));
      super(tabContext, extension);
      this.clickDelegate = clickDelegate;
      this.browserStyle = Boolean(
        extension.manifest.page_action?.browser_style
      );
    }

    updateOnChange(tab) {
      DesktopExtensionActions.notifyPageAction(this.extension.id, tab || null);
    }

    dispatchClick(tab, clickInfo) {
      this.clickDelegate.onClick(tab, clickInfo);
    }

    getTab(tabId) {
      return tabTracker.getTab(tabId);
    }

    isPanelShownBlockingOpenPopup(window) {
      return DesktopExtensionActions.isPopupOpen(window);
    }
  }

  this.pageAction = class extends ExtensionAPIPersistent {
    async onManifestEntry() {
      const { extension } = this;
      this.action = new PageAction(extension, this);
      await this.action.loadIconData();
      pageActionMap.set(extension, this);
      DesktopExtensionActions.registerPageAction(extension, this.action);
    }

    onShutdown() {
      pageActionMap.delete(this.extension);
      this.action.onShutdown();
      DesktopExtensionActions.unregisterPageAction(this.extension.id);
    }

    onClick(tab, clickInfo) {
      this.emit("click", tab, clickInfo);
    }

    triggerAction(window) {
      const nativeTab = DesktopExtensionTabs.activeTabForWindow(window);
      const result = DesktopExtensionActions.triggerPageAction(
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
    };

    getAPI(context) {
      return {
        pageAction: {
          ...this.action.api(context),
          onClicked: new EventManager({
            context,
            module: "pageAction",
            event: "onClicked",
            inputHandling: true,
            extensionApi: this,
          }).api(),
        },
      };
    }
  };

  global.pageActionFor = extension => pageActionMap.get(extension);
}
