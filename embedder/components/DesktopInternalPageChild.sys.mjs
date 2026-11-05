/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveNavisInternalPageURI } from "resource://gre/modules/DesktopInternalPages.sys.mjs";

const SETTINGS_COMMAND_EVENT = "NavisSettingsCommand";
const APPEARANCE_COMMAND_EVENT = "NavisAppearanceCommand";
const APPEARANCE_STATE_EVENT = "NavisAppearanceState";
const APPEARANCE_COMMANDS = new Set(["appearance:get"]);
const SETTINGS_STATE_EVENT = "NavisSettingsState";
const SETTINGS_COMMANDS = new Set([
  "settings:get",
  "settings:set-search-provider",
  "settings:set-remote-suggestions",
  "settings:set-locale",
  "settings:relaunch-locale",
  "settings:set-process-isolation",
  "settings:relaunch-process-isolation",
  "settings:set-clean-links",
  "settings:clear-site-data",
  "settings:search-add",
  "settings:search-update",
  "settings:search-remove",
  "settings:search-move",
  "settings:set-appearance",
  "settings:set-download",
  "settings:choose-download-directory",
]);
const DIAGNOSTICS_COMMAND_EVENT = "NavisDiagnosticsCommand";
const DIAGNOSTICS_STATE_EVENT = "NavisDiagnosticsState";
const DIAGNOSTICS_COMMANDS = new Set(["diagnostics:get"]);
const MANAGEMENT_COMMAND_EVENT = "NavisManagementCommand";
const MANAGEMENT_STATE_EVENT = "NavisManagementState";
const MANAGEMENT_COMMANDS = new Map([
  ["processes", new Set(["processes:get", "processes:end"])],
  ["credits", new Set(["credits:get"])],
  ["profiles", new Set(["profiles:get", "profiles:create", "profile:update", "profiles:launch", "profiles:set-default", "profiles:remove", "profiles:restart"])],
  ["newtab", new Set(["newtab:navigate"])],
  ["history", new Set(["history:get", "history:delete", "history:clear"])],
  [
    "bookmarks",
    new Set([
      "bookmarks:get",
      "bookmarks:create",
      "bookmarks:update",
      "bookmarks:delete",
    ]),
  ],
  [
    "passwords",
    new Set([
      "passwords:get",
      "passwords:reveal",
      "passwords:delete",
      "passwords:clear",
    ]),
  ],
  [
    "downloads",
    new Set([
      "downloads:get",
      "downloads:acknowledge",
      "downloads:open",
      "downloads:cancel",
      "downloads:retry",
      "downloads:remove",
    ]),
  ],
  [
    "extensions",
    new Set([
      "extensions:get",
      "extensions:select-package",
      "extensions:confirm-install",
      "extensions:cancel-install",
      "extensions:set-enabled",
      "extensions:set-private-browsing",
      "extensions:set-pinned",
      "extensions:uninstall",
      "extensions:open-options",
    ]),
  ],
]);
const BOOKMARK_MUTATION_COMMANDS = new Set([
  "bookmarks:create",
  "bookmarks:update",
]);

function boundedText(value, maximum, { allowEmpty = false } = {}) {
  return typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length)
    ? value
    : null;
}

