/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MAX_ICON_URL_LENGTH = 131072;

/** Projects favicon candidates without exposing DOM nodes to the parent. */
export class DesktopFaviconChild extends JSWindowActorChild {
  #seenDocument = null;
  #seenDeclaredIcon = false;

  handleEvent(event) {
    const document = this.contentWindow.document;
    if (event.type === "pagehide") {
      if (event.target === document) {
        this.#reset();
      }
      return;
    }
    if (event.type === "pageshow") {
      if (event.target === document) {
        this.#ensureDocument(document);
        this.#sendDefault(document);
      }
      return;
    }
    if (event.type === "DOMHeadElementParsed") {
      if (event.target?.ownerDocument === document) {
        this.#ensureDocument(document);
        this.#sendDefault(document);
      }
      return;
    }

    const link = event.target;
    if (
      link?.ownerDocument !== document ||
      link.documentGlobal !== this.contentWindow
    ) {
      return;
    }
    this.#ensureDocument(document);
    const relations = new Set(
      String(link.rel || "")
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean)
    );
    // A tab favicon is the standardized `icon` relation. Rich touch icons are
    // deliberately not allowed to displace a smaller tab icon late in head
    // parsing; /favicon.ico remains the fallback when no tab icon exists.
    if (!relations.has("icon")) {
      return;
    }
    if (relations.has("mask-icon") || link.hasAttribute("color")) {
      return;
    }
    const href = link.getAttribute("href");
    if (!href || href.length > MAX_ICON_URL_LENGTH) {
      return;
    }
    let iconURL;
    try {
      iconURL = new this.contentWindow.URL(href, document.baseURI);
    } catch {
      return;
    }
    if (
      !["http:", "https:", "data:"].includes(iconURL.protocol) ||
      iconURL.href.length > MAX_ICON_URL_LENGTH
    ) {
      return;
    }
    this.#seenDeclaredIcon = true;
    this.#send(document, iconURL.href, false);
  }

  #ensureDocument(document) {
    if (this.#seenDocument === document) {
      return;
    }
    this.#seenDocument = document;
    this.#seenDeclaredIcon = false;
  }

  #sendDefault(document) {
    if (this.#seenDeclaredIcon) {
      return;
    }
    const pageURI = document.documentURIObject;
    if (!["http", "https"].includes(pageURI.scheme)) {
      return;
    }
    const iconURI = pageURI.mutate().setPathQueryRef("/favicon.ico").finalize();
    this.#send(document, iconURI.spec, true);
  }

  #send(document, iconURL, isDefault) {
    this.sendAsyncMessage("DesktopFavicon:Candidate", {
      pageURL: document.documentURI,
      iconURL,
      isDefault: Boolean(isDefault),
    });
  }

  #reset() {
    this.#seenDocument = null;
    this.#seenDeclaredIcon = false;
  }
}
