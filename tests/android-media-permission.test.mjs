// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const producer = await readFile(
  new URL(
    "../gecko/mobile/shared/modules/navis/NavisAndroidGeckoProducer.sys.mjs",
    import.meta.url,
  ),
  "utf8",
);
function fixture(response) {
  const requests = [];
  const sandbox = {
    ChromeUtils: { importESModule: () => ({ ActorManagerParent: {} }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    producer.replaceAll("export ", "") +
      "\nglobalThis.factory=createNavisGeckoEventDispatcher",
    sandbox,
  );
  const dispatcher = sandbox.factory({
    targetBridge: {
      mediaPermission: async (request) => {
        requests.push(request);
        return response;
      },
    },
    rawDispatcher: {},
    isLive: () => true,
    getBrowser: () => ({
      currentURI: { spec: "https://example.com" },
      browsingContext: { originAttributes: {} },
    }),
  });
  return { requests, dispatcher };
}
const media = {
  video: [
    { rawId: "private-front", label: "Front" },
    { rawId: "private-back", label: "Back" },
  ],
  audio: [{ rawId: "private-audio", label: "Microphone" }],
};
test("only selected devices cross the native boundary and raw IDs never reach UI", async () => {
  const f = fixture({ allow: true, video: "1", audio: "0" });
  const result = await f.dispatcher.sendRequestForResult(
    "GeckoView:MediaPermission",
    media,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    video: "private-back",
    audio: "private-audio",
    navisDecision: "allow-session",
  });
  assert.doesNotMatch(
    JSON.stringify(f.requests),
    /private-front|private-back|private-audio/,
  );
  assert.deepEqual(JSON.parse(f.requests[0].videoSources), [
    { id: "0", label: "Front" },
    { id: "1", label: "Back" },
  ]);
});
test("explicit media block remains distinct from dismissal for native persistence", async () => {
  const f = fixture({ allow: false, decision: "block" });
  assert.deepEqual(JSON.parse(JSON.stringify(await f.dispatcher.sendRequestForResult(
    "GeckoView:MediaPermission", media,
  ))), { navisDecision: "block" });
});
test("boolean-only, missing, forged and canceled device responses fail closed", async () => {
  for (const response of [
    { allow: true },
    { allow: true, video: "2", audio: "0" },
    { allow: true, video: 1, audio: "0" },
    { allow: true, video: "01", audio: "0" },
    { allow: true, video: "1" },
    { allow: false, video: "1", audio: "0" },
    null,
  ]) {
    const f = fixture(response);
    assert.equal(
      await f.dispatcher.sendRequestForResult(
        "GeckoView:MediaPermission",
        media,
      ),
      null,
    );
  }
});
