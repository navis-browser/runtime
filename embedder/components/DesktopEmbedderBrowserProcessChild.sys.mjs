/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  DesktopEmbedderWebRTCChild:
    "resource://gre/modules/DesktopEmbedderWebRTCChild.sys.mjs",
});

export class DesktopEmbedderBrowserProcessChild extends JSProcessActorChild {
  observe(subject, topic, data) {
    lazy.DesktopEmbedderWebRTCChild.observe(subject, topic, data);
  }
}
