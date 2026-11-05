// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const managers = [];
class Manager {
  hasDialogs = false;
  focused = 0;
  constructor(options) { this.options = options; managers.push(this); }
  open(uri, options) {
    if (this.fail) throw Error("native open failed");
    this.hasDialogs = true;
    this.closed = options.closedCallback;
    return {};
  }
  abortDialogs() {
    this.hasDialogs = false;
    this.closed?.();
    this.closed = null;
  }
  focusTopDialog() { ++this.focused; }
}
const localizationRoots = new Set();
class Localization {
  connectRoot(root) { localizationRoots.add(root); }
  disconnectRoot(root) { localizationRoots.delete(root); }
}
const Services = {
  io: { newURI: uri => ({ scheme: uri.split(":", 1)[0] }) },
  scriptloader: { loadSubScript(uri, window) {
    if (uri.endsWith("customElements.js")) { window.MozXULElement = {}; return; }
    window.PrintUtils = {
      startPrintWindow(context) { return this.getTabDialogBox(context.browser).open("chrome://global/content/print.html"); },
      handleStaticCloneCreatedForPrint: info => info,
    };
  } },
};
const source = (await fs.readFile(new URL("../embedder/modules/DesktopPrinting.sys.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replaceAll("export ", "");
const context = vm.createContext({ Services, AppConstants: {}, XPCOMUtils: {}, SubDialogManager: Manager });
vm.runInContext(source + "\nglobalThis.getPrinting = getDesktopPrinting;", context);
function node(name) {
  const value = { className: "", inert: false, isConnected: true, children: [], attributes: new Map(),
    append(child) { child.parentElement = this; this.children.push(child); },
    remove() { this.isConnected = false; this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1); },
    setAttribute(key, value) { this.attributes.set(key, value); },
    removeAttribute(key) { this.attributes.delete(key); },
  };
  value.classList = { contains: token => value.className.split(" ").includes(token) };
  return value;
}
function fixture() {
  const body = node("body"), chrome = node("chrome"), blocked = node("blocked");
  blocked.inert = true;
  body.append(chrome); body.append(blocked);
  const window = { DOMLocalization: Localization, document: { body, createElement: node, createXULElement: node,
    documentElement: { getAttribute: () => "dark" } } };
  window.document.defaultView = window;
  const browser = Object.assign(node("browser"), { ownerDocument: window.document, focus() { this.focused = true; } });
  browser.browsingContext = { browser };
  const printing = context.getPrinting(window);
  const unbind = printing.bindBrowser(browser);
  return { window, browser, chrome, blocked, printing, unbind };
}
const a = fixture(), b = fixture();
assert.equal(context.getPrinting(a.window), a.printing);
assert.throws(() => a.printing.start(b.browser), /unavailable/);
assert.throws(() => a.printing.configure({styleSheets: ["https://bad.test/style.css"]}), /packaged/);
a.printing.configure({styleSheets: ["chrome://navis/content/documents.css"]});
assert.equal(a.printing.start(a.browser), true);
const manager = managers.at(-1);
assert.equal(a.chrome.inert, true);
assert.equal(b.chrome.inert, false, "modal input is scoped to the exact owner window");
assert.equal(a.printing.start(a.browser), false);
assert.equal(manager.focused, 1);
assert.throws(() => a.printing.configure(), /while printing/);
manager.abortDialogs();
assert.equal(a.chrome.inert, false);
assert.equal(a.blocked.inert, true, "pre-existing inert state survives print close");
assert.equal(a.browser.focused, true);
manager.fail = true;
assert.throws(() => a.printing.start(a.browser), /native open failed/);
assert.equal(a.chrome.inert, false, "open failure restores input");
manager.fail = false;
a.printing.start(a.browser);
a.unbind(); a.unbind();
assert.equal(manager.hasDialogs, false);
assert.equal(a.chrome.inert, false);
assert.throws(() => a.printing.clone({parent: {top: {embedderElement: b.browser}}}), /unavailable/);
assert.throws(() => a.printing.start(a.browser), /unavailable/);
a.printing.close(); a.printing.close(); b.printing.close();
assert.equal(localizationRoots.size, 0);
console.log("Print host ownership, modal input, duplicate/open failure and idempotent teardown passed; native printing remains separate");
