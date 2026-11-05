/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager as GeckoAddonManager } from "resource://gre/modules/AddonManager.sys.mjs";
import { DesktopExtensionActions } from "resource://gre/modules/DesktopExtensionActions.sys.mjs";
import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";
import { ExtensionParent } from "resource://gre/modules/ExtensionParent.sys.mjs";
import { ExtensionPermissions } from "resource://gre/modules/ExtensionPermissions.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { getDesktopLocaleState } from "resource://gre/modules/DesktopLocale.sys.mjs";

const BUILTIN_IDS_PREF = "extensions.applicationBuiltins.allowedIds";
const PRIVATE_PERMISSION = "internal:privateBrowsingAllowed";
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PREVIEW_LIFETIME_MS = 5 * 60 * 1000;

const FILE_PICKER_TEXT = Object.freeze({
  "en-US": Object.freeze({
    title: "Install an extension package",
    filter: "Navis extension package (*.xpi)",
  }),
  "zh-CN": Object.freeze({
    title: "安装扩展程序包",
    filter: "Navis 扩展程序包 (*.xpi)",
  }),
});

// The accepted 1.0 compatibility profile includes only APIs with a retained
// Toolkit backend or an explicit Navis adapter. Required declarations outside
// this set fail closed before installation.
const SUPPORTED_REQUIRED_PERMISSIONS = new Set([
  "activeTab",
  "alarms",
  "browserSettings",
  "bookmarks",
  "browsingData",
  "clipboardRead",
  "clipboardWrite",
  "contextMenus",
  "cookies",
  "declarativeNetRequest",
  "declarativeNetRequestFeedback",
  "dns",
  "downloads",
  "downloads.open",
  "find",
  "history",
  "idle",
  "management",
  "menus",
  "notifications",
  "permissions",
  "privacy",
  "proxy",
  "search",
  "sessions",
  "scripting",
  "storage",
  "tabs",
  "topSites",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
]);

const FORBIDDEN_PERMISSIONS = new Set([
  "activityLog",
  "contextualIdentities",
  "debugger",
  "geckoProfiler",
  "geckoViewAddons",
  "mozillaAddons",
  "nativeMessaging",
  "nativeMessagingFromContent",
  "networkStatus",
  "normandyAddonStudy",
  "pkcs11",
  "tabHide",
  "telemetry",
  "urlbar",
]);

const UNSUPPORTED_MANIFEST_KEYS = new Set([
  "chrome_settings_overrides",
  "chrome_url_overrides",
  "devtools_page",
  "experiment_apis",
  "protocol_handlers",
  "sidebar_action",
  "theme",
  "theme_experiment",
]);

function frozenStrings(values = []) {
  return Object.freeze(
    [...new Set(values.filter(value => typeof value === "string"))].sort()
  );
}

function boundedString(value, maximum = 4096) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function safeAddonIcon(addon) {
  const icon = boundedString(addon.iconURL, 512 * 1024);
  if (
    /^moz-extension:\/\/[0-9a-f-]+\//iu.test(icon) ||
    /^data:image\/(?:avif|gif|jpeg|png|svg\+xml|webp);base64,/iu.test(icon)
  ) {
    return icon;
  }
  return "";
}

