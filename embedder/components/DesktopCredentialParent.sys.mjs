/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const CONDITIONAL_PENDING_TOPIC = "webauthn:conditional-get-pending";
const CONDITIONAL_POLL_MS = 250;
const MAX_ACCOUNT_COUNT = 32;
const MAX_ACCOUNT_TEXT_LENGTH = 256;
const MAX_CREDENTIAL_ID_LENGTH = 1024;
const MAX_ORIGIN_LENGTH = 4096;

function webAuthnService() {
  return Cc["@mozilla.org/webauthn/service;1"].getService(
    Ci.nsIWebAuthnService
  );
}

function boundedText(value, maximum, { empty = true } = {}) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!empty && !value)
  ) {
    return null;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return null;
    }
  }
  return value;
}

function httpOrigin(value) {
  if (typeof value !== "string" || !value || value.length > MAX_ORIGIN_LENGTH) {
    return null;
  }
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function credentialId(value) {
  let bytes;
  try {
    bytes = Array.from(value);
  } catch {
    return null;
  }
  if (
    !bytes.length ||
    bytes.length > MAX_CREDENTIAL_ID_LENGTH ||
    bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    return null;
  }
  return bytes;
}

function projectEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ACCOUNT_COUNT) {
    return null;
  }
  const accounts = [];
  const credentialIds = [];
  let rpId = null;
  for (const entry of entries) {
    const userName = boundedText(
      entry?.userName ?? "",
      MAX_ACCOUNT_TEXT_LENGTH
    );
    const entryRpId = boundedText(entry?.rpId, 253, { empty: false });
    const id = credentialId(entry?.credentialId);
    if (userName === null || entryRpId === null || !id) {
      return null;
    }
    if (rpId !== null && entryRpId !== rpId) {
      return null;
    }
    rpId = entryRpId;
    accounts.push(Object.freeze({ name: userName, displayName: userName }));
    credentialIds.push(id);
  }
  return Object.freeze({
    accounts: Object.freeze(accounts),
    credentialIds,
    rpId,
  });
}

function getAutoFillEntries(service, tid) {
  return new Promise(resolve => {
    const callback = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebAuthnAutoFillEntriesCallback",
      ]),
      resolve,
      reject: () => resolve([]),
    };
    try {
      service.getAutoFillEntries(tid, callback);
    } catch {
      resolve(null);
    }
  });
}

