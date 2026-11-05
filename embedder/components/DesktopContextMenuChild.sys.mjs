/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { E10SUtils } from "resource://gre/modules/E10SUtils.sys.mjs";
import { ContentDOMReference } from "resource://gre/modules/ContentDOMReference.sys.mjs";
import {
  InlineSpellChecker,
  SpellCheckHelper,
} from "resource://gre/modules/InlineSpellChecker.sys.mjs";

const MAX_URL_LENGTH = 4096;
const MAX_SELECTION_LENGTH = 512;
const MAX_SPELL_SUGGESTIONS = 5;
const MAX_SPELL_SUGGESTION_LENGTH = 128;
const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "blob:"]);
const ADDRESS_OPEN_COMMANDS = new Set([
  "open-link-new-tab",
  "open-image-new-tab",
  "open-media-new-tab",
]);
const COPYABLE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "blob:",
  "mailto:",
  "tel:",
]);
const SUPPORTED_DOCUMENT_SCHEMES = new Set([
  "http",
  "https",
  "moz-extension",
  "navis",
]);

function command(id, group, enabled = true) {
  return { id, group, enabled: Boolean(enabled) };
}

/** Captures a short-lived content target and projects only plain menu facts. */
export class DesktopContextMenuChild extends JSWindowActorChild {
  #token = 0;
  #target = null;
  #document = null;
  #commands = new Map();
  #values = Object.freeze({});
  #spellChecker = null;

