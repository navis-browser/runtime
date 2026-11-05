/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { bindDocumentHost } from "resource://gre/modules/NavisDocuments.sys.mjs";
import { getDesktopPrinting } from "resource://gre/modules/DesktopPrinting.sys.mjs";

export function bindDesktopDocuments(browser) {
  const releasePrinting = getDesktopPrinting(browser.ownerDocument.defaultView).bindBrowser(browser);
  const releasePDF = bindDocumentHost(browser, {
    async save(request, isCurrent, context) {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(browser.ownerDocument.defaultView.browsingContext, request.filename, Ci.nsIFilePicker.modeSave);
      picker.defaultString = request.filename;
      if (request.filename.toLowerCase().endsWith(".pdf")) {
        picker.defaultExtension = "pdf";
        picker.appendFilter("PDF", "*.pdf");
      }
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      const directory = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      directory.initWithPath(await Downloads.getPreferredDownloadsDirectory());
      picker.displayDirectory = directory;
      if (!isCurrent()) return false;
      const result = await new Promise(resolve => picker.open(resolve));
      if (![Ci.nsIFilePicker.returnOK, Ci.nsIFilePicker.returnReplace].includes(result) ||
          !picker.file || !isCurrent()) return false;
      const isPrivate = !!context.usePrivateBrowsing;
      const download = await Downloads.createDownload({
        source: {
          url: request.blobUrl, isPrivate,
          loadingPrincipal: context.currentWindowGlobal.documentPrincipal,
          cookieJarSettings: context.currentWindowGlobal.cookieJarSettings,
        },
        target: picker.file,
      });
      if (!isCurrent()) return false;
      const list = await Downloads.getList(isPrivate ? Downloads.PRIVATE : Downloads.PUBLIC);
      if (!isCurrent()) return false;
      await list.add(download);
      await download.start();
      Services.obs.notifyObservers(null, "pdfjs:saveComplete");
      return true;
    },
  });
  return () => {
    releasePDF();
    releasePrinting();
  };
}
