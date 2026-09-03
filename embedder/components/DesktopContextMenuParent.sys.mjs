/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { projectDesktopCopiedLink } from "resource://gre/modules/DesktopCleanLinks.sys.mjs";

/** Routes sanitized child facts to the owning browser and validates commands. */
export class DesktopContextMenuParent extends JSWindowActorParent {
  #token = null;
  #commands = new Set();
  #values = Object.freeze({});

  receiveMessage(message) {
    if (
      message.name === "DesktopContextMenu:ContentInteraction" &&
      this.manager.isCurrentGlobal
    ) {
      const browser = this.manager.rootFrameLoader?.ownerElement;
      browser?.desktopEmbedderContentInteraction?.(this, {
        kind: message.data?.kind === "pointer" ? "pointer" : "unknown",
      });
      return;
    }
    if (
      message.name !== "DesktopContextMenu:Show" ||
      !this.manager.isCurrentGlobal
    ) {
      return;
    }
    const browser = this.manager.rootFrameLoader?.ownerElement;
    if (!browser || typeof browser.desktopEmbedderContextMenu !== "function") {
      this.sendAsyncMessage("DesktopContextMenu:Dismiss", {
        token: message.data?.token,
      });
      return;
    }

    const data = message.data || {};
    const token = Number(data.token);
    if (!Number.isSafeInteger(token) || token <= 0) {
      return;
    }
    this.#token = token;
    this.#commands = new Set(
      Array.isArray(data.items) ? data.items.map(item => item?.id) : []
    );
    this.#values = Object.freeze({
      linkUrl: typeof data.linkUrl === "string" ? data.linkUrl : "",
      imageUrl: typeof data.imageUrl === "string" ? data.imageUrl : "",
      mediaUrl: typeof data.mediaUrl === "string" ? data.mediaUrl : "",
    });

    const ownerWindow = browser.documentGlobal;
    const innerScreenX = Number(ownerWindow.mozInnerScreenX) || 0;
    const innerScreenY = Number(ownerWindow.mozInnerScreenY) || 0;
    browser.desktopEmbedderContextMenu(this, {
      ...data,
      x: Number(data.screenX) - innerScreenX,
      y: Number(data.screenY) - innerScreenY,
      browsingContextId: this.manager.browsingContext.id,
    });
  }

  execute(token, command) {
    if (
      token !== this.#token ||
      !this.#commands.has(command) ||
      !this.manager.isCurrentGlobal
    ) {
      return false;
    }

    const rawValue = {
      "copy-link-address": this.#values.linkUrl,
      "copy-image-address": this.#values.imageUrl,
      "copy-media-address": this.#values.mediaUrl,
    }[command];
    const value =
      command === "copy-link-address"
        ? projectDesktopCopiedLink(rawValue)
        : rawValue;
    if (value) {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(value, this.manager);
      this.#clear();
      this.sendAsyncMessage("DesktopContextMenu:Dismiss", { token });
      return true;
    }

    this.sendAsyncMessage("DesktopContextMenu:Execute", { token, command });
    this.#clear();
    return true;
  }

  dismiss(token) {
    if (token !== this.#token) {
      return false;
    }
    this.sendAsyncMessage("DesktopContextMenu:Dismiss", { token });
    this.#clear();
    return true;
  }

  didDestroy() {
    this.#clear();
  }

  #clear() {
    this.#token = null;
    this.#commands.clear();
    this.#values = Object.freeze({});
  }
}