function configuredBuiltInIds() {
  if (!Services.prefs.prefIsLocked(BUILTIN_IDS_PREF)) {
    throw new Error("The application extension registry is not immutable");
  }
  return new Set(
    Services.prefs
      .getStringPref(BUILTIN_IDS_PREF, "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean)
  );
}

function isHostPermission(permission) {
  return (
    permission === "<all_urls>" ||
    permission.startsWith("http://") ||
    permission.startsWith("https://") ||
    permission.startsWith("*://")
  );
}

function classifyRequiredPermissions(manifest) {
  const declared = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter(value => typeof value === "string")
    : [];
  const mv3Hosts = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions.filter(value => typeof value === "string")
    : [];
  const apiPermissions = declared.filter(
    permission => !isHostPermission(permission)
  );
  const hostPermissions = [...declared.filter(isHostPermission), ...mv3Hosts];
  const forbidden = apiPermissions.filter(
    permission =>
      permission.startsWith("internal:") ||
      FORBIDDEN_PERMISSIONS.has(permission)
  );
  const unsupported = apiPermissions.filter(
    permission =>
      !permission.startsWith("internal:") &&
      !FORBIDDEN_PERMISSIONS.has(permission) &&
      !SUPPORTED_REQUIRED_PERMISSIONS.has(permission)
  );
  return Object.freeze({
    apiPermissions: frozenStrings(apiPermissions),
    hostPermissions: frozenStrings(hostPermissions),
    forbidden: frozenStrings(forbidden),
    unsupported: frozenStrings(unsupported),
  });
}

function classifyOptionalPermissions(manifest) {
  const declared = Array.isArray(manifest.optional_permissions)
    ? manifest.optional_permissions.filter(value => typeof value === "string")
    : [];
  const mv3Hosts = Array.isArray(manifest.optional_host_permissions)
    ? manifest.optional_host_permissions.filter(
        value => typeof value === "string"
      )
    : [];
  return Object.freeze({
    apiPermissions: frozenStrings(
      declared.filter(permission => !isHostPermission(permission))
    ),
    hostPermissions: frozenStrings([
      ...declared.filter(isHostPermission),
      ...mv3Hosts,
    ]),
    unsupported: frozenStrings(
      declared.filter(
        permission =>
          !isHostPermission(permission) &&
          !SUPPORTED_REQUIRED_PERMISSIONS.has(permission)
      )
    ),
  });
}

function readPackageManifest(file) {
  if (!file?.isFile() || !file.leafName.toLowerCase().endsWith(".xpi")) {
    throw new Error("Only a local XPI package can be installed");
  }
  if (file.fileSize <= 0 || file.fileSize > MAX_PACKAGE_BYTES) {
    throw new Error("The extension package size is outside the accepted range");
  }
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader
  );
  reader.open(file);
  try {
    reader.test(null);
    if (!reader.hasEntry("manifest.json")) {
      throw new Error("The extension package has no manifest.json");
    }
    const entry = reader.getEntry("manifest.json");
    if (
      entry.isDirectory ||
      entry.realSize <= 0 ||
      entry.realSize > MAX_MANIFEST_BYTES
    ) {
      throw new Error(
        "The extension manifest size is outside the accepted range"
      );
    }
    const stream = reader.getInputStream("manifest.json");
    try {
      const source = NetUtil.readInputStreamToString(stream, entry.realSize, {
        charset: "UTF-8",
        replacement: Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER,
      });
      const manifest = JSON.parse(source);
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
      ) {
        throw new Error("The extension manifest is not an object");
      }
      return manifest;
    } finally {
      stream.close();
    }
  } finally {
    reader.close();
  }
}

function compatibilityForManifest(manifest) {
  const required = classifyRequiredPermissions(manifest);
  const optional = classifyOptionalPermissions(manifest);
  const manifestKeys = frozenStrings(
    Object.keys(manifest).filter(key => UNSUPPORTED_MANIFEST_KEYS.has(key))
  );
  const unsupportedCommands = frozenStrings(
    manifest.commands && typeof manifest.commands === "object"
      ? Object.keys(manifest.commands).filter(
          command => command === "_execute_sidebar_action"
        )
      : []
  );
  const issues = frozenStrings([
    ...required.forbidden.map(value => `forbidden-permission:${value}`),
    ...required.unsupported.map(value => `unsupported-permission:${value}`),
    ...manifestKeys.map(value => `unsupported-manifest:${value}`),
    ...unsupportedCommands.map(value => `unsupported-command:${value}`),
  ]);
  return Object.freeze({
    compatible: issues.length === 0,
    issues,
    requiredPermissions: required.apiPermissions,
    requiredOrigins: required.hostPermissions,
    optionalPermissions: optional.apiPermissions,
    optionalOrigins: optional.hostPermissions,
    unsupportedOptionalPermissions: optional.unsupported,
  });
}

function installError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function publicError(error) {
  return Object.freeze({
    code: boundedString(error?.code || "invalid-package", 80),
    message: boundedString(
      error?.message || "The extension operation failed",
      512
    ),
  });
}

/**
 *
 */
export class DesktopExtensionManager {
  #pending = new Map();
  #closed = false;

