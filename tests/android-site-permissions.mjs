// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia }
  from "../embedder/modules/SitePermissionOrigins.sys.mjs";

const source = await readFile(new URL("../embedder/modules/NavisAndroidPermissions.sys.mjs", import.meta.url), "utf8");
const values = new Map();
const key = (principal, name) => `${principal.origin}|${name}`;
const perms = {
  ALLOW_ACTION: 1, DENY_ACTION: 2, EXPIRE_NEVER: 0, EXPIRE_SESSION: 1,
  getPermissionObject: (principal, name, exact) => {
    assert.equal(exact, true); return values.get(key(principal, name));
  },
  testExactPermissionFromPrincipal: (principal, name) => values.get(key(principal, name))?.capability ?? 0,
  addFromPrincipal: (principal, name, capability, expireType) => values.set(key(principal, name), { capability, expireType }),
  removeFromPrincipal: (principal, name) => values.delete(key(principal, name)),
};
const Services = { uuid: { generateUUID: randomUUID }, perms };
globalThis.Services = Services;
const api = vm.runInNewContext(source.replace(/^import[\s\S]*?;$/gm, "").replaceAll("export ", "") +
  "\n({ registerAndroidPermissions, androidSitePermissions, setAndroidSitePermission, androidPermissionEpoch, revokeAllAndroidPermissions, stopAndroidSiteDevices });",
  { permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia,
    Services, Ci: {} });
let nextBrowser = 1;
function host(privateMode = false, origin = "https://site.test") {
  const principal = { isContentPrincipal: true, privateBrowsingId: privateMode ? 1 : 0,
    origin: origin + (privateMode ? "^privateBrowsingId=1" : ""),
    URI: { prePath: origin, schemeIs: value => value === "https" }, schemeIs: value => value === "https",
    equals(other) { return other?.origin === this.origin; },
  };
  const stopped = [], updates = [];
  const context = { browserId: nextBrowser++, children: [],
    currentWindowGlobal: { getActor(name) { assert.equal(name, "GeckoViewPermission");
      return { sendQuery: async name => { assert.equal(name, "Navis:StopMedia"); stopped.push(name); } }; } },
  };
  Object.assign(context.currentWindowGlobal, { documentPrincipal: principal, browsingContext: context, isCurrentGlobal: true });
  const browser = { contentPrincipal: principal, documentURI: { prePath: origin, schemeIs: value => value === "https" }, browsingContext: context };
  let canceled = 0;
  const unregister = api.registerAndroidPermissions(browser, { cancel: () => canceled++, publish: state => updates.push(state) });
  return { browser, principal, stopped, updates, unregister, get canceled() { return canceled; } };
}
const current = host(), peer = host(), isolated = host(true);
const change = (browser, kind, decision, originToken = api.androidSitePermissions(browser).permissions[0]?.originToken) =>
  api.setAndroidSitePermission(browser, kind, decision, originToken);
assert.equal(api.androidSitePermissions(current.browser).permissions.length, 5);
await change(current.browser, "geolocation", "allow");
assert.equal(perms.testExactPermissionFromPrincipal(current.principal, "geo"), 1);
assert.equal(perms.testExactPermissionFromPrincipal(isolated.principal, "geo"), 0);
assert.equal(current.canceled, 1);
assert.equal(peer.canceled, 1);
assert.equal(isolated.canceled, 0);
const epoch = api.androidPermissionEpoch(current.principal);
await change(current.browser, "camera", "ask");
assert.equal(api.androidPermissionEpoch(current.principal), epoch + 1);
assert.equal(current.stopped.length, 1);
assert.equal(peer.stopped.length, 1);
assert.equal(isolated.stopped.length, 0);
await change(isolated.browser, "microphone", "block");
assert.equal(values.get(key(isolated.principal, "microphone")).expireType, 1);
for (const [kind, decision] of [["serial", "allow"], ["unknown", "allow"], ["camera", "other"]]) {
  await assert.rejects(() => change(current.browser, kind, decision), /Invalid/);
}
current.browser.navisAndroidMediaStateChanged({ camera: true, microphone: false });
assert.equal(api.androidSitePermissions(current.browser).devices.camera, true);
assert.deepEqual(Object.keys(current.updates.at(-1)).sort(), ["camera", "microphone"]);
assert.ok(Object.isFrozen(current.updates.at(-1)));
assert.doesNotMatch(JSON.stringify(current.updates), /connectionId|browserId|principal/);

