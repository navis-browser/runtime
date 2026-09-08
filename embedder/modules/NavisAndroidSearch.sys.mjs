/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { NavisSearchService } from "resource://gre/modules/NavisSearchService.sys.mjs";
import { classifyAddressInput } from "resource://gre/modules/DesktopAddressInput.sys.mjs";
import { rankLocalSuggestions } from "resource://gre/modules/NavisSuggestionPolicy.sys.mjs";
import { PrivateBrowsingUtils } from "resource://gre/modules/PrivateBrowsingUtils.sys.mjs";

const requests = new WeakMap();

export async function initializeAndroidSearch(legacy) {
  return NavisSearchService.init(legacy);
}

function keys(data, allowed) {
  if (Object.keys(data).some(key => !allowed.includes(key))) throw new TypeError("Invalid search arguments");
}

function requestId(data) {
  if (typeof data.requestId !== "string" || !/^[a-z0-9-]{1,64}$/u.test(data.requestId)) {
    throw new TypeError("Invalid suggestion request identity");
  }
  return data.requestId;
}

/** The native product transport carries values only; privacy comes from the live Core Session. */
export async function queryAndroidSearch(window, operation, data) {
  const browser = window.tab?.linkedBrowser;
  if (!browser || window.closed) throw new Error("Search request has no live host");
  const privateMode = PrivateBrowsingUtils.isBrowserPrivate(browser);
  switch (operation) {
    case "search:get": keys(data, []); return NavisSearchService.snapshot;
    case "search:default": keys(data, ["id"]); await NavisSearchService.setDefault(data.id); break;
    case "search:upsert":
      keys(data, ["id", "name", "template", "suggestionTemplate"]);
      await NavisSearchService.upsert(data); break;
    case "search:remove": keys(data, ["id"]); await NavisSearchService.remove(data.id); break;
    case "search:move": keys(data, ["id", "index"]); await NavisSearchService.move(data.id, data.index); break;
    case "search:remote":
      keys(data, ["enabled"]);
      await NavisSearchService.setRemoteSuggestionsEnabled(data.enabled); break;
    case "search:resolve": {
      keys(data, ["query", "forceSearch"]);
      if (typeof data.forceSearch !== "boolean") throw new TypeError("Expected explicit search mode");
      const input = data.forceSearch ? { kind: "search", query: data.query } : classifyAddressInput(data.query);
      return input.kind === "url" ? { url: input.url } : NavisSearchService.submission(input.query, { privateMode });
    }
    case "search:local-rank":
      keys(data, ["query", "candidates"]);
      if (!Array.isArray(data.candidates) || data.candidates.length > 500) throw new TypeError("Invalid local candidates");
      return { suggestions: rankLocalSuggestions(data.query, data.candidates, { privateMode, maxResults: 6 }) };
    case "search:cancel": {
      keys(data, ["requestId"]);
      const id = requestId(data);
      const pending = requests.get(browser);
      if (pending?.id === id) { pending.controller.abort(); requests.delete(browser); }
      return { cancelled: true };
    }
    case "search:suggest": {
      keys(data, ["query", "requestId"]);
      const id = requestId(data);
      requests.get(browser)?.controller.abort();
      const controller = new AbortController();
      const original = browser.browsingContext?.currentWindowGlobal;
      const pending = { id, controller };
      requests.set(browser, pending);
      const abort = () => controller.abort();
      window.addEventListener("unload", abort, { once: true });
      try {
        const suggestions = await NavisSearchService.suggestions(data.query, {
          privateMode, signal: controller.signal, maxResults: 5,
        });
        if (controller.signal.aborted || window.closed || requests.get(browser) !== pending ||
            browser.browsingContext?.currentWindowGlobal !== original) return { suggestions: [] };
        return { suggestions };
      } finally {
        window.removeEventListener("unload", abort);
        if (requests.get(browser) === pending) requests.delete(browser);
      }
    }
    default: throw new TypeError("Unknown search operation");
  }
  return NavisSearchService.snapshot;
}