  async initialize() {
    this.#assertOpen();
    configuredBuiltInIds();
    // AddonManager's public startup promise resolves after every provider has
    // synchronously registered its active add-ons.  DesktopEngine emits the
    // separate extensions-late-startup browser-lifecycle signal only after a
    // real Navis session has been activated; sending it here can race the XPI
    // provider and create remote extension documents backed by stub policies.
    await GeckoAddonManager.readyPromise;

    const extensions = await GeckoAddonManager.getAddonsByTypes([
      "extension",
    ]);
    // AddonManager.readyPromise covers synchronous provider registration, not
    // the per-addon bootstrap promises queued by XPIProvider. In Firefox the
    // full browser startup naturally gives those promises time to install the
    // real parent policy before SessionStore releases delayed backgrounds.
    // Navis has a much shorter startup path, so make that ordering explicit.
    await Promise.allSettled(
      extensions
        .filter(addon => addon.isActive && addon.startupPromise)
        .map(addon => addon.startupPromise)
    );

    // A profile created by an older candidate may already contain an extension
    // discovered through directory side-loading. Keep its bytes intact but
    // fail closed until the user deliberately installs it through this manager.
    for (const addon of extensions) {
      if (
        addon.scope === GeckoAddonManager.SCOPE_PROFILE &&
        addon.foreignInstall &&
        addon.isActive &&
        addon.permissions & GeckoAddonManager.PERM_CAN_DISABLE
      ) {
        await addon.disable();
      }
    }
  }

  async snapshot() {
    this.#assertOpen();
    const builtInIds = configuredBuiltInIds();
    const records = [];
    for (const addon of await GeckoAddonManager.getAddonsByTypes([
      "extension",
    ])) {
      const builtIn =
        addon.scope === GeckoAddonManager.SCOPE_APPLICATION &&
        builtInIds.has(addon.id);
      const user = addon.scope === GeckoAddonManager.SCOPE_PROFILE;
      if (!builtIn && !user) {
        continue;
      }
      records.push(await this.#projectAddon(addon, builtIn));
    }
    records.sort(
      (left, right) =>
        Number(right.builtIn) - Number(left.builtIn) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    );
    return Object.freeze(records);
  }

  async selectPackage(ownerWindow) {
    this.#assertOpen();
    this.#assertOwnerWindow(ownerWindow);
    this.#cancelPending();
    const locale = getDesktopLocaleState().active;
    const text = FILE_PICKER_TEXT[locale] || FILE_PICKER_TEXT["en-US"];
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      ownerWindow.browsingContext,
      text.title,
      Ci.nsIFilePicker.modeOpen
    );
    picker.appendFilter(text.filter, "*.xpi");
    const result = await new Promise(resolve => picker.open(resolve));
    if (result !== Ci.nsIFilePicker.returnOK || !picker.file) {
      return Object.freeze({ outcome: "cancelled", preview: null });
    }
    try {
      const preview = await this.#createPreview(picker.file.clone());
      return Object.freeze({ outcome: "preview", preview });
    } catch (error) {
      return Object.freeze({
        outcome: "rejected",
        preview: null,
        error: publicError(error),
      });
    }
  }

  async confirmInstall(token) {
    this.#assertOpen();
    const pending = this.#takePending(token);
    if (!pending.compatibility.compatible) {
      pending.install.cancel();
      throw installError(
        "The package requires capabilities outside the Navis profile",
        "unsupported-capability"
      );
    }
    try {
      const addon = await pending.install.install();
      if (
        !addon ||
        addon.id !== pending.id ||
        addon.scope !== GeckoAddonManager.SCOPE_PROFILE ||
        addon.foreignInstall
      ) {
        throw installError(
          "AddonManager did not commit a managed profile extension",
          "install-commit-failed"
        );
      }
      return Object.freeze({
        outcome: pending.existingVersion ? "updated" : "installed",
        extension: await this.#projectAddon(addon, false),
      });
    } catch (error) {
      try {
        pending.install.cancel();
      } catch {}
      throw error;
    }
  }

  cancelInstall(token) {
    this.#assertOpen();
    const pending = this.#takePending(token);
    try {
      pending.install.cancel();
    } catch {}
    return true;
  }

