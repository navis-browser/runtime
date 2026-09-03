/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const MAX_ICON_BYTES = 512 * 1024;
const MAX_ICON_URL_LENGTH = 131072;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

function readAsDataURL(bytes, type) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result), { once: true });
    reader.addEventListener("error", reject, { once: true });
    reader.readAsDataURL(new Blob([bytes], { type }));
  });
}

/** Loads a bounded icon with the current content principal. */
export class DesktopFaviconParent extends JSWindowActorParent {
  #request = 0;
  #latestAppliedRequest = 0;

  receiveMessage(message) {
    if (
      message.name !== "DesktopFavicon:Candidate" ||
      !this.manager.isCurrentGlobal
    ) {
      return;
    }
    const browser = this.manager.rootFrameLoader?.ownerElement;
    const data = message.data || {};
    if (
      !browser ||
      typeof browser.desktopEmbedderFaviconChanged !== "function" ||
      typeof data.pageURL !== "string" ||
      typeof data.iconURL !== "string" ||
      data.iconURL.length > MAX_ICON_URL_LENGTH ||
      browser.currentURI?.spec !== data.pageURL
    ) {
      return;
    }
    const request = ++this.#request;
    this.#load(browser, data, request).catch(() => {});
  }

  async #load(browser, data, request) {
    const iconURI = Services.io.newURI(data.iconURL);
    if (!["http", "https", "data"].includes(iconURI.scheme)) {
      return;
    }
    const principal = browser.contentPrincipal;
    Services.scriptSecurityManager.checkLoadURIWithPrincipal(
      principal,
      iconURI,
      Services.scriptSecurityManager.ALLOW_CHROME
    );

    let dataURL;
    if (iconURI.schemeIs("data")) {
      if (
        data.iconURL.length > MAX_ICON_BYTES * 1.5 ||
        !/^data:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|vnd\.microsoft\.icon|webp|x-icon)[;,]/iu.test(
          data.iconURL
        )
      ) {
        return;
      }
      dataURL = data.iconURL;
    } else {
      dataURL = await this.#fetch(iconURI, principal);
    }
    if (
      request < this.#latestAppliedRequest ||
      !this.manager.isCurrentGlobal ||
      browser.currentURI?.spec !== data.pageURL
    ) {
      return;
    }
    this.#latestAppliedRequest = request;
    browser.desktopEmbedderFaviconChanged(this, {
      pageURL: data.pageURL,
      originalURL: data.iconURL,
      iconURL: dataURL,
      isDefault: Boolean(data.isDefault),
    });
  }

  #fetch(uri, principal) {
    const channel = lazy.NetUtil.newChannel({
      uri,
      loadingPrincipal: principal,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT |
        Ci.nsILoadInfo.SEC_ALLOW_CHROME |
        Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_FAVICON,
    });
    channel.loadFlags |=
      Ci.nsIRequest.LOAD_BACKGROUND |
      Ci.nsIRequest.VALIDATE_NEVER |
      Ci.nsIRequest.LOAD_FROM_CACHE;
    if (channel instanceof Ci.nsIHttpChannelInternal) {
      channel.blockAuthPrompt = true;
    }
    return new Promise((resolve, reject) => {
      lazy.NetUtil.asyncFetch(channel, async (input, status, request) => {
        if (!Components.isSuccessCode(status)) {
          reject(Components.Exception("Favicon load failed", status));
          return;
        }
        try {
          const length = input.available();
          if (length <= 0 || length > MAX_ICON_BYTES) {
            throw new RangeError("Favicon exceeds the Navis byte boundary");
          }
          const bytes = new Uint8Array(
            lazy.NetUtil.readInputStream(input, length)
          );
          input.close();
          const responseType = request.QueryInterface(Ci.nsIChannel).contentType;
          let type = responseType;
          if (!ALLOWED_IMAGE_TYPES.has(type)) {
            type = Cc["@mozilla.org/image/loader;1"]
              .createInstance(Ci.nsIContentSniffer)
              .getMIMETypeFromContent(request, bytes, bytes.length);
          }
          if (!ALLOWED_IMAGE_TYPES.has(type)) {
            throw new TypeError("Favicon response is not a supported image");
          }
          resolve(await readAsDataURL(bytes, type));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  didDestroy() {
    this.#request++;
    this.#latestAppliedRequest = this.#request;
  }
}
