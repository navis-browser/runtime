/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function browserForActor(actor) {
  return actor.browsingContext.top.embedderElement;
}

const captureStates = new WeakMap();

function publishCaptureState(context) {
  const state = { camera: false, microphone: false, screen: false };
  for (const capture of captureStates.get(context)?.values() ?? []) {
    for (const key of Object.keys(state)) state[key] ||= capture[key];
  }
  context.embedderElement?.desktopEmbedderMediaStateChanged?.(Object.freeze(state));
}

export class DesktopEmbedderWebRTCParent extends JSWindowActorParent {
  #context = null;
  #windowId = null;

  didDestroy() {
    if (this.#context && captureStates.get(this.#context)?.delete(this.#windowId)) {
      publishCaptureState(this.#context);
    }
  }

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
        const window = this.manager;
        const topWindow = window.topWindowContext;
        const isCurrent = () => window.isCurrentGlobal && topWindow.isCurrentGlobal &&
          this.browsingContext.currentWindowGlobal === window &&
          this.browsingContext.top.currentWindowGlobal === topWindow;
        if (!isCurrent()) {
          this.#respond(message.data, { allow: false });
          return;
        }
        const principal = window.documentPrincipal;
        const request = Object.freeze({
          ...message.data,
          origin: topWindow.documentPrincipal.originNoSuffix,
          frameOrigin: principal.originNoSuffix,
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
          principal,
          isCurrent,
        );
        break;
      }
      case "webrtc:CancelRequest":
        browser?.desktopEmbedderCancelWebRTCPermissionPrompt?.(message.data);
        break;
      case "webrtc:UpdateIndicators": {
        this.#context = this.browsingContext.top;
        this.#windowId = this.manager.innerWindowId;
        let captures = captureStates.get(this.#context);
        if (!captures) captureStates.set(this.#context, captures = new Map());
        const state = {
          camera: Boolean(message.data.camera),
          microphone: Boolean(message.data.microphone),
          screen: Boolean(message.data.screen || message.data.window || message.data.browser),
        };
        if (Object.values(state).some(Boolean)) captures.set(this.#windowId, state);
        else captures.delete(this.#windowId);
        publishCaptureState(this.#context);
        break;
      }
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
