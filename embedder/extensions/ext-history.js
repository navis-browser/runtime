/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError */

  ChromeUtils.defineESModuleGetters(this, {
    getDesktopProfileStore:
      "resource://gre/modules/DesktopProfileStore.sys.mjs",
  });

  const MAX_RESULTS = 500;

  function historyItem(entry) {
    return {
      id: entry.url,
      url: entry.url,
      title: entry.title,
      lastVisitTime: entry.lastVisitedAt,
      visitCount: entry.visitCount,
      typedCount: 0,
    };
  }

  this.history = class extends ExtensionAPIPersistent {
    storeEvent(event, listener) {
      return ({ fire }) => {
        const store = getDesktopProfileStore();
        const routed = (_eventName, detail) => listener(fire, detail);
        store.on(event, routed);
        return {
          unregister: () => store.off(event, routed),
          convert(newFire) {
            fire = newFire;
          },
        };
      };
    }

    PERSISTENT_EVENTS = {
      onVisited: this.storeEvent("history-visited", (fire, entry) => {
        fire.async(historyItem(entry));
      }),
      onVisitRemoved: this.storeEvent("history-removed", (fire, detail) => {
        fire.async({ allHistory: detail.allHistory, urls: [...detail.urls] });
      }),
      onTitleChanged: this.storeEvent("history-title-changed", (fire, detail) =>
        fire.async({ url: detail.url, title: detail.title })
      ),
    };

    getAPI(context) {
      const store = getDesktopProfileStore();
      return {
        history: {
          onVisited: new EventManager({
            context,
            module: "history",
            event: "onVisited",
            extensionApi: this,
          }).api(),
          onVisitRemoved: new EventManager({
            context,
            module: "history",
            event: "onVisitRemoved",
            extensionApi: this,
          }).api(),
          onTitleChanged: new EventManager({
            context,
            module: "history",
            event: "onTitleChanged",
            extensionApi: this,
          }).api(),

          async search(query) {
            const limit = Math.min(query.maxResults ?? 100, MAX_RESULTS);
            const startTime =
              query.startTime ?? Date.now() - 24 * 60 * 60 * 1000;
            const endTime = query.endTime ?? Number.POSITIVE_INFINITY;
            const entries = await store.queryHistory({
              search: query.text,
              limit: MAX_RESULTS,
            });
            return entries
              .filter(
                entry =>
                  entry.lastVisitedAt >= startTime &&
                  entry.lastVisitedAt <= endTime
              )
              .slice(0, limit)
              .map(historyItem);
          },

          async getVisits({ url }) {
            const visits = await store.getHistoryVisits(url);
            return visits.map(visit => ({
              id: url,
              visitId: visit.id,
              visitTime: visit.visitTime,
              referringVisitId: "0",
              transition: "link",
            }));
          },

          async addUrl({ url, title = "", visitTime = Date.now() }) {
            const uri = Services.io.newURI(url);
            if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
              throw new ExtensionError(
                "Navis history accepts HTTP(S) addresses only"
              );
            }
            await store.addHistoryVisit({
              url: uri.spec,
              title,
              visitedAt: visitTime,
            });
          },

          async deleteUrl({ url }) {
            await store.deleteHistory([url]);
          },

          async deleteRange({ startTime, endTime }) {
            await store.deleteHistoryRange(startTime, endTime);
          },

          async deleteAll() {
            await store.clearHistory();
          },
        },
      };
    }
  };
}