function sanitizeCommandValue(command, rawValue) {
  if (command === "downloads:acknowledge") {
    let raw;
    try { raw = Cu.waiveXrays(rawValue); } catch { return { valid: false }; }
    if (!Array.isArray(raw) || raw.length > 500) return { valid: false };
    const value = [];
    for (const item of raw) {
      const id = boundedText(item?.id, 128);
      const token = boundedText(item?.token, 64);
      if (!id || !token) return { valid: false };
      value.push({ id, token });
    }
    return { valid: true, value };
  }
  if (command === "processes:end") {
    let raw;
    try { raw = Cu.waiveXrays(rawValue); } catch { return { valid: false }; }
    const token = boundedText(raw?.token, 64);
    return { valid: !!token, value: { token } };
  }
  if (command.startsWith("settings:search-") ||
      command === "settings:set-appearance" || command === "settings:set-download" ||
      ["profiles:create", "profile:update", "profiles:launch", "profiles:set-default", "profiles:remove", "profiles:restart"].includes(command)) {
    let raw;
    try { raw = Cu.waiveXrays(rawValue); } catch { return { valid: false }; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid: false };
    const id = boundedText(raw.id, command.startsWith("profiles:") ? 512 : 64);
    if (["settings:search-add", "settings:search-update"].includes(command)) {
      const name = boundedText(raw.name, 80);
      const template = boundedText(raw.template, 4096);
      const suggestionTemplate = boundedText(raw.suggestionTemplate ?? "", 4096, { allowEmpty: true });
      return { valid: !!name && !!template && suggestionTemplate !== null && (command.endsWith("-add") || !!id),
        value: { id, name, template, suggestionTemplate } };
    }
    if (command === "settings:search-remove" || command === "profiles:launch" || command === "profiles:set-default") {
      return { valid: !!id, value: { id } };
    }
    if (command === "settings:search-move") {
      const position = raw.position;
      return { valid: !!id && Number.isInteger(position) && position >= 0 && position < 64, value: { id, position } };
    }
    if (command === "profiles:remove") return { valid: !!id && typeof raw.deleteFiles === "boolean", value: { id, deleteFiles: raw.deleteFiles } };
    if (command === "profiles:restart") return { valid: typeof raw.safeMode === "boolean", value: { safeMode: raw.safeMode } };
    if (command === "profiles:create" || command === "profile:update") {
      const userName = boundedText(raw.userName, 80);
      const accentColor = boundedText(raw.accentColor, 7);
      return { valid: !!userName && /^#[0-9a-f]{6}$/i.test(accentColor || ""), value: { userName, accentColor } };
    }
    const key = boundedText(raw.key, 32);
    const value = raw.value;
    const booleanKeys = command === "settings:set-download"
      ? ["askBeforeSaving", "deletePrivateOnExit", "openWhenComplete"] : ["historyButton", "showCertificateOrganization"];
    const valid = booleanKeys.includes(key) ? typeof value === "boolean" :
      command === "settings:set-appearance" && ["theme", "accent", "bookmarkBar"].includes(key) && boundedText(value, 32) !== null;
    return { valid, value: { key, value } };
  }
  if (command === "settings:set-clean-links" || command === "settings:set-remote-suggestions") {
    return {
      valid: typeof rawValue === "boolean",
      value: rawValue,
    };
  }
  if (
    new Set([
      "history:clear",
      "passwords:get",
      "passwords:clear",
      "downloads:get",
      "extensions:get",
      "extensions:select-package",
    ]).has(command)
  ) {
    return { valid: rawValue === undefined, value: undefined };
  }
  if (command === "history:get") {
    const value = boundedText(rawValue ?? "", 256, { allowEmpty: true });
    return { valid: value !== null, value };
  }
  if (command === "bookmarks:get") {
    const value = boundedText(rawValue ?? "root", 128);
    return { valid: value !== null, value };
  }
  const textLimits = new Map([
    ["newtab:navigate", 8192],
    ["history:delete", 4096],
    ["bookmarks:delete", 128],
    ["passwords:reveal", 128],
    ["passwords:delete", 128],
    ["downloads:cancel", 128],
    ["downloads:retry", 128],
    ["downloads:remove", 128],
    ["downloads:open", 128],
    ["extensions:confirm-install", 80],
    ["extensions:cancel-install", 80],
    ["extensions:uninstall", 256],
    ["extensions:open-options", 256],
    ["settings:set-search-provider", 64],
    ["settings:set-locale", 16],
    ["settings:set-process-isolation", 16],
  ]);
  if (textLimits.has(command)) {
    const value = boundedText(rawValue, textLimits.get(command));
    return { valid: value !== null, value };
  }
  if (BOOKMARK_MUTATION_COMMANDS.has(command)) {
    let value;
    try {
      value = Cu.waiveXrays(rawValue);
    } catch {
      return { valid: false };
    }
    const id = boundedText(value?.id, 128);
    const parentId = boundedText(value?.parentId ?? "root", 128);
    const type = value?.type === "folder" ? "folder" : "bookmark";
    const title = boundedText(value?.title ?? "", 512, { allowEmpty: true });
    const url = boundedText(value?.url ?? "", 4096, { allowEmpty: true });
    const valid =
      parentId !== null &&
      title !== null &&
      url !== null &&
      (command === "bookmarks:create" || id !== null) &&
      (type === "folder" || Boolean(url));
    return {
      valid,
      value: valid ? { id, parentId, type, title, url } : undefined,
    };
  }
  if (
    command === "extensions:set-enabled" ||
    command === "extensions:set-private-browsing" ||
    command === "extensions:set-pinned"
  ) {
    let value;
    try {
      value = Cu.waiveXrays(rawValue);
    } catch {
      return { valid: false };
    }
    const id = boundedText(value?.id, 256);
    const enabled = value?.enabled;
    const valid = id !== null && typeof enabled === "boolean";
    return {
      valid,
      value: valid ? { id, enabled } : undefined,
    };
  }
  return { valid: rawValue === undefined, value: undefined };
}

/** Bridges bounded commands from exact authenticated Navis internal pages. */
export class DesktopInternalPageChild extends JSWindowActorChild {
  #requestId = 0;
  #latestRequests = new Map();

  receiveMessage(message) {
    if (message.name === "DesktopInternalPage:ProfileChanged") {
      if (this.#currentPage()?.key === "profiles" && message.data?.pageKey === "profiles") {
        // A notification requests a fresh snapshot without replacing a pending mutation.
        this.#dispatchState("NavisProfileChanged", message.data);
      }
      return;
    }
    if (message.name === "DesktopInternalPage:AppearanceChanged") {
      const page = this.#currentPage();
      if (!page || page.id === "settings" || message.data?.pageKey !== page.key) return;
      // A newer preference push supersedes any older initial-page read.
      this.#latestRequests.set(APPEARANCE_STATE_EVENT, ++this.#requestId);
      this.#dispatchState(APPEARANCE_STATE_EVENT, message.data);
      return;
    }
    if (message.name !== "DesktopInternalPage:DownloadsChanged" ||
        this.#currentPage()?.key !== "downloads") return;
    this.#dispatchState("NavisDownloadsChanged", message.data);
  }

  handleEvent(event) {
    if (event.type === "click" || event.type === "auxclick") {
      this.#handleLinkActivation(event);
      return;
    }
    if (event.target !== this.contentWindow.document) {
      return;
    }
    const page = this.#currentPage();
    let commands;
    let stateEvent;
    if (event.type === APPEARANCE_COMMAND_EVENT && page && page.id !== "settings") {
      commands = APPEARANCE_COMMANDS;
      stateEvent = APPEARANCE_STATE_EVENT;
    } else if (event.type === SETTINGS_COMMAND_EVENT && page?.id === "settings") {
      commands = SETTINGS_COMMANDS;
      stateEvent = SETTINGS_STATE_EVENT;
    } else if (
      event.type === DIAGNOSTICS_COMMAND_EVENT &&
      (page?.key === "support" || page?.id === "settings")
    ) {
      commands = DIAGNOSTICS_COMMANDS;
      stateEvent = DIAGNOSTICS_STATE_EVENT;
    } else if (
      event.type === MANAGEMENT_COMMAND_EVENT &&
      MANAGEMENT_COMMANDS.has(page?.key)
    ) {
      commands = MANAGEMENT_COMMANDS.get(page.key);
      stateEvent = MANAGEMENT_STATE_EVENT;
    } else {
      return;
    }
    let detail;
    try {
      detail = Cu.waiveXrays(event).detail;
    } catch {
      return;
    }
    const command = typeof detail?.command === "string" ? detail.command : "";
    if (!commands.has(command)) {
      return;
    }
    const sanitized = sanitizeCommandValue(command, detail.value);
    if (!sanitized.valid) {
      return;
    }
    if (command === "downloads:acknowledge") {
      if (this.contentWindow.document.visibilityState !== "visible" ||
          !this.contentWindow.document.hasFocus()) return;
      // Attention acknowledgements must not supersede an outstanding mutation
      // or its reply in the management request stream.
      this.sendQuery("DesktopInternalPage:Command", {
        pageKey: page.key, command, value: sanitized.value,
      }).catch(() => {});
      return;
    }
    this.#request(page, command, stateEvent, sanitized.value);
  }

  #handleLinkActivation(event) {
    const page = this.#currentPage();
    if (!page || event.defaultPrevented ||
        (event.type === "click" ? event.button !== 0 : event.button !== 1)) return;
    const document = this.contentWindow.document;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const link = target?.closest("a[href], area[href]");
    if (link?.ownerDocument !== document || !/^navis:/i.test(link.href)) return;
    const targetName = link.target.toLowerCase();

    // Native content-triggered loads cannot carry authority for our dangerous
    // protocol. Authenticate the source again in the parent and use the
    // existing browser-owned Session navigation instead of forwarding that IPC.
    let uri;
    try { uri = Services.io.newURI(link.href); } catch {}
    if (event.isTrusted && event.button === 0 && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.altKey && ["", "_self", "_parent", "_top"].includes(targetName) && uri?.hasRef &&
        uri.specIgnoringRef === document.documentURIObject.specIgnoringRef) return;
    event.preventDefault();
    if (!event.isTrusted || event.altKey || link.hasAttribute("download") ||
        link.href.length > 8192 || !resolveNavisInternalPageURI(uri)) return;
    const newTab = event.button === 1 || event.ctrlKey || event.metaKey;
    const disposition = newTab ? (event.shiftKey ? "foreground" : "background") :
      event.shiftKey ? "window" :
      targetName && !["_self", "_parent", "_top"].includes(targetName) ? "foreground" : "current";
    this.sendQuery("DesktopInternalPage:Command", {
      pageKey: page.key,
      command: "internal:navigate",
      value: { url: uri.spec, disposition },
    }).catch(() => {});
  }

  #currentPage() {
    try {
      return resolveNavisInternalPageURI(
        this.contentWindow.document.documentURIObject
      );
    } catch {
      return null;
    }
  }

  async #request(page, command, stateEvent, value = undefined) {
    const requestId = ++this.#requestId;
    // Settings and diagnostics share the settings SPA, but a background
    // diagnostic read must not supersede a user's settings operation.
    this.#latestRequests.set(stateEvent, requestId);
    try {
      const state = await this.sendQuery("DesktopInternalPage:Command", {
        pageKey: page.key,
        command,
        value,
      });
      if (
        requestId !== this.#latestRequests.get(stateEvent) ||
        !this.#samePageFamily(page)
      ) {
        return;
      }
      this.#dispatchState(stateEvent, { requestId, ...state });
    } catch {
      if (
        requestId === this.#latestRequests.get(stateEvent) &&
        this.#samePageFamily(page)
      ) {
        this.#dispatchState(stateEvent, {
          requestId,
          pageKey: page.key,
          outcome: command === "diagnostics:get" ? "pending" : "failed",
        });
      }
    }
  }

  #dispatchState(stateEvent, state) {
    const ownerWindow = this.contentWindow;
    const detail = Cu.cloneInto(state, ownerWindow);
    ownerWindow.dispatchEvent(
      new ownerWindow.CustomEvent(stateEvent, { detail })
    );
  }

  #samePageFamily(page) {
    const current = this.#currentPage();
    return current?.key === page.key || (page.id === "settings" && current?.id === "settings");
  }
}
