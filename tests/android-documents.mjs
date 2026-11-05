// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

let activeHost, released = 0, sequence = 0, timers = [], now = 0;
const source = (await fs.readFile(new URL("../embedder/modules/NavisAndroidDocuments.sys.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "").replaceAll("export ", "");
const context = vm.createContext({
  Date: { now: () => now },
  AppConstants: {}, XPCOMUtils: {},
  bindDocumentHost(browser, host) { activeHost = host; return () => ++released; },
  Services: { uuid: { generateUUID: () => `token-${++sequence}` }, scriptloader: { loadSubScript() {} } },
});
vm.runInContext(source + "\nglobalThis.create = createAndroidDocuments;", context);
function fixture() {
  assert.equal(timers.length, 0);
  const source = { innerWindowId: 101, documentTitle: "PDF" };
  const browser = { isConnected: true, browsingContext: { currentWindowGlobal: source } };
  const clone = { isConnected: true, browsingContext: {
    currentWindowGlobal: {innerWindowId: 201, isInitialDocument: true},
  }, remove() { this.isConnected = false; } };
  const events = [];
  const window = { MozXULElement: {}, setTimeout: resolve => timers.push(resolve),
    PrintUtils: { createParentBrowserForStaticClone: () => clone } };
  const documents = context.create(window, browser, {
    // Messaging.sys.mjs DispatcherDelegate takes a type string and a separate payload.
    sendRequest(type, payload = {}) { assert.equal(typeof type, "string"); events.push({type, payload}); },
    sendRequestForResult(type, payload) { assert.equal(typeof type, "string"); events.push({type, payload}); return true; },
  });
  return {documents, browser, clone, events};
}
{
  const f = fixture();
  assert.throws(() => f.documents.clone({parent: {top: {}}}), /Foreign/);
  f.documents.clone({parent: {top: f.browser.browsingContext}, isForWindowDotPrint: true});
  if (timers.length) timers.shift()();
  assert.equal(f.events[0].type, "NavisAndroid:Print");
  assert.deepEqual(Object.keys(f.events[0].payload), []);
  const beginning = f.documents.query("document:begin", {});
  let settled = false;
  beginning.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "The initial blank WindowGlobal is not a print snapshot");
  await assert.rejects(f.documents.query("document:begin", {}), /already in progress/);
  f.clone.browsingContext.currentWindowGlobal = { innerWindowId: 202, isInitialDocument: false };
  timers.shift()();
  const lease = await beginning;
  assert.equal(lease.sourceWindow, 101); assert.equal(lease.printWindow, 202);
  assert.equal(Object.isFrozen(lease), true);
  await f.documents.query("document:finish", {token: "foreign"});
  assert.equal(f.clone.isConnected, true);
  await f.documents.query("document:finish", {token: lease.token});
  assert.equal(f.clone.isConnected, false);
  f.documents.close(); f.documents.close();
  await assert.rejects(f.documents.query("document:begin", {}), /closed/);
}
{
  const f = fixture();
  f.documents.clone({parent: {top: f.browser.browsingContext}, isForWindowDotPrint: true});
  if (timers.length) timers.shift()();
  const beginning = f.documents.query("document:begin", {});
  f.browser.browsingContext.currentWindowGlobal = {innerWindowId: 999};
  timers.shift()();
  await assert.rejects(beginning, /changed/);
  assert.equal(f.clone.isConnected, false);
  assert.equal(await activeHost.save({blobUrl: "https://example.test/a.pdf"}, () => true), false);
  assert.equal(await activeHost.save({blobUrl: "blob:resource://pdf.js/1"}, () => false), false);
  const request = Object.freeze({blobUrl: "blob:resource://pdf.js/1", originalUrl: "https://example.test/document.pdf", filename: "document.pdf"});
  assert.equal(await activeHost.save(request, () => true), true);
  assert.equal(f.events.at(-1).type, "NavisAndroid:SavePDF");
  assert.equal(f.events.at(-1).payload, request);
  f.documents.close();
}
{
  const f = fixture();
  f.documents.clone({parent: {top: f.browser.browsingContext}, isForWindowDotPrint: true});
  assert.equal(f.events.length, 0, "Dispatch must follow the OpenInternal return");
  timers.shift()();
  const beginning = f.documents.query("document:begin", {});
  now += 5001;
  timers.shift()();
  await assert.rejects(beginning, /changed/);
  assert.equal(f.clone.isConnected, false);
  f.documents.close();
}
{
  const f = fixture();
  f.documents.clone({parent: {top: f.browser.browsingContext}, isForWindowDotPrint: true});
  f.documents.close();
  timers.shift()();
  assert.equal(f.events.length, 0, "Closing cancels deferred print dispatch");
}
{
  const f = fixture();
  f.documents.clone({parent: {top: f.browser.browsingContext}, isForWindowDotPrint: true});
  f.browser.browsingContext.currentWindowGlobal = {innerWindowId: 999};
  timers.shift()();
  assert.equal(f.events.length, 0, "Navigation cancels deferred print dispatch");
  assert.equal(f.clone.isConnected, false);
  f.documents.close();
}
assert.equal(released, 5);
console.log("Android print lease, foreign source, pending race, navigation, save and idempotent teardown passed; no device claim");
