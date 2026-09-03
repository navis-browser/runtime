/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "MediaManagerService",
  "@mozilla.org/mediaManagerService;1",
  Ci.nsIMediaManagerService
);

function getActorForWindow(contentWindow) {
  try {
    return (
      contentWindow.windowGlobalChild?.getActor("DesktopEmbedderWebRTC") ||
      null
    );
  } catch {
    return null;
  }
}

function captureKind(device) {
  if (device.type === "videoinput") {
    return device.mediaSource === "camera" ? "camera" : "screen";
  }
  if (device.type === "audioinput") {
    return device.mediaSource === "microphone" ? "microphone" : "screen";
  }
  return null;
}

function rememberCapture(contentWindow, device) {
  const kind = captureKind(device);
  if (!kind) {
    return;
  }
  const captures =
    contentWindow.desktopEmbedderActiveMediaCaptures ||
    (contentWindow.desktopEmbedderActiveMediaCaptures = new Map());
  const key = device.rawId || `${device.type}:${device.mediaSource}`;
  captures.set(key, { kind, mediaSource: device.mediaSource });
}

function trackedCaptureState(contentWindow) {
  const state = { camera: false, microphone: false, screen: false };
  for (const capture of (
    contentWindow.desktopEmbedderActiveMediaCaptures || new Map()
  ).values()) {
    state[capture.kind] = true;
  }
  return state;
}

function setupPendingRequests(contentWindow) {
  if (contentWindow.desktopEmbedderPendingGetUserMediaRequests) {
    return;
  }
  contentWindow.desktopEmbedderPendingGetUserMediaRequests = new Map();
  contentWindow.desktopEmbedderPendingPeerConnectionRequests = new Set();
  contentWindow.addEventListener(
    "unload",
    DesktopEmbedderWebRTCChild.handleEvent
  );
}

function releasePendingRequests(contentWindow) {
  if (
    contentWindow.desktopEmbedderPendingGetUserMediaRequests?.size ||
    contentWindow.desktopEmbedderPendingPeerConnectionRequests?.size
  ) {
    return;
  }
  contentWindow.desktopEmbedderPendingGetUserMediaRequests = null;
  contentWindow.desktopEmbedderPendingPeerConnectionRequests = null;
  contentWindow.removeEventListener(
    "unload",
    DesktopEmbedderWebRTCChild.handleEvent
  );
}

function forgetGetUserMediaRequest(contentWindow, callID) {
  contentWindow.desktopEmbedderPendingGetUserMediaRequests?.delete(callID);
  releasePendingRequests(contentWindow);
}

function forgetPeerConnectionRequest(contentWindow, callID) {
  contentWindow.desktopEmbedderPendingPeerConnectionRequests?.delete(callID);
  releasePendingRequests(contentWindow);
}

function denyGetUserMediaRequest(data) {
  Services.obs.notifyObservers(
    null,
    data.noOSPermission
      ? "getUserMedia:response:noOSPermission"
      : "getUserMedia:response:deny",
    data.callID
  );

  if (!data.windowID) {
    return;
  }
  const contentWindow = Services.wm.getOuterWindowWithId(data.windowID);
  if (contentWindow?.desktopEmbedderPendingGetUserMediaRequests) {
    forgetGetUserMediaRequest(contentWindow, data.callID);
  }
}

function handlePeerConnectionRequest(subject) {
  const { windowID, innerWindowID, callID, isSecure } = subject;
  const contentWindow = Services.wm.getOuterWindowWithId(windowID);
  if (!contentWindow) {
    Services.obs.notifyObservers(null, "PeerConnection:response:deny", callID);
    return;
  }
  setupPendingRequests(contentWindow);
  contentWindow.desktopEmbedderPendingPeerConnectionRequests.add(callID);
  getActorForWindow(contentWindow)?.sendAsyncMessage("rtcpeer:Request", {
    windowID,
    innerWindowID,
    callID,
    documentURI: contentWindow.document.documentURI,
    secure: isSecure,
  });
}

