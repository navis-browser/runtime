// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia }
  from "../embedder/modules/SitePermissionOrigins.sys.mjs";

globalThis.Services = { uuid: { generateUUID: randomUUID } };
export function frame(origin, privateMode = false) {
  const url = new URL(origin);
  const uri = { prePath: origin, asciiHost: url.hostname, schemeIs: value => url.protocol === `${value}:` };
  const principal = { URI: uri, origin: origin + (privateMode ? "^privateBrowsingId=1" : ""),
    isContentPrincipal: true, privateBrowsingId: privateMode ? 1 : 0,
    equals(other) { return this.origin === other?.origin; },
  };
  const stopped = [];
  const context = { children: [] };
  const window = { documentPrincipal: principal, browsingContext: context, isCurrentGlobal: true,
    getActor: name => ({ sendQuery: async message => stopped.push([name, message]) }),
  };
  context.currentWindowGlobal = window;
  const browser = { contentPrincipal: principal, documentURI: uri, browsingContext: context };
  return { browser, principal, context, window, stopped };
}

const first = frame("https://first.test"), embedded = frame("https://embedded.test"),
  peer = frame("https://embedded.test"), isolated = frame("https://embedded.test", true);
first.context.children.push(embedded.context, peer.context, isolated.context);
assert.equal(permissionFrames(first.browser).length, 4);
const origins = permissionOrigins(first.browser);
assert.equal(origins.length, 3);
const scope = origins.find(value => value.principal.equals(embedded.principal));
assert.equal(scope.windows.length, 2);
assert.equal(scope.embedded, true);
assert.equal(resolvePermissionOrigin(first.browser, scope.token)?.origin, "https://embedded.test");
assert.equal(resolvePermissionOrigin(peer.browser, scope.token), null, "Token cannot move between browsers");
await stopPermissionMedia(first.browser, embedded.principal, "permission", "stop");
assert.equal(first.stopped.length, 0);
assert.equal(embedded.stopped.length, 1);
assert.equal(peer.stopped.length, 1);
assert.equal(isolated.stopped.length, 0, "Origin attributes isolate permission changes");
await stopPermissionMedia(first.browser, first.principal, "permission", "stop");
assert.equal(first.stopped.length, 1);
assert.equal(embedded.stopped.length, 1, "An individual top-origin reset leaves another origin's capture intact");
assert.equal(isolated.stopped.length, 0);
first.context.children = [embedded.context];
assert.equal(resolvePermissionOrigin(first.browser, scope.token)?.token, scope.token);
first.context.children = [frame("https://embedded.test").context];
assert.equal(resolvePermissionOrigin(first.browser, scope.token), null, "A replacement document cannot reuse the old choice");
const replacement = permissionOrigins(first.browser)[1];
first.context.children = [];
assert.equal(resolvePermissionOrigin(first.browser, replacement.token), null);
first.context.currentWindowGlobal = { ...first.window };
assert.equal(resolvePermissionOrigin(first.browser, origins[0].token), null, "Same-origin top navigation invalidates all tokens");
first.browser.documentURI = { prePath: "https://spoof.test" };
assert.deepEqual(permissionOrigins(first.browser), []);
console.log("PASS permission origins: current native documents, exact attributes, attached-frame tokens and scoped media stop");