  async setEnabled(id, enabled) {
    this.#assertOpen();
    if (typeof enabled !== "boolean") {
      throw new TypeError("The extension enabled state must be boolean");
    }
    const { addon, builtIn } = await this.#managedAddon(id);
    const requiredPermission = enabled
      ? GeckoAddonManager.PERM_CAN_ENABLE
      : GeckoAddonManager.PERM_CAN_DISABLE;
    if (!(addon.permissions & requiredPermission)) {
      throw installError(
        "The extension enabled state cannot be changed",
        "immutable-state"
      );
    }
    if (enabled) {
      await addon.enable();
    } else {
      await addon.disable();
    }
    const updated = await GeckoAddonManager.getAddonByID(id);
    if (!updated || updated.isActive !== enabled) {
      throw installError(
        "AddonManager did not commit the extension state",
        "state-commit-failed"
      );
    }
    return this.#projectAddon(updated, builtIn);
  }

  async setPrivateBrowsingAllowed(id, allowed) {
    this.#assertOpen();
    if (typeof allowed !== "boolean") {
      throw new TypeError("The private-window access state must be boolean");
    }
    const { addon, builtIn } = await this.#managedAddon(id);
    if (builtIn) {
      throw installError(
        "Application built-in private-window policy is immutable",
        "immutable-built-in"
      );
    }
    if (allowed && addon.incognito === "not_allowed") {
      throw installError(
        "The extension manifest forbids private-window access",
        "private-access-unavailable"
      );
    }
    const permissions = {
      permissions: [PRIVATE_PERMISSION],
      origins: [],
      data_collection: [],
    };
    const extension = ExtensionParent.GlobalManager.getExtension(id);
    if (allowed) {
      await ExtensionPermissions.add(id, permissions, extension);
    } else {
      await ExtensionPermissions.remove(id, permissions, extension);
    }
    if (addon.isActive) {
      await addon.reload();
    }
    const updated = await GeckoAddonManager.getAddonByID(id);
    if (!updated) {
      throw installError(
        "AddonManager lost the extension while updating private access",
        "state-commit-failed"
      );
    }
    const projected = await this.#projectAddon(updated, false);
    if (projected.privateBrowsingAllowed !== allowed) {
      throw installError(
        "AddonManager did not commit private-window access",
        "state-commit-failed"
      );
    }
    return projected;
  }

  async setToolbarPinned(id, pinned) {
    this.#assertOpen();
    if (typeof pinned !== "boolean") {
      throw new TypeError("The extension toolbar state must be boolean");
    }
    const { addon, builtIn } = await this.#managedAddon(id);
    if (!addon.isActive || !DesktopExtensionActions.has(id)) {
      throw installError(
        "The extension has no active toolbar action",
        "action-unavailable"
      );
    }
    DesktopExtensionActions.setPinned(id, pinned);
    return this.#projectAddon(addon, builtIn);
  }

  async uninstall(id) {
    this.#assertOpen();
    // A blocked profile-directory side-load cannot run, but the manager must
    // still let the user clean it up.
    const { addon, builtIn } = await this.#managedAddon(id, true);
    if (
      builtIn ||
      !(addon.permissions & GeckoAddonManager.PERM_CAN_UNINSTALL)
    ) {
      throw installError(
        "Application built-ins cannot be uninstalled",
        "immutable-built-in"
      );
    }
    await addon.uninstall();
    if (await GeckoAddonManager.getAddonByID(id)) {
      throw installError(
        "AddonManager did not remove the extension",
        "uninstall-commit-failed"
      );
    }
    DesktopExtensionActions.forgetPinned(id);
    return true;
  }

  async openOptions(ownerWindow, id) {
    this.#assertOpen();
    this.#assertOwnerWindow(ownerWindow);
    const { addon } = await this.#managedAddon(id);
    if (!addon.isActive || !addon.optionsURL) {
      throw installError(
        "The extension has no available options page",
        "options-unavailable"
      );
    }
    const extension = ExtensionParent.GlobalManager.getExtension(id);
    if (!extension?.principal) {
      throw installError(
        "The extension runtime is not ready",
        "extension-not-ready"
      );
    }
    DesktopExtensionTabs.createTab(
      ownerWindow,
      addon.optionsURL,
      true,
      extension.principal
    );
    return true;
  }