function handleGetUserMediaRequest(subject) {
  const constraints = subject.getConstraints();
  const contentWindow = Services.wm.getOuterWindowWithId(subject.windowID);
  if (!contentWindow) {
    denyGetUserMediaRequest({ callID: subject.callID });
    return;
  }

  const audioInputDevices = [];
  const videoInputDevices = [];
  const audioOutputDevices = [];
  const devices = [];
  const video = constraints.video || constraints.picture;
  const audio = constraints.audio;
  const sharingScreen =
    video && typeof video !== "boolean" && video.mediaSource !== "camera";
  const sharingAudio =
    audio && typeof audio !== "boolean" && audio.mediaSource !== "microphone";

  for (let device of subject.devices) {
    device = device.QueryInterface(Ci.nsIMediaDevice);
    const publicDevice = {
      name: device.rawName,
      deviceIndex: devices.length,
      mediaSource: device.mediaSource,
    };

    if (
      device.type === "audioinput" &&
      audio &&
      (device.mediaSource === "microphone") !== sharingAudio
    ) {
      audioInputDevices.push(publicDevice);
      devices.push(device);
    } else if (
      device.type === "videoinput" &&
      video &&
      (device.mediaSource === "camera") !== sharingScreen
    ) {
      videoInputDevices.push(publicDevice);
      devices.push(device);
    } else if (
      device.type === "audiooutput" &&
      subject.type === "selectaudiooutput"
    ) {
      audioOutputDevices.push(publicDevice);
      devices.push(device);
    }
  }

  const requestTypes = [];
  if (videoInputDevices.length) {
    requestTypes.push(sharingScreen ? "Screen" : "Camera");
  }
  if (audioInputDevices.length) {
    requestTypes.push(sharingAudio ? "AudioCapture" : "Microphone");
  }
  if (audioOutputDevices.length) {
    requestTypes.push("Speaker");
  }

  if (!requestTypes.length) {
    denyGetUserMediaRequest({ callID: subject.callID });
    return;
  }

  setupPendingRequests(contentWindow);
  contentWindow.desktopEmbedderPendingGetUserMediaRequests.set(
    subject.callID,
    devices
  );
  const actor = getActorForWindow(contentWindow);
  if (!actor) {
    denyGetUserMediaRequest({
      callID: subject.callID,
      windowID: subject.windowID,
    });
    return;
  }

  actor.sendAsyncMessage("webrtc:Request", {
    callID: subject.callID,
    windowID: subject.windowID,
    documentURI: contentWindow.document.documentURI,
    secure: subject.isSecure,
    isHandlingUserInput: subject.isHandlingUserInput,
    requestTypes,
    sharingScreen,
    sharingAudio,
    audioInputDevices,
    videoInputDevices,
    audioOutputDevices,
  });
}

function getCaptureState(contentWindow, remove = false) {
  if (remove) {
    return { remove: true };
  }

  const camera = {};
  const microphone = {};
  const screen = {};
  const window = {};
  const browser = {};
  const devices = {};
  lazy.MediaManagerService.mediaCaptureWindowState(
    contentWindow,
    camera,
    microphone,
    screen,
    window,
    browser,
    devices
  );

  const tracked = trackedCaptureState(contentWindow);

  if (
    camera.value === lazy.MediaManagerService.STATE_NOCAPTURE &&
    microphone.value === lazy.MediaManagerService.STATE_NOCAPTURE &&
    screen.value === lazy.MediaManagerService.STATE_NOCAPTURE &&
    window.value === lazy.MediaManagerService.STATE_NOCAPTURE &&
    browser.value === lazy.MediaManagerService.STATE_NOCAPTURE
  ) {
    if (tracked.camera || tracked.microphone || tracked.screen) {
      return {
        camera: tracked.camera,
        microphone: tracked.microphone,
        screen: tracked.screen,
        window: false,
        browser: false,
      };
    }
    return { remove: true };
  }

  return {
    camera: camera.value || tracked.camera,
    microphone: microphone.value || tracked.microphone,
    screen: screen.value || tracked.screen,
    window: window.value,
    browser: browser.value,
  };
}

function sendIndicatorUpdate(contentWindow) {
  if (!contentWindow) {
    return;
  }
  const actor = getActorForWindow(contentWindow);
  if (!actor) {
    return;
  }
  actor.sendAsyncMessage("webrtc:UpdateIndicators", {
    ...getCaptureState(contentWindow),
    windowId: contentWindow.windowGlobalChild.innerWindowId,
  });
}

