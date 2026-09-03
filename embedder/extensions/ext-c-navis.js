/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* globals extensions */

extensions.registerModules({
  menusInternal: {
    url: "chrome://navis-extensions/content/ext-c-menus.js",
    scopes: ["addon_child"],
    paths: [["contextMenus"], ["menus"]],
  },
  omnibox: {
    url: "chrome://navis-extensions/content/ext-c-omnibox.js",
    scopes: ["addon_child"],
    paths: [["omnibox"]],
  },
  tabs: {
    url: "chrome://navis-extensions/content/ext-c-tabs.js",
    scopes: ["addon_child"],
    paths: [["tabs"]],
  },
});
