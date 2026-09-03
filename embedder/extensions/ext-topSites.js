/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals ExtensionAPI */

  ChromeUtils.defineESModuleGetters(this, {
    getDesktopProfileStore:
      "resource://gre/modules/DesktopProfileStore.sys.mjs",
  });

  function siteKey(url) {
    try {
      const uri = Services.io.newURI(url);
      return Services.eTLD.getBaseDomain(uri);
    } catch {
      try {
        return Services.io.newURI(url).host;
      } catch {
        return url;
      }
    }
  }

  this.topSites = class extends ExtensionAPI {
    getAPI() {
      return {
        topSites: {
          async get(options = {}) {
            const limit = Math.min(options.limit ?? 12, 100);
            const entries = [
              ...(await getDesktopProfileStore().queryHistory({ limit: 500 })),
            ].sort(
              (left, right) =>
                right.visitCount - left.visitCount ||
                right.lastVisitedAt - left.lastVisitedAt
            );
            const seen = new Set();
            const results = [];
            for (const entry of entries) {
              const key = siteKey(entry.url);
              if (options.onePerDomain !== false && seen.has(key)) {
                continue;
              }
              seen.add(key);
              results.push({
                url: entry.url,
                title: entry.title,
                type: "url",
              });
              if (results.length === limit) {
                break;
              }
            }
            return results;
          },
        },
      };
    }
  };
}
