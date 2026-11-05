/* SPDX-License-Identifier: MPL-2.0 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../embedder/modules/CertificateSecurity.sys.mjs", import.meta.url), "utf8"))
  .replace(/^import .*;$/gmu, "")
  .replaceAll("export function", "function");
const expiration = "2026-12-28T05:26:25Z";

function fixture(mode = 2, navis = true) {
  let initializations = 0;
  const context = {
    AppConstants: { MOZ_NAVIS_REMOTE_SETTINGS_POLICY: navis },
    CERTIFICATE_SECURITY_DATA: { ctExpiration: expiration, onecrlTimestamp: 1792274405312 },
    Services: { prefs: { getIntPref(key) {
      assert.equal(key, "security.pki.certificate_transparency.mode");
      return mode;
    } } },
    ChromeUtils: { importESModule(uri) {
      assert.equal(uri, "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs");
      return { RemoteSecuritySettings: { init() { initializations++; } } };
    } },
  };
  vm.runInNewContext(`${source}\nglobalThis.read = certificateSecurityDiagnostics; globalThis.init = initializeCertificateSecurity;`, context);
  return { status: now => new Map(context.read(now)).get("diagnostics.certificateTransparency"),
    read: now => new Map(context.read(now)), init: context.init, initializations: () => initializations };
}

test("diagnostics distinguish current, expiring, expired and disabled CT", () => {
  const f = fixture();
  const expires = Date.parse(expiration);
  assert.equal(f.status(expires - 42 * 86400000), "ct-current");
  assert.equal(f.status(expires - 27 * 86400000), "ct-expiring");
  assert.equal(f.status(expires), "ct-expiring");
  assert.equal(f.status(expires + 1000), "ct-expired");
  assert.equal(fixture(0).status(expires - 42 * 86400000), "disabled");
  assert.equal(f.read(expires).get("diagnostics.ctExpiration"), expiration);
});

test("an expired package cannot report CT protection even when mode is 2", () => {
  assert.equal(fixture(2).status(Date.parse(expiration) + 1), "ct-expired");
});

test("the normal bundled-storage consumer initializes only for the Navis policy", () => {
  const selected = fixture();
  selected.init();
  assert.equal(selected.initializations(), 1);
  const upstream = fixture(2, false);
  upstream.init();
  assert.equal(upstream.initializations(), 0);
});
