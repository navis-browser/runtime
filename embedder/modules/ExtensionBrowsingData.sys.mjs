/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { getDesktopProfileStore } from "resource://gre/modules/DesktopProfileStore.sys.mjs";

const DATA_TYPES = Object.freeze([
  "cache",
  "cookies",
  "downloads",
  "formData",
  "history",
  "indexedDB",
  "localStorage",
  "passwords",
  "pluginData",
  "serverBoundCertificates",
  "serviceWorkers",
]);

async function clearDownloads(since = 0) {
  const list = await Downloads.getList(Downloads.ALL);
  for (const download of await list.getAll()) {
    const startedAt = download.startTime?.getTime?.() ?? 0;
    if (download.stopped && startedAt >= since) {
      await list.remove(download);
    }
  }
}

/** Product-backed pieces consumed by Toolkit's generic browsingData API. */
export class BrowsingDataDelegate {
  constructor(extension) {
    this.extension = extension;
  }

  handleRemoval(dataType, options) {
    const since = options.since ?? 0;
    const store = getDesktopProfileStore();
    switch (dataType) {
      case "downloads":
        return clearDownloads(since);
      case "formData":
        // Navis does not keep a separate durable form-history database.
        return Promise.resolve();
      case "history":
        return since
          ? store.deleteHistoryRange(since, Date.now())
          : store.clearHistory();
      case "passwords":
        return store.clearCredentials(since);
      case "serverBoundCertificates":
        // Gecko no longer stores the legacy server-bound certificate type.
        return Promise.resolve();
      default:
        return undefined;
    }
  }

  async settings() {
    const dataToRemove = {};
    const dataRemovalPermitted = {};
    for (const type of DATA_TYPES) {
      dataToRemove[type] = false;
      dataRemovalPermitted[type] = ![
        "pluginData",
        "serverBoundCertificates",
      ].includes(type);
    }
    return {
      options: {
        since: 0,
        originTypes: {
          extension: false,
          protectedWeb: false,
          unprotectedWeb: true,
        },
      },
      dataToRemove,
      dataRemovalPermitted,
    };
  }
}
