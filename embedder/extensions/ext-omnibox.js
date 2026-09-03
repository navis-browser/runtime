/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionOmnibox:
      "resource://gre/modules/DesktopExtensionOmnibox.sys.mjs",
  });

  const EVENTS = Object.freeze({
    cancelled: "navis-omnibox-input-cancelled",
    changed: "navis-omnibox-input-changed",
    deleted: "navis-omnibox-suggestion-deleted",
    entered: "navis-omnibox-input-entered",
    started: "navis-omnibox-input-started",
  });

  this.omnibox = class extends ExtensionAPIPersistent {
    PERSISTENT_EVENTS = {
      onInputStarted({ fire }) {
        return this.#persistentEvent(EVENTS.started, fire, currentFire =>
          currentFire.sync()
        );
      },
      onInputCancelled({ fire }) {
        return this.#persistentEvent(EVENTS.cancelled, fire, currentFire =>
          currentFire.sync()
        );
      },
      onInputEntered({ fire }) {
        return this.#persistentEvent(
          EVENTS.entered,
          fire,
          (currentFire, _eventName, text, disposition) => {
            this.extension.tabManager.addActiveTabPermission();
            currentFire.sync(text, disposition);
          }
        );
      },
      onInputChanged({ fire }) {
        return this.#persistentEvent(
          EVENTS.changed,
          fire,
          (currentFire, _eventName, text, requestId) =>
            currentFire.sync(text, requestId)
        );
      },
      onDeleteSuggestion({ fire }) {
        return this.#persistentEvent(
          EVENTS.deleted,
          fire,
          (currentFire, _eventName, text) => currentFire.sync(text)
        );
      },
    };

    #persistentEvent(event, fire, dispatch) {
      const { extension } = this;
      let currentFire = fire;
      const listener = (...args) => dispatch(currentFire, ...args);
      extension.on(event, listener);
      return {
        unregister() {
          extension.off(event, listener);
        },
        convert(newFire) {
          currentFire = newFire;
        },
      };
    }

    onManifestEntry() {
      this.keyword = this.extension.manifest.omnibox.keyword;
      try {
        DesktopExtensionOmnibox.register(this.keyword, this.extension);
      } catch (error) {
        this.extension.manifestError(error.message);
      }
    }

    onShutdown() {
      DesktopExtensionOmnibox.unregister(this.keyword, this.extension);
    }

    getAPI(context) {
      const extensionApi = this;
      return {
        omnibox: {
          setDefaultSuggestion: suggestion =>
            DesktopExtensionOmnibox.setDefaultSuggestion(
              this.keyword,
              this.extension,
              suggestion
            ),
          onInputStarted: new EventManager({
            context,
            module: "omnibox",
            event: "onInputStarted",
            extensionApi,
          }).api(),
          onInputCancelled: new EventManager({
            context,
            module: "omnibox",
            event: "onInputCancelled",
            extensionApi,
          }).api(),
          onInputEntered: new EventManager({
            context,
            module: "omnibox",
            event: "onInputEntered",
            extensionApi,
            inputHandling: true,
          }).api(),
          onInputChanged: new EventManager({
            context,
            module: "omnibox",
            event: "onInputChanged",
            extensionApi,
          }).api(),
          onDeleteSuggestion: new EventManager({
            context,
            module: "omnibox",
            event: "onDeleteSuggestion",
            extensionApi,
          }).api(),
          addSuggestions: (requestId, suggestions) => {
            DesktopExtensionOmnibox.addSuggestions(
              this.keyword,
              this.extension,
              requestId,
              suggestions
            );
          },
        },
      };
    }
  };
}
