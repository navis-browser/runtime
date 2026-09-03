/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const MAX_ACTIVE_REQUESTS = 64;
const MAX_EXTENSION_GROUPS = 64;
const MAX_ITEMS_PER_EXTENSION = 128;
const MAX_DEPTH = 8;

function boundedText(value, maximum = 256) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function freezeItem(item) {
  return Object.freeze({
    id: item.id,
    group: item.group,
    label: item.label,
    enabled: item.enabled,
    type: item.type,
    checked: item.checked,
    children: Object.freeze(item.children.map(freezeItem)),
  });
}

/**
 * Binds extension-owned menu state to short-lived opaque Platform commands.
 * Extension objects and callbacks never cross the Engine delegate boundary.
 */
class DesktopExtensionMenuRegistry {
  #adapters = new Map();
  #requests = new Map();
  #nextRequestId = 1;
  #nextCommandId = 1;

  register(extension, adapter) {
    if (
      !extension?.id ||
      !adapter ||
      typeof adapter.project !== "function" ||
      typeof adapter.invoke !== "function"
    ) {
      throw new TypeError("An extension menu adapter is incomplete");
    }
    this.unregister(extension.id);
    this.#adapters.set(extension.id, { extension, adapter });
  }

  unregister(extensionId) {
    const entry = this.#adapters.get(extensionId);
    if (!entry) {
      return false;
    }
    this.#adapters.delete(extensionId);
    for (const [requestId, request] of [...this.#requests]) {
      if (request.adapters.has(entry)) {
        this.#finishRequest(requestId, request);
      }
    }
    return true;
  }

  open(nativeTab, context) {
    const requestId = `extension-menu-request-${this.#nextRequestId++}`;
    const commands = new Map();
    const adapters = new Set();
    const items = [];
    const entries = [...this.#adapters.values()]
      .filter(
        ({ extension }) =>
          extension.privateBrowsingAllowed ||
          !PrivateBrowsingUtils.isBrowserPrivate(nativeTab.browser)
      )
      .sort(
        (left, right) =>
          left.extension.name.localeCompare(right.extension.name) ||
          left.extension.id.localeCompare(right.extension.id)
      )
      .slice(0, MAX_EXTENSION_GROUPS);

    for (const entry of entries) {
      let projected;
      try {
        projected = entry.adapter
          .project(context, nativeTab)
          .slice(0, MAX_ITEMS_PER_EXTENSION);
      } catch (error) {
        console.error("Extension menu projection failed", error);
        continue;
      }
      if (!projected.length) {
        continue;
      }
      adapters.add(entry);
      const bound = projected.map(item =>
        this.#bindItem(
          entry,
          item,
          context,
          nativeTab,
          commands,
          0,
          `extension:${entry.extension.id}`
        )
      );
      if (bound.length === 1) {
        items.push(bound[0]);
      } else {
        items.push({
          id: `extension-menu-group-${this.#nextCommandId++}`,
          group: `extension:${entry.extension.id}`,
          label: boundedText(entry.extension.name),
          enabled: true,
          type: "normal",
          checked: false,
          children: bound,
        });
      }
      try {
        entry.adapter.shown?.(
          projected.flatMap(item => this.#projectedIds(item)),
          context,
          nativeTab
        );
      } catch (error) {
        console.error("Extension menu onShown dispatch failed", error);
      }
    }

    if (adapters.size) {
      while (this.#requests.size >= MAX_ACTIVE_REQUESTS) {
        const oldest = this.#requests.entries().next().value;
        if (!oldest) {
          break;
        }
        this.#finishRequest(oldest[0], oldest[1]);
      }
      this.#requests.set(requestId, {
        commands,
        adapters,
      });
    }
    return Object.freeze({
      requestId: adapters.size ? requestId : null,
      items: Object.freeze(items.map(freezeItem)),
    });
  }

  execute(requestId, commandId) {
    const request = this.#requests.get(requestId);
    const command = request?.commands.get(commandId);
    if (!request || !command) {
      return false;
    }
    this.#requests.delete(requestId);
    try {
      Promise.resolve(
        command.entry.adapter.invoke(
          command.itemId,
          command.context,
          command.nativeTab
        )
      ).catch(error => console.error("Extension menu command failed", error));
    } catch (error) {
      console.error("Extension menu command failed", error);
    }
    this.#notifyHidden(request);
    return true;
  }

  dismiss(requestId) {
    const request = this.#requests.get(requestId);
    if (!request) {
      return false;
    }
    return this.#finishRequest(requestId, request);
  }

  #bindItem(entry, item, context, nativeTab, commands, depth, group) {
    if (depth > MAX_DEPTH) {
      throw new Error("Extension menu nesting exceeds the Navis limit");
    }
    const type = ["normal", "checkbox", "radio", "separator"].includes(
      item.type
    )
      ? item.type
      : "normal";
    const children = Array.isArray(item.children)
      ? item.children
          .slice(0, MAX_ITEMS_PER_EXTENSION)
          .map(child =>
            this.#bindItem(
              entry,
              child,
              context,
              nativeTab,
              commands,
              depth + 1,
              group
            )
          )
      : [];
    const commandId = `extension-menu-command-${this.#nextCommandId++}`;
    if (type !== "separator" && !children.length) {
      commands.set(commandId, {
        entry,
        itemId: item.itemId,
        context,
        nativeTab,
      });
    }
    return {
      id: commandId,
      group,
      label: boundedText(item.label),
      enabled: type !== "separator" && item.enabled !== false,
      type,
      checked: Boolean(item.checked),
      children,
    };
  }

  #projectedIds(item) {
    return [
      item.itemId,
      ...(Array.isArray(item.children)
        ? item.children.flatMap(child => this.#projectedIds(child))
        : []),
    ];
  }

  #finishRequest(requestId, request) {
    this.#requests.delete(requestId);
    this.#notifyHidden(request);
    return true;
  }

  #notifyHidden(request) {
    for (const entry of request.adapters) {
      try {
        entry.adapter.hidden?.();
      } catch (error) {
        console.error("Extension menu onHidden dispatch failed", error);
      }
    }
  }
}

export const DesktopExtensionMenus = new DesktopExtensionMenuRegistry();
