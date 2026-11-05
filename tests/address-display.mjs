// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { decodeDesktopAddressForDisplay } from "../embedder/modules/DesktopAddressInput.sys.mjs";

const cases = [
  ["https://example.test/%E4%B8%AD%E6%96%87?q=%E4%BD%A0%E5%A5%BD#%E7%AB%A0", "https://example.test/中文?q=你好#章"],
  ["https://example.test/caf%C3%A9/%F0%9F%8C%8D", "https://example.test/café/🌍"],
  ["https://example.test/a%2Fb?x=a%26b%3Dc#d%23e", "https://example.test/a%2Fb?x=a%26b%3Dc#d%23e"],
  ["https://example.test/%252F/%E4%B8%AD", "https://example.test/%252F/%E4%B8%AD"],
  ["https://example.test/%2520/%25/%E4%B8%AD", "https://example.test/%2520/%25/中"],
  ["https://example.test/%E4%B8%AD%FF", "https://example.test/%E4%B8%AD%FF"],
  ["https://example.test/%00%09%0A%0D%C2%A0%E3%80%80", "https://example.test/%00%09%0A%0D%C2%A0%E3%80%80"],
  ["https://example.test/%E2%80%AE%E2%80%8B%EF%BB%BF", "https://example.test/%E2%80%AE%E2%80%8B%EF%BB%BF"],
  ["https://example.test/a%20b%20%20c%20", "https://example.test/a b%20 c%20"],
  ["https://example.test/%F0%9F%94%92", "https://example.test/%F0%9F%94%92"],
  ["navis://settings/", "navis://settings/"],
];
for (const [spec, expected] of cases) {
  const scheme = new URL(spec).protocol.slice(0, -1);
  const display = decodeDesktopAddressForDisplay(spec, scheme);
  assert.equal(display, expected, spec);
  // Re-submission must keep the escaped separators and literal percent values.
  assert.equal(new URL(display).href, new URL(spec).href, spec);
}
assert.equal(decodeDesktopAddressForDisplay("file:///tmp/%E4%B8%AD", "file"), "file:///tmp/中");
assert.equal(decodeDesktopAddressForDisplay("about:%E4%B8%AD", "about"), "about:%E4%B8%AD");

// Exercise the actual backend copy method across its native URI/cleaner
// boundary, including a cleaner returning a readable internationalized host.
const engine = readFileSync(new URL("../embedder/modules/DesktopEngine.sys.mjs", import.meta.url), "utf8");
const method = engine.slice(engine.indexOf("  copyAddressLink(value) {"), engine.indexOf("  getSiteDataState(session) {"));
let clean = false;
let copied;
const Peer = vm.runInNewContext(`(class { #assertOpen() {} copyText(value) { write(value); return true; } ${method} })`, {
  Services: {io: {newURI(value) { const url = new URL(value); return {asciiSpec: url.href, schemeIs: scheme => url.protocol === scheme + ":"}; }}},
  projectDesktopCopiedLink: value => clean ? "https://例子.test/中文" : value,
  write: value => copied = value,
}, {timeout: 1000});
const peer = new Peer();
assert.equal(peer.copyAddressLink("https://example.test/中文"), true);
assert.equal(copied, "https://example.test/%E4%B8%AD%E6%96%87");
clean = true;
assert.equal(peer.copyAddressLink("https://example.test/中文"), true);
assert.equal(copied, new URL("https://例子.test/中文").href);
copied = undefined;
assert.equal(peer.copyAddressLink("navis://settings/"), false);
assert.equal(peer.copyAddressLink("https://[invalid"), false);
assert.equal(copied, undefined);
console.log("Address display: readable Unicode, URL round trips and unsafe-character cases passed.");
