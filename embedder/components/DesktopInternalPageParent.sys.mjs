/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Routes a bounded Navis internal-page request to its owning Session. */
export class DesktopInternalPageParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (
      message.name !== "DesktopInternalPage:Command" ||
      !this.manager.isCurrentGlobal
    ) {
      throw new Error("Stale Navis internal-page request");
    }
    const browser = this.manager.rootFrameLoader?.ownerElement;
    if (
      !browser ||
      typeof browser.desktopEmbedderInternalPageCommand !== "function"
    ) {
      throw new Error("Navis internal-page bridge is unavailable");
    }
    return browser.desktopEmbedderInternalPageCommand(this, message.data || {});
  }
}
