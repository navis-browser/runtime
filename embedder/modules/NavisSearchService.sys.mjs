/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  NAVIS_SEARCH_CATALOGUE,
  isNavisSuggestionQuery,
  validateNavisSearchProvider,
} from "resource://gre/modules/NavisSearchPolicy.sys.mjs";

const SEARCH_TYPE = "text/html";
const SUGGEST_TYPE = "application/x-suggestions+json";
const IMPORT_VERSION = "navis-import-version";
const REMOTE_CONSENT = "navis-remote-suggestions";
const BAIDU_SUGGESTIONS_VERSION = "navis-baidu-suggestions-version";
const PROVIDER_ID = "navis-provider-id";
const DISPLAY_NAME = "navis-display-name";
const EMPTY = Object.freeze([]);

/** Core-private adapter: all engines, order, defaults and writes belong to Gecko. */
export class NavisSearchAdapter {
  #service;
  #makeController;
  #ready = null;
  #legacy = null;
  #snapshot = null;
  #initialized = false;
  #engines = new Map();
  #queue = Promise.resolve();
  #requests = new Set();
  #revision = 0;
  #mutating = false;

  constructor({ searchService, createSuggestionController }) {
    this.#service = searchService;
    this.#makeController = createSuggestionController;
  }

  init(legacy) {
    if (this.#ready) return this.#ready;
    if (legacy !== undefined) this.#legacy = structuredClone(legacy);
    this.#ready = this.#initialize(this.#legacy ?? {}).catch(error => {
      this.#ready = null;
      this.#initialized = false;
      throw error;
    });
    return this.#ready;
  }

  async #initialize(legacy) {
    await this.#service.init();
    const settings = this.#service._settings;
    if (settings.getMetaDataAttribute(IMPORT_VERSION) !== 1) {
      const providers = (legacy.providers ?? NAVIS_SEARCH_CATALOGUE).map(value => {
        // Old records had no suggestion field. Only unchanged built-ins receive
        // the catalogue endpoint; a user's edited endpoint stays unconfigured.
        const builtin = NAVIS_SEARCH_CATALOGUE.find(item => item.id === value.id);
        return validateNavisSearchProvider({
          ...value,
          suggestionTemplate: value.suggestionTemplate ??
            (builtin?.template === value.template ? builtin.suggestionTemplate : ""),
        });
      });
      if (!providers.length || providers.length > 64 ||
          new Set(providers.map(item => item.id)).size !== providers.length ||
          NAVIS_SEARCH_CATALOGUE.some(item => !providers.some(value => value.id === item.id))) {
        throw new TypeError("Invalid legacy search provider collection");
      }
      await this.#refresh();
      for (const provider of providers) await this.#writeProvider(provider);
      for (let index = 0; index < providers.length; index++) {
        await this.#service.moveEngine(this.#engines.get(providers[index].id), index);
      }
      const selected = this.#engines.get(legacy.defaultProviderId) ?? this.#engines.get("google");
      await this.#service.setDefault(selected, this.#service.CHANGE_REASON.USER);
      settings.setMetaDataAttribute(REMOTE_CONSENT, legacy.remoteSuggestionsEnabled === true);
      // Marker is in the same atomic search.json.mozlz4 write as the engines.
      // Partial migration is idempotent by persisted provider ID on next startup.
      settings.setMetaDataAttribute(IMPORT_VERSION, 1);
      settings.setMetaDataAttribute(BAIDU_SUGGESTIONS_VERSION, 1);
      try {
        await settings._write();
      } catch (error) {
        settings.setMetaDataAttribute(IMPORT_VERSION, undefined);
        settings.setMetaDataAttribute(BAIDU_SUGGESTIONS_VERSION, undefined);
        throw error;
      }
    }
    await this.#upgradeBaiduSuggestions();
    const snapshot = await this.#refresh();
    this.#initialized = true;
    return snapshot;
  }

  async #upgradeBaiduSuggestions() {
    const settings = this.#service._settings;
    const previousVersion = settings.getMetaDataAttribute(BAIDU_SUGGESTIONS_VERSION);
    if (previousVersion === 1) return;
    const snapshot = await this.#refresh();
    const previous = snapshot.providers.find(provider => provider.id === "baidu");
    const builtin = NAVIS_SEARCH_CATALOGUE.find(provider => provider.id === "baidu");
    // Old releases omitted this endpoint and recorded no edit provenance.
    // Backfill only that empty built-in on its original search template, once.
    // Never replace a custom endpoint/search URL or refill a later user clear.
    const upgrade = previous && !previous.suggestionTemplate && previous.template === builtin.template;
    try {
      if (upgrade) await this.#writeProvider({ ...previous, suggestionTemplate: builtin.suggestionTemplate });
      settings.setMetaDataAttribute(BAIDU_SUGGESTIONS_VERSION, 1);
      await settings._write();
    } catch (error) {
      settings.setMetaDataAttribute(BAIDU_SUGGESTIONS_VERSION, previousVersion);
      if (upgrade) await this.#writeProvider(previous);
      throw error;
    }
  }

  get snapshot() {
    if (!this.#initialized) throw new Error("Search service is not ready");
    return this.#snapshot;
  }

  async #refresh() {
    const engines = await this.#service.getVisibleEngines();
    this.#engines = new Map(engines.filter(engine => engine.getAttr(PROVIDER_ID))
      .map(engine => [engine.getAttr(PROVIDER_ID), engine]));
    const providers = [...this.#engines].map(([id, engine]) => validateNavisSearchProvider({
      id, name: engine.getAttr(DISPLAY_NAME) ?? engine.name,
      template: engine.getURLOfType(SEARCH_TYPE).template,
      suggestionTemplate: engine.getURLOfType(SUGGEST_TYPE)?.template ?? "",
    }));
    this.#snapshot = Object.freeze({
      providers: Object.freeze(providers),
      defaultProviderId: this.#service.defaultEngine.getAttr(PROVIDER_ID),
      remoteSuggestionsEnabled: this.#service._settings.getMetaDataAttribute(REMOTE_CONSENT) === true,
    });
    return this.#snapshot;
  }

  #mutate(operation) {
    const result = this.#queue.then(async () => {
      await this.init();
      let rollback;
      this.#mutating = true;
      this.#revision++;
      this.#cancelRequests();
      try {
        await operation(undo => { rollback = undo; });
        this.#revision++;
        this.#cancelRequests();
        const snapshot = await this.#refresh();
        await this.#service._settings._write();
        return snapshot;
      } catch (error) {
        if (rollback) {
          await rollback();
          this.#revision++;
          this.#cancelRequests();
          await this.#refresh();
        }
        throw error;
      } finally {
        this.#mutating = false;
      }
    });
    this.#queue = result.catch(() => {});
    return result;
  }

  #engine(id) {
    const engine = this.#engines.get(id);
    if (!engine) throw new TypeError("Unknown search provider");
    return engine;
  }

  async #writeProvider(provider) {
    let engine = this.#engines.get(provider.id);
    // Gecko requires unique engine names. Preserve duplicate user-facing names
    // in metadata, using a disambiguated internal name only where necessary.
    let name = provider.name;
    for (let suffix = 0; ; suffix++) {
      const existing = this.#service.getEngineByName(name);
      if (!existing || existing === engine) break;
      name = `${provider.name} [${provider.id}${suffix ? `-${suffix}` : ""}]`;
    }
    const formInfo = { name, url: provider.template,
      suggestUrl: provider.suggestionTemplate || undefined };
    if (engine) {
      engine.updateWithFormInfo(formInfo);
    } else {
      engine = await this.#service.addUserEngine(formInfo);
      engine.setAttr(PROVIDER_ID, provider.id);
      this.#engines.set(provider.id, engine);
    }
    engine.setAttr(DISPLAY_NAME, provider.name);
  }

  upsert(value) {
    const provider = validateNavisSearchProvider(value);
    return this.#mutate(async undo => {
      if (!this.#engines.has(provider.id) && this.#engines.size >= 64) {
        throw new RangeError("Search provider limit reached");
      }
      const previous = this.snapshot.providers.find(item => item.id === provider.id);
      undo(async () => {
        if (previous) await this.#writeProvider(previous);
        else if (this.#engines.has(provider.id)) {
          await this.#service.removeEngine(this.#engines.get(provider.id), this.#service.CHANGE_REASON.USER);
        }
      });
      await this.#writeProvider(provider);
    });
  }

  setDefault(id) {
    return this.#mutate(undo => {
      const engine = this.#engine(id);
      const previous = this.#service.defaultEngine;
      undo(() => this.#service.setDefault(previous, this.#service.CHANGE_REASON.USER));
      return this.#service.setDefault(engine, this.#service.CHANGE_REASON.USER);
    });
  }

  remove(id) {
    return this.#mutate(undo => {
      const engine = this.#engine(id);
      if (NAVIS_SEARCH_CATALOGUE.some(provider => provider.id === id)) {
        throw new TypeError("Built-in search providers cannot be removed");
      }
      const position = this.snapshot.providers.findIndex(provider => provider.id === id);
      const previousDefault = this.#service.defaultEngine;
      undo(async () => {
        if (!this.#service.getEngineByName(engine.name)) await this.#service.addSearchEngine(engine);
        await this.#service.moveEngine(engine, position);
        await this.#service.setDefault(previousDefault, this.#service.CHANGE_REASON.USER);
      });
      return this.#service.removeEngine(engine, this.#service.CHANGE_REASON.USER);
    });
  }

  move(id, position) {
    return this.#mutate(undo => {
      const engine = this.#engine(id);
      if (!Number.isInteger(position) || position < 0 || position >= this.#engines.size) {
        throw new RangeError("Invalid search provider position");
      }
      const previous = this.snapshot.providers.findIndex(provider => provider.id === id);
      undo(() => this.#service.moveEngine(engine, previous));
      return this.#service.moveEngine(engine, position);
    });
  }

  setRemoteSuggestionsEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("Suggestion setting must be boolean");
    return this.#mutate(undo => {
      const previous = this.snapshot.remoteSuggestionsEnabled;
      undo(() => this.#service._settings.setMetaDataAttribute(REMOTE_CONSENT, previous));
      this.#service._settings.setMetaDataAttribute(REMOTE_CONSENT, enabled);
    });
  }

  submission(query, { providerId, privateMode = false } = {}) {
    this.snapshot;
    if (typeof query !== "string" || !query.trim() || query.length > 16384 ||
        typeof privateMode !== "boolean") throw new TypeError("Invalid search request");
    const engine = providerId ? this.#engine(providerId) : privateMode
      ? this.#service.defaultPrivateEngine : this.#service.defaultEngine;
    const result = engine.getSubmission(query.trim(), SEARCH_TYPE);
    if (!result?.uri || result.postData) throw new Error("Search provider requires an unsupported submission");
    return Object.freeze({ url: result.uri.spec });
  }

  async suggestions(query, { providerId, privateMode = false, signal, maxResults = 5 } = {}) {
    await this.init();
    if (this.#mutating || !this.snapshot.remoteSuggestionsEnabled || privateMode !== false || signal?.aborted ||
        !isNavisSuggestionQuery(query)) return EMPTY;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
      throw new RangeError("Invalid suggestion limit");
    }
    const engine = this.#engine(providerId ?? this.snapshot.defaultProviderId);
    if (!engine.getURLOfType(SUGGEST_TYPE)) return EMPTY;
    const controller = this.#makeController();
    const revision = this.#revision;
    const stop = () => controller.stop();
    this.#requests.add(controller);
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (signal?.aborted) return EMPTY;
      const result = await controller.fetch({
        searchString: query.trim(), inPrivateBrowsing: false, engine,
        maxLocalResults: 0, maxRemoteResults: maxResults,
      });
      if (signal?.aborted || revision !== this.#revision || !this.snapshot.remoteSuggestionsEnabled) return EMPTY;
      return Object.freeze([...new Set((result?.remote ?? []).map(item => item.value)
        .filter(value => typeof value === "string" && value.length <= 256 &&
          value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)))].slice(0, maxResults));
    } catch {
      return EMPTY;
    } finally {
      signal?.removeEventListener("abort", stop);
      this.#requests.delete(controller);
      controller.stop();
    }
  }

  #cancelRequests() {
    for (const controller of this.#requests) controller.stop();
    this.#requests.clear();
  }
}

// Imports are deferred until the actual backend starts; the class is injectable
// for deterministic contract tests without starting Gecko or opening a Profile.
let instance;
export const NavisSearchService = new Proxy({}, {
  get(_target, key) {
    if (!instance) {
      // A cold DNS/TLS connection can exceed Gecko's 500 ms suggestion budget.
      // This shared product default retains explicit user overrides; cancellation
      // still aborts superseded requests immediately on every platform.
      Services.prefs.getDefaultBranch("").setIntPref("browser.search.suggest.timeout", 2000);
      instance = new NavisSearchAdapter({
        searchService: ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs").SearchService,
        createSuggestionController: () => new (ChromeUtils.importESModule(
          "moz-src:///toolkit/components/search/SearchSuggestionController.sys.mjs"
        ).SearchSuggestionController)(),
      });
    }
    const value = instance[key];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
