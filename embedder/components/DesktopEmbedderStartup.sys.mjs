/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const STARTUP_CRASH_TRACKING_DELAY_MS = 30 * 1000;

export function DesktopEmbedderStartup() {}

DesktopEmbedderStartup.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),

  observe(subject, topic) {
    if (topic === "app-startup") {
      const { ensureDesktopEmbedderActorsRegistered } =
        ChromeUtils.importESModule(
          "resource://gre/modules/DesktopEmbedderActorRegistry.sys.mjs"
        );
      ensureDesktopEmbedderActorsRegistered();
      const { initializeDesktopWebAuthnPrompt } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopWebAuthnPrompt.sys.mjs"
      );
      initializeDesktopWebAuthnPrompt();

      Services.obs.addObserver(this, "profile-after-change");
      Services.obs.addObserver(this, "final-ui-startup");
      Services.obs.addObserver(this, "quit-application-granted");
    } else if (topic === "profile-after-change") {
      Services.obs.removeObserver(this, "profile-after-change");
      const { initializeDesktopLocale } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopLocale.sys.mjs"
      );
      const { initializeDesktopProcessIsolation } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopProcessIsolation.sys.mjs"
      );
      initializeDesktopLocale();
      initializeDesktopProcessIsolation();
      const { initializeCertificateSecurity } = ChromeUtils.importESModule(
        "resource://gre/modules/CertificateSecurity.sys.mjs"
      );
      initializeCertificateSecurity();
      const { initializeNavisPDF } = ChromeUtils.importESModule(
        "resource://gre/modules/NavisDocuments.sys.mjs");
      initializeNavisPDF();
    } else if (topic === "final-ui-startup") {
      Services.obs.removeObserver(this, "final-ui-startup");
      // Idempotent fallback for startup paths that do not publish the normal
      // profile notification before opening the product window.
      const { initializeDesktopLocale } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopLocale.sys.mjs"
      );
      const { initializeDesktopProcessIsolation } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopProcessIsolation.sys.mjs"
      );
      initializeDesktopLocale();
      initializeDesktopProcessIsolation();
      this.startupCrashTimer = setTimeout(() => {
        this.startupCrashTimer = null;
        Services.tm.idleDispatchToMainThread(
          Services.startup.trackStartupCrashEnd
        );
      }, STARTUP_CRASH_TRACKING_DELAY_MS);
    } else if (topic === "quit-application-granted") {
      Services.obs.removeObserver(this, "quit-application-granted");
      const { shutdownDesktopWebAuthnPrompt } = ChromeUtils.importESModule(
        "resource://gre/modules/DesktopWebAuthnPrompt.sys.mjs"
      );
      shutdownDesktopWebAuthnPrompt();
      const { shutdownNavisPDF } = ChromeUtils.importESModule(
        "resource://gre/modules/NavisDocuments.sys.mjs");
      shutdownNavisPDF();
      if (this.startupCrashTimer !== null) {
        clearTimeout(this.startupCrashTimer);
        this.startupCrashTimer = null;
      }
      Services.startup.trackStartupCrashEnd();
    }
  },

  startupCrashTimer: null,
};
