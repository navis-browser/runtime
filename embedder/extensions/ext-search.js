/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals ExtensionAPI, ExtensionError, tabTracker, windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    NavisSearchService: "resource://gre/modules/NavisSearchService.sys.mjs",
    readSearchProviders: "resource://gre/modules/NavisSettingsPolicy.sys.mjs",
    readDefaultSearchProvider: "resource://gre/modules/NavisSettingsPolicy.sys.mjs",
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    clearTimeout: "resource://gre/modules/Timer.sys.mjs",
    setTimeout: "resource://gre/modules/Timer.sys.mjs",
  });

  const prepareSearch = () => NavisSearchService.init({
    providers: readSearchProviders(Services.prefs),
    defaultProviderId: readDefaultSearchProvider(Services.prefs),
    remoteSuggestionsEnabled: false,
  });

  function selectedProvider(name = null) {
    if (name) {
      const provider = NavisSearchService.snapshot.providers.find(
        candidate => candidate.name === name || candidate.id === name
      );
      if (!provider) {
        throw new ExtensionError(`Unknown Navis search engine: ${name}`);
      }
      return provider;
    }
    return NavisSearchService.snapshot.providers.find(
      provider => provider.id === NavisSearchService.snapshot.defaultProviderId);
  }

  function requestPrivacy(properties) {
    const target = properties.tabId != null ? tabTracker.getTab(properties.tabId) : tabTracker.activeTab;
    return Boolean(target?.session.state.private);
  }

  function searchURL(text, engine = null, privateMode = false) {
    if (typeof text !== "string" || !text.trim() || text.length > 8192) {
      throw new ExtensionError("A bounded search query is required");
    }
    return NavisSearchService.submission(text.trim(), {providerId: selectedProvider(engine).id, privateMode}).url;
  }

  function openSearch(context, url, { tabId, disposition }, fallback) {
    if (tabId != null && disposition != null) {
      throw new ExtensionError("tabId and disposition cannot be combined");
    }
    if (tabId != null) {
      const tab = tabTracker.getTab(tabId);
      DesktopExtensionTabs.updateTab(tab, { url });
      return;
    }
    const effectiveDisposition = disposition || fallback;
    const activeTab = tabTracker.activeTab;
    if (!activeTab) {
      throw new ExtensionError("Navis has no active tab for search");
    }
    if (effectiveDisposition === "CURRENT_TAB") {
      DesktopExtensionTabs.updateTab(activeTab, { url });
      return;
    }
    if (effectiveDisposition === "NEW_TAB") {
      DesktopExtensionTabs.createTab(
        activeTab.window,
        url,
        true,
        context.principal
      );
      return;
    }
    if (effectiveDisposition === "NEW_WINDOW") {
      const features = `chrome,dialog=no,all,resizable=yes,minimizable=yes${
        activeTab.session.state.private ? ",private" : ""
      }`;
      let opened = null;
      let timeout = null;
      const listener = (_eventName, event) => {
        if (opened && event.nativeTab.window === opened) {
          DesktopExtensionTabs.off("tab-created", listener);
          clearTimeout(timeout);
          DesktopExtensionTabs.updateTab(event.nativeTab, { url });
        }
      };
      DesktopExtensionTabs.on("tab-created", listener);
      opened = Services.ww.openWindow(
        activeTab.window,
        "chrome://navis/content/main.xhtml",
        "_blank",
        features,
        null
      );
      timeout = setTimeout(() => {
        DesktopExtensionTabs.off("tab-created", listener);
        if (
          !opened.closed &&
          !DesktopExtensionTabs.activeTabForWindow(opened)
        ) {
          opened.close();
        }
      }, 30 * 1000);
      return;
    }
    throw new ExtensionError(`Unsupported search disposition: ${disposition}`);
  }

  this.search = class extends ExtensionAPI {
    getAPI(context) {
      return {
        search: {
          async get() {
            await prepareSearch();
            const current = selectedProvider();
            return NavisSearchService.snapshot.providers.map(provider => ({
              name: provider.name,
              alias: provider.id,
              isDefault: provider.id === current.id,
            }));
          },

          async search(properties) {
            await prepareSearch();
            openSearch(
              context,
              searchURL(properties.query, properties.engine, requestPrivacy(properties)),
              properties,
              "NEW_TAB"
            );
          },

          async query(properties) {
            await prepareSearch();
            openSearch(
              context,
              searchURL(properties.text, null, requestPrivacy(properties)),
              properties,
              "CURRENT_TAB"
            );
          },
        },
      };
    }
  };
}
