// SPDX-License-Identifier: MPL-2.0
// Actual Runtime adoption method with recorded native-window and Session peers.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(process.argv[2] || new URL("../embedder/modules/DesktopEngine.sys.mjs", import.meta.url), "utf8");
const start = source.indexOf("  adoptInitialSession(");
assert.ok(start > 0, "Runtime must support native initial-window adoption");
const method = source.slice(start, source.indexOf("  activateSession(", start));
const GET_VIEW_WINDOW = Symbol("window"), CREATE_BROWSER = Symbol("browser");
class EngineView {
  session = null;
  constructor(window) { this.window = window; }
  [GET_VIEW_WINDOW]() { return this.window; }
}
const { Runtime } = vm.runInNewContext(`
  class Runtime {
    #closed = false;
    #sessions = new Set();
    context = {sessions: new Set()};
    options = [];
    creations = 0;
    closes = 0;
    creationHook = () => {};
    browserHook = () => {};
    #assertOpen() { if(this.#closed) throw new Error('Closed Runtime'); }
    #ensureWindow(window) {
      if(window.foreign) throw new Error('Foreign Runtime');
      return this.context;
    }
    close() { this.#closed = true; }
    createSession({view, delegates}) {
      ++this.creations;
      const session = {
        delegates,
        [CREATE_BROWSER]: options => { this.options.push(options); this.browserHook(); },
        close: () => { if (this.#sessions.delete(session)) {
          ++this.closes; this.context.sessions.delete(session); view.session = null;
        } },
      };
      view.session = session;
      this.#sessions.add(session); this.context.sessions.add(session);
      this.creationHook(session);
      return session;
    }
    ${method}
  }
  ({Runtime});
`, {EngineView, GET_VIEW_WINDOW, CREATE_BROWSER,
  Ci: {nsIInterfaceRequestor: "requestor", nsIAppWindow: "app-window"},
  ChromeUtils: {predictRemoteTypeForURI: (uri, {window, userContextId}) => {
    assert.equal(uri, null); assert.equal(userContextId, 7);
    if (window.predictFailure) throw new Error("Process allocation failed");
    return window.remoteType;
  }},
  userContextIdFrom: info => info.originAttributes.userContextId});

function fixture() {
  const info = {isRemote: true, originAttributes: {userContextId: 7}};
  const native = {initialOpenWindowInfo: info};
  const window = {closed: false, remoteType: "webIsolated=fixture", docShell: {treeOwner: {
    QueryInterface(type) { assert.equal(type, "requestor"); return this; },
    getInterface(type) { assert.equal(type, "app-window"); return native; },
  }}};
  const runtime = new Runtime(), view = new EngineView(window);
  return {runtime, view, window, native, info, adopt: options => runtime.adoptInitialSession({view, ...options})};
}
{
  const f = fixture(), delegates = {};
  const session = f.adopt({delegates});
  assert.equal(session, f.view.session);
  assert.equal(session.delegates, delegates);
  assert.equal(f.runtime.creations, 1);
  assert.equal(f.runtime.options[0].openWindowInfo, f.info);
  assert.deepEqual(structuredClone({...f.runtime.options[0], openWindowInfo: undefined}), {
    openWindowInfo: undefined, userContextId: 7, remoteType: f.window.remoteType, skipLoad: true,
  });
  session.close();
  assert.throws(() => f.adopt(), /already been claimed/);
  assert.equal(f.runtime.creations, 1, "Closing must not permit native actor reuse");
}
{
  const f = fixture(); f.native.initialOpenWindowInfo = null;
  assert.equal(f.adopt(), null);
  assert.equal(f.runtime.creations, 0);
  assert.equal(f.view.session, null);
}
for (const invalidate of [
  f => f.runtime.close(), f => { f.window.closed = true; },
  f => { f.view.session = {}; }, f => { f.info.isRemote = false; },
  f => { f.window.foreign = true; }, f => f.runtime.context.sessions.add({}),
]) {
  const f = fixture(); invalidate(f);
  assert.throws(() => f.adopt());
  assert.equal(f.runtime.creations, 0);
  assert.equal(f.runtime.options.length, 0);
}
assert.throws(() => fixture().runtime.adoptInitialSession({view: {}}), /unbound/);
for (const invalidate of [
  f => { f.window.predictFailure = true; },
  f => { f.window.remoteType = null; },
  f => { f.runtime.creationHook = session => session.close(); },
  f => { f.runtime.creationHook = () => { f.window.closed = true; }; },
  f => { f.runtime.browserHook = () => { throw new Error("Native adoption failed"); }; },
  f => { f.runtime.browserHook = () => f.view.session.close(); },
  f => { f.runtime.browserHook = () => { f.window.closed = true; }; },
]) {
  const f = fixture(); invalidate(f);
  assert.throws(() => f.adopt());
  assert.equal(f.view.session, null);
  assert.equal(f.runtime.context.sessions.size, 0);
  assert.equal(f.runtime.closes, 1);
  assert.equal(f.runtime.context.initialSessionClaimed, true);
}
{
  const f = fixture();
  f.runtime.creationHook = () => {
    assert.throws(() => f.runtime.adoptInitialSession({view: new EngineView(f.window)}), /claimed/);
  };
  assert.ok(f.adopt());
  assert.equal(f.runtime.creations, 1);
}
console.log("Initial-window adoption boundary checks passed; no native browser claim");
