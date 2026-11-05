// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia }
  from "../embedder/modules/SitePermissionOrigins.sys.mjs";

const source = await readFile(
  new URL("../embedder/modules/DesktopEngine.sys.mjs", import.meta.url),
  "utf8",
);
function slice(start, end) {
  const index = source.indexOf(start);
  const finish = source.indexOf(end, index + start.length);
  assert.ok(index >= 0 && finish > index);
  return source.slice(index, finish);
}
const GET_BROWSER = Symbol(),
  REVOKE_PERMISSION = Symbol();
const LIVE_ENGINE_SESSIONS = new Set(),
  values = new Map();
const key = (principal, kind) =>
  `${principal.origin}|${principal.privateMode}|${kind}`;
const perms = {
  ALLOW_ACTION: 1,
  DENY_ACTION: 2,
  EXPIRE_NEVER: 0,
  EXPIRE_SESSION: 1,
  testExactPermissionFromPrincipal: (principal, kind) =>
    values.get(key(principal, kind))?.capability ?? 0,
  getPermissionObject: (principal, kind, exact) => {
    assert.equal(exact, true);
    return values.get(key(principal, kind)) ?? null;
  },
  removeFromPrincipal: (principal, kind) => values.delete(key(principal, kind)),
  addFromPrincipal: (principal, kind, capability, expireType) =>
    values.set(key(principal, kind), { capability, expireType }),
};
const Services = { perms, uuid: { generateUUID: randomUUID } };
globalThis.Services = Services;
const Runtime = vm.runInNewContext(
  `
  ${slice("const CONTENT_PERMISSIONS =", "let nextPromptId =")}
  ${slice("function authenticatedWebPrincipal(", "function authenticatedWebAuthnOrigin(")}
  class Runtime {
    #sessions = new Set();
    capabilities = { mediaCapture: true };
    #assertOpen() {}
    register(session) { this.#sessions.add(session); }
    ${slice("  getSitePermissionState(", "  // Keeping the authenticated product-page router")}
  }
  Runtime;
`,
  {
    GET_BROWSER,
    REVOKE_PERMISSION,
    LIVE_ENGINE_SESSIONS,
    Services, permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia,
    isLoopbackHost: () => false,
  },
);

function session(origin = "https://site.test", privateMode = false) {
  const url = new URL(origin);
  const uri = {
    prePath: origin,
    asciiHost: url.hostname,
    schemeIs: (scheme) => url.protocol === `${scheme}:`,
  };
  const principal = {
    origin,
    privateMode,
    URI: uri,
    isContentPrincipal: true,
    equals(other) {
      return (
        this.origin === other.origin && this.privateMode === other.privateMode
      );
    },
  };
  const context = { children: [] };
  context.currentWindowGlobal = { isCurrentGlobal: true, browsingContext: context, documentPrincipal: principal };
  const browser = { contentPrincipal: principal, documentURI: uri, browsingContext: context };
  const revoked = [];
  const result = {
    state: { private: privateMode, navigationId: 7 },
    browser,
    revoked,
    [GET_BROWSER]: () => browser,
    [REVOKE_PERMISSION]: (keys, stop) =>
      revoked.push({ keys: [...keys], stop }),
  };
  LIVE_ENGINE_SESSIONS.add(result);
  return result;
}
const runtime = new Runtime(),
  current = session(),
  peer = session(),
  privatePeer = session(undefined, true);
runtime.register(current);
const update = (kind, decision, navigationId = 7) =>
  runtime.setSitePermission(current, { navigationId, kind, decision,
    originToken: runtime.getSitePermissionState(current).permissions[0]?.originToken });