const parentSource = await readFile(new URL("../gecko/mobile/shared/actors/GeckoViewPermissionParent.sys.mjs", import.meta.url), "utf8");
const Parent = vm.runInNewContext(parentSource.replace(/^import .*;$/gm, "").replace("export class", "class") +
  "\nGeckoViewPermissionParent;", { GeckoViewActorParent: class {}, GeckoViewUtils: { initLogging: () => ({ debug() {} }) },
    Services, ChromeUtils: { importESModule: () => api },
  });
const top = { embedderElement: current.browser };
let resolve;
function actor(id) {
  const actor = new Parent();
  actor.manager = { innerWindowId: id, documentPrincipal: current.principal, documentURI: { spec: "https://site.test" } };
  actor.browsingContext = { top, currentWindowGlobal: actor.manager };
  actor.eventDispatcher = { sendRequestForResult: () => new Promise(reply => { resolve = reply; }) };
  return actor;
}
const first = actor(1), second = actor(2);
const update = (actor, devices) => actor.receiveMessage({ name: "GeckoView:MediaRecordingStatusChanged", data: { devices, innerWindowId: 1 } });
update(first, [{ type: "camera", status: "recording" }]);
update(second, [{ type: "microphone", status: "recording" }]);
update(second, []);
assert.equal(current.updates.at(-1).camera, true);
update(second, [{ type: "microphone", status: "recording" }]);
first.didDestroy();
assert.equal(current.updates.at(-1).camera, false);
assert.equal(current.updates.at(-1).microphone, true);
second.didDestroy();
assert.equal(current.updates.at(-1).microphone, false);

const pending = first.receiveMessage({ name: "GeckoView:MediaPermission", data: { video: [{}] } });
await change(current.browser, "camera", "ask");
resolve({ navisDecision: "allow-session", video: "native-id" });
assert.equal(await pending, null, "Late allow cannot undo a user reset");
assert.equal(perms.testExactPermissionFromPrincipal(current.principal, "camera"), 0);
const blocking = first.receiveMessage({ name: "GeckoView:MediaPermission", data: { video: [{}] } });
resolve({ navisDecision: "block" });
assert.equal(await blocking, null);
assert.equal(perms.testExactPermissionFromPrincipal(current.principal, "camera"), 2);
assert.equal(first.receiveMessage({ name: "GeckoView:MediaPermission", data: { video: [{}] } }), null);
const embeddedHost = host(false, "https://embedder.test");
embeddedHost.browser.browsingContext.children.push(current.browser.browsingContext);
const beforeStop = current.stopped.length;
await change(current.browser, "camera", "ask");
assert.equal(embeddedHost.canceled, 1, "Reset reaches peer tabs containing this origin");
assert.equal(embeddedHost.stopped.length, 0, "Unrelated embedding origin does not lose camera access");
assert.ok(current.stopped.length > beforeStop);
const embeddedChoice = api.androidSitePermissions(embeddedHost.browser).permissions.find(p => p.embedded);
assert.equal(embeddedChoice.origin, "https://site.test");
await change(embeddedHost.browser, "geolocation", "block", embeddedChoice.originToken);
assert.equal(perms.testExactPermissionFromPrincipal(current.principal, "geo"), 2);
assert.equal(perms.testExactPermissionFromPrincipal(embeddedHost.principal, "geo"), 0);
for (const kind of ["midi", "serial", "hid", "usb", "bluetooth", "xr"]) {
  await assert.rejects(() => change(current.browser, kind, "allow"), /Invalid/);
  await assert.rejects(() => api.stopAndroidSiteDevices(embeddedHost.browser, kind), /Invalid/);
}
embeddedHost.browser.browsingContext.children = [];
await assert.rejects(() => change(embeddedHost.browser, "camera", "allow", embeddedChoice.originToken), /Invalid/);
await assert.rejects(() => api.setAndroidSitePermission(current.browser, "camera", "allow"), /Invalid/);
embeddedHost.unregister();
current.unregister(); peer.unregister(); isolated.unregister();
assert.equal(api.androidSitePermissions(current.browser).permissions.length, 0);
console.log("PASS Android native site permissions: exact/private principals, native stop, request epochs, frame aggregation and immutable media state");
