/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function httpOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function usableInput(input) {
  const ownerWindow = input?.ownerDocument?.documentGlobal;
  return (
    ownerWindow &&
    ownerWindow.HTMLInputElement.isInstance(input) &&
    !input.disabled &&
    !input.readOnly
  );
}

function usernameCandidate(input) {
  if (!usableInput(input)) {
    return false;
  }
  const type = input.type.toLowerCase();
  return ["email", "tel", "text", "url"].includes(type);
}

function conditionalPasskeyInput(input) {
  if (!usernameCandidate(input)) {
    return false;
  }
  const autocomplete = input.getAttribute("autocomplete");
  return (
    typeof autocomplete === "string" &&
    autocomplete.length <= 256 &&
    autocomplete.toLowerCase().trim().split(/\s+/u).includes("webauthn")
  );
}

function setUserInput(input, value) {
  if (typeof input.setUserInput === "function") {
    input.setUserInput(value);
    return;
  }
  const ownerWindow = input.ownerDocument.documentGlobal;
  const setter = Object.getOwnPropertyDescriptor(
    ownerWindow.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(
    new ownerWindow.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
      data: value,
    })
  );
  input.dispatchEvent(
    new ownerWindow.Event("change", { bubbles: true, composed: true })
  );
}

/**
 * Small content-side credential adapter for the Desktop Embedder.
 *
 * Gecko still owns DOM/form semantics. This actor observes the same privileged
 * password-field events used by LoginManager, but transfers only normalized
 * strings to the Core-private parent binding. No Platform or storage object is
 * reachable from content.
 */
export class DesktopCredentialChild extends JSWindowActorChild {
  #lastQuerySignature = "";
  #lastSubmission = "";
  #lastSubmissionAt = 0;

  handleEvent(event) {
    if (
      event.type === "submit" ||
      event.type === "before-form-submission" ||
      event.type === "form-submission-detected"
    ) {
      this.#captureSubmission(event);
      return;
    }
    if (event.type === "focusin") {
      Promise.resolve()
        .then(() => this.#discoverConditionalPasskey(event.target))
        .catch(error => {
          if (this.document) {
            console.error(
              "Desktop conditional WebAuthn discovery failed",
              error
            );
          }
        });
    }
    Promise.resolve()
      .then(() => this.#discover(event.target))
      .catch(error => {
        if (this.document) {
          console.error("Desktop credential field discovery failed", error);
        }
      });
  }

  receiveMessage(message) {
    if (message.name === "DesktopCredential:Fill") {
      return this.#fill(message.data);
    }
    if (message.name === "DesktopCredential:CheckConditional") {
      return this.#discoverConditionalPasskey(this.document?.activeElement);
    }
    return undefined;
  }

  #discoverConditionalPasskey(input) {
    if (!conditionalPasskeyInput(input)) {
      return false;
    }
    const origin = httpOrigin(input.ownerDocument?.location?.href);
    if (!origin) {
      return false;
    }
    this.sendAsyncMessage("DesktopCredential:ConditionalWebAuthn", { origin });
    return true;
  }

  #findFields(target = null, { submission = false } = {}) {
    const document = this.document;
    const origin = httpOrigin(document?.location?.href);
    if (!document || !origin) {
      return null;
    }

    let scope = null;
    if (this.contentWindow.HTMLFormElement.isInstance(target)) {
      scope = target;
    } else if (this.contentWindow.HTMLInputElement.isInstance(target)) {
      scope = target.form;
    }
    scope ??= document;

    const passwordInputs = [
      ...scope.querySelectorAll('input[type="password"]'),
    ].filter(usableInput);
    if (!passwordInputs.length && scope !== document) {
      passwordInputs.push(
        ...[...document.querySelectorAll('input[type="password"]')].filter(
          usableInput
        )
      );
    }
    const password = submission
      ? (passwordInputs.find(input => input.value) ?? passwordInputs.at(-1))
      : (passwordInputs.find(
          input => !input.autocomplete.toLowerCase().includes("new-password")
        ) ?? passwordInputs[0]);
    if (!password) {
      return null;
    }

    const form = password.form;
    const candidates = [...(form ?? document).querySelectorAll("input")].filter(
      usernameCandidate
    );
    let username = candidates.find(input =>
      input.autocomplete.toLowerCase().split(/\s+/).includes("username")
    );
    username ??= candidates
      .filter(
        input =>
          input.compareDocumentPosition(password) &
          this.contentWindow.Node.DOCUMENT_POSITION_FOLLOWING
      )
      .at(-1);
    username ??= candidates[0] ?? null;

    const actionOrigin =
      httpOrigin(form?.action || document.location.href) ?? origin;
    return {
      actionOrigin,
      origin,
      password,
      passwordField: password.name || password.id || "",
      username,
      usernameField: username?.name || username?.id || "",
    };
  }

  async #discover(target) {
    const fields = this.#findFields(target);
    if (!fields) {
      return;
    }
    const signature = [
      fields.origin,
      fields.actionOrigin,
      fields.usernameField,
      fields.passwordField,
      fields.username?.value || "",
      fields.password.value ? "password-present" : "password-empty",
    ].join("\u0000");
    if (signature === this.#lastQuerySignature) {
      return;
    }
    this.#lastQuerySignature = signature;

    const response = await this.sendQuery("DesktopCredential:Query", {
      actionOrigin: fields.actionOrigin,
      allowAutoFill: !fields.password.value && !fields.username?.value,
      origin: fields.origin,
      passwordField: fields.passwordField,
      usernameField: fields.usernameField,
    });
    if (response?.credential) {
      this.#fill(response.credential);
    }
  }

  #fill(credential) {
    const fields = this.#findFields();
    if (
      !fields ||
      credential?.origin !== fields.origin ||
      typeof credential.username !== "string" ||
      typeof credential.password !== "string"
    ) {
      return Object.freeze({ filled: false });
    }
    if (fields.username) {
      setUserInput(fields.username, credential.username);
    }
    setUserInput(fields.password, credential.password);
    return Object.freeze({ filled: true });
  }

  #captureSubmission(event) {
    const fields = this.#findFields(event.target, { submission: true });
    if (!fields?.password.value) {
      return;
    }
    const username = fields.username?.value || "";
    const password = fields.password.value;
    const signature = [fields.origin, username, password].join("\u0000");
    const now = Date.now();
    if (
      signature === this.#lastSubmission &&
      now - this.#lastSubmissionAt < 2000
    ) {
      return;
    }
    this.#lastSubmission = signature;
    this.#lastSubmissionAt = now;
    this.sendAsyncMessage("DesktopCredential:Submit", {
      actionOrigin: fields.actionOrigin,
      origin: fields.origin,
      password,
      passwordField: fields.passwordField,
      username,
      usernameField: fields.usernameField,
    });
  }
}
