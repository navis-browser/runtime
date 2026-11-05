/* SPDX-License-Identifier: MPL-2.0 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { CERTIFICATE_SECURITY_DATA } from "resource://gre/modules/CertificateSecurityData.sys.mjs";

export function initializeCertificateSecurity() {
  if (AppConstants.MOZ_NAVIS_REMOTE_SETTINGS_POLICY) {
    const { RemoteSecuritySettings } = ChromeUtils.importESModule(
      "resource://gre/modules/psm/RemoteSecuritySettings.sys.mjs"
    );
    RemoteSecuritySettings.init();
  }
}

export function certificateSecurityDiagnostics(now = Date.now()) {
  const expires = Date.parse(CERTIFICATE_SECURITY_DATA.ctExpiration);
  const mode = Services.prefs.getIntPref("security.pki.certificate_transparency.mode", 0);
  const status = !Number.isFinite(expires) ? "unavailable"
    : now > expires ? "ct-expired"
      : mode !== 2 ? "disabled"
        : expires - now < 28 * 86400000 ? "ct-expiring" : "ct-current";
  return [
    ["diagnostics.certificateTransparency", status],
    ["diagnostics.ctExpiration", CERTIFICATE_SECURITY_DATA.ctExpiration],
    ["diagnostics.revocationsDate", new Date(CERTIFICATE_SECURITY_DATA.onecrlTimestamp).toISOString()],
  ];
}
