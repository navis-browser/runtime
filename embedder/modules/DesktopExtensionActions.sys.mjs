/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "resource://gre/modules/EventEmitter.sys.mjs";
import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";
import { ExtensionParent } from "resource://gre/modules/ExtensionParent.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const PINNED_ACTIONS_PREF = "navis.extensions.toolbar.pinned";
const MAX_PINNED_ACTIONS = 128;

function boundedText(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function frozenColor(value, fallback) {
  if (!Array.isArray(value) || value.length !== 4) {
    return Object.freeze([...fallback]);
  }
  return Object.freeze(
    value.map(channel =>
      Number.isFinite(channel)
        ? Math.min(255, Math.max(0, Math.round(channel)))
        : 0
    )
  );
}

function preferredIcon(extension, values) {
  let icon = "";
  try {
    icon = ExtensionParent.IconDetails.getPreferredIcon(
      values.icon || extension.manifest.icons || {},
      extension,
      32
    ).icon;
  } catch {}
  if (typeof icon !== "string" || icon.length > 512 * 1024) {
    return "";
  }
  if (icon.startsWith(extension.baseURI.spec)) {
    return icon;
  }
  if (/^data:image\/(?:png|gif|jpeg|webp|svg\+xml);base64,/i.test(icon)) {
    return icon;
  }
  return "";
}

/** Projects extension action state without exposing Gecko action objects. */
class DesktopExtensionActionRegistry extends EventEmitter {
  #actions = new Map();
  #pageActions = new Map();
  #popupWindows = new WeakSet();

  register(extension, action) {
    this.#actions.set(extension.id, { extension, action });
    this.notify(extension.id, null);
  }

  unregister(extensionId) {
    if (this.#actions.delete(extensionId)) {
      this.emit("action-removed", { extensionId });
    }
  }

  registerPageAction(extension, action) {
    this.#pageActions.set(extension.id, { extension, action });
    this.notifyPageAction(extension.id, null);
  }

  unregisterPageAction(extensionId) {
    if (this.#pageActions.delete(extensionId)) {
      this.emit("page-action-removed", { extensionId });
    }
  }

  notifyPageAction(extensionId, nativeTab) {
    if (!this.#pageActions.has(extensionId)) {
      return;
    }
    this.emit("page-action-changed", {
      extensionId,
      tabId: nativeTab?.id ?? null,
    });
  }

  notify(extensionId, nativeTab) {
    const snapshot = this.snapshot(extensionId, nativeTab);
    if (snapshot) {
      this.emit("action-changed", snapshot);
    }
  }

  snapshot(extensionId, nativeTab = DesktopExtensionTabs.activeTab) {
    const entry = this.#actions.get(extensionId);
    if (!entry) {
      return null;
    }
    if (
      nativeTab &&
      PrivateBrowsingUtils.isBrowserPrivate(nativeTab.browser) &&
      !entry.extension.privateBrowsingAllowed
    ) {
      return null;
    }
    const values = entry.action.getContextData(nativeTab || null);
    const badgeBackgroundColor = frozenColor(
      values.badgeBackgroundColor,
      [217, 0, 0, 255]
    );
    let badgeTextColor;
    try {
      badgeTextColor = entry.action.getTextColor(values);
    } catch {
      badgeTextColor = [255, 255, 255, 255];
    }
    return Object.freeze({
      extensionId,
      name: boundedText(entry.extension.name, 256),
      version: boundedText(entry.extension.version, 128),
      tabId: nativeTab?.id ?? null,
      enabled: values.enabled !== false,
      title: boundedText(values.title || entry.extension.name, 512),
      icon: preferredIcon(entry.extension, values),
      badgeText: boundedText(values.badgeText, 64),
      badgeBackgroundColor,
      badgeTextColor: frozenColor(badgeTextColor, [255, 255, 255, 255]),
      hasPopup: Boolean(values.popup),
      toolbarPinned: this.isPinned(extensionId),
    });
  }

  snapshots(nativeTab = DesktopExtensionTabs.activeTab) {
    return Object.freeze(
      [...this.#actions]
        .map(([extensionId]) => this.snapshot(extensionId, nativeTab))
        .filter(Boolean)
        .sort(
          (left, right) =>
            Number(right.toolbarPinned) - Number(left.toolbarPinned) ||
            left.name.localeCompare(right.name) ||
            left.extensionId.localeCompare(right.extensionId)
        )
    );
  }

  pageSnapshot(extensionId, nativeTab = DesktopExtensionTabs.activeTab) {
    const entry = this.#pageActions.get(extensionId);
    if (!entry || !nativeTab) {
      return null;
    }
    if (
      PrivateBrowsingUtils.isBrowserPrivate(nativeTab.browser) &&
      !entry.extension.privateBrowsingAllowed
    ) {
      return null;
    }
    if (!entry.action.isShownForTab(nativeTab)) {
      return null;
    }
    const values = entry.action.getContextData(nativeTab);
    return Object.freeze({
      extensionId,
      name: boundedText(entry.extension.name, 256),
      version: boundedText(entry.extension.version, 128),
      tabId: nativeTab.id,
      enabled: true,
      title: boundedText(values.title || entry.extension.name, 512),
      icon: preferredIcon(entry.extension, values),
      hasPopup: Boolean(values.popup),
    });
  }

  pageSnapshots(nativeTab = DesktopExtensionTabs.activeTab) {
    return Object.freeze(
      [...this.#pageActions]
        .map(([extensionId]) => this.pageSnapshot(extensionId, nativeTab))
        .filter(Boolean)
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.extensionId.localeCompare(right.extensionId)
        )
    );
  }

  has(extensionId) {
    return this.#actions.has(extensionId);
  }

  getExtension(extensionId) {
    return (
      this.#actions.get(extensionId)?.extension ||
      this.#pageActions.get(extensionId)?.extension ||
      null
    );
  }

  runtimeState(extensionId) {
    const extension = this.getExtension(extensionId);
    if (!extension) {
      return Object.freeze({
        available: false,
        ready: false,
        state: "unavailable",
        errors: Object.freeze([]),
      });
    }
    const registered =
      ExtensionParent.GlobalManager.getExtension(extensionId) === extension;
    return Object.freeze({
      available: true,
      ready: Boolean(
        registered && extension.policy?.active && !extension.hasShutdown
      ),
      state: boundedText(extension.state, 1024),
      errors: Object.freeze(
        (extension.errors || [])
          .filter(value => typeof value === "string")
          .map(value => boundedText(value, 1024))
          .slice(0, 16)
      ),
    });
  }

  isPinned(extensionId) {
    return this.#readPinned().has(extensionId);
  }

  setPinned(extensionId, pinned) {
    if (!this.#actions.has(extensionId)) {
      throw new Error("The extension has no active toolbar action");
    }
    if (typeof pinned !== "boolean") {
      throw new TypeError("The extension toolbar state must be boolean");
    }
    const pinnedIds = this.#readPinned();
    if (pinned) {
      if (pinnedIds.size >= MAX_PINNED_ACTIONS && !pinnedIds.has(extensionId)) {
        throw new Error("The extension toolbar pin limit was reached");
      }
      pinnedIds.add(extensionId);
    } else {
      pinnedIds.delete(extensionId);
    }
    this.#writePinned(pinnedIds);
    this.notify(extensionId, null);
    return pinned;
  }

  forgetPinned(extensionId) {
    const pinnedIds = this.#readPinned();
    if (!pinnedIds.delete(extensionId)) {
      return false;
    }
    this.#writePinned(pinnedIds);
    return true;
  }

  trigger(extensionId, nativeTab = DesktopExtensionTabs.activeTab) {
    const entry = this.#actions.get(extensionId);
    if (
      !entry ||
      !nativeTab ||
      !this.snapshot(extensionId, nativeTab)?.enabled
    ) {
      return null;
    }
    const popup = entry.action.triggerClickOrPopup(nativeTab) || "";
    this.#assertPopup(entry, popup);
    return Object.freeze({
      extensionId,
      popup,
      nativeTab,
      browserStyle: Boolean(entry.action.browserStyle),
    });
  }

  triggerPageAction(
    extensionId,
    nativeTab = DesktopExtensionTabs.activeTab,
    clickInfo = undefined
  ) {
    const entry = this.#pageActions.get(extensionId);
    if (!entry || !this.pageSnapshot(extensionId, nativeTab)) {
      return null;
    }
    const popup = entry.action.triggerClickOrPopup(nativeTab, clickInfo) || "";
    this.#assertPopup(entry, popup);
    return Object.freeze({
      extensionId,
      popup,
      nativeTab,
      browserStyle: Boolean(entry.action.browserStyle),
    });
  }

  requestPopup(extensionId, popup, nativeTab) {
    const entry =
      this.#actions.get(extensionId) || this.#pageActions.get(extensionId);
    if (
      !entry ||
      !nativeTab ||
      !(
        this.snapshot(extensionId, nativeTab)?.enabled ||
        this.pageSnapshot(extensionId, nativeTab)?.enabled
      )
    ) {
      return false;
    }
    this.#assertPopup(entry, popup);
    this.emit("popup-requested", {
      extensionId,
      popup,
      nativeTab,
      browserStyle: Boolean(entry.action.browserStyle),
    });
    return true;
  }

  setPopupOpen(window, open) {
    if (open) {
      this.#popupWindows.add(window);
    } else {
      this.#popupWindows.delete(window);
    }
  }

  isPopupOpen(window) {
    return this.#popupWindows.has(window);
  }

  #assertPopup(entry, popup) {
    if (popup && !popup.startsWith(entry.extension.baseURI.spec)) {
      throw new Error("Extension action popup must belong to its extension");
    }
  }

  #readPinned() {
    let values = [];
    try {
      values = JSON.parse(
        Services.prefs.getStringPref(PINNED_ACTIONS_PREF, "[]")
      );
    } catch {}
    if (!Array.isArray(values)) {
      return new Set();
    }
    return new Set(
      values
        .filter(value => typeof value === "string" && value.length <= 256)
        .slice(0, MAX_PINNED_ACTIONS)
    );
  }

  #writePinned(values) {
    Services.prefs.setStringPref(
      PINNED_ACTIONS_PREF,
      JSON.stringify([...values].sort())
    );
  }
}

export const DesktopExtensionActions = new DesktopExtensionActionRegistry();