assert.equal(runtime.getSitePermissionState(current).permissions.length, 5);
await update("geolocation", "allow");
assert.equal(
  perms.testExactPermissionFromPrincipal(
    current.browser.contentPrincipal,
    "geo",
  ),
  1,
);
assert.equal(
  perms.testExactPermissionFromPrincipal(
    privatePeer.browser.contentPrincipal,
    "geo",
  ),
  0,
);
assert.equal(peer.revoked.length, 1);
assert.equal(privatePeer.revoked.length, 0);
for (const [kind, decision, navigation] of [
  ["camera", "allow", 6],
  ["unknown", "allow", 7],
  ["camera", "unexpected", 7],
]) {
  await assert.rejects(
    () => update(kind, decision, navigation),
    /Invalid or stale/,
  );
}
assert.throws(() => runtime.getSitePermissionState(peer), /does not belong/);
await assert.rejects(
  () =>
    runtime.setSitePermission(peer, {
      navigationId: 7,
      kind: "camera",
      decision: "allow",
    }),
  /does not belong/,
);
await update("camera", "allow");
await update("microphone", "allow");
await update("camera", "ask");
assert.deepEqual(peer.revoked.at(-1), {
  keys: ["camera", "microphone", "MediaManagerVideo"],
  stop: true,
});
assert.equal(
  perms.testExactPermissionFromPrincipal(
    current.browser.contentPrincipal,
    "camera",
  ),
  0,
);
assert.equal(
  perms.testExactPermissionFromPrincipal(
    current.browser.contentPrincipal,
    "microphone",
  ),
  0,
);
const privateRuntime = new Runtime();
privateRuntime.register(privatePeer);
await privateRuntime.setSitePermission(privatePeer, {
  originToken: privateRuntime.getSitePermissionState(privatePeer).permissions[0].originToken,
  navigationId: 7,
  kind: "geolocation",
  decision: "allow",
});
assert.equal(
  values.get(key(privatePeer.browser.contentPrincipal, "geo")).expireType,
  1,
);
assert.ok(
  privateRuntime
    .getSitePermissionState(privatePeer)
    .permissions.find((p) => p.kind === "geolocation").temporary,
);
const trustedURI = current.browser.documentURI;
current.browser.documentURI = {
  ...trustedURI,
  prePath: "https://another.test",
};
assert.equal(runtime.getSitePermissionState(current).available, false);
await assert.rejects(() => update("geolocation", "allow"), /Invalid or stale/);
current.browser.documentURI = trustedURI;
current.browser.contentPrincipal.isContentPrincipal = false;
assert.equal(runtime.getSitePermissionState(current).available, false);
current.browser.contentPrincipal.isContentPrincipal = true;
runtime.capabilities.mediaCapture = false;
assert.equal(runtime.getSitePermissionState(current).permissions.length, 3);
await assert.rejects(() => update("camera", "allow"), /Invalid or stale/);
console.log(
  "PASS site permissions: authenticated origin, stale/foreign denial, live peers, media revocation, private isolation and lifetime",
);

const embeddedHost = session("https://embedder.test");
embeddedHost.browser.browsingContext.children.push(current.browser.browsingContext);
await update("geolocation", "block");
assert.equal(embeddedHost.revoked.length, 1, "Origin revocation reaches embedded documents in other tabs");
runtime.register(embeddedHost);
const inventory = runtime.getSitePermissionState(embeddedHost);
const embeddedEntry = inventory.permissions.find(item => item.origin === "https://site.test");
assert.ok(embeddedEntry?.embedded);
assert.ok(Object.isFrozen(embeddedEntry));
await runtime.setSitePermission(embeddedHost, { navigationId: 7, originToken: embeddedEntry.originToken,
  kind: "geolocation", decision: "ask" });
assert.equal(perms.testExactPermissionFromPrincipal(current.browser.contentPrincipal, "geo"), 0);
embeddedHost.browser.browsingContext.children = [];
await assert.rejects(() => runtime.setSitePermission(embeddedHost, {
  navigationId: 7, originToken: embeddedEntry.originToken, kind: "geolocation", decision: "allow",
}), /Invalid or stale/);
console.log("PASS desktop embedded-origin inventory, peer revocation and detached-frame rejection");

for (const kind of ["midi", "serial", "hid", "usb", "bluetooth", "xr"]) {
  await assert.rejects(() => runtime.stopSiteDevices(embeddedHost, { navigationId: 7, kind }), /Invalid or stale/);
  await assert.rejects(() => update(kind, "allow"), /Invalid or stale/);
}
await assert.rejects(() => runtime.setSitePermission(current, { navigationId: 7, kind: "camera", decision: "allow" }), /Invalid or stale/);
console.log("PASS excluded device actions and missing origin tokens are rejected");
