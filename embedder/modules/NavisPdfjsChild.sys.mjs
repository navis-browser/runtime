/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PdfjsChild as EnginePdfjsChild } from "resource://pdf.js/PdfjsChild.sys.mjs";

// An application may register this optional packaged resource. Runtime owns
// authentication and attachment; the application owns its presentation.
const STYLE_HOST = "navis-pdf-style";
const STYLE = `resource://${STYLE_HOST}/pdf-reader.css`;
const VIEWER = "resource://pdf.js/web/viewer.html";

export class PdfjsChild extends EnginePdfjsChild {
  init(supportsFind) {
    super.init(supportsFind);
    const principal = this.contentWindow.document.nodePrincipal;
    if (!principal.isContentPrincipal || principal.URI?.spec !== VIEWER) return;
    const resources = Services.io.getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resources.hasSubstitution(STYLE_HOST)) return;
    this.contentWindow.windowUtils.loadSheetUsingURIString(
      STYLE, Ci.nsIDOMWindowUtils.AUTHOR_SHEET);
  }
}
