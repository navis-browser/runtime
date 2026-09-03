/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const WEB_AUTHN_TOPIC = "webauthn-prompt";
const MAX_ORIGIN_LENGTH = 4096;
const MAX_ACCOUNT_COUNT = 32;
const MAX_ACCOUNT_TEXT_LENGTH = 256;
const PROMPT_TYPES = new Set([
  "already-registered",
  "attestation-consent",
  "cancel",
  "device-blocked",
  "listen-error",
  "listen-success",
  "pin-auth-blocked",
  "pin-invalid",
  "pin-is-too-long",
  "pin-is-too-short",
  "pin-not-set",
  "pin-required",
  "presence",
  "select-device",
  "select-sign-result",
  "selected-device",
  "unknown-error",
  "uv-blocked",
  "uv-invalid",
]);

let initialized = false;
let activePrompt = null;

function transactionId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function browsingContextId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedText(value, maximum) {
  if (typeof value !== "string" || value.length > maximum) {
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

function projectAccounts(entities) {
  if (!Array.isArray(entities) || entities.length > MAX_ACCOUNT_COUNT) {
    return null;
  }
  const accounts = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") {
      return null;
    }
    const name = boundedText(entity.name ?? "", MAX_ACCOUNT_TEXT_LENGTH);
    const displayName = boundedText(
      entity.displayName ?? "",
      MAX_ACCOUNT_TEXT_LENGTH
    );
    if (name === null || displayName === null) {
      return null;
    }
    accounts.push(Object.freeze({ name, displayName }));
  }
  return Object.freeze(accounts);
}

function projectPrompt(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const tid = transactionId(data.tid);
  const type = data.prompt?.type;
  if (!tid || typeof type !== "string" || !PROMPT_TYPES.has(type)) {
    return null;
  }
  if (type === "cancel") {
    return Object.freeze({ type, tid, browsingContextId: null });
  }

  const contextId = browsingContextId(data.browsingContextId);
  const origin = boundedText(data.origin, MAX_ORIGIN_LENGTH);
  if (!contextId || origin === null || !origin) {
    return null;
  }

  let retries = null;
  if (data.prompt.retries !== undefined && data.prompt.retries !== null) {
    if (
      !Number.isInteger(data.prompt.retries) ||
      data.prompt.retries < 0 ||
      data.prompt.retries > 255
    ) {
      return null;
    }
    retries = data.prompt.retries;
  }

  let accounts = Object.freeze([]);
  if (type === "select-sign-result") {
    accounts = projectAccounts(data.prompt.entities);
    if (!accounts?.length) {
      return null;
    }
  }

  const errorKind =
    type === "listen-error" && PROMPT_TYPES.has(data.prompt.error?.type)
      ? data.prompt.error.type
      : null;
  return Object.freeze({
    type,
    tid,
    browsingContextId: contextId,
    origin,
    retries,
    accounts,
    errorKind,
  });
}

function webAuthnService() {
  return Cc["@mozilla.org/webauthn/service;1"].getService(
    Ci.nsIWebAuthnService
  );
}

function cancelTransaction(tid) {
  try {
    webAuthnService().cancel(tid);
  } catch (error) {
    console.error("Desktop WebAuthn transaction cancellation failed", error);
  }
}

function browserForContext(contextId) {
  try {
    const context = BrowsingContext.get(contextId);
    const top = context?.top;
    if (!top || top.id !== contextId) {
      return null;
    }
    const browser = top.embedderElement;
    return browser?.browsingContext?.id === contextId ? browser : null;
  } catch {
    return null;
  }
}

const observer = {
  observe(_subject, topic, value) {
    if (topic !== WEB_AUTHN_TOPIC) {
      return;
    }

    let raw;
    try {
      raw = JSON.parse(value);
    } catch {
      return;
    }
    const prompt = projectPrompt(raw);
    const tid = transactionId(raw?.tid);
    if (!prompt) {
      if (tid) {
        cancelTransaction(tid);
      }
      return;
    }

    if (prompt.type === "cancel") {
      if (activePrompt?.tid !== prompt.tid) {
        return;
      }
      const browser = activePrompt.browser.deref();
      activePrompt = null;
      browser?.desktopEmbedderWebAuthnPrompt?.(prompt);
      return;
    }

    const browser = browserForContext(prompt.browsingContextId);
    if (typeof browser?.desktopEmbedderWebAuthnPrompt !== "function") {
      cancelTransaction(prompt.tid);
      return;
    }
    const previousBrowser = activePrompt?.browser.deref();
    if (
      activePrompt &&
      (activePrompt.tid !== prompt.tid || previousBrowser !== browser)
    ) {
      const previous = activePrompt;
      activePrompt = null;
      cancelTransaction(previous.tid);
      try {
        previousBrowser?.desktopEmbedderWebAuthnPrompt?.(
          Object.freeze({
            type: "cancel",
            tid: previous.tid,
            browsingContextId: null,
          })
        );
      } catch (error) {
        console.error("Desktop WebAuthn stale prompt cleanup failed", error);
      }
      if (previous.tid === prompt.tid) {
        return;
      }
    }
    activePrompt = { tid: prompt.tid, browser: new WeakRef(browser) };
    try {
      browser.desktopEmbedderWebAuthnPrompt(prompt);
    } catch (error) {
      activePrompt = null;
      cancelTransaction(prompt.tid);
      console.error("Desktop WebAuthn prompt routing failed", error);
    }
  },
};

export function forgetDesktopWebAuthnPrompt(tid, browser) {
  if (
    activePrompt?.tid === tid &&
    (!browser || activePrompt.browser.deref() === browser)
  ) {
    activePrompt = null;
  }
}

export function initializeDesktopWebAuthnPrompt() {
  if (initialized) {
    return;
  }
  Services.obs.addObserver(observer, WEB_AUTHN_TOPIC);
  initialized = true;
}

export function shutdownDesktopWebAuthnPrompt() {
  if (!initialized) {
    return;
  }
  Services.obs.removeObserver(observer, WEB_AUTHN_TOPIC);
  activePrompt = null;
  initialized = false;
}