  handleEvent(event) {
    if (event.type === "pointerdown") {
      this.#handlePointerDown(event);
      return;
    }
    this.#handleContextMenu(event).catch((error) => {
      console.error("Desktop context-menu preparation failed", error);
    });
  }

  #handlePointerDown(event) {
    if (!event.isTrusted) {
      return;
    }
    // Transient product surfaces should close immediately on content input,
    // but the context-menu target must live until Platform either selects a
    // command or reports the XUL popup dismissal. Windows may dispatch this
    // pointerdown after popuphidden while it is still the menu-selection hit.
    this.sendAsyncMessage("DesktopContextMenu:ContentInteraction", {
      kind: "pointer",
    });
  }

  async #handleContextMenu(event) {
    if (
      event.type !== "contextmenu" ||
      !event.isTrusted ||
      event.defaultPrevented ||
      !SUPPORTED_DOCUMENT_SCHEMES.has(
        this.contentWindow.document.documentURIObject?.scheme,
      )
    ) {
      return;
    }

    const target = this.#normalizeTarget(event.composedTarget);
    const document = target?.ownerDocument;
    if (!target || !document || document.defaultView !== this.contentWindow) {
      return;
    }

    const link = this.#findLink(target);
    const image = this.#imageTarget(target);
    const media = this.#mediaTarget(target);
    const textControl = this.#textControl(target);
    const editable = this.#isEditable(target, textControl);
    const selectedText = this.#selectedText(target, textControl);
    const password = Boolean(textControl) &&
      this.contentWindow.HTMLInputElement.isInstance(textControl) && textControl.type === "password";
    const linkUrl = this.#safeURL(link?.href, document.baseURI);
    const imageUrl = this.#safeURL(
      image?.currentSrc || image?.src,
      document.baseURI,
    );
    const mediaUrl = this.#safeURL(
      media?.currentSrc || media?.src,
      document.baseURI,
    );
    const hasSelection = Boolean(selectedText);

    this.#clear(this.#token);
    const token = ++this.#token;
    this.#target = target;
    this.#document = document;
    event.preventDefault();
    event.stopPropagation();

    const spellcheck = await this.#spellcheckItems(event, token, target);
    if (
      token !== this.#token ||
      this.#target !== target ||
      this.contentWindow.document !== document ||
      target.ownerDocument !== document ||
      !target.isConnected
    ) {
      spellcheck.checker?.uninit();
      return;
    }
    this.#spellChecker = spellcheck.checker;
    const items = [
      ...this.#targetItems({ linkUrl, imageUrl, mediaUrl, media }),
      ...spellcheck.items,
      ...this.#editItems(document, editable, hasSelection),
      command("inspect-element", "developer"),
    ];

    this.#commands = new Map(items.map((item) => [item.id, item]));
    this.#values = Object.freeze({
      linkUrl: linkUrl?.href || "",
      imageUrl: imageUrl?.href || "",
      mediaUrl: mediaUrl?.href || "",
      spellSuggestions: Object.freeze(spellcheck.suggestions),
    });

    this.sendAsyncMessage("DesktopContextMenu:Show", {
      token,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      items,
      context: {
        editable,
        password,
        hasSelection,
        misspelled: spellcheck.suggestions.length > 0,
        link: Boolean(linkUrl),
        image: Boolean(imageUrl),
        media: this.#mediaKind(media),
      },
      linkUrl: linkUrl?.href || "",
      linkText: link?.textContent?.trim().slice(0, MAX_SELECTION_LENGTH) || "",
      imageUrl: imageUrl?.href || "",
      mediaUrl: mediaUrl?.href || "",
      selectedText: selectedText.slice(0, MAX_SELECTION_LENGTH),
      selectionSearchText: !password && selectedText.length <= 8192 ? selectedText : "",
      targetIdentifier: ContentDOMReference.get(target),
    });
  }

  #targetItems({ linkUrl, imageUrl, mediaUrl, media }) {
    const items = [];
    this.#appendAddressItems(items, "link", linkUrl);
    this.#appendAddressItems(items, "image", imageUrl);
    if (!media) {
      return items;
    }
    items.push(
      command(media.paused ? "play-media" : "pause-media", "media"),
      command(media.muted ? "unmute-media" : "mute-media", "media"),
      command(
        media.controls ? "hide-media-controls" : "show-media-controls",
        "media",
      ),
    );
    this.#appendAddressItems(items, "media", mediaUrl);
    return items;
  }

  #appendAddressItems(items, kind, url) {
    if (!url) {
      return;
    }
    if (OPENABLE_PROTOCOLS.has(url.protocol)) {
      items.push(command(`open-${kind}-new-tab`, kind));
    }
    if (COPYABLE_PROTOCOLS.has(url.protocol)) {
      items.push(command(`copy-${kind}-address`, kind));
    }
  }

  #editItems(document, editable, hasSelection) {
    if (editable) {
      return [
        command("undo", "edit", this.#queryCommandEnabled(document, "undo")),
        command("redo", "edit", this.#queryCommandEnabled(document, "redo")),
        command("cut", "edit", hasSelection),
        command("copy", "edit", hasSelection),
        command("paste", "edit"),
        command("select-all", "edit"),
      ];
    }
    return [
      ...(hasSelection ? [command("copy", "edit")] : []),
      command("select-all", "edit"),
    ];
  }

  async #spellcheckItems(event, token, target) {
    const editFlags = SpellCheckHelper.isEditable(
      event.composedTarget,
      this.contentWindow,
    );
    if (!(editFlags & SpellCheckHelper.SPELLCHECKABLE)) {
      return { checker: null, items: [], suggestions: [] };
    }

    let editor = null;
    if (editFlags & (SpellCheckHelper.TEXTAREA | SpellCheckHelper.INPUT)) {
      editor = event.composedTarget.editor;
    } else {
      editor = this.contentWindow.docShell.editingSession.getEditorForWindow(
        this.contentWindow,
      );
    }
    if (!editor) {
      return { checker: null, items: [], suggestions: [] };
    }

    const checker = new InlineSpellChecker(editor);
    checker.initFromEvent(event.rangeParent, event.rangeOffset);
    if (
      !checker.canSpellCheck ||
      !checker.enabled ||
      checker.initialSpellCheckPending ||
      !checker.overMisspelling
    ) {
      checker.uninit();
      return { checker: null, items: [], suggestions: [] };
    }

    let candidates = [];
    try {
      candidates = await checker.mInlineSpellChecker.spellChecker.suggest(
        checker.mMisspelling,
        MAX_SPELL_SUGGESTIONS,
      );
    } catch {}
    if (token !== this.#token || this.#target !== target) {
      return { checker, items: [], suggestions: [] };
    }

    const suggestions = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (
        typeof candidate !== "string" ||
        !candidate ||
        candidate.length > MAX_SPELL_SUGGESTION_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(candidate) ||
        seen.has(candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      suggestions.push(candidate);
      if (suggestions.length === MAX_SPELL_SUGGESTIONS) {
        break;
      }
    }
    if (!suggestions.length) {
      checker.uninit();
      return { checker: null, items: [], suggestions: [] };
    }
    return {
      checker,
      suggestions,
      items: suggestions.map((suggestion, index) => ({
        id: `spell-replace-${index}`,
        group: "spelling",
        enabled: true,
        suggestion,
      })),
    };
  }

  #mediaKind(media) {
    if (!media) {
      return null;
    }
    return this.contentWindow.HTMLVideoElement.isInstance(media)
      ? "video"
      : "audio";
  }

  receiveMessage(message) {
    const { token } = message.data || {};
    if (token !== this.#token || !this.#target) {
      return false;
    }
    if (message.name === "DesktopContextMenu:Dismiss") {
      this.#clear(token);
      return true;
    }
    if (message.name !== "DesktopContextMenu:Execute") {
      return false;
    }

    const { command: commandId } = message.data;
    const offered = this.#commands.get(commandId);
    // Address commands use the facts captured when the menu opened. A hover
    // handler may remove or adopt that node while the user chooses a command.
    // Element operations still require the live target in its original document.
    if (
      !offered?.enabled ||
      this.#document !== this.contentWindow.document ||
      (!ADDRESS_OPEN_COMMANDS.has(commandId) &&
        (!this.#target.isConnected ||
          this.#target.ownerDocument !== this.#document))
    ) {
      this.#clear(token);
      return false;
    }

    const target = this.#target;
    const values = this.#values;
    try {
      E10SUtils.wrapHandlingUserInput(this.contentWindow, true, () => {
        this.#execute(commandId, target, values);
      });
      return true;
    } finally {
      this.#clear(token);
    }
  }

  didDestroy() {
    this.#spellChecker?.uninit();
    this.#spellChecker = null;
    this.#target = null;
    this.#document = null;
    this.#commands.clear();
    this.#values = Object.freeze({});
  }

  #execute(commandId, target, values) {
    const document = this.#document;
    if (/^spell-replace-[0-4]$/u.test(commandId)) {
      const index = Number(commandId.at(-1));
      const suggestion = values.spellSuggestions[index];
      if (suggestion) {
        this.#spellChecker?.replaceMisspelling(suggestion);
      }
      return;
    }
    switch (commandId) {
      case "open-link-new-tab":
        this.#openInNewTab(document, values.linkUrl);
        break;
      case "open-image-new-tab":
        this.#openInNewTab(document, values.imageUrl);
        break;
      case "open-media-new-tab":
        this.#openInNewTab(document, values.mediaUrl);
        break;
      case "play-media":
        Promise.resolve(target.play()).catch(() => {});
        break;
      case "pause-media":
        target.pause();
        break;
      case "mute-media":
        target.muted = true;
        break;
      case "unmute-media":
        target.muted = false;
        break;
      case "show-media-controls":
        target.controls = true;
        break;
      case "hide-media-controls":
        target.controls = false;
        break;
      case "select-all":
        this.#selectAll(target);
        break;
      case "undo":
      case "redo":
      case "cut":
      case "copy":
      case "paste":
        document.execCommand(commandId);
        break;
    }
  }

  #openInNewTab(document, url) {
    if (!url) {
      return;
    }
    document.defaultView.open(url, "_blank", "noopener");
  }

  #selectAll(target) {
    const textControl = this.#textControl(target);
    if (textControl && typeof textControl.select === "function") {
      textControl.select();
      return;
    }
    target.ownerDocument.execCommand("selectAll");
  }

  #clear(token) {
    if (token !== this.#token) {
      return;
    }
    this.#target = null;
    this.#document = null;
    this.#commands.clear();
    this.#values = Object.freeze({});
    this.#spellChecker?.uninit();
    this.#spellChecker = null;
  }

  #normalizeTarget(target) {
    let candidate = target;
    if (candidate?.nodeType === candidate.TEXT_NODE) {
      candidate = candidate.parentElement;
    }
    const shadowRoot = candidate?.containingShadowRoot;
    if (
      shadowRoot?.isUAWidget?.() &&
      this.contentWindow.HTMLMediaElement.isInstance(shadowRoot.host)
    ) {
      candidate = shadowRoot.host;
    }
    return candidate?.nodeType === candidate.ELEMENT_NODE ? candidate : null;
  }

  #findLink(target) {
    let candidate = target;
    while (candidate) {
      if (
        (this.contentWindow.HTMLAnchorElement.isInstance(candidate) ||
          this.contentWindow.HTMLAreaElement.isInstance(candidate)) &&
        candidate.href
      ) {
        return candidate;
      }
      candidate = candidate.flattenedTreeParentNode;
    }
    return null;
  }

  #imageTarget(target) {
    return this.contentWindow.HTMLImageElement.isInstance(target)
      ? target
      : null;
  }

  #mediaTarget(target) {
    return this.contentWindow.HTMLMediaElement.isInstance(target)
      ? target
      : null;
  }

  #textControl(target) {
    if (
      this.contentWindow.HTMLInputElement.isInstance(target) &&
      target.mozIsTextField(false)
    ) {
      return target;
    }
    if (this.contentWindow.HTMLTextAreaElement.isInstance(target)) {
      return target;
    }
    return null;
  }

  #isEditable(target, textControl) {
    if (textControl) {
      return !textControl.disabled && !textControl.readOnly;
    }
    return target.isContentEditable || target.ownerDocument.designMode === "on";
  }

  #selectedText(target, textControl) {
    if (
      textControl &&
      Number.isInteger(textControl.selectionStart) &&
      Number.isInteger(textControl.selectionEnd) &&
      textControl.selectionEnd > textControl.selectionStart
    ) {
      return textControl.value.slice(
        textControl.selectionStart,
        textControl.selectionEnd,
      );
    }
    const selection = target.documentGlobal.getSelection();
    return selection?.isCollapsed ? "" : selection?.toString() || "";
  }

  #queryCommandEnabled(document, commandId) {
    try {
      return document.queryCommandEnabled(commandId);
    } catch {
      return false;
    }
  }

  #safeURL(value, baseURI) {
    if (!value || String(value).length > MAX_URL_LENGTH) {
      return null;
    }
    try {
      const url = new this.contentWindow.URL(value, baseURI);
      return COPYABLE_PROTOCOLS.has(url.protocol) &&
        url.href.length <= MAX_URL_LENGTH
        ? url
        : null;
    } catch {
      return null;
    }
  }
}
