// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import {
  permissionDecisions,
  normalizePermissionResponse,
} from "../embedder/modules/DesktopPermissionPolicy.sys.mjs";

const request = {
  decisions: permissionDecisions(false),
  choices: {
    camera: [
      { id: "0", label: "Front" },
      { id: "1", label: "USB" },
    ],
    microphone: [{ id: "0", label: "Microphone" }],
  },
};
const answer = {
  decision: "allow-session",
  choices: { camera: "1", microphone: "0" },
};
const result = normalizePermissionResponse(answer, request);
assert.deepEqual(result, answer);
assert.ok(Object.isFrozen(result));
assert.ok(Object.isFrozen(result.choices));
answer.choices.camera = "0";
assert.equal(result.choices.camera, "1", "Selection is a snapshot");

for (const invalid of [
  "allow-session",
  undefined,
  null,
  true,
  { decision: "allow-always", choices: { camera: "7", microphone: "0" } },
  { decision: "allow-session", choices: { camera: 1, microphone: "0" } },
  { decision: "allow-session", choices: { camera: "1" } },
  {
    decision: "allow-session",
    choices: { camera: "1", microphone: "0", serial: "0" },
  },
  { decision: "allow-session", choices: { camera: "1", microphone: "-1" } },
  { decision: "unexpected" },
]) {
  assert.equal(normalizePermissionResponse(invalid, request), null);
}
for (const decision of ["block", "dismiss"]) {
  assert.equal(normalizePermissionResponse(decision, request), decision);
}
assert.equal(
  normalizePermissionResponse("allow-always", {
    decisions: permissionDecisions(true),
  }),
  null,
);
assert.equal(
  normalizePermissionResponse("allow-always", {
    decisions: permissionDecisions(false, false),
  }),
  null,
);
assert.equal(
  normalizePermissionResponse("allow-session", {}),
  "allow-session",
  "Existing simple consumers stay compatible",
);
assert.equal(
  normalizePermissionResponse({ decision: "allow-session", choices: {} }, {}),
  "allow-session",
);
assert.equal(
  normalizePermissionResponse(
    { decision: "allow-session", choices: { serial: "0" } },
    {},
  ),
  null,
);
console.log(
  "PASS permission decisions: offered actions, explicit device choice, forged selections, private persistence, immutable responses",
);

