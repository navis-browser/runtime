/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../embedder/modules/NavisDocuments.sys.mjs", import.meta.url), "utf8");
const context = vm.createContext({
  ChromeUtils: { registerWindowActor() {}, importESModule() { return {}; } },
  JSWindowActorParent: class {},
  Services: {
    io: { newURI: value => ({ spec: value }) },
    scriptSecurityManager: { checkLoadURIWithPrincipal(principal, uri) {
      if (uri.spec.startsWith("blob:") && !uri.spec.startsWith("blob:resource://pdf.js/")) throw Error("foreign blob");
    } },
  },
  Ci: { nsIScriptSecurityManager: { STANDARD: 0 } },
  console,
});
vm.runInContext(source.replaceAll("export ", "") + "\nglobalThis.api = { bindDocumentHost, PdfjsParent };", context);
const { bindDocumentHost, PdfjsParent } = context.api;
let saves = [];
let continueSave;
const browser = { isConnected: true };
const manager = {
  documentPrincipal: { isContentPrincipal: true, URI: { spec: "resource://pdf.js/web/viewer.html" } },
  documentURI: { spec: "https://example.test/form.pdf#page=2" },
};
const bc = { parent: null, sandboxFlags: 0, currentWindowGlobal: manager, top: { embedderElement: browser } };
const actor = new PdfjsParent();
Object.assign(actor, { manager, browsingContext: bc });
const unbind = bindDocumentHost(browser, { save: async (request, isCurrent) => {
  await new Promise(resolve => { continueSave = resolve; });
  if (isCurrent()) saves.push(request);
} });
const message = { name: "PDFJS:Parent:saveURL", data: { blobUrl: "blob:resource://pdf.js/123", originalUrl: "https://example.test/form.pdf", filename: "form.pdf" } };
const save = async () => { const result = actor.receiveMessage(message); continueSave?.(); await result; };
await save();
assert.equal(saves.length, 1);
assert.equal(Object.isFrozen(saves[0]), true);

for (const principal of ["https://example.test", "resource://pdf.js/evil.html", "resource://pdf.js/web/viewer.html?fake=1"]) {
  manager.documentPrincipal.URI.spec = principal;
  await save();
}
manager.documentPrincipal.URI.spec = "resource://pdf.js/web/viewer.html";
for (const data of [
  { ...message.data, originalUrl: "file:///secret.pdf" },
  { ...message.data, blobUrl: "https://other.test/secret.pdf" },
  { ...message.data, blobUrl: "blob:https://other.test/123" },
  { ...message.data, blobUrl: "javascript:alert(1)" },
  { ...message.data, originalUrl: "x".repeat(65537) },
]) {
  await actor.receiveMessage({ ...message, data });
}
assert.equal(saves.length, 1, "ordinary documents and foreign URLs cannot use the PDF save authority");

bc.parent = {};
bc.sandboxFlags = 0x10000;
await save();
assert.equal(saves.length, 1, "sandboxed embedded PDFs cannot download");
bc.parent = null;
bc.sandboxFlags = 0;
const pending = actor.receiveMessage(message);
bc.currentWindowGlobal = {};
continueSave();
await pending;
assert.equal(saves.length, 1, "navigation while the destination picker is open revokes the request");
bc.currentWindowGlobal = manager;
unbind();
await save();
assert.equal(saves.length, 1, "a released host cannot save");
unbind();
console.log("PDF actor authority, sandbox, foreign-blob, navigation and host-release checks passed");

// Reader presentation is optional and must never style a Web/system document.
const childSource = await fs.readFile(new URL("../embedder/modules/NavisPdfjsChild.sys.mjs", import.meta.url), "utf8");
let configured = true;
const attached = [];
const initialized = [];
const childContext = vm.createContext({
  EnginePdfjsChild: class { init(find) { initialized.push(find); } },
  Services: { io: { getProtocolHandler(scheme) {
    assert.equal(scheme, "resource");
    return { QueryInterface() { return { hasSubstitution(host) {
      assert.equal(host, "navis-pdf-style"); return configured;
    } }; } };
  } } },
  Ci: { nsIResProtocolHandler: {}, nsIDOMWindowUtils: { AUTHOR_SHEET: 1 } },
});
vm.runInContext(childSource.replace(/^import .*;$/m, "").replaceAll("export ", "") +
  "\nglobalThis.PdfjsChild = PdfjsChild;", childContext);
const child = new childContext.PdfjsChild();
const principal = { isContentPrincipal: true, URI: { spec: "resource://pdf.js/web/viewer.html" } };
child.contentWindow = { document: { nodePrincipal: principal }, windowUtils: {
  loadSheetUsingURIString(uri, kind) { attached.push({ uri, kind }); },
} };
child.init(false);
assert.deepEqual(attached, [{ uri: "resource://navis-pdf-style/pdf-reader.css", kind: 1 }]);
configured = false;
child.init(true);
assert.equal(attached.length, 1, "a standalone Runtime requires no Platform skin");
configured = true;
for (const spec of ["https://example.test/document.pdf", "resource://pdf.js/web/viewer.html?fake=1",
  "resource://pdf.js/web/other.html"]) {
  principal.URI.spec = spec; child.init(false);
}
principal.URI.spec = "resource://pdf.js/web/viewer.html";
principal.isContentPrincipal = false;
child.init(false);
assert.equal(attached.length, 1, "only the exact PDF viewer content principal receives presentation");
assert.deepEqual(initialized, [false, true, false, false, false, false], "upstream actor initialization is retained");
console.log("Optional packaged PDF presentation preserves upstream initialization and principal isolation");
