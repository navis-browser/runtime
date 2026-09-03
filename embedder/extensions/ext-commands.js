/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError, tabTracker,
   windowTracker */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    ExtensionShortcuts: "resource://gre/modules/ExtensionShortcuts.sys.mjs",
  });

  this.commands = class extends ExtensionAPIPersistent {
    PERSISTENT_EVENTS = {
      onCommand({ fire }) {
        const { tabManager } = this.extension;
        const listener = async (_eventName, commandName) => {
          const nativeTab = tabTracker.activeTab;
          let converted;
          if (nativeTab && tabManager.canAccessTab(nativeTab)) {
            tabManager.addActiveTabPermission(nativeTab);
            converted = tabManager.convert(nativeTab);
          }
          if (fire.wakeup) {
            await fire.wakeup();
          }
          fire.async(commandName, converted);
        };
        this.on("command", listener);
        return {
          unregister: () => this.off("command", listener),
          convert(newFire) {
            fire = newFire;
          },
        };
      },

      onChanged({ fire }) {
        const listener = (_eventName, changeInfo) => fire.async(changeInfo);
        this.on("shortcutChanged", listener);
        return {
          unregister: () => this.off("shortcutChanged", listener),
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    static onUninstall(extensionId) {
      return ExtensionShortcuts.removeCommandsFromStorage(extensionId);
    }

    async onManifestEntry() {
      if ("_execute_sidebar_action" in this.extension.manifest.commands) {
        throw new ExtensionError(
          "Navis 1.0 does not provide extension sidebar commands"
        );
      }
      const shortcuts = new ExtensionShortcuts({
        extension: this.extension,
        onCommand: name => this.emit("command", name),
        onShortcutChanged: changeInfo =>
          this.emit("shortcutChanged", changeInfo),
      });
      this.extension.shortcuts = shortcuts;
      await shortcuts.loadCommands();
      await shortcuts.register();
    }

    onShutdown() {
      this.extension.shortcuts?.unregister();
    }

    getAPI(context) {
      return {
        commands: {
          getAll: () => this.extension.shortcuts.allCommands(),
          update: args => this.extension.shortcuts.updateCommand(args),
          reset: name => this.extension.shortcuts.resetCommand(name),
          openShortcutSettings: () => {
            const window = windowTracker.topWindow;
            if (!window) {
              throw new ExtensionError("Navis has no browser window");
            }
            DesktopExtensionTabs.createTab(
              window,
              "navis://extensions/",
              true,
              Services.scriptSecurityManager.getSystemPrincipal()
            );
          },
          onCommand: new EventManager({
            context,
            module: "commands",
            event: "onCommand",
            inputHandling: true,
            extensionApi: this,
          }).api(),
          onChanged: new EventManager({
            context,
            module: "commands",
            event: "onChanged",
            extensionApi: this,
          }).api(),
        },
      };
    }
  };
}
