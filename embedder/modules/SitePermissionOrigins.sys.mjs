// SPDX-License-Identifier: MPL-2.0

const inventories = new WeakMap();

function isWebPrincipal(principal) {
  return principal?.isContentPrincipal && !principal.isSystemPrincipal && !principal.addonId &&
    (principal.URI?.schemeIs("http") || principal.URI?.schemeIs("https"));
}

export function permissionFrames(browser) {
  const root = browser?.browsingContext;
  const top = root?.currentWindowGlobal;
  if (!top?.isCurrentGlobal || !browser.contentPrincipal || !isWebPrincipal(top.documentPrincipal) ||
      !top.documentPrincipal.equals(browser.contentPrincipal) ||
      top.documentPrincipal.URI.prePath !== browser.documentURI?.prePath) return [];
  const pending = [root], frames = [];
  while (pending.length) {
    const context = pending.pop();
    if (context.isDiscarded) continue;
    const window = context.currentWindowGlobal;
    if (!window?.isCurrentGlobal || window.browsingContext !== context) continue;
    if (isWebPrincipal(window.documentPrincipal)) frames.push(window);
    pending.push(...context.children);
  }
  return frames;
}

// Tokens name only currently attached documents, never native window identities.
export function permissionOrigins(browser) {
  const frames = permissionFrames(browser);
  if (!frames.length) {
    if (browser) inventories.delete(browser);
    return [];
  }
  const top = frames[0];
  const previous = inventories.get(browser);
  const groups = new Map();
  for (const window of frames) {
    const principal = window.documentPrincipal;
    let group = groups.get(principal.origin);
    if (!group) {
      group = { principal, origin: principal.URI.prePath, windows: [] };
      groups.set(principal.origin, group);
    }
    group.windows.push(window);
  }
  for (const [key, group] of groups) {
    const old = previous?.top === top ? previous.groups.get(key) : null;
    group.token = old?.windows.some(window => group.windows.includes(window))
      ? old.token : Services.uuid.generateUUID().toString();
    group.embedded = !group.principal.equals(top.documentPrincipal);
  }
  inventories.set(browser, { top, groups });
  return [...groups.values()];
}

export function resolvePermissionOrigin(browser, token) {
  if (typeof token !== "string" || !token) return null;
  return permissionOrigins(browser).find(group => group.token === token) ?? null;
}

export async function stopPermissionMedia(browser, principal, actorName, messageName) {
  const frames = permissionFrames(browser);
  const results = await Promise.allSettled(frames
    .filter(window => window.documentPrincipal.equals(principal))
    .map(async window => {
      try { await window.getActor(actorName).sendQuery(messageName, {}); }
      catch (error) {
        if (window.isCurrentGlobal && !window.browsingContext.isDiscarded) throw error;
      }
    }));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Device revocation failed");
}
