/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { bindDocumentHost } from "resource://gre/modules/NavisDocuments.sys.mjs";

export function createAndroidDocuments(window, browser, dispatcher) {
  window.AppConstants = AppConstants;
  window.Services = Services;
  window.XPCOMUtils = XPCOMUtils;
  if (!window.MozXULElement) {
    Services.scriptloader.loadSubScript("chrome://global/content/customElements.js", window);
  }
  Services.scriptloader.loadSubScript("chrome://global/content/printUtils.js", window);
  let lease = null;
  let beginning = false;
  let clone = null;
  let closed = false;
  const releasePDF = bindDocumentHost(browser, {
    async save(request, isCurrent) {
      if (!isCurrent() || closed) return false;
      // The viewer's original/edited bytes already live in this blob. Reuse
      // the existing native response/download transport without re-fetching
      // an authenticated URL, reconstructing POST or exposing filesystem paths.
      if (!request.blobUrl.startsWith("blob:")) return false;
      return dispatcher.sendRequestForResult("NavisAndroid:SavePDF", request);
    },
  });

  const clearClone = () => {
    clone?.remove();
    clone = null;
  };

  return {
    handles: operation => ["document:begin", "document:finish"].includes(operation),
    async query(operation, payload) {
      if (closed || !browser.isConnected) throw new Error("Document host closed");
      if (operation === "document:finish") {
        if (lease && payload?.token === lease.token) {
          lease = null;
          clearClone();
        }
        return true;
      }
      if (operation !== "document:begin" || lease || beginning) throw new Error("Document print already in progress");
      beginning = true;
      try {
      const source = browser.browsingContext.currentWindowGlobal;
      const target = clone || browser;
      const pending = () => !target.browsingContext?.currentWindowGlobal ||
        (target !== browser && target.browsingContext.currentWindowGlobal.isInitialDocument);
      const deadline = Date.now() + 5000;
      while (pending() && Date.now() < deadline &&
             !closed && target.isConnected && browser.browsingContext.currentWindowGlobal === source) {
        await new Promise(resolve => window.setTimeout(resolve, 10));
      }
      const printWindow = target.browsingContext?.currentWindowGlobal;
      if (!source || pending() || closed || !target.isConnected ||
          browser.browsingContext.currentWindowGlobal !== source) {
        clearClone();
        throw new Error("Print document changed");
      }
      lease = Object.freeze({ token: Services.uuid.generateUUID().toString(),
        sourceWindow: source.innerWindowId, printWindow: printWindow.innerWindowId,
        title: String(source.documentTitle || "Navis").slice(0, 200) });
      // This descriptor stays in the private Java binding. Platform receives
      // only a bounded title and a render/close transport, never native IDs.
      return lease;
      } finally {
        beginning = false;
      }
    },
    clone(openWindowInfo) {
      if (closed || openWindowInfo?.parent?.top !== browser.browsingContext ||
          !browser.isConnected) throw new Error("Foreign print source");
      if (openWindowInfo.isForWindowDotPrint && (clone || lease || beginning)) {
        throw new Error("Document print already in progress");
      }
      const result = window.PrintUtils.createParentBrowserForStaticClone(
        openWindowInfo.parent, openWindowInfo);
      if (openWindowInfo.isForWindowDotPrint) {
        clone = result;
        clone.id = "navis-print-clone";
        const source = browser.browsingContext.currentWindowGlobal;
        // OpenInternal must return the browser before its static document can
        // replace the initial blank WindowGlobal (as in upstream PrintUtils).
        window.setTimeout(() => {
          if (closed || clone !== result) return;
          if (!browser.isConnected || browser.browsingContext.currentWindowGlobal !== source) {
            clearClone();
            return;
          }
          dispatcher.sendRequest("NavisAndroid:Print", {});
        }, 0);
      }
      return result;
    },
    close() {
      if (closed) return;
      closed = true;
      lease = null;
      clearClone();
      releasePDF();
    },
  };
}
