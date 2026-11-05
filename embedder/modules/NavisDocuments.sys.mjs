/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PDF_VIEWER = "resource://pdf.js/web/viewer.html";
const hosts = new WeakMap();
let registered = false;

// Only the private Session binding installs a document host. A resource
// principal alone does not grant a content-created browser product authority.
export function bindDocumentHost(browser, { save }) {
  if (hosts.has(browser) || typeof save !== "function") {
    throw new TypeError("A document host requires one save implementation");
  }
  const host = Object.freeze({ save });
  hosts.set(browser, host);
  return () => {
    if (hosts.get(browser) === host) hosts.delete(browser);
  };
}

export function initializeNavisPDF() {
  if (registered) return;
  ChromeUtils.registerWindowActor("Pdfjs", {
    parent: { esModuleURI: "resource://gre/modules/NavisDocuments.sys.mjs" },
    child: { esModuleURI: "resource://gre/modules/NavisPdfjsChild.sys.mjs" },
    allFrames: true,
  });
  const { PdfJs } = ChromeUtils.importESModule("resource://pdf.js/PdfJs.sys.mjs");
  // Preserve an explicit existing MIME decision. A new Profile still acquires
  // the internal handler through PDF.js's normal migration, without changing
  // any operating-system file association.
  const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService);
  const mime = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService)
    .getFromTypeAndExtension("application/pdf", "pdf");
  if (handlers.exists(mime) && Services.prefs.getIntPref("pdfjs.migrationVersion", 0) < 1) {
    Services.prefs.setIntPref("pdfjs.migrationVersion", 2);
  }
  PdfJs.init(false);
  registered = true;
}

export function shutdownNavisPDF() {
  if (!registered) return;
  const { PdfJs } = ChromeUtils.importESModule("resource://pdf.js/PdfJs.sys.mjs");
  PdfJs.uninit();
  ChromeUtils.unregisterWindowActor("Pdfjs");
  registered = false;
}

export class PdfjsParent extends JSWindowActorParent {
  receiveMessage(message) {
    // Find is handled by the viewer itself. AI, signature storage, Nimbus and
    // telemetry messages have no product implementation or side effect.
    if (message.name !== "PDFJS:Parent:saveURL") return null;
    const browser = this.browsingContext.top.embedderElement;
    const host = hosts.get(browser);
    const manager = this.manager;
    const isCurrent = () => browser?.isConnected && hosts.get(browser) === host &&
      this.browsingContext.currentWindowGlobal === manager &&
      manager.documentPrincipal?.isContentPrincipal &&
      manager.documentPrincipal.URI?.spec === PDF_VIEWER &&
      (!this.browsingContext.parent || !(this.browsingContext.sandboxFlags & 0x10000));
    if (!host || !isCurrent()) return null;
    const data = message.data;
    if (!data || ![data.originalUrl, data.blobUrl].every(value =>
      typeof value === "string" && value.length > 0 && value.length <= 65536)) return null;
    const documentURL = manager.documentURI?.spec;
    const withoutFragment = value => value?.split("#", 1)[0];
    const isAttachmentBlob = data.originalUrl === data.blobUrl && data.blobUrl.startsWith("blob:");
    if ((!isAttachmentBlob && withoutFragment(data.originalUrl) !== withoutFragment(documentURL)) ||
        (data.blobUrl !== data.originalUrl && !data.blobUrl.startsWith("blob:"))) return null;
    try {
      Services.scriptSecurityManager.checkLoadURIWithPrincipal(
        manager.documentPrincipal, Services.io.newURI(data.blobUrl),
        Ci.nsIScriptSecurityManager.STANDARD);
    } catch {
      return null;
    }
    const filename = typeof data.filename === "string"
      ? data.filename.replace(/[\u0000-\u001f\u007f/\\]/g, "_").slice(0, 240)
      : "document.pdf";
    return host.save(Object.freeze({
      blobUrl: data.blobUrl, originalUrl: data.originalUrl,
      filename: filename || "document.pdf",
    }), isCurrent, this.browsingContext);
  }
}
