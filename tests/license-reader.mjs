// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";

const calls = [];
let failed = null;
globalThis.Services = { appinfo: { OS: "Linux" } };
globalThis.Components = { isSuccessCode: value => value === 0 };
globalThis.Ci = { nsIParserUtils: {} };
globalThis.Cc = { "@mozilla.org/parserutils;1": { getService: () => ({ convertToPlainText: value => value }) } };
globalThis.ChromeUtils = { importESModule: () => ({ NetUtil: {
  newChannel: options => options,
  asyncFetch(channel, callback) {
    calls.push(channel.uri);
    assert.match(channel.uri, /^(resource|chrome):\/\//);
    callback({ text: channel.uri, available: () => channel.uri.length }, failed === channel.uri ? 1 : 0);
  },
  readInputStreamToString: stream => stream.text,
} }) };

const load = suffix => import(`../embedder/modules/DesktopProductPages.sys.mjs?${suffix}`);
const source = "resource://gre/modules/navis-licenses/source-code.txt";
const android = "resource://android/assets/navis-licenses/android-dependencies.txt";
const desktop = await load("desktop");
assert.match(await desktop.getNavisLicenseText(), /source-code\.txt/);
assert.ok(!calls.includes(android));
const count = calls.length;
await desktop.getNavisLicenseText();
assert.equal(calls.length, count);
Services.appinfo.OS = "Android";
const mobile = await load("android");
failed = android;
await assert.rejects(mobile.getNavisLicenseText(), /could not be read/);
failed = null;
const text = await mobile.getNavisLicenseText();
assert.ok(text.includes(source));
assert.ok(text.includes(android));
assert.ok(text.includes("colorpicker-compose-1.1.4.txt"));
console.log("Offline license reader: desktop/Android, source directions, cache and retry passed");