/** Core-private bridge from password-form events to an owned EngineSession. */
export class DesktopCredentialParent extends JSWindowActorParent {
  #conditional = null;
  #observingConditional = false;
  #conditionalObserver = {
    QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
    observe: (subject, topic) => this.observe(subject, topic),
  };

  actorCreated() {
    Services.obs.addObserver(
      this.#conditionalObserver,
      CONDITIONAL_PENDING_TOPIC
    );
    this.#observingConditional = true;
  }

  observe(_subject, topic) {
    if (topic !== CONDITIONAL_PENDING_TOPIC) {
      return;
    }
    try {
      this.sendAsyncMessage("DesktopCredential:CheckConditional", {});
    } catch {
      // The actor may be between WindowGlobal replacement and didDestroy.
    }
  }

  receiveMessage(message) {
    const browser = this.browsingContext.top.embedderElement;
    if (message.name === "DesktopCredential:Query") {
      if (typeof browser?.desktopEmbedderCredentialQuery !== "function") {
        return Object.freeze({ credential: null });
      }
      return browser.desktopEmbedderCredentialQuery(this, message.data);
    }
    if (message.name === "DesktopCredential:Submit") {
      if (typeof browser?.desktopEmbedderCredentialSubmit === "function") {
        Promise.resolve(
          browser.desktopEmbedderCredentialSubmit(this, message.data)
        ).catch(error => {
          console.error("Desktop credential submission failed", error);
        });
      }
      return undefined;
    }
    if (message.name === "DesktopCredential:ConditionalWebAuthn") {
      this.#showConditionalWebAuthn(message.data).catch(error => {
        console.error("Desktop conditional WebAuthn prompt failed", error);
      });
      return undefined;
    }
    return undefined;
  }

  #contextForConditional(request) {
    const context = this.browsingContext;
    const browser = context?.top?.embedderElement;
    const origin = httpOrigin(request?.origin);
    if (
      !origin ||
      !Number.isSafeInteger(context?.id) ||
      context.id <= 0 ||
      browser?.browsingContext?.id !== context.top.id
    ) {
      return null;
    }
    return { browser, contextId: context.id, origin };
  }

  #retireConditional(state, { cancelService = false } = {}) {
    if (this.#conditional === state) {
      this.#conditional = null;
    }
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.event) {
      try {
        state.browser.desktopEmbedderWebAuthnConditionalPromptCanceled?.(
          state.event
        );
      } catch {}
    }
    if (cancelService) {
      try {
        webAuthnService().cancel(state.tid);
      } catch {}
    }
  }

  #monitorConditional(state) {
    state.timer = setTimeout(() => {
      state.timer = null;
      if (this.#conditional !== state) {
        return;
      }
      let pending = 0;
      try {
        pending = webAuthnService().hasPendingConditionalGet(
          state.contextId,
          state.origin
        );
      } catch {}
      if (pending !== state.tid) {
        this.#retireConditional(state);
        return;
      }
      this.#monitorConditional(state);
    }, CONDITIONAL_POLL_MS);
  }

  #applyConditionalResponse(state, response) {
    const service = webAuthnService();
    if (
      service.hasPendingConditionalGet(state.contextId, state.origin) !==
      state.tid
    ) {
      return;
    }
    if (response === null) {
      return;
    }
    if (
      response?.action === "select" &&
      Number.isInteger(response.selected) &&
      response.selected >= 0 &&
      response.selected < state.credentialIds.length
    ) {
      service.selectAutoFillEntry(
        state.tid,
        state.credentialIds[response.selected]
      );
    } else if (response?.action === "continue") {
      service.resumeConditionalGet(state.tid);
    } else {
      service.cancel(state.tid);
    }
  }

  async #showConditionalWebAuthn(request) {
    const context = this.#contextForConditional(request);
    if (!context) {
      return;
    }
    const service = webAuthnService();
    const tid = service.hasPendingConditionalGet(
      context.contextId,
      context.origin
    );
    if (!Number.isSafeInteger(tid) || tid <= 0) {
      return;
    }
    if (this.#conditional?.tid === tid) {
      return;
    }
    if (this.#conditional) {
      this.#retireConditional(this.#conditional);
    }

    const state = {
      ...context,
      tid,
      event: null,
      timer: null,
      credentialIds: [],
    };
    this.#conditional = state;
    const projected = projectEntries(await getAutoFillEntries(service, tid));
    if (this.#conditional !== state) {
      return;
    }
    if (!projected) {
      this.#retireConditional(state, { cancelService: true });
      return;
    }
    if (
      service.hasPendingConditionalGet(context.contextId, context.origin) !==
      tid
    ) {
      this.#retireConditional(state);
      return;
    }
    if (
      typeof context.browser.desktopEmbedderWebAuthnConditionalPrompt !==
      "function"
    ) {
      this.#retireConditional(state, { cancelService: true });
      return;
    }

    state.credentialIds = projected.credentialIds;
    state.event = Object.freeze({
      browsingContextId: context.contextId,
      origin: context.origin,
      rpId: projected.rpId,
      accounts: projected.accounts,
    });
    this.#monitorConditional(state);

    let response;
    try {
      response = await context.browser.desktopEmbedderWebAuthnConditionalPrompt(
        state.event
      );
    } catch (error) {
      console.error("Desktop conditional WebAuthn routing failed", error);
      response = Object.freeze({ action: "cancel" });
    }
    if (this.#conditional !== state) {
      return;
    }
    this.#conditional = null;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.#applyConditionalResponse(state, response);
  }

  didDestroy() {
    if (this.#observingConditional) {
      try {
        Services.obs.removeObserver(
          this.#conditionalObserver,
          CONDITIONAL_PENDING_TOPIC
        );
      } catch {}
      this.#observingConditional = false;
    }
    if (this.#conditional) {
      this.#retireConditional(this.#conditional, { cancelService: true });
    }
    try {
      const browser = this.browsingContext?.top?.embedderElement;
      browser?.desktopEmbedderCredentialActorDestroyed?.(this);
    } catch {
      // The browsing context may already be detached during process teardown.
    }
  }
}
