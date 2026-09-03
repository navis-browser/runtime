/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const DESKTOP_CLEAN_LINKS_PREF = "navis.cleanLinks.enabled";

const GECKO_CLEAN_LINK_PREFS = Object.freeze([
  "privacy.query_stripping.enabled",
  "privacy.query_stripping.enabled.pbmode",
  "privacy.query_stripping.redirect",
  "privacy.query_stripping.strip_on_share.enabled",
]);

let desktopCleanLinksReadiness = null;

function queryStringStripper() {
  return Cc["@mozilla.org/url-query-string-stripper;1"].getService(
    Ci.nsIURLQueryStringStripper
  );
}

function queryStringListService() {
  return Cc["@mozilla.org/query-stripping-list-service;1"].getService(
    Ci.nsIURLQueryStrippingListService
  );
}

function waitForListProjection(service, kind) {
  return new Promise((resolve, reject) => {
    const register =
      kind === "navigation"
        ? "registerAndRunObserver"
        : "registerAndRunObserverStripOnShare";
    const unregister =
      kind === "navigation"
        ? "unregisterObserver"
        : "unregisterStripOnShareObserver";
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      try {
        service[unregister](observer);
      } catch {}
      resolve();
    };
    const observer = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIURLQueryStrippingListObserver",
      ]),
      onQueryStrippingListUpdate() {
        if (kind === "navigation") {
          finish();
        }
      },
      onStripOnShareUpdate() {
        if (kind === "copy") {
          finish();
        }
      },
    };
    try {
      service[register](observer);
    } catch (error) {
      reject(error);
    }
  });
}

/** Returns the persisted product-level clean-links setting. */
export function getDesktopCleanLinksEnabled() {
  return Services.prefs.getBoolPref(DESKTOP_CLEAN_LINKS_PREF, false);
}

/**
 * Keeps Gecko's copy/share, top-level navigation and redirect paths on one
 * product decision. Gecko deliberately preserves same-site and add-on loads
 * for compatibility; Navis does not bypass those engine-level exceptions.
 */
export function synchronizeDesktopCleanLinkPreferences() {
  const enabled = getDesktopCleanLinksEnabled();
  for (const preference of GECKO_CLEAN_LINK_PREFS) {
    Services.prefs.setBoolPref(preference, enabled);
  }
  if (!enabled) {
    desktopCleanLinksReadiness = null;
  }
  return enabled;
}

/**
 * Starts Gecko's asynchronous policy service and resolves only after both
 * consumer projections have reached their observers. Navis configures those
 * projections from one bundled policy, so the first link after startup or
 * immediately after enabling cannot escape before that policy is ready.
 *
 * @returns {Promise<boolean>} Whether clean links remains enabled.
 */
export function prepareDesktopCleanLinks() {
  if (!synchronizeDesktopCleanLinkPreferences()) {
    return Promise.resolve(false);
  }
  if (!desktopCleanLinksReadiness) {
    // Constructing the stripper registers Gecko's own observers. The two
    // temporary public observers below are readiness barriers only; each
    // unregisters itself immediately after its first projected list.
    queryStringStripper();
    const service = queryStringListService();
    desktopCleanLinksReadiness = Promise.all([
      waitForListProjection(service, "navigation"),
      waitForListProjection(service, "copy"),
    ])
      .then(() => getDesktopCleanLinksEnabled())
      .catch(error => {
        desktopCleanLinksReadiness = null;
        throw error;
      });
  }
  return desktopCleanLinksReadiness;
}

/**
 * Persists and immediately applies the product-level clean-links setting.
 *
 * @param {boolean} enabled
 * @returns {boolean} The applied setting.
 */
export function setDesktopCleanLinksEnabled(enabled) {
  if (typeof enabled !== "boolean") {
    throw new TypeError("Clean-links setting must be a boolean");
  }
  Services.prefs.setBoolPref(DESKTOP_CLEAN_LINKS_PREF, enabled);
  return synchronizeDesktopCleanLinkPreferences();
}

/**
 * Projects an HTTP(S) link through Navis's unified Gecko-backed policy.
 * Invalid, unsupported and not-yet-matched values are copied unchanged.
 *
 * @param {string} value
 * @returns {string} The safe link text to copy.
 */
export function projectDesktopCopiedLink(value) {
  if (typeof value !== "string" || !value || !getDesktopCleanLinksEnabled()) {
    return value;
  }

  try {
    const uri = Services.io.newURI(value);
    if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
      return value;
    }
    const stripped = queryStringStripper().stripForCopyOrShare(uri) ?? uri;
    return Services.io.createExposableURI(stripped)?.displaySpec ?? value;
  } catch (error) {
    console.warn("Navis could not clean a copied link", error);
    return value;
  }
}
