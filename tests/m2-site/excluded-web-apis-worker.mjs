// SPDX-License-Identifier: MPL-2.0
import "/excluded-web-apis-probe.js";
const probe = globalThis.navisApiProbe;
if ("onconnect" in self) {
  self.onconnect = event => { event.ports[0].postMessage(probe()); event.ports[0].close(); };
} else {
  self.postMessage(probe());
}
