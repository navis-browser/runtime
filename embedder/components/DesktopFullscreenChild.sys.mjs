/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function requestParentExit(actor) {
  actor.sendAsyncMessage("DesktopFullscreen:Exit", {});
}

/** Routes trusted content fullscreen events across process boundaries. */
export class DesktopFullscreenChild extends JSWindowActorChild {
  receiveMessage(message) {
    const contentWindow = this.contentWindow;
    const windowUtils = contentWindow?.windowUtils;

    switch (message.name) {
      case "DesktopFullscreen:Entered": {
        if (!windowUtils) {
          requestParentExit(this);
          return;
        }

        const remoteFrameBC = message.data.remoteFrameBC;
        if (remoteFrameBC) {
          const remoteFrame = remoteFrameBC.embedderElement;
          if (!remoteFrame) {
            requestParentExit(this);
            return;
          }
          windowUtils.remoteFrameFullscreenChanged(remoteFrame);
          return;
        }

        if (
          !windowUtils.handleFullscreenRequests() &&
          !contentWindow.document.fullscreenElement
        ) {
          requestParentExit(this);
        }
        return;
      }
      case "DesktopFullscreen:Exited":
        windowUtils?.exitFullscreen();
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "MozDOMFullscreen:Request":
        this.sendAsyncMessage("DesktopFullscreen:Request", {
          fullscreenKeyboardLock: event.detail,
        });
        return;
      case "MozDOMFullscreen:Exit":
        requestParentExit(this);
        return;
      case "MozDOMFullscreen:Entered":
      case "MozDOMFullscreen:Exited":
        if (!this.contentWindow?.document.fullscreenElement) {
          requestParentExit(this);
        }
    }
  }
}
