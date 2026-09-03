/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { EventEmitter } from "resource://gre/modules/EventEmitter.sys.mjs";
import { DesktopExtensionTabs } from "resource://gre/modules/DesktopExtensionTabs.sys.mjs";

const MAX_SUGGESTIONS = 12;
const MAX_CONTENT_LENGTH = 8192;
const MAX_DESCRIPTION_LENGTH = 4096;

const EVENTS = Object.freeze({
  cancelled: "navis-omnibox-input-cancelled",
  changed: "navis-omnibox-input-changed",
  deleted: "navis-omnibox-suggestion-deleted",
  entered: "navis-omnibox-input-entered",
  started: "navis-omnibox-input-started",
});

function boundedText(value, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function plainDescription(value) {
  return boundedText(value, MAX_DESCRIPTION_LENGTH)
    .replace(/<\/?(?:dim|match|url)>/giu, "")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&");
}

function inactiveSnapshot() {
  return Object.freeze({
    active: false,
    defaultDescription: "",
    extensionId: "",
    extensionName: "",
    input: "",
    keyword: "",
    suggestions: Object.freeze([]),
  });
}

class DesktopExtensionOmniboxRegistry extends EventEmitter {
  #entries = new Map();
  #sessions = new Map();
  #nextRequestId = 1;

  constructor() {
    super();
    DesktopExtensionTabs.on("tab-removed", (_eventName, event) => {
      this.cancel(event.nativeTab);
    });
  }

  register(keyword, extension) {
    if (
      typeof keyword !== "string" ||
      !/^[^?\s:][^\s:]*$/u.test(keyword) ||
      keyword.length > 128
    ) {
      throw new Error("The extension omnibox keyword is invalid");
    }
    const existing = this.#entries.get(keyword);
    if (existing && existing.extension !== extension) {
      throw new Error(`The omnibox keyword '${keyword}' is already registered`);
    }
    this.#entries.set(keyword, {
      defaultDescription: "",
      extension,
      extensionId: extension.id,
      extensionName: boundedText(extension.name, 256) || extension.id,
      keyword,
    });
  }

  unregister(keyword, extension) {
    const entry = this.#entries.get(keyword);
    if (!entry || entry.extension !== extension) {
      return false;
    }
    this.#entries.delete(keyword);
    for (const [nativeTab, session] of this.#sessions) {
      if (session.entry === entry) {
        this.cancel(nativeTab);
      }
    }
    return true;
  }

  setDefaultSuggestion(keyword, extension, suggestion) {
    const entry = this.#entries.get(keyword);
    if (!entry || entry.extension !== extension) {
      throw new Error(`The omnibox keyword '${keyword}' is unavailable`);
    }
    entry.defaultDescription = plainDescription(suggestion?.description);
    for (const [nativeTab, session] of this.#sessions) {
      if (session.entry === entry) {
        this.#notify(nativeTab);
      }
    }
  }

  update(nativeTab, value) {
    const input = boundedText(value, MAX_CONTENT_LENGTH);
    const match = /^(\S+)\s(.*)$/su.exec(input);
    const entry = match ? this.#entries.get(match[1]) : null;
    const current = this.#sessions.get(nativeTab);
    if (!entry) {
      if (current) {
        this.cancel(nativeTab);
      }
      return inactiveSnapshot();
    }

    const query = match[2];
    let session = current;
    if (!session || session.entry !== entry) {
      if (session) {
        this.cancel(nativeTab);
      }
      session = {
        entry,
        input: query,
        requestId: 0,
        suggestions: [],
      };
      this.#sessions.set(nativeTab, session);
      entry.extension.emit(EVENTS.started);
    }

    if (session.input !== query || session.requestId === 0) {
      session.input = query;
      session.requestId = this.#nextRequestId++;
      session.suggestions = [];
      entry.extension.emit(EVENTS.changed, query, session.requestId);
    }
    this.#notify(nativeTab);
    return this.snapshot(nativeTab);
  }

  addSuggestions(keyword, extension, requestId, suggestions) {
    const entry = this.#entries.get(keyword);
    if (!entry || entry.extension !== extension || !Array.isArray(suggestions)) {
      return false;
    }
    const sessionEntry = [...this.#sessions].find(
      ([, session]) =>
        session.entry === entry && session.requestId === requestId
    );
    if (!sessionEntry) {
      return false;
    }
    const [nativeTab, session] = sessionEntry;
    session.suggestions = suggestions
      .slice(0, MAX_SUGGESTIONS)
      .map(suggestion =>
        Object.freeze({
          content: boundedText(suggestion?.content, MAX_CONTENT_LENGTH),
          deletable: Boolean(suggestion?.deletable),
          description: plainDescription(suggestion?.description),
        })
      )
      .filter(suggestion => suggestion.content && suggestion.description);
    this.#notify(nativeTab);
    return true;
  }

  accept(nativeTab, content = null, disposition = "currentTab") {
    const session = this.#sessions.get(nativeTab);
    if (!session) {
      return false;
    }
    const value =
      typeof content === "string" && content
        ? boundedText(content, MAX_CONTENT_LENGTH)
        : session.input;
    this.#sessions.delete(nativeTab);
    session.entry.extension.emit(EVENTS.entered, value, disposition);
    this.#notify(nativeTab);
    return true;
  }

  cancel(nativeTab) {
    const session = this.#sessions.get(nativeTab);
    if (!session) {
      return false;
    }
    this.#sessions.delete(nativeTab);
    session.entry.extension.emit(EVENTS.cancelled);
    this.#notify(nativeTab);
    return true;
  }

  deleteSuggestion(nativeTab, content) {
    const session = this.#sessions.get(nativeTab);
    const suggestion = session?.suggestions.find(
      candidate => candidate.content === content && candidate.deletable
    );
    if (!suggestion) {
      return false;
    }
    session.suggestions = session.suggestions.filter(
      candidate => candidate !== suggestion
    );
    session.entry.extension.emit(EVENTS.deleted, content);
    this.#notify(nativeTab);
    return true;
  }

  snapshot(nativeTab) {
    const session = this.#sessions.get(nativeTab);
    if (!session) {
      return inactiveSnapshot();
    }
    return Object.freeze({
      active: true,
      defaultDescription: session.entry.defaultDescription,
      extensionId: session.entry.extensionId,
      extensionName: session.entry.extensionName,
      input: session.input,
      keyword: session.entry.keyword,
      suggestions: Object.freeze([...session.suggestions]),
    });
  }

  #notify(nativeTab) {
    this.emit("state-changed", {
      nativeTab,
      state: this.snapshot(nativeTab),
    });
  }
}

export { EVENTS as DESKTOP_EXTENSION_OMNIBOX_EVENTS };
export const DesktopExtensionOmnibox = new DesktopExtensionOmniboxRegistry();
