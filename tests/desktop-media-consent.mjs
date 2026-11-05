// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { permissionDecisions } from "../embedder/modules/DesktopPermissionPolicy.sys.mjs";

const source = await readFile(new URL("../embedder/modules/DesktopEngine.sys.mjs", import.meta.url), "utf8");
const start = source.indexOf("  #handleMediaPermission(");
const end = source.indexOf("  #handlePrompt(", start);
assert.ok(start > 0 && end > start);
const writes = [], replies = [];
const Session = vm.runInNewContext(`
  let nextPromptId = 0;
  class Session {
    #state = { private: false };
    entry;
    #enqueuePrompt(entry) { this.entry = entry; }
    #selectMediaDevices() { return [0]; }
    #addMediaManagerVideoPermission() {}
    request(request, respond, principal, current) { this.#handleMediaPermission(request, respond, principal, current); }
    ${source.slice(start, end)}
  }
  Session;
`, { permissionDecisions, MEDIA_PERMISSION_KEYS: new Map([["Camera", "camera"]]),
  Services: { perms: { testExactPermissionFromPrincipal: () => 0,
    ALLOW_ACTION: 1, DENY_ACTION: 2, EXPIRE_NEVER: 0, EXPIRE_SESSION: 1,
    addFromPrincipal: (...args) => writes.push(args),
  } },
});
const request = { secure: true, requestTypes: ["Camera"], videoInputDevices: [{ name: "Camera" }], audioInputDevices: [],
  origin: "https://outer.test", frameOrigin: "https://frame.test" };
const principal = { origin: request.origin };
let current = true;
const session = new Session();
session.request(request, reply => replies.push(reply), principal, () => current);
assert.ok(session.entry);
current = false;
session.entry.respond({ decision: "allow-always", choices: { camera: "0" } });
assert.equal(writes.length, 0, "Late approval cannot persist a grant for a replaced document");
assert.equal(replies.at(-1).allow, false);
session.entry.respond("block");
assert.equal(writes.length, 0, "Late denial cannot persist a decision for a replaced document");
current = true;
session.request(request, reply => replies.push(reply), principal, () => current);
session.entry.respond({ decision: "allow-session", choices: { camera: "0" } });
assert.equal(writes.length, 1);
assert.equal(replies.at(-1).allow, true);
console.log("PASS media consent: authenticated live approval and no persisted decision after frame navigation");

const revokeStart = source.indexOf("  async [REVOKE_PERMISSION](");
const revokeEnd = source.indexOf("  setPromptDelegate(", revokeStart);
const REVOKE_PERMISSION = Symbol("revoke"), stopped = [], canceled = [];
const Revoker = vm.runInNewContext(`
  class Revoker {
    #browser = {};
    entries = [];
    #cancelMatchingPrompts(predicate) {
      for (const entry of this.entries.filter(predicate)) canceled.push(entry);
    }
    revoke(principal) { return this[REVOKE_PERMISSION](["camera"], true, principal); }
    ${source.slice(revokeStart, revokeEnd)}
  }
  Revoker;
`, { REVOKE_PERMISSION, canceled, SITE_PERMISSION_KINDS: new Map(),
  stopPermissionMedia: async (_browser, principal) => stopped.push(principal),
});
function identity(origin) { return { origin, equals: other => origin === other?.origin }; }
const privateFrame = identity("https://frame.test^privateBrowsingId=1");
const privateTop = identity("https://outer.test^privateBrowsingId=1");
const normalFrame = identity("https://frame.test");
const revoker = new Revoker();
for (const principal of [privateFrame, privateTop, normalFrame]) {
  revoker.entries.push({ permissionPrincipal: principal, delegateType: "permission",
    descriptor: { category: "media", permissions: ["camera"],
      origin: "https://outer.test", frameOrigin: "https://frame.test" } });
}
await revoker.revoke(privateFrame);
assert.deepEqual(canceled, [revoker.entries[0]], "Cancellation follows the requesting principal and its private attributes");
assert.deepEqual(stopped, [privateFrame]);
console.log("PASS pending media cancellation uses native principals, not display origins");
