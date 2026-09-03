/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager as GeckoAddonManager } from "resource://gre/modules/AddonManager.sys.mjs";
import { DesktopExtensionCompatibility } from "resource://gre/modules/DesktopExtensionManager.sys.mjs";
import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";
import { ExtensionParent } from "resource://gre/modules/ExtensionParent.sys.mjs";

const OPTIONAL_PERMISSION_TOPIC = "webextension-optional-permission-prompt";
const BUILTIN_IDS_PREF = "extensions.applicationBuiltins.allowedIds";
const MAX_PERMISSION_COUNT = 128;
const MAX_PERMISSION_LENGTH = 2048;
const SUPPORTED_PERMISSIONS = new Set(
  DesktopExtensionCompatibility.supportedRequiredPermissions
);

function frozenStrings(value) {
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_COUNT) {
    return null;
  }
  const strings = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      !item ||
      item.length > MAX_PERMISSION_LENGTH
    ) {
      return null;
    }
    strings.push(item);
  }
  return Object.freeze([...new Set(strings)].sort());
}

function configuredBuiltInIds() {
  if (!Services.prefs.prefIsLocked(BUILTIN_IDS_PREF)) {
    return new Set();
  }
  return new Set(
    Services.prefs
      .getStringPref(BUILTIN_IDS_PREF, "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function isManagedAddon(addon) {
  if (!addon?.isActive || addon.type !== "extension") {
    return false;
  }
  if (
    !Number.isInteger(addon.signedState) ||
    addon.signedState < GeckoAddonManager.SIGNEDSTATE_SIGNED
  ) {
    return false;
  }
  if (addon.scope === GeckoAddonManager.SCOPE_PROFILE) {
    return !addon.foreignInstall;
  }
  return (
    addon.scope === GeckoAddonManager.SCOPE_APPLICATION &&
    configuredBuiltInIds().has(addon.id)
  );
}

function isNavisWindow(ownerWindow) {
  return Boolean(
    ownerWindow &&
    !ownerWindow.closed &&
    ownerWindow.document?.documentElement?.getAttribute("windowtype") ===
      "navis:browser"
  );
}

function nativeTabForBrowser(browser) {
  if (!browser?.isConnected) {
    return null;
  }
  const exactTab = DesktopExtensionTabs.getForBrowser(browser);
  if (exactTab) {
    return exactTab;
  }
  if (browser.getAttribute?.("webextension-view-type") !== "popup") {
    return null;
  }
  const ownerWindow =
    browser.ownerGlobal ||
    browser.documentGlobal ||
    browser.browsingContext?.topChromeWindow;
  return isNavisWindow(ownerWindow)
    ? DesktopExtensionTabs.activeTabForWindow(ownerWindow)
    : null;
}

function projectRequest(extension, permissions) {
  const apiPermissions = frozenStrings(permissions?.permissions);
  const origins = frozenStrings(permissions?.origins);
  const dataCollection = frozenStrings(permissions?.data_collection || []);
  if (
    !apiPermissions ||
    !origins ||
    !dataCollection ||
    dataCollection.length ||
    (!apiPermissions.length && !origins.length) ||
    apiPermissions.some(permission => !SUPPORTED_PERMISSIONS.has(permission))
  ) {
    return null;
  }
  return Object.freeze({
    extensionId: extension.id.slice(0, 256),
    extensionName: extension.name.slice(0, 256),
    permissions: apiPermissions,
    origins,
  });
}

/**
 * Routes Gecko's process-wide optional-permission observer into the owning
 * Runtime without exposing Extension, AddonManager or browser objects.
 */
class DesktopExtensionPermissionPromptRegistry {
  #runtimeHandlers = new Map();

  registerRuntime(runtime, handler) {
    if (!runtime || typeof handler !== "function") {
      throw new TypeError(
        "An extension permission Runtime handler is required"
      );
    }
    const first = this.#runtimeHandlers.size === 0;
    this.#runtimeHandlers.set(runtime, handler);
    if (first) {
      Services.obs.addObserver(this, OPTIONAL_PERMISSION_TOPIC);
    }
  }

  unregisterRuntime(runtime) {
    if (!this.#runtimeHandlers.delete(runtime)) {
      return false;
    }
    if (!this.#runtimeHandlers.size) {
      Services.obs.removeObserver(this, OPTIONAL_PERMISSION_TOPIC);
    }
    return true;
  }

  observe(subject, topic) {
    if (topic !== OPTIONAL_PERMISSION_TOPIC) {
      return;
    }
    const details = subject?.wrappedJSObject;
    const resolve = details?.resolve;
    if (typeof resolve !== "function") {
      return;
    }
    let settled = false;
    const finish = allowed => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(allowed === true);
    };
    Promise.resolve(this.#route(details)).then(finish, error => {
      console.error("Navis rejected an extension permission request", error);
      finish(false);
    });
  }

  async #route(details) {
    if (
      typeof details.id !== "string" ||
      !details.id ||
      details.id.length > 256
    ) {
      return false;
    }
    const extension = ExtensionParent.GlobalManager.getExtension(details.id);
    const addon = await GeckoAddonManager.getAddonByID(details.id);
    if (!extension || extension.id !== addon?.id || !isManagedAddon(addon)) {
      return false;
    }
    const request = projectRequest(extension, details.permissions);
    const nativeTab = nativeTabForBrowser(details.browser);
    if (
      !request ||
      !nativeTab ||
      nativeTab.session.state.closed ||
      nativeTab.session.state.crashed ||
      (nativeTab.session.state.private && !extension.privateBrowsingAllowed)
    ) {
      return false;
    }
    const handler = this.#runtimeHandlers.get(nativeTab.runtime);
    if (!handler) {
      return false;
    }
    return (await handler(nativeTab, request)) === true;
  }
}

export const DesktopExtensionPermissionPrompts =
  new DesktopExtensionPermissionPromptRegistry();
