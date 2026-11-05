/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SubDialogManager } from "resource://gre/modules/SubDialog.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const windows = new WeakMap();

export function getDesktopPrinting(window) {
  let printing = windows.get(window);
  if (!printing) {
    printing = new DesktopPrinting(window);
    windows.set(window, printing);
  }
  return printing;
}

// Toolkit owns document cloning, pagination, settings and native printer
// integration. This adapter supplies only a host in place of Firefox tabs.
class DesktopPrinting {
  #window;
  #hosts = new Map();
  #styleSheets = [];
  #inert = new Map();
  #localization;
  #closed = false;

  constructor(window) {
    this.#window = window;
    window.Services = Services;
    window.AppConstants = AppConstants;
    window.XPCOMUtils = XPCOMUtils;
    if (!window.MozXULElement) {
      Services.scriptloader.loadSubScript("chrome://global/content/customElements.js", window);
    }
    if (!window.PrintUtils) {
      Services.scriptloader.loadSubScript("chrome://global/content/printUtils.js", window);
    }
    this.#localization = new window.DOMLocalization(["toolkit/printing/printUI.ftl"]);
    window.PrintUtils.l10n = this.#localization;
    window.PrintUtils.getTabDialogBox = browser => this.#dialogBox(browser);
  }

  configure({ styleSheets = [] } = {}) {
    if (!Array.isArray(styleSheets) || styleSheets.length > 8 ||
        styleSheets.some(uri => typeof uri !== "string" || uri.length > 1024 ||
          !["chrome", "resource"].includes(Services.io.newURI(uri).scheme))) {
      throw new TypeError("Print presentation requires bounded packaged stylesheets");
    }
    if ([...this.#hosts.values()].some(host => host.manager?.hasDialogs)) {
      throw new Error("Print presentation cannot change while printing");
    }
    for (const host of this.#hosts.values()) {
      if (host.stack) this.#localization.disconnectRoot(host.stack);
      host.stack?.remove();
      host.stack = null;
      host.manager = null;
    }
    this.#styleSheets = [...styleSheets];
  }

  bindBrowser(browser) {
    if (this.#closed || this.#hosts.has(browser) || browser.ownerDocument?.defaultView !== this.#window) {
      throw new Error("Invalid print host ownership");
    }
    const host = { browser, stack: null, manager: null };
    this.#hosts.set(browser, host);
    return () => {
      if (this.#hosts.get(browser) !== host) return;
      this.#hosts.delete(browser);
      host.manager?.abortDialogs();
      if (host.stack) {
        this.#localization.disconnectRoot(host.stack);
        host.stack.remove();
      }
      this.#restoreInput();
    };
  }

  start(browser) {
    this.#assertBrowser(browser);
    const existing = this.#hosts.get(browser).manager;
    if (existing?.hasDialogs) {
      existing.focusTopDialog();
      return false;
    }
    this.#window.PrintUtils.startPrintWindow(browser.browsingContext);
    return true;
  }

  clone(openWindowInfo) {
    const browser = openWindowInfo?.parent?.top?.embedderElement;
    this.#assertBrowser(browser);
    return this.#window.PrintUtils.handleStaticCloneCreatedForPrint(openWindowInfo);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const host of this.#hosts.values()) {
      host.manager?.abortDialogs();
      if (host.stack) this.#localization.disconnectRoot(host.stack);
      host.stack?.remove();
    }
    this.#hosts.clear();
    this.#restoreInput();
    windows.delete(this.#window);
  }

  #assertBrowser(browser) {
    if (this.#closed || !browser?.isConnected || !this.#hosts.has(browser) ||
        browser.ownerDocument?.defaultView !== this.#window) throw new Error("Print Session is unavailable");
  }

  #restoreInput() {
    if ([...this.#hosts.values()].some(host => host.manager?.hasDialogs)) return;
    for (const [element, inert] of this.#inert) element.inert = inert;
    this.#inert.clear();
  }

  #dialogBox(browser) {
    this.#assertBrowser(browser);
    const host = this.#hosts.get(browser);
    if (!host.manager) {
      const document = this.#window.document;
      host.stack = document.createElement("div");
      host.stack.className = "desktop-engine-print-stack";
      host.stack.hidden = true;
      const template = document.createXULElement("vbox");
      template.className = "dialogOverlay";
      template.hidden = true;
      const box = document.createXULElement("hbox");
      box.className = "dialogBox";
      const frame = document.createXULElement("browser");
      frame.className = "dialogFrame printSettingsBrowser";
      frame.setAttribute("flex", "1");
      frame.setAttribute("disablehistory", "true");
      box.append(frame);
      template.append(box);
      document.body.append(host.stack);
      this.#localization.connectRoot(host.stack);
      host.manager = new SubDialogManager({
        dialogStack: host.stack, dialogTemplate: template,
        dialogOptions: {
          styleSheets: this.#styleSheets,
          resizeCallback: ({ frame }) => {
            const root = frame.contentDocument.documentElement;
            root.setAttribute("data-navis-print", "");
            const theme = document.documentElement.getAttribute("data-theme");
            if (theme) root.setAttribute("data-theme", theme);
          },
        },
      });
    }
    return {
      getTabDialogManager: () => host.manager,
      open: (uri, options, ...args) => {
        if (uri !== "chrome://global/content/print.html" ||
            [...this.#hosts.values()].some(item => item.manager?.hasDialogs)) {
          throw new Error("A print dialog is already open");
        }
        const { promise: closedPromise, resolve } = Promise.withResolvers();
        for (const element of this.#window.document.body.children) {
          if (element === host.stack || element.classList.contains("desktop-engine-print-stack")) continue;
          if (!this.#inert.has(element)) this.#inert.set(element, element.inert);
          element.inert = true;
        }
        let dialog;
        try {
          dialog = host.manager.open(uri, {
          ...options,
          closedCallback: () => {
            browser.removeAttribute("tabDialogShowing");
            this.#restoreInput();
            if (browser.isConnected) browser.focus();
            resolve();
          },
          }, ...args);
          if (!dialog) throw new Error("Print dialog could not open");
        } catch (error) {
          browser.removeAttribute("tabDialogShowing");
          this.#restoreInput();
          resolve();
          throw error;
        }
        browser.setAttribute("tabDialogShowing", "true");
        return { dialog, closedPromise };
      },
    };
  }
}
