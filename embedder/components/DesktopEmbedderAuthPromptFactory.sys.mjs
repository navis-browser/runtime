/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * A password-storage-free nsIAuthPrompt2 bridge for desktop embedders.
 *
 * Necko asks the window watcher for an asynchronous authentication prompt.
 * Firefox normally satisfies that request through Login Manager. A reusable
 * engine embedder must not need the Firefox password database merely to show
 * HTTP authentication UI, so this component forwards the request to Gecko's
 * prompt service. The registered Prompt actor then projects it through the
 * owning EngineSession's PromptDelegate.
 */

/** Tracks one Necko authentication consumer and enforces one callback. */
class DesktopEmbedderAuthRequest {
  #callback;
  #context;
  #finished = false;

  constructor(callback, context) {
    this.#callback = callback;
    this.#context = context;
  }

  QueryInterface = ChromeUtils.generateQI(["nsICancelable"]);

  get finished() {
    return this.#finished;
  }

  cancel(_reason) {
    this.#complete(false, null, false);
  }

  accept(authInfo) {
    this.#complete(true, authInfo, true);
  }

  dismiss() {
    this.#complete(false, null, true);
  }

  #complete(accepted, authInfo, userCancel) {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    try {
      if (accepted) {
        this.#callback.onAuthAvailable(this.#context, authInfo);
      } else {
        this.#callback.onAuthCancelled(this.#context, userCancel);
      }
    } catch {}
    this.#callback = null;
    this.#context = null;
  }
}

/** Implements the prompt interfaces used by Necko and BrowserParent. */
class DesktopEmbedderAuthPrompter {
  #browser = null;
  #window = null;

  QueryInterface = ChromeUtils.generateQI([
    "nsIAuthPrompt2",
    "nsILoginManagerAuthPrompter",
  ]);

  init(window) {
    this.#window = window;
    if (!window || window.isChromeWindow) {
      return;
    }
    try {
      this.#browser = window.docShell?.chromeEventHandler ?? null;
    } catch {}
  }

  set browser(browser) {
    this.#browser = browser;
  }

  get browser() {
    return this.#browser;
  }

  #browsingContext() {
    if (this.#browser?.browsingContext) {
      return this.#browser.browsingContext;
    }
    try {
      return BrowsingContext.getFromWindow(this.#window);
    } catch {
      return null;
    }
  }

  promptAuth(channel, level, authInfo) {
    const browsingContext = this.#browsingContext();
    if (!browsingContext) {
      return false;
    }
    return Services.prompt.promptAuthBC(
      browsingContext,
      Services.prompt.MODAL_TYPE_TAB,
      channel,
      level,
      authInfo
    );
  }

  asyncPromptAuth(channel, callback, context, level, authInfo) {
    const browsingContext = this.#browsingContext();
    const request = new DesktopEmbedderAuthRequest(callback, context);

    // The nsIAuthPrompt2 contract forbids invoking the callback before this
    // method has returned. Dispatch even the no-context failure accordingly.
    Services.tm.dispatchToMainThread(async () => {
      if (request.finished) {
        return;
      }
      if (!browsingContext) {
        request.dismiss();
        return;
      }
      try {
        const accepted = await Services.prompt.asyncPromptAuth(
          browsingContext,
          Services.prompt.MODAL_TYPE_TAB,
          channel,
          level,
          authInfo
        );
        if (accepted) {
          request.accept(authInfo);
        } else {
          request.dismiss();
        }
      } catch (error) {
        console.error("Desktop embedder authentication prompt failed", error);
        request.dismiss();
      }
    });

    return request;
  }
}

export function DesktopEmbedderAuthPromptFactory() {}

DesktopEmbedderAuthPromptFactory.prototype = {
  classID: Components.ID("{b739bb31-2575-45a7-8914-63b4f90207fc}"),
  QueryInterface: ChromeUtils.generateQI(["nsIPromptFactory"]),

  getPrompt(window, iid) {
    const prompt = new DesktopEmbedderAuthPrompter();
    prompt.init(window);
    return prompt.QueryInterface(iid);
  },
};
