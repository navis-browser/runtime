/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveNavisInternalPageURI } from "resource://gre/modules/DesktopInternalPages.sys.mjs";

const SETTINGS_COMMAND_EVENT = "NavisSettingsCommand";
const SETTINGS_STATE_EVENT = "NavisSettingsState";
const SETTINGS_COMMANDS = new Set([
  "settings:get",
  "settings:set-search-provider",
  "settings:set-locale",
  "settings:relaunch-locale",
  "settings:set-process-isolation",
  "settings:relaunch-process-isolation",
  "settings:set-clean-links",
  "settings:clear-site-data",
]);
const DIAGNOSTICS_COMMAND_EVENT = "NavisDiagnosticsCommand";
const DIAGNOSTICS_STATE_EVENT = "NavisDiagnosticsState";
const DIAGNOSTICS_COMMANDS = new Set(["diagnostics:get"]);
const MANAGEMENT_COMMAND_EVENT = "NavisManagementCommand";
const MANAGEMENT_STATE_EVENT = "NavisManagementState";
const MANAGEMENT_COMMANDS = new Map([
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
  if (command === "settings:set-clean-links") {
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
    ["extensions:confirm-install", 80],
    ["extensions:cancel-install", 80],
    ["extensions:uninstall", 256],
    ["extensions:open-options", 256],
    ["settings:set-search-provider", 32],
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

  handleEvent(event) {
    if (event.target !== this.contentWindow.document) {
      return;
    }
    const page = this.#currentPage();
    let commands;
    let stateEvent;
    if (event.type === SETTINGS_COMMAND_EVENT && page?.key === "settings") {
      commands = SETTINGS_COMMANDS;
      stateEvent = SETTINGS_STATE_EVENT;
    } else if (
      event.type === DIAGNOSTICS_COMMAND_EVENT &&
      (page?.key === "support" || page?.key === "settings/help")
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
    this.#request(page, command, stateEvent, sanitized.value);
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
    try {
      const state = await this.sendQuery("DesktopInternalPage:Command", {
        pageKey: page.key,
        command,
        value,
      });
      if (
        requestId !== this.#requestId ||
        this.#currentPage()?.key !== page.key
      ) {
        return;
      }
      this.#dispatchState(stateEvent, { requestId, ...state });
    } catch {
      if (
        requestId === this.#requestId &&
        this.#currentPage()?.key === page.key
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
}
