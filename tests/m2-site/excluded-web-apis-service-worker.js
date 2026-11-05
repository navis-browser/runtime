// SPDX-License-Identifier: MPL-2.0
importScripts("/excluded-web-apis-probe.js");
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("message", event => { event.ports[0].postMessage(globalThis.navisApiProbe()); });
