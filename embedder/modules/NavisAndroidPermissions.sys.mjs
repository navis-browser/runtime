// SPDX-License-Identifier: MPL-2.0

import { permissionFrames, permissionOrigins, resolvePermissionOrigin, stopPermissionMedia }
  from "resource://gre/modules/SitePermissionOrigins.sys.mjs";

const hosts = new Map();
const epochs = new Map();

export function androidPermissionEpoch(principal) {
  return epochs.get(principal.origin) ?? 0;
}
const permissions = new Map([
  ["geolocation", { key: "geo" }],
  ["desktop-notification", { key: "desktop-notification" }],
  ["persistent-storage", { key: "persistent-storage" }],
  ["camera", { key: "camera" }],
  ["microphone", { key: "microphone" }],
]);

function publish(host) {
  host.publish(host.media);
}

export function registerAndroidPermissions(browser, { cancel, publish: onState }) {
  if (hosts.has(browser)) throw new Error("Permission host already registered");
  const host = {
    cancel, publish: onState,
    media: Object.freeze({ camera: false, microphone: false }),
  };
  browser.navisAndroidMediaStateChanged = state => {
    host.media = Object.freeze({ camera: state.camera === true, microphone: state.microphone === true });
    publish(host);
  };
  hosts.set(browser, host);
  return () => {
    browser.navisAndroidMediaStateChanged = null;
    hosts.delete(browser);
  };
}

export function androidSitePermissions(browser) {
  const origins = permissionOrigins(browser);
  const host = hosts.get(browser);
  if (!origins.length || !host) return { permissions: [], devices: {} };
  return {
    permissions: origins.flatMap(scope => [...permissions].filter(([, value]) =>
      !value.pref || Services.prefs.getBoolPref(value.pref, false))
      .map(([kind, value]) => {
        const stored = Services.perms.getPermissionObject(scope.principal, value.key, true);
        const action = Services.perms.testExactPermissionFromPrincipal(scope.principal, value.key);
        return Object.freeze({ kind, origin: scope.origin, originToken: scope.token, embedded: scope.embedded,
          state: action === Services.perms.ALLOW_ACTION ? "allow" :
            action === Services.perms.DENY_ACTION ? "block" : "ask",
          temporary: stored?.expireType === Services.perms.EXPIRE_SESSION,
          decisions: Object.freeze(value.chooser ? ["ask", "block"] : ["ask", "allow", "block"]),
        });
      })),
    devices: host.media,
  };
}

export async function revokeAndroidPermissions(principal, keys, stopActive) {
  epochs.set(principal.origin, androidPermissionEpoch(principal) + 1);
  const stopped = [];
  for (const [browser, host] of hosts) {
    if (!permissionFrames(browser).some(window => window.documentPrincipal.equals(principal))) continue;
    host.cancel();
    if (stopActive && keys.some(key => key === "camera" || key === "microphone") && browser.browsingContext) {
      stopped.push(stopPermissionMedia(browser, principal, "GeckoViewPermission", "Navis:StopMedia"));
    }
  }
  const results = await Promise.allSettled(stopped);
  const failed = results.filter(result => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), "Device revocation failed");
}

export async function revokeAllAndroidPermissions() {
  const principals = new Map();
  for (const browser of hosts.keys()) {
    for (const { principal } of permissionOrigins(browser)) principals.set(principal.origin, principal);
  }
  await Promise.all([...principals.values()].map(principal => revokeAndroidPermissions(
    principal, ["camera", "microphone"], true,
  )));
}

// The caller authenticates the site-information token before entering here.
export async function setAndroidSitePermission(browser, kind, decision, originToken) {
  const principal = resolvePermissionOrigin(browser, originToken)?.principal;
  const permission = permissions.get(kind);
  if (!principal || !hosts.has(browser) || !permission ||
      (permission.pref && !Services.prefs.getBoolPref(permission.pref, false)) ||
      !["ask", "allow", "block"].includes(decision) || (permission.chooser && decision === "allow")) {
    throw new TypeError("Invalid site permission change");
  }
  const keys = [permission.key];
  if (decision !== "allow" && ["camera", "microphone"].includes(kind)) {
    keys.splice(0, 1, "camera", "microphone", "MediaManagerVideo");
  }
  for (const key of keys) Services.perms.removeFromPrincipal(principal, key);
  if (decision !== "ask") {
    Services.perms.addFromPrincipal(principal, permission.key,
      decision === "allow" ? Services.perms.ALLOW_ACTION : Services.perms.DENY_ACTION,
      principal.privateBrowsingId ? Services.perms.EXPIRE_SESSION : Services.perms.EXPIRE_NEVER);
  }
  await revokeAndroidPermissions(principal, keys, decision !== "allow");
}

export async function stopAndroidSiteDevices(browser, kind) {
  if (!hosts.has(browser) || !["camera", "microphone"].includes(kind)) {
    throw new TypeError("Invalid device stop");
  }
  const results = await Promise.allSettled(permissionOrigins(browser).map(scope =>
    setAndroidSitePermission(browser, kind, "ask", scope.token)));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Device revocation failed");
}
