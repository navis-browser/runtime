// SPDX-License-Identifier: MPL-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function actorClass(name, globals) {
  const source = await readFile(
    new URL(`../embedder/components/${name}.sys.mjs`, import.meta.url),
    "utf8",
  );
  return vm.runInNewContext(
    source.replace(/^import[\s\S]*?;\n/gmu, "")
      .replace(`export class ${name}`, `class ${name}`) + `\n${name};`,
    globals,
    { timeout: 1000 },
  );
}

const Child = await actorClass("DesktopContextMenuChild", {
  JSWindowActorChild: class {},
  E10SUtils: { wrapHandlingUserInput: (_window, _active, run) => run() },
  ContentDOMReference: { get: () => ({}) },
  SpellCheckHelper: { isEditable: () => 0, SPELLCHECKABLE: 1 },
  InlineSpellChecker: class {},
  console,
});
const Parent = await actorClass("DesktopContextMenuParent", {
  JSWindowActorParent: class {},
  projectDesktopCopiedLink: value => value,
  Cc: { "@mozilla.org/widget/clipboardhelper;1": {
    getService: () => ({ copyString(value, manager) { manager.copied.push(value); } }),
  } },
  Ci: { nsIClipboardHelper: {} },
});

async function menu(kind = "link") {
  const opened = [], edits = [];
  const window = {
    URL,
    open: (...args) => opened.push(args),
    getSelection: () => ({ isCollapsed: true }),
    HTMLAnchorElement: { isInstance: node => node?.kind === "link" },
    HTMLAreaElement: { isInstance: () => false },
    HTMLImageElement: { isInstance: node => node?.kind === "image" },
    HTMLMediaElement: { isInstance: node => node?.kind === "media" },
    HTMLVideoElement: { isInstance: node => node?.kind === "media" },
    HTMLInputElement: { isInstance: () => false },
    HTMLTextAreaElement: { isInstance: () => false },
  };
  const document = {
    documentURIObject: { scheme: "https" },
    baseURI: "https://origin.example/",
    defaultView: window,
    queryCommandEnabled: () => false,
    execCommand: command => edits.push(command),
  };
  window.document = document;
  const target = {
    kind, nodeType: 1, ELEMENT_NODE: 1, TEXT_NODE: 3,
    ownerDocument: document, documentGlobal: window, isConnected: true,
    href: "https://link.example/original",
    src: "https://media.example/original", textContent: "Hover link",
    paused: true, muted: false, controls: false,
    isContentEditable: kind === "editable",
    pause() { this.paused = true; },
    play() { this.paused = false; },
  };
  const child = new Child(), parent = new Parent();
  const shown = [], childResults = [];
  parent.manager = {
    isCurrentGlobal: true, browsingContext: { id: 1 }, copied: [],
    rootFrameLoader: { ownerElement: {
      documentGlobal: { mozInnerScreenX: 0, mozInnerScreenY: 0 },
      desktopEmbedderContextMenu: (_actor, data) => shown.push(data),
    } },
  };
  child.contentWindow = window;
  child.sendAsyncMessage = (name, data) => parent.receiveMessage({ name, data });
  parent.sendAsyncMessage = (name, data) => {
    childResults.push(child.receiveMessage({ name, data }));
  };
  function show() {
    child.handleEvent({
      type: "contextmenu", isTrusted: true, defaultPrevented: false,
      composedTarget: target, screenX: 10, screenY: 10, clientX: 10, clientY: 10,
      preventDefault() {}, stopPropagation() {},
    });
  }
  show();
  await new Promise(setImmediate);
  assert.equal(shown.length, 1);
  const token = shown[0].token;
  return {
    child, parent, target, document, window, opened, edits, shown, childResults,
    show, token,
    execute: command => parent.execute(token, command),
  };
}

for (const kind of ["link", "image", "media"]) {
  for (const change of ["hidden", "removed", "adopted"]) {
    test(`${kind} address snapshot survives ${change} target`, async () => {
      const f = await menu(kind);
      const expected = kind === "link" ? f.target.href : f.target.src;
      f.target.href = f.target.src = "https://changed.example/";
      if (change === "hidden") f.target.hidden = true;
      if (change === "removed") f.target.isConnected = false;
      if (change === "adopted") {
        f.target.ownerDocument = {
          defaultView: { open() { assert.fail("Opened under the adopted document"); } },
        };
      }
      assert.equal(f.execute(`open-${kind}-new-tab`), true);
      assert.equal(f.childResults.at(-1), true);
      assert.deepEqual(f.opened, [[expected, "_blank", "noopener"]]);
      assert.equal(f.execute(`open-${kind}-new-tab`), false);
    });
  }
}

test("copy address remains independent of the original target", async () => {
  const f = await menu();
  f.target.isConnected = false;
  assert.equal(f.execute("copy-link-address"), true);
  assert.deepEqual(f.parent.manager.copied, ["https://link.example/original"]);
  assert.equal(f.execute("copy-link-address"), false);
});

test("removed or adopted targets cannot receive element mutations", async () => {
  for (const change of ["removed", "adopted"]) {
    const f = await menu("media");
    if (change === "removed") f.target.isConnected = false;
    else f.target.ownerDocument = {};
    f.execute("mute-media");
    assert.equal(f.childResults.at(-1), false);
    assert.equal(f.target.muted, false);
    assert.equal(f.execute("open-media-new-tab"), false);
    assert.equal(f.opened.length, 0);
  }
});

test("same-document element mutations remain available", async () => {
  const f = await menu("media");
  f.execute("mute-media");
  assert.equal(f.childResults.at(-1), true);
  assert.equal(f.target.muted, true);
});

test("dismissed, replaced, destroyed and navigated menus cannot open an address", async () => {
  for (const retire of ["dismiss", "replace", "destroy", "navigate", "document-replaced"]) {
    const f = await menu();
    if (retire === "dismiss") f.parent.dismiss(f.token);
    if (retire === "destroy") f.child.didDestroy();
    if (retire === "navigate") f.parent.manager.isCurrentGlobal = false;
    if (retire === "document-replaced") f.window.document = {};
    if (retire === "replace") {
      f.show();
      await new Promise(setImmediate);
      assert.equal(f.shown.length, 2);
    }
    f.execute("open-link-new-tab");
    assert.equal(f.opened.length, 0, retire);
  }
});

test("unoffered commands and foreign tokens cannot use saved addresses", async () => {
  const f = await menu();
  assert.equal(f.execute("open-image-new-tab"), false);
  assert.equal(f.parent.execute(f.token + 1, "open-link-new-tab"), false);
  assert.equal(f.child.receiveMessage({ name: "DesktopContextMenu:Execute",
    data: { token: f.token + 1, command: "open-link-new-tab" } }), false);
  assert.equal(f.opened.length, 0);
  assert.equal(f.execute("open-link-new-tab"), true);
  assert.equal(f.opened.length, 1);
});

test("disabled editing commands remain rejected", async () => {
  const f = await menu("editable");
  assert.equal(f.shown[0].items.find(item => item.id === "undo").enabled, false);
  f.execute("undo");
  assert.equal(f.childResults.at(-1), false);
  assert.deepEqual(f.edits, []);
});
