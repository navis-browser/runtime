/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PromptUtils } from "resource://gre/modules/PromptUtils.sys.mjs";

function dismissedResult(args, { aborted = false } = {}) {
  return {
    promptAborted: aborted,
    ok: false,
    buttonNumClicked: Number.isInteger(args.buttonNumClicked)
      ? args.buttonNumClicked
      : 1,
    checked: Boolean(args.checked),
    value: typeof args.value === "string" ? args.value : "",
    user: typeof args.user === "string" ? args.user : "",
    pass: typeof args.pass === "string" ? args.pass : "",
    selected: Number.isInteger(args.selected) ? args.selected : -1,
  };
}

/**
 * Product-neutral replacement for Firefox's PromptParent actor.
 *
 * Gecko keeps modal state and prompt transport below this boundary. The
 * embedder browser callback projects the native argument bag into the public
 * Session PromptDelegate contract and returns only primitive result fields.
 */
export class PromptParent extends JSWindowActorParent {
  #pendingControllers = new Set();

  didDestroy() {
    for (const controller of this.#pendingControllers) {
      controller.abort();
    }
    this.#pendingControllers.clear();
  }

  receiveMessage(message) {
    if (message.name !== "Prompt:Open") {
      return undefined;
    }
    return this.#openPrompt(message.data);
  }

  async #openPrompt(args) {
    const owningBrowsingContext = this.browsingContext;
    const browsingContext = owningBrowsingContext.top;
    const browser = browsingContext.embedderElement;
    if (
      !this.windowContext.isActiveInTab ||
      typeof browser?.desktopEmbedderPrompt !== "function"
    ) {
      return dismissedResult(args);
    }

    const controller = new AbortController();
    this.#pendingControllers.add(controller);
    // The root document's defaultView is shared by both ESR baselines;
    // documentGlobal is retained only as a newer fallback.
    const chromeWindow =
      browser.getRootNode()?.defaultView ?? browser.documentGlobal;
    let enteredModalState = false;
    let result = dismissedResult(args);

    try {
      browser.enterModalState?.();
      enteredModalState = true;
      try {
        PromptUtils.fireDialogEvent(
          chromeWindow,
          "DOMWillOpenModalDialog",
          browser,
          args.modalType === Services.prompt.MODAL_TYPE_CONTENT
            ? {
                inPermitUnload: Boolean(args.inPermitUnload),
                promptPrincipal: args.promptPrincipal,
                tabPrompt: true,
              }
            : null
        );
      } catch (error) {
        console.error("Desktop embedder prompt open event failed", error);
      }

      const candidate = await browser.desktopEmbedderPrompt(
        args,
        controller.signal
      );
      if (candidate && typeof candidate === "object") {
        result = candidate;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("Desktop embedder prompt projection failed", error);
      }
      result = dismissedResult(args, {
        aborted: controller.signal.aborted,
      });
    } finally {
      this.#pendingControllers.delete(controller);
      if (enteredModalState) {
        try {
          browser.maybeLeaveModalState?.();
        } catch {}
      }
      try {
        PromptUtils.fireDialogEvent(
          chromeWindow,
          "DOMModalDialogClosed",
          browser,
          args.modalType === Services.prompt.MODAL_TYPE_CONTENT
            ? {
                owningBrowsingContext,
                promptType: args.inPermitUnload
                  ? "beforeunload"
                  : args.promptType,
                areLeaving: Boolean(result.ok),
                value: result.ok ? result.value : null,
              }
            : null
        );
      } catch (error) {
        console.error("Desktop embedder prompt close event failed", error);
      }
    }

    return result;
  }
}
