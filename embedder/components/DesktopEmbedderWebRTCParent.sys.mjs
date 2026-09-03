/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function browserForActor(actor) {
  return actor.browsingContext.top.embedderElement;
}

export class DesktopEmbedderWebRTCParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = browserForActor(this);

    switch (message.name) {
      case "rtcpeer:Request":
        this.sendAsyncMessage("rtcpeer:Allow", {
          callID: message.data.callID,
          windowID: message.data.windowID,
        });
        break;
      case "rtcpeer:CancelRequest":
        break;
      case "webrtc:Request": {
        const principal = this.manager.topWindowContext.documentPrincipal;
        const request = Object.freeze({
          ...message.data,
          origin: principal.origin,
          frameOrigin: this.manager.documentPrincipal.origin,
        });
        if (
          typeof browser?.desktopEmbedderWebRTCPermissionPrompt !== "function"
        ) {
          this.#respond(message.data, { allow: false });
          return;
        }
        browser.desktopEmbedderWebRTCPermissionPrompt(
          request,
          decision => this.#respond(message.data, decision),
          principal
        );
        break;
      }
      case "webrtc:CancelRequest":
        browser?.desktopEmbedderCancelWebRTCPermissionPrompt?.(message.data);
        break;
      case "webrtc:UpdateIndicators":
        browser?.desktopEmbedderMediaStateChanged?.(
          Object.freeze({
            camera: Boolean(message.data.camera),
            microphone: Boolean(message.data.microphone),
            screen: Boolean(
              message.data.screen || message.data.window || message.data.browser
            ),
          })
        );
        break;
    }
  }

  #respond(request, decision) {
    const allow = Boolean(decision?.allow);
    this.sendAsyncMessage(allow ? "webrtc:Allow" : "webrtc:Deny", {
      callID: request.callID,
      windowID: request.windowID,
      devices: allow ? decision.devices || [] : undefined,
    });
  }
}
