/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export function permissionDecisions(privateMode, persistent = true) {
  return Object.freeze([
    "allow-session",
    ...(!privateMode && persistent ? ["allow-always"] : []),
    "block",
    "dismiss",
  ]);
}

export function normalizePermissionResponse(response, request) {
  const decision = typeof response === "string" ? response : response?.decision;
  if (!(request.decisions ?? permissionDecisions(false)).includes(decision)) {
    return null;
  }
  if (decision === "block" || decision === "dismiss") {
    return decision;
  }
  const offered = request.choices ?? {};
  const keys = Object.keys(offered);
  const selected = typeof response === "object" ? response?.choices : undefined;
  if (!keys.length) {
    return selected && Object.keys(selected).length ? null : decision;
  }
  if (
    !selected ||
    typeof selected !== "object" ||
    Array.isArray(selected) ||
    Object.keys(selected).length !== keys.length
  ) {
    return null;
  }
  const choices = {};
  for (const key of keys) {
    if (
      !Object.hasOwn(selected, key) ||
      typeof selected[key] !== "string" ||
      !offered[key].some((option) => option.id === selected[key])
    ) {
      return null;
    }
    choices[key] = selected[key];
  }
  return Object.freeze({ decision, choices: Object.freeze(choices) });
}