const source = await readFile(
  new URL("../embedder/modules/DesktopEngine.sys.mjs", import.meta.url),
  "utf8",
);
function method(start, end) {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin);
  return source.slice(begin, finish);
}
function fixture(privateMode = false, existing = 0) {
  const writes = [],
    replies = [];
  const Session = vm.runInNewContext(
    `
    let nextPromptId = 1;
    const MEDIA_PERMISSION_KEYS = new Map([["Camera", "camera"], ["Microphone", "microphone"]]);
    class Session {
      #state = { private: privateMode };
      #prompts = [];
      get prompt() { return this.#prompts[0]?.descriptor; }
      start(request) { this.#handleMediaPermission(request, reply, {}, () => true); }
      answer(id, response) { return this.#resolvePrompt(id, response); }
      #enqueuePrompt(entry) { this.#prompts.push(entry); }
      #showNextPrompt() {}
      #addMediaManagerVideoPermission() {}
      ${method("  #handleMediaPermission(", "  #handlePrompt(")}
      ${method("  #selectMediaDevices(", "  #addMediaManagerVideoPermission(")}
      ${method("  #resolvePrompt(", "  #clearCredentialState(")}
    }
    Session;
  `,
    {
      privateMode,
      normalizePermissionResponse,
      permissionDecisions,
      console,
      reply: (value) => replies.push(structuredClone(value)),
      Services: {
        perms: {
          ALLOW_ACTION: 1,
          DENY_ACTION: 2,
          EXPIRE_NEVER: 0,
          EXPIRE_SESSION: 1,
          testExactPermissionFromPrincipal: () => existing,
          addFromPrincipal: (...args) => writes.push(args.slice(1)),
        },
      },
    },
  );
  const session = new Session();
  const request = {
    requestTypes: ["Camera", "Microphone"],
    secure: true,
    callID: "request-1",
    origin: "https://site.test",
    frameOrigin: "https://site.test",
    isHandlingUserInput: true,
    videoInputDevices: [
      { name: "Front", deviceIndex: 7 },
      { name: "USB", deviceIndex: 12 },
    ],
    audioInputDevices: [{ name: "Built-in", deviceIndex: 5 }],
  };
  return { session, request, writes, replies };
}
{
  const f = fixture();
  f.session.start(f.request);
  const prompt = f.session.prompt;
  assert.equal(
    f.session.answer("stale-id", {
      decision: "allow-always",
      choices: { camera: "1", microphone: "0" },
    }),
    false,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(
    f.session.answer(prompt.id, {
      decision: "allow-session",
      choices: { camera: "1", microphone: "0" },
    }),
    true,
  );
  assert.deepEqual(f.replies, [{ allow: true, devices: [12, 5] }]);
  assert.deepEqual(f.writes, [
    ["camera", 1, 1],
    ["microphone", 1, 1],
  ]);
  assert.equal(
    f.session.answer(prompt.id, "allow-always"),
    false,
    "A request settles only once",
  );
}
for (const response of [
  "allow-session",
  { decision: "allow-session", choices: { camera: "500", microphone: "0" } },
]) {
  const f = fixture();
  f.session.start(f.request);
  f.session.answer(f.session.prompt.id, response);
  assert.deepEqual(f.replies, [{ allow: false }]);
  assert.equal(
    f.writes.length,
    0,
    "Malformed choices cannot write a permission",
  );
}
{
  const f = fixture(true);
  f.session.start(f.request);
  f.session.answer(f.session.prompt.id, "block");
  assert.deepEqual(
    f.writes,
    [
      ["camera", 2, 1],
      ["microphone", 2, 1],
    ],
    "Private blocks are session-only",
  );
}
{
  const f = fixture(false, 1);
  f.session.start(f.request);
  assert.ok(
    f.session.prompt,
    "Remembered access still offers multiple devices for explicit selection",
  );
  assert.equal(f.replies.length, 0);
}
for (const change of [
  (r) => (r.secure = false),
  (r) => (r.videoInputDevices = []),
  (r) => r.requestTypes.push("Screen"),
]) {
  const f = fixture();
  change(f.request);
  f.session.start(f.request);
  assert.equal(f.session.prompt, undefined);
  assert.deepEqual(f.replies, [{ allow: false }]);
  assert.equal(f.writes.length, 0);
}
console.log(
  "PASS real media permission bridge: selected native device, stale/duplicate reply, malformed choice, private block and unavailable capture",
);

{
  const trace = [];
  const Queue = vm.runInNewContext(
    `
    class Queue {
      #prompts = [];
      start(entries) { this.#prompts = entries; }
      cancelPermissions() { this.#cancelMatchingPrompts(e => e.delegateType === "permission", "delegate-changed"); }
      #notifyPromptCanceled(entry) { trace.push("notify:" + entry.id); }
      #showNextPrompt() { trace.push("show:" + this.#prompts[0]?.id); }
      ${method("  #cancelMatchingPrompts(", "  #cancelAllPrompts(")}
    }
    Queue;
  `,
    { trace },
  );
  const queue = new Queue();
  queue.start(
    ["permission", "permission", "prompt"].map((delegateType, id) => ({
      id,
      delegateType,
      delegateRequested: id === 0,
      cancel: () => trace.push(`cancel:${id}`),
    })),
  );
  queue.cancelPermissions();
  assert.deepEqual(
    trace,
    ["cancel:0", "notify:0", "cancel:1", "show:2"],
    "Canceled queued permissions are never briefly dispatched",
  );
}
