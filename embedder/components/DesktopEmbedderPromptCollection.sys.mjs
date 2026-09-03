/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const DOM_STRINGS = "chrome://global/locale/dom/dom.properties";
const APP_STRINGS = "chrome://global/locale/appstrings.properties";

function stringBundle(url) {
  const bundle = Services.strings.createBundle(url);
  if (!bundle) {
    throw new Error(`Desktop embedder prompt strings are unavailable: ${url}`);
  }
  return bundle;
}

function promptButtonFlags(defaultButton = 0, useDefaultCancelLabel = false) {
  let flags =
    Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0;
  flags |=
    (useDefaultCancelLabel
      ? Services.prompt.BUTTON_TITLE_CANCEL
      : Services.prompt.BUTTON_TITLE_IS_STRING) * Services.prompt.BUTTON_POS_1;
  flags |=
    defaultButton === 1
      ? Services.prompt.BUTTON_POS_1_DEFAULT
      : Services.prompt.BUTTON_POS_0_DEFAULT;
  return flags;
}

/**
 * Product-neutral specialized prompt service for desktop Gecko embedders.
 *
 * Firefox normally owns this contract. Keeping the generic web-platform
 * cases here prevents before-unload, form repost, and folder-upload decisions
 * from depending on Firefox tabs, profiles, PDF UI, or telemetry.
 */
export class DesktopEmbedderPromptCollection {
  async asyncBeforeUnloadCheck(browsingContext) {
    const docViewer = browsingContext?.docShell?.docViewer;
    if (
      !browsingContext ||
      (docViewer && !docViewer.isTabModalPromptAllowed) ||
      !browsingContext.ancestorsAreCurrent
    ) {
      return true;
    }

    let title;
    let message;
    let leaveLabel;
    let stayLabel;
    try {
      const strings = stringBundle(DOM_STRINGS);
      title = strings.GetStringFromName("OnBeforeUnloadTitle");
      message = strings.GetStringFromName("OnBeforeUnloadMessage2");
      leaveLabel = strings.GetStringFromName("OnBeforeUnloadLeaveButton");
      stayLabel = strings.GetStringFromName("OnBeforeUnloadStayButton");
    } catch (error) {
      console.error("Desktop embedder before-unload strings failed", error);
      return false;
    }

    try {
      const result = await Services.prompt.asyncConfirmEx(
        browsingContext,
        Services.prompt.MODAL_TYPE_CONTENT,
        title,
        message,
        promptButtonFlags(),
        leaveLabel,
        stayLabel,
        null,
        null,
        false,
        { inPermitUnload: true }
      );
      return (
        result.QueryInterface(Ci.nsIPropertyBag2).get("buttonNumClicked") === 0
      );
    } catch (error) {
      console.error("Desktop embedder before-unload prompt failed", error);
      return false;
    }
  }

  confirmRepost(browsingContext) {
    let message;
    let resendLabel;
    try {
      const strings = stringBundle(APP_STRINGS);
      message = strings.GetStringFromName("confirmRepostPrompt");
      resendLabel = strings.GetStringFromName("resendButton.label");
    } catch (error) {
      console.error("Desktop embedder repost strings failed", error);
      return false;
    }

    try {
      return (
        Services.prompt.confirmExBC(
          browsingContext,
          Services.prompt.MODAL_TYPE_TAB,
          null,
          message,
          promptButtonFlags(0, true),
          resendLabel,
          null,
          null,
          null,
          {}
        ) === 0
      );
    } catch (error) {
      console.error("Desktop embedder repost prompt failed", error);
      return false;
    }
  }

  confirmFolderUpload(browsingContext, directoryName) {
    let title;
    let message;
    let uploadLabel;
    try {
      const strings = stringBundle(DOM_STRINGS);
      title = strings.GetStringFromName("FolderUploadPrompt.title");
      message = strings.formatStringFromName("FolderUploadPrompt.message", [
        directoryName,
      ]);
      uploadLabel = strings.GetStringFromName(
        "FolderUploadPrompt.acceptButtonLabel"
      );
    } catch (error) {
      console.error("Desktop embedder folder-upload strings failed", error);
      return false;
    }

    const flags = promptButtonFlags(1, true) | Ci.nsIPrompt.BUTTON_DELAY_ENABLE;
    try {
      return (
        Services.prompt.confirmExBC(
          browsingContext,
          Services.prompt.MODAL_TYPE_TAB,
          title,
          message,
          flags,
          uploadLabel,
          null,
          null,
          null,
          {}
        ) === 0
      );
    } catch (error) {
      console.error("Desktop embedder folder-upload prompt failed", error);
      return false;
    }
  }
}

DesktopEmbedderPromptCollection.prototype.QueryInterface =
  ChromeUtils.generateQI(["nsIPromptCollection"]);
