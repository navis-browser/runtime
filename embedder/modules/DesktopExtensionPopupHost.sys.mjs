/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DesktopExtensionActions } from "resource://gre/modules/DesktopExtensionActions.sys.mjs";
import { ExtensionParent } from "resource://gre/modules/ExtensionParent.sys.mjs";

const MIN_WIDTH = 120;
const MIN_HEIGHT = 40;
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
const FALLBACK_WIDTH = 320;
const FALLBACK_HEIGHT = 180;
const POPUP_STYLESHEET =
  "chrome://navis/content/webextension/extension-popup-panel.css";
const BROWSER_STYLE_STYLESHEET =
  "chrome://navis/content/webextension/extension.css";

function boundedDimension(value, minimum, maximum, fallback) {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.ceil(value)))
    : fallback;
}

function validAnchorId(value) {
  return (
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)
  );
}

/** Hosts one process-isolated extension action popup per Navis window. */
export class DesktopExtensionPopupHost {
  #byWindow = new WeakMap();
  #openPopups = new Set();

  async open(
    ownerWindow,
    extension,
    popupURL,
    anchorId,
    browserStyle = false
  ) {
    if (
      !ownerWindow ||
      ownerWindow.closed ||
      ownerWindow.document?.documentElement?.getAttribute("windowtype") !==
        "navis:browser"
    ) {
      throw new TypeError("An extension popup requires a Navis window");
    }
    if (!extension?.remote || !extension?.principal || !extension?.baseURI) {
      throw new Error("The extension does not have an isolated popup runtime");
    }
    if (
      typeof popupURL !== "string" ||
      !popupURL.startsWith(extension.baseURI.spec)
    ) {
      throw new Error("The extension popup URL is outside its own origin");
    }
    if (!validAnchorId(anchorId)) {
      throw new TypeError("The extension popup anchor ID is invalid");
    }
    if (typeof browserStyle !== "boolean") {
      throw new TypeError("The extension popup browser-style state is invalid");
    }

    this.closeWindow(ownerWindow);
    const { document } = ownerWindow;
    const popupset = document.getElementById("navis-popupset");
    const initialAnchor = document.getElementById(anchorId);
    if (!popupset || !initialAnchor?.isConnected) {
      throw new Error("The extension popup does not have a live Platform host");
    }

    const panel = document.createXULElement("panel");
    const accessibleName = String(extension.name || extension.id).slice(0, 256);
    panel.id = "navis-extension-popup";
    panel.classList.add("navis-extension-popup", "panel-no-padding");
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", accessibleName);
    panel.setAttribute("tabspecific", "true");
    panel.setAttribute("remote", "true");
    panel.setAttribute("neverhidden", "true");

    const stack = document.createXULElement("stack");
    stack.classList.add("navis-extension-popup-stack");
    const browser = document.createXULElement("browser");
    browser.classList.add("navis-extension-popup-browser");
    browser.setAttribute("aria-label", accessibleName);
    browser.setAttribute("type", "content");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("messagemanagergroup", "webext-browsers");
    browser.setAttribute("webextension-view-type", "popup");
    browser.setAttribute("constrainpopups", "false");
    browser.setAttribute(
      "initialBrowsingContextGroupId",
      extension.policy.browsingContextGroupId
    );
    browser.setAttribute("remote", "true");
    browser.setAttribute("remoteType", extension.remoteType);
    browser.setAttribute("maychangeremoteness", "true");
    browser.style.width = `${FALLBACK_WIDTH}px`;
    browser.style.height = `${FALLBACK_HEIGHT}px`;

    const frameLoaderReady = new Promise(resolve => {
      browser.addEventListener("XULFrameLoaderCreated", resolve, {
        once: true,
      });
    });
    stack.append(browser);
    panel.append(stack);
    popupset.append(panel);

    let resolveContentReady;
    const contentReady = new Promise(resolve => {
      resolveContentReady = resolve;
    });

    const state = {
      ownerWindow,
      extensionId: extension.id,
      panel,
      browser,
      destroyed: false,
      browserStyle,
      contentReady,
      resolveContentReady,
      messageManager: null,
      receiveMessage: message => this.#receiveMessage(state, message),
      onPopupHidden: () => this.#destroy(state),
      onPopupShown: () => {
        state.messageManager?.sendAsyncMessage("Extension:GrabFocus", {});
      },
      onWindowClose: event => {
        event.preventDefault();
        event.stopPropagation();
        this.closeWindow(ownerWindow);
      },
      onCrash: () => this.closeWindow(ownerWindow),
      onRemotenessChanged: () => this.#initializeBrowser(state),
    };
    this.#byWindow.set(ownerWindow, state);
    this.#openPopups.add(state);
    DesktopExtensionActions.setPopupOpen(ownerWindow, true);
    panel.addEventListener("popuphidden", state.onPopupHidden, { once: true });
    panel.addEventListener("popupshown", state.onPopupShown);
    browser.addEventListener("DOMWindowClose", state.onWindowClose);
    browser.addEventListener("oop-browser-crashed", state.onCrash);
    browser.addEventListener(
      "DidChangeBrowserRemoteness",
      state.onRemotenessChanged
    );

    await frameLoaderReady;
    if (state.destroyed) {
      return false;
    }
    this.#initializeBrowser(state);
    browser.fixupAndLoadURIString(popupURL, {
      triggeringPrincipal: extension.principal,
    });
    await contentReady;
    if (state.destroyed) {
      return false;
    }
    const liveAnchor = document.getElementById(anchorId);
    if (!liveAnchor?.isConnected) {
      this.#destroy(state);
      throw new Error(
        "The extension popup anchor disappeared during initialization"
      );
    }
    panel.openPopup(liveAnchor, "after_end", 0, 4, false, false);
    return true;
  }

