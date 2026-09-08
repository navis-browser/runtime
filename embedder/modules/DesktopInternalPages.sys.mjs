/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ROUTE_DEFINITIONS = Object.freeze(
  [
    ...["processes", "profiles", "credits"].map(id => ({
      id,
      route: "",
      path: "/",
      titleId: `internal.${id}.title`,
      descriptionId: `internal.${id}.description`,
      listed: true,
    })),
    {
      id: "newtab",
      route: "",
      path: "/",
      titleId: "internal.newtab.title",
      descriptionId: "internal.newtab.description",
      listed: true,
    },
    {
      id: "history",
      route: "",
      path: "/",
      titleId: "internal.history.title",
      descriptionId: "internal.history.description",
      listed: true,
    },
    {
      id: "bookmarks",
      route: "",
      path: "/",
      titleId: "internal.bookmarks.title",
      descriptionId: "internal.bookmarks.description",
      listed: true,
    },
    {
      id: "passwords",
      route: "",
      path: "/",
      titleId: "internal.passwords.title",
      descriptionId: "internal.passwords.description",
      listed: true,
    },
    {
      id: "downloads",
      route: "",
      path: "/",
      titleId: "internal.downloads.title",
      descriptionId: "internal.downloads.description",
      listed: true,
    },
    {
      id: "extensions",
      route: "",
      path: "/",
      titleId: "internal.extensions.title",
      descriptionId: "internal.extensions.description",
      listed: true,
    },
    {
      id: "urls",
      route: "",
      path: "/",
      titleId: "internal.urls.title",
      descriptionId: "internal.urls.description",
      listed: true,
    },
    {
      id: "support",
      route: "",
      path: "/",
      titleId: "internal.support.title",
      descriptionId: "internal.support.description",
      listed: true,
    },
    {
      id: "settings",
      route: "",
      path: "/",
      titleId: "internal.settings.title",
      descriptionId: "internal.settings.description",
      listed: true,
    },
    {
      id: "settings",
      route: "help",
      path: "/help",
      titleId: "internal.help.title",
      descriptionId: "internal.help.description",
      listed: false,
    },
    ...[
      ["search", "settings.searchEngine"],
      ["privacy", "settings.privacySecurity"],
      ["appearance", "settings.appearance"],
      ["downloads", "settings.downloadConfiguration"],
    ].map(([route, titleId]) => ({
      id: "settings",
      route,
      path: `/${route}`,
      titleId,
      descriptionId: "internal.settings.description",
      listed: false,
    })),
  ].map(route =>
    Object.freeze({
      ...route,
      key: route.route ? `${route.id}/${route.route}` : route.id,
      url: `navis://${route.id}${route.path}`,
    })
  )
);

const PUBLIC_PAGES = Object.freeze(
  ROUTE_DEFINITIONS.filter(route => route.listed)
);
const ROUTE_BY_KEY = new Map(
  ROUTE_DEFINITIONS.map(route => [`${route.id}\n${route.path}`, route])
);

const INTERNAL_ERROR_IDS = Object.freeze([
  "certerror",
  "framecrashed",
  "httpsonlyerror",
  "neterror",
]);

export function getNavisInternalPages() {
  return PUBLIC_PAGES;
}

export function getNavisInternalPage(id, route = "") {
  const path = route ? `/${route}` : "/";
  return ROUTE_BY_KEY.get(`${id}\n${path}`) ?? null;
}

export function isNavisInternalErrorId(id) {
  return INTERNAL_ERROR_IDS.includes(id);
}

export function resolveNavisInternalPageURI(uri) {
  try {
    if (
      !uri?.schemeIs("navis") ||
      uri.hasUserPass ||
      uri.port !== -1 ||
      uri.hasQuery
    ) {
      return null;
    }
    const page = ROUTE_BY_KEY.get(
      `${uri.asciiHost.toLowerCase()}\n${uri.filePath}`
    );
    if (!page || uri.specIgnoringRef !== page.url) {
      return null;
    }
    return page;
  } catch {
    return null;
  }
}
