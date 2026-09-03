/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError,
   ExtensionUtils, global */

  ChromeUtils.defineESModuleGetters(this, {
    DesktopExtensionMenus:
      "resource://gre/modules/DesktopExtensionMenus.sys.mjs",
    DesktopExtensionTabs: "resource://gre/modules/DesktopExtensionTabs.sys.mjs",
    ExtensionMenus: "resource://gre/modules/ExtensionMenus.sys.mjs",
  });

  const { parseMatchPatterns } = ExtensionUtils;
  let nextMenuItemId = 1;

  function boundedText(value, maximum = 512) {
    return typeof value === "string" ? value.slice(0, maximum) : "";
  }

  function applicableContexts(context) {
    const values = new Set();
    if (context.link) {
      values.add("link");
    }
    if (context.image) {
      values.add("image");
    }
    if (context.media === "audio" || context.media === "video") {
      values.add(context.media);
    }
    if (context.editable) {
      values.add(context.password ? "password" : "editable");
    }
    if (context.hasSelection) {
      values.add("selection");
    }
    if (!values.size) {
      values.add("page");
    }
    values.add("all");
    return values;
  }

  function sensitiveContext(extension, nativeTab, context) {
    if (extension.tabManager.hasActiveTabPermission(nativeTab)) {
      return true;
    }
    try {
      return extension.allowedOrigins.matches(context.pageUrl);
    } catch {
      return false;
    }
  }

  function eventInfo(context, includeSensitive) {
    const info = {
      editable: Boolean(context.editable),
      viewType: "tab",
    };
    if (context.media || context.image) {
      info.mediaType = context.media || "image";
    }
    if (includeSensitive) {
      if (context.link) {
        info.linkUrl = context.linkUrl;
      }
      if (context.image || context.media) {
        info.srcUrl = context.imageUrl || context.mediaUrl;
      }
      info.pageUrl = context.pageUrl;
      if (context.hasSelection) {
        info.selectionText = context.selectedText;
      }
    }
    return info;
  }

  class MenuItem {
    constructor(owner, properties) {
      this.owner = owner;
      this.id = properties.id ?? nextMenuItemId++;
      this.type = "normal";
      this.title = "";
      this.checked = false;
      this.contexts = ["page"];
      this.enabled = true;
      this.visible = true;
      this.parentId = undefined;
      this.command = undefined;
      this.viewTypes = undefined;
      this.documentUrlPatterns = undefined;
      this.targetUrlPatterns = undefined;
      this.setProperties(properties, true);
    }

    setProperties(properties, creating = false) {
      if (!creating && properties.id != null && properties.id !== this.id) {
        throw new ExtensionError("A menu item ID cannot be changed");
      }
      const previousParent = this.parentId;
      ExtensionMenus.mergeMenuProperties(this, properties);
      if (
        properties.parentId != null &&
        properties.contexts == null &&
        this.owner.items.get(properties.parentId)
      ) {
        this.contexts = this.owner.items.get(properties.parentId).contexts;
      }
      this.owner.validateParent(this.id, this.parentId);
      try {
        this.documentMatcher = this.documentUrlPatterns
          ? parseMatchPatterns(this.documentUrlPatterns, {
              restrictSchemes: this.owner.extension.restrictSchemes,
            })
          : null;
        this.targetMatcher = this.targetUrlPatterns
          ? parseMatchPatterns(this.targetUrlPatterns, {
              restrictSchemes: false,
            })
          : null;
      } catch (error) {
        this.parentId = previousParent;
        throw error;
      }
    }

    matches(context, contexts) {
      if (
        !this.visible ||
        !this.contexts.some(value => contexts.has(value)) ||
        (this.viewTypes && !this.viewTypes.includes("tab"))
      ) {
        return false;
      }
      try {
        if (
          this.documentMatcher &&
          !this.documentMatcher.matches(Services.io.newURI(context.pageUrl))
        ) {
          return false;
        }
        if (this.targetMatcher) {
          const targets = [context.linkUrl, context.imageUrl, context.mediaUrl]
            .filter(Boolean)
            .map(url => Services.io.newURI(url));
          if (!targets.some(uri => this.targetMatcher.matches(uri))) {
            return false;
          }
        }
      } catch {
        return false;
      }
      return true;
    }
  }

  this.menusInternal = class extends ExtensionAPIPersistent {
    #promiseInitialized = null;
    items = new Map();

    constructor(extension) {
      super(extension);
      this.extension = extension;
    }

    onStartup() {
      this.#promiseInitialized = this.#initialize();
      return this.#promiseInitialized;
    }

    async #initialize() {
      const { extension } = this;
      await ExtensionMenus.asyncInitForExtension(extension);
      if (
        !extension.hasShutdown &&
        ExtensionMenus.shouldPersistMenus(extension)
      ) {
        for (const properties of ExtensionMenus.getMenus(extension).values()) {
          this.#add(properties);
        }
      }
      if (!extension.hasShutdown) {
        DesktopExtensionMenus.register(extension, {
          project: (context, nativeTab) => this.#project(context, nativeTab),
          invoke: (itemId, context, nativeTab) =>
            this.#invoke(itemId, context, nativeTab),
          shown: (ids, context, nativeTab) =>
            this.emit("shown", ids, context, nativeTab),
          hidden: () => this.emit("hidden"),
        });
      }
    }

    onShutdown() {
      DesktopExtensionMenus.unregister(this.extension.id);
      this.items.clear();
    }

    PERSISTENT_EVENTS = {
      onClicked({ context, fire }) {
        const listener = async (_eventName, info, nativeTab) => {
          if (fire.wakeup) {
            await fire.wakeup();
          }
          if (!DesktopExtensionTabs.getById(nativeTab.id, null)) {
            return;
          }
          const tab = this.extension.tabManager.convert(nativeTab);
          context.withPendingBrowser(nativeTab.browser, () =>
            fire.sync(info, tab)
          );
        };
        this.on("clicked", listener);
        return {
          unregister: () => this.off("clicked", listener),
          convert(newFire, newContext) {
            fire = newFire;
            context = newContext;
          },
        };
      },

      onShown({ fire }) {
        const listener = (_eventName, ids, menuContext, nativeTab) => {
          const info = {
            ...eventInfo(
              menuContext,
              sensitiveContext(this.extension, nativeTab, menuContext)
            ),
            contexts: [...applicableContexts(menuContext)],
            menuIds: ids,
          };
          fire.sync(info, this.extension.tabManager.convert(nativeTab));
        };
        this.on("shown", listener);
        return {
          unregister: () => this.off("shown", listener),
          convert(newFire) {
            fire = newFire;
          },
        };
      },

      onHidden({ fire }) {
        const listener = () => fire.sync();
        this.on("hidden", listener);
        return {
          unregister: () => this.off("hidden", listener),
          convert(newFire) {
            fire = newFire;
          },
        };
      },
    };

    getAPI(context) {
      this.#promiseInitialized ??= this.#initialize();
      const events = {
        refresh: async () => {},
        onShown: new EventManager({
          context,
          module: "menusInternal",
          event: "onShown",
          name: "menus.onShown",
          extensionApi: this,
        }).api(),
        onHidden: new EventManager({
          context,
          module: "menusInternal",
          event: "onHidden",
          name: "menus.onHidden",
          extensionApi: this,
        }).api(),
      };
      return {
        contextMenus: events,
        menus: events,
        menusInternal: {
          create: async properties => {
            await this.#promiseInitialized;
            if (this.extension.hasShutdown) {
              return;
            }
            if (
              ExtensionMenus.shouldPersistMenus(this.extension) &&
              properties.id == null
            ) {
              throw new ExtensionError(
                "menus.create requires an ID for event backgrounds"
              );
            }
            const item = this.#add(properties);
            ExtensionMenus.addMenu(this.extension, {
              ...properties,
              id: item.id,
            });
          },
          update: async (id, properties) => {
            await this.#promiseInitialized;
            const item = this.#get(id);
            item.setProperties(properties);
            ExtensionMenus.updateMenu(this.extension, id, properties);
          },
          remove: async id => {
            await this.#promiseInitialized;
            const ids = this.#descendantIds(this.#get(id));
            for (const removeId of ids) {
              this.items.delete(removeId);
            }
            ExtensionMenus.deleteMenus(this.extension, ids);
          },
          removeAll: async () => {
            await this.#promiseInitialized;
            this.items.clear();
            ExtensionMenus.deleteAllMenus(this.extension);
          },
          onClicked: new EventManager({
            context,
            module: "menusInternal",
            event: "onClicked",
            name: "menus.onClicked",
            extensionApi: this,
          }).api(),
        },
      };
    }

    validateParent(itemId, parentId) {
      if (parentId == null) {
        return;
      }
      if (!this.items.has(parentId)) {
        throw new ExtensionError(`Cannot find parent menu item ${parentId}`);
      }
      const seen = new Set([itemId]);
      for (let current = this.items.get(parentId); current; ) {
        if (seen.has(current.id)) {
          throw new ExtensionError("A menu item cannot contain itself");
        }
        seen.add(current.id);
        current =
          current.parentId == null ? null : this.items.get(current.parentId);
      }
    }

    #add(properties) {
      const prospectiveId = properties.id ?? nextMenuItemId;
      if (this.items.has(prospectiveId)) {
        throw new ExtensionError(
          `Menu item ID already exists: ${prospectiveId}`
        );
      }
      const item = new MenuItem(this, properties);
      this.items.set(item.id, item);
      return item;
    }

    #get(id) {
      const item = this.items.get(id);
      if (!item) {
        throw new ExtensionError(`Cannot find menu item with ID ${id}`);
      }
      return item;
    }

    #children(parentId) {
      return [...this.items.values()].filter(
        item => item.parentId === parentId
      );
    }

    #descendantIds(item) {
      return [
        item.id,
        ...this.#children(item.id).flatMap(child => this.#descendantIds(child)),
      ];
    }

    #project(context) {
      const contexts = applicableContexts(context);
      const projectChildren = parentId =>
        this.#children(parentId)
          .filter(item => item.matches(context, contexts))
          .map(item => ({
            itemId: item.id,
            type: item.type,
            label: boundedText(
              item.title.replace(/%s/gu, () => context.selectedText.trim())
            ),
            enabled: item.enabled,
            checked: item.checked,
            children: projectChildren(item.id),
          }));
      return projectChildren(undefined);
    }

    #invoke(itemId, menuContext, nativeTab) {
      const item = this.#get(itemId);
      const wasChecked = item.checked;
      if (item.type === "checkbox") {
        item.checked = !item.checked;
      } else if (item.type === "radio") {
        for (const sibling of this.#children(item.parentId)) {
          if (sibling.type === "radio") {
            sibling.checked = false;
          }
        }
        item.checked = true;
      }

      this.extension.tabManager.addActiveTabPermission(nativeTab);
      const info = {
        ...eventInfo(menuContext, true),
        menuItemId: item.id,
        button: 0,
        modifiers: [],
      };
      if (item.parentId != null) {
        info.parentMenuItemId = item.parentId;
      }
      if (item.type === "checkbox" || item.type === "radio") {
        info.wasChecked = wasChecked;
        info.checked = item.checked;
      }

      const executeAction =
        item.command ===
        (this.extension.manifestVersion < 3
          ? "_execute_browser_action"
          : "_execute_action")
          ? global.browserActionFor
          : item.command === "_execute_page_action"
            ? global.pageActionFor
            : null;
      if (executeAction) {
        executeAction(this.extension)?.triggerAction(nativeTab.window);
        return;
      }
      this.emit("clicked", info, nativeTab);
    }
  };
}