function updateIndicators(subject) {
  const properties = subject.QueryInterface(Ci.nsIPropertyBag2);
  const contentWindow = properties.getProperty("window");
  sendIndicatorUpdate(contentWindow);
}

function stopCapture(subject) {
  const contentWindow = Services.wm.getOuterWindowWithId(subject.windowID);
  const captures = contentWindow?.desktopEmbedderActiveMediaCaptures;
  if (!captures) {
    return;
  }

  let removed = subject.rawID ? captures.delete(subject.rawID) : false;
  if (!removed) {
    for (const [key, capture] of captures) {
      if (capture.mediaSource === subject.mediaSource) {
        captures.delete(key);
        removed = true;
      }
    }
  }
  if (removed) {
    sendIndicatorUpdate(contentWindow);
  }
}

function removeIndicators(data) {
  const contentWindow = Services.wm.getOuterWindowWithId(data);
  if (contentWindow) {
    contentWindow.desktopEmbedderActiveMediaCaptures = null;
  }
  const actor = contentWindow && getActorForWindow(contentWindow);
  actor?.sendAsyncMessage("webrtc:UpdateIndicators", {
    ...getCaptureState(contentWindow, true),
    windowId: data,
  });
}

export class DesktopEmbedderWebRTCChild extends JSWindowActorChild {
  static handleEvent(event) {
    const contentWindow = event.target.defaultView;
    const actor = getActorForWindow(contentWindow);
    if (!actor) {
      return;
    }
    for (const callID of (
      contentWindow.desktopEmbedderPendingGetUserMediaRequests || new Map()
    ).keys()) {
      actor.sendAsyncMessage("webrtc:CancelRequest", callID);
    }
    for (const callID of
      contentWindow.desktopEmbedderPendingPeerConnectionRequests || new Set()) {
      actor.sendAsyncMessage("rtcpeer:CancelRequest", callID);
    }
  }

  static observe(subject, topic, data) {
    switch (topic) {
      case "getUserMedia:request":
        handleGetUserMediaRequest(subject);
        break;
      case "recording-device-stopped":
        stopCapture(subject);
        break;
      case "PeerConnection:request":
        handlePeerConnectionRequest(subject);
        break;
      case "recording-device-events":
        updateIndicators(subject);
        break;
      case "recording-window-ended":
        removeIndicators(data);
        break;
    }
  }

  receiveMessage(message) {
    const { callID, windowID } = message.data;
    const contentWindow = Services.wm.getOuterWindowWithId(windowID);

    switch (message.name) {
      case "rtcpeer:Allow":
      case "rtcpeer:Deny":
        if (contentWindow) {
          forgetPeerConnectionRequest(contentWindow, callID);
        }
        Services.obs.notifyObservers(
          null,
          message.name === "rtcpeer:Allow"
            ? "PeerConnection:response:allow"
            : "PeerConnection:response:deny",
          callID
        );
        break;
      case "webrtc:Allow": {
        const pending =
          contentWindow?.desktopEmbedderPendingGetUserMediaRequests?.get(
            callID
          );
        if (!pending) {
          denyGetUserMediaRequest({ callID, windowID });
          return;
        }
        const allowedDevices = Cc["@mozilla.org/array;1"].createInstance(
          Ci.nsIMutableArray
        );
        const sharing = {
          camera: 0,
          microphone: 0,
          screen: 0,
          window: 0,
          browser: 0,
        };
        for (const deviceIndex of message.data.devices) {
          const device = pending[deviceIndex];
          if (device) {
            allowedDevices.appendElement(device);
            rememberCapture(contentWindow, device);
            if (
              device.type === "videoinput" &&
              device.mediaSource === "camera"
            ) {
              sharing.camera = 1;
            } else if (
              device.type === "audioinput" &&
              device.mediaSource === "microphone"
            ) {
              sharing.microphone = 1;
            } else if (device.type === "videoinput") {
              sharing.screen = 1;
            }
          }
        }
        forgetGetUserMediaRequest(contentWindow, callID);
        this.sendAsyncMessage("webrtc:UpdateIndicators", {
          ...sharing,
          windowId: windowID,
        });
        Services.obs.notifyObservers(
          allowedDevices,
          "getUserMedia:response:allow",
          callID
        );
        break;
      }
      case "webrtc:Deny":
        denyGetUserMediaRequest(message.data);
        break;
    }
  }
}
