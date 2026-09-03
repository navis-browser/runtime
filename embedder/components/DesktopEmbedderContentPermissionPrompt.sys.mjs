/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function DesktopEmbedderContentPermissionPrompt() {}

DesktopEmbedderContentPermissionPrompt.prototype = {
  classID: Components.ID("{1c39b180-2f52-4c61-a706-72eca1e5f41f}"),

  QueryInterface: ChromeUtils.generateQI(["nsIContentPermissionPrompt"]),

  prompt(request) {
    let browser = request.element;
    if (!browser) {
      try {
        browser = request.window?.docShell.chromeEventHandler;
      } catch {}
    }

    if (
      typeof browser?.desktopEmbedderContentPermissionPrompt === "function"
    ) {
      browser.desktopEmbedderContentPermissionPrompt(request);
      return;
    }

    request.cancel();
  },
};
