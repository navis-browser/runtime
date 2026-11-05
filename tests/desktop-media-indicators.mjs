// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL(
    "../embedder/components/DesktopEmbedderWebRTCParent.sys.mjs",
    import.meta.url,
  ),
  "utf8",
);
const Parent = vm.runInNewContext(
  source.replace("export class", "class") + "\nDesktopEmbedderWebRTCParent;",
  {
    JSWindowActorParent: class {},
  },
);
const updates = [];
const top = {
  embedderElement: {
    desktopEmbedderMediaStateChanged: (state) =>
      updates.push(structuredClone(state)),
  },
};
function actor(id) {
  const actor = new Parent();
  actor.browsingContext = { top };
  actor.manager = { innerWindowId: id };
  return actor;
}
const one = actor(1),
  two = actor(2);
const update = (actor, data) =>
  actor.receiveMessage({ name: "webrtc:UpdateIndicators", data });
update(one, { camera: true });
update(two, { microphone: true, windowId: 1 });
assert.deepEqual(updates.at(-1), {
  camera: true,
  microphone: true,
  screen: false,
});
update(two, {});
assert.equal(
  updates.at(-1).camera,
  true,
  "An idle frame cannot hide another frame's recording",
);
update(two, { microphone: true });
one.didDestroy();
assert.deepEqual(updates.at(-1), {
  camera: false,
  microphone: true,
  screen: false,
});
two.didDestroy();
assert.deepEqual(updates.at(-1), {
  camera: false,
  microphone: false,
  screen: false,
});
console.log(
  "PASS capture indicators: frame aggregation, authenticated window identity, frame teardown",
);

let pending;
const replies = [];
const topWindow = { isCurrentGlobal: true, documentPrincipal: { originNoSuffix: "https://outer.test", origin: "https://outer.test^privateBrowsingId=1" } };
top.currentWindowGlobal = topWindow;
top.embedderElement.desktopEmbedderWebRTCPermissionPrompt = (...args) => { pending = args; };
one.manager = { isCurrentGlobal: true, topWindowContext: topWindow,
  documentPrincipal: { originNoSuffix: "https://frame.test", origin: "https://frame.test^privateBrowsingId=1" } };
one.browsingContext.currentWindowGlobal = one.manager;
one.sendAsyncMessage = (name, data) => replies.push({ name, data });
one.receiveMessage({ name: "webrtc:Request", data: { callID: "native-call", windowID: 1 } });
assert.equal(pending[0].frameOrigin, "https://frame.test");
assert.equal(pending[0].origin, "https://outer.test");
assert.equal(pending[2], one.manager.documentPrincipal,
  "A frame's media grant belongs to its own authenticated principal");
assert.equal(pending[3](), true);
one.browsingContext.currentWindowGlobal = {};
assert.equal(pending[3](), false, "Embedded navigation invalidates pending consent");
one.receiveMessage({ name: "webrtc:Request", data: {} });
assert.equal(replies.at(-1).name, "webrtc:Deny");
console.log("PASS capture permission authenticates both requesting and embedding documents");