  close() {
    if (this.#closed) {
      return false;
    }
    this.#closed = true;
    this.#cancelPending();
    return true;
  }

  async #createPreview(file) {
    const manifest = readPackageManifest(file);
    const compatibility = compatibilityForManifest(manifest);
    const install = await GeckoAddonManager.getInstallForFile(file, null, {
      source: "navis",
      method: "local-extension-manager",
    });
    if (install?.error === GeckoAddonManager.ERROR_SIGNEDSTATE_REQUIRED) {
      try {
        install.cancel();
      } catch {}
      throw installError(
        "The extension is not signed by a trusted Mozilla add-on root",
        "signature-required"
      );
    }
    if (
      !install ||
      install.state !== GeckoAddonManager.STATE_DOWNLOADED ||
      install.error ||
      !install.addon
    ) {
      throw installError(
        "Gecko rejected the extension package",
        "invalid-package"
      );
    }
    const addon = install.addon;
    if (addon.type !== "extension" || !addon.isWebExtension) {
      install.cancel();
      throw installError(
        "Navis accepts WebExtension packages only",
        "unsupported-package-type"
      );
    }
    if (
      addon.isCorrectlySigned === false ||
      !Number.isInteger(addon.signedState) ||
      addon.signedState < GeckoAddonManager.SIGNEDSTATE_SIGNED
    ) {
      install.cancel();
      throw installError(
        "The extension is not signed by a trusted Mozilla add-on root",
        "signature-required"
      );
    }
    if (!addon.isCompatible || addon.appDisabled) {
      install.cancel();
      throw installError(
        "The extension is not compatible with this Navis build",
        "incompatible-version"
      );
    }
    if (configuredBuiltInIds().has(addon.id)) {
      install.cancel();
      throw installError(
        "Application built-ins cannot be replaced by a local package",
        "immutable-built-in"
      );
    }
    const existing = await GeckoAddonManager.getAddonByID(addon.id);
    if (existing) {
      if (existing.scope !== GeckoAddonManager.SCOPE_PROFILE) {
        install.cancel();
        throw installError(
          "The package identity belongs to another install scope",
          "identity-conflict"
        );
      }
      const comparison = Services.vc.compare(addon.version, existing.version);
      if (comparison < 0) {
        install.cancel();
        throw installError(
          "Extension downgrades are not supported in Navis",
          "downgrade-rejected"
        );
      }
      // Selecting the exact signed package in the manager is the explicit
      // adoption path for a profile-directory discovery that startup blocked.
      if (comparison === 0 && !existing.foreignInstall) {
        install.cancel();
        throw installError(
          "The selected package version is already installed",
          "same-version"
        );
      }
    }
    const token = Services.uuid.generateUUID().toString().slice(1, -1);
    const pending = {
      token,
      id: addon.id,
      install,
      compatibility,
      existingVersion: existing?.version || "",
      expiresAt: Date.now() + PREVIEW_LIFETIME_MS,
    };
    this.#pending.set(token, pending);
    return Object.freeze({
      token,
      id: boundedString(addon.id, 256),
      name: boundedString(addon.name, 256),
      description: boundedString(addon.description, 1024),
      icon: safeAddonIcon(addon),
      version: boundedString(addon.version, 128),
      existingVersion: boundedString(existing?.version, 128),
      packageName: boundedString(file.leafName, 256),
      packageBytes: file.fileSize,
      signedState: addon.signedState,
      compatibility,
    });
  }

  async #projectAddon(addon, builtIn) {
    const granted = await ExtensionPermissions.get(addon.id);
    const required = addon.userPermissions || {};
    const optional = addon.optionalPermissions || {};
    const privateBrowsingAllowed = Boolean(
      granted.permissions?.includes(PRIVATE_PERMISSION)
    );
    const foreignInstall = !builtIn && Boolean(addon.foreignInstall);
    const managed = builtIn || !foreignInstall;
    const hasAction = managed && DesktopExtensionActions.has(addon.id);
    const runtime = DesktopExtensionActions.runtimeState(addon.id);
    return Object.freeze({
      id: boundedString(addon.id, 256),
      name: boundedString(addon.name, 256),
      description: boundedString(addon.description, 1024),
      version: boundedString(addon.version, 128),
      builtIn,
      enabled: Boolean(addon.isActive),
      signatureState: addon.signedState,
      correctlySigned: addon.isCorrectlySigned !== false,
      foreignInstall,
      blockedSideload: foreignInstall,
      privateBrowsingAllowed,
      privateBrowsingAvailable:
        managed && !builtIn && addon.incognito !== "not_allowed",
      requiredPermissions: frozenStrings(required.permissions),
      requiredOrigins: frozenStrings(required.origins),
      optionalPermissions: frozenStrings(optional.permissions),
      optionalOrigins: frozenStrings(addon.optionalOriginsNormalized),
      grantedOptionalPermissions: frozenStrings(
        granted.permissions?.filter(
          permission => permission !== PRIVATE_PERMISSION
        )
      ),
      grantedOptionalOrigins: frozenStrings(granted.origins),
      canChangeEnabled:
        managed &&
        Boolean(
          addon.permissions &
            (GeckoAddonManager.PERM_CAN_ENABLE |
              GeckoAddonManager.PERM_CAN_DISABLE)
        ),
      canUninstall:
        !builtIn &&
        Boolean(addon.permissions & GeckoAddonManager.PERM_CAN_UNINSTALL),
      canUpdate: !builtIn,
      hasOptions: managed && Boolean(addon.optionsURL),
      hasAction,
      runtimeReady: !addon.isActive || runtime.ready,
      runtimeState: runtime.state,
      runtimeErrors: runtime.errors,
      toolbarPinned: DesktopExtensionActions.isPinned(addon.id),
      installDate: addon.installDate?.toISOString?.() || "",
      updateDate: addon.updateDate?.toISOString?.() || "",
    });
  }

  async #managedAddon(id, allowForeign = false) {
    if (typeof id !== "string" || !id || id.length > 256) {
      throw new TypeError("The extension ID is invalid");
    }
    const addon = await GeckoAddonManager.getAddonByID(id);
    if (!addon || addon.type !== "extension") {
      throw installError("The extension is unavailable", "not-found");
    }
    const builtIn =
      addon.scope === GeckoAddonManager.SCOPE_APPLICATION &&
      configuredBuiltInIds().has(addon.id);
    if (!builtIn && addon.scope !== GeckoAddonManager.SCOPE_PROFILE) {
      throw installError(
        "The extension is outside the Navis manager scope",
        "unmanaged-scope"
      );
    }
    if (!builtIn && addon.foreignInstall && !allowForeign) {
      throw installError(
        "A foreign profile extension must be installed explicitly",
        "foreign-install"
      );
    }
    return { addon, builtIn };
  }

  #takePending(token) {
    if (typeof token !== "string" || token.length > 80) {
      throw new TypeError("The extension preview token is invalid");
    }
    const pending = this.#pending.get(token);
    this.#pending.delete(token);
    if (!pending || pending.expiresAt < Date.now()) {
      try {
        pending?.install.cancel();
      } catch {}
      throw installError("The extension preview expired", "preview-expired");
    }
    return pending;
  }

  #cancelPending() {
    for (const pending of this.#pending.values()) {
      try {
        pending.install.cancel();
      } catch {}
    }
    this.#pending.clear();
  }

  #assertOwnerWindow(ownerWindow) {
    if (
      !ownerWindow ||
      ownerWindow.closed ||
      ownerWindow.document?.documentElement?.getAttribute("windowtype") !==
        "navis:browser"
    ) {
      throw new TypeError("The extension operation requires a Navis window");
    }
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("The extension manager is closed");
    }
  }
}

export const DesktopExtensionCompatibility = Object.freeze({
  supportedRequiredPermissions: frozenStrings([
    ...SUPPORTED_REQUIRED_PERMISSIONS,
  ]),
  forbiddenPermissions: frozenStrings([...FORBIDDEN_PERMISSIONS]),
  unsupportedManifestKeys: frozenStrings([...UNSUPPORTED_MANIFEST_KEYS]),
});