  closeWindow(ownerWindow) {
    const state = this.#byWindow.get(ownerWindow);
    if (!state) {
      return false;
    }
    if (state.panel.state === "open" || state.panel.state === "showing") {
      state.panel.hidePopup();
    } else {
      this.#destroy(state);
    }
    return true;
  }

  closeExtension(extensionId) {
    let closed = false;
    for (const state of [...this.#openPopups]) {
      if (state.extensionId === extensionId) {
        closed = this.closeWindow(state.ownerWindow) || closed;
      }
    }
    return closed;
  }

  close() {
    for (const state of [...this.#openPopups]) {
      this.closeWindow(state.ownerWindow);
    }
  }

  #initializeBrowser(state) {
    if (state.destroyed) {
      return;
    }
    const messageManager = state.browser.messageManager;
    if (!messageManager || state.messageManager === messageManager) {
      return;
    }
    this.#removeMessageListeners(state);
    state.messageManager = messageManager;
    for (const name of [
      "Extension:BrowserBackgroundChanged",
      "Extension:BrowserContentLoaded",
      "Extension:BrowserResized",
    ]) {
      messageManager.addMessageListener(name, state.receiveMessage);
    }
    ExtensionParent.apiManager.emit(
      "extension-browser-inserted",
      state.browser
    );
    messageManager.loadFrameScript(
      "chrome://extensions/content/ext-browser-content.js",
      false,
      true
    );
    messageManager.sendAsyncMessage("Extension:InitBrowser", {
      allowScriptsToClose: true,
      blockParser: false,
      fixedWidth: false,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      stylesheets: state.browserStyle
        ? [BROWSER_STYLE_STYLESHEET, POPUP_STYLESHEET]
        : [POPUP_STYLESHEET],
    });
  }

  #receiveMessage(state, { name, data }) {
    if (state.destroyed) {
      return;
    }
    if (name === "Extension:BrowserResized") {
      const width = boundedDimension(
        data?.width,
        MIN_WIDTH,
        MAX_WIDTH,
        FALLBACK_WIDTH
      );
      const height = boundedDimension(
        data?.height,
        MIN_HEIGHT,
        MAX_HEIGHT,
        FALLBACK_HEIGHT
      );
      state.browser.style.width = `${width}px`;
      state.browser.style.minWidth = `${width}px`;
      state.browser.style.height = `${height}px`;
      state.browser.style.minHeight = `${height}px`;
      state.browser.frameLoader?.requestUpdatePosition();
      state.resolveContentReady?.();
      state.resolveContentReady = null;
      return;
    }
    if (name === "Extension:BrowserBackgroundChanged") {
      const background = data?.background;
      if (
        typeof background === "string" &&
        background.length <= 128 &&
        state.ownerWindow.CSS.supports("color", background)
      ) {
        state.panel.style.setProperty(
          "--navis-extension-popup-background",
          background
        );
      }
      return;
    }
    if (name === "Extension:BrowserContentLoaded") {
      state.messageManager?.sendAsyncMessage("Extension:GrabFocus", {});
    }
  }

  #removeMessageListeners(state) {
    if (!state.messageManager) {
      return;
    }
    for (const name of [
      "Extension:BrowserBackgroundChanged",
      "Extension:BrowserContentLoaded",
      "Extension:BrowserResized",
    ]) {
      try {
        state.messageManager.removeMessageListener(name, state.receiveMessage);
      } catch {}
    }
    state.messageManager = null;
  }

  #destroy(state) {
    if (state.destroyed) {
      return;
    }
    state.destroyed = true;
    state.resolveContentReady?.();
    state.resolveContentReady = null;
    this.#removeMessageListeners(state);
    state.panel.removeEventListener("popupshown", state.onPopupShown);
    state.browser.removeEventListener("DOMWindowClose", state.onWindowClose);
    state.browser.removeEventListener("oop-browser-crashed", state.onCrash);
    state.browser.removeEventListener(
      "DidChangeBrowserRemoteness",
      state.onRemotenessChanged
    );
    state.panel.remove();
    this.#openPopups.delete(state);
    if (this.#byWindow.get(state.ownerWindow) === state) {
      this.#byWindow.delete(state.ownerWindow);
      DesktopExtensionActions.setPopupOpen(state.ownerWindow, false);
    }
  }
}
