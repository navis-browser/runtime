/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

{
  /* globals EventManager, ExtensionAPIPersistent, ExtensionError */

  ChromeUtils.defineESModuleGetters(this, {
    getDesktopProfileStore:
      "resource://gre/modules/DesktopProfileStore.sys.mjs",
  });

  const ROOT_ID = "root";
  const MAX_TREE_NODES = 10000;

  function bookmarkNode(bookmark) {
    return {
      id: bookmark.id,
      parentId: bookmark.parentId,
      index: bookmark.position,
      ...(bookmark.url ? { url: bookmark.url } : {}),
      title: bookmark.title,
      dateAdded: bookmark.createdAt,
      ...(bookmark.type === "folder"
        ? { dateGroupModified: bookmark.updatedAt }
        : {}),
      type: bookmark.type,
    };
  }

  function rootNode(children = undefined) {
    return {
      id: ROOT_ID,
      title: "",
      type: "folder",
      ...(children ? { children } : {}),
    };
  }

  async function requireBookmark(store, id) {
    if (id === ROOT_ID) {
      return null;
    }
    const bookmark = await store.getBookmark(id);
    if (!bookmark) {
      throw new ExtensionError(`Unknown Navis bookmark: ${id}`);
    }
    return bookmark;
  }

  async function bookmarkTree(
    store,
    id,
    budget = { remaining: MAX_TREE_NODES }
  ) {
    const bookmark = await requireBookmark(store, id);
    const children = [];
    const type = bookmark?.type || "folder";
    if (type === "folder") {
      const records = await store.listBookmarks(id);
      for (const child of records) {
        budget.remaining -= 1;
        if (budget.remaining < 0) {
          throw new ExtensionError("Navis bookmark tree limit was exceeded");
        }
        children.push(await bookmarkTree(store, child.id, budget));
      }
    }
    return bookmark
      ? {
          ...bookmarkNode(bookmark),
          ...(type === "folder" ? { children } : {}),
        }
      : rootNode(children);
  }

  async function flattenBookmarks(store) {
    const root = await bookmarkTree(store, ROOT_ID);
    const result = [];
    const visit = node => {
      if (node.id !== ROOT_ID) {
        const plain = { ...node };
        delete plain.children;
        result.push(plain);
      }
      for (const child of node.children || []) {
        visit(child);
      }
    };
    visit(root);
    return result;
  }

  this.bookmarks = class extends ExtensionAPIPersistent {
    storeEvent(event, listener) {
      return ({ fire }) => {
        const store = getDesktopProfileStore();
        const routed = (_eventName, detail) => listener(fire, detail);
        store.on(event, routed);
        return {
          unregister: () => store.off(event, routed),
          convert(newFire) {
            fire = newFire;
          },
        };
      };
    }

    PERSISTENT_EVENTS = {
      onCreated: this.storeEvent("bookmark-created", (fire, bookmark) => {
        fire.async(bookmark.id, bookmarkNode(bookmark));
      }),
      onRemoved: this.storeEvent("bookmark-removed", (fire, bookmark) => {
        fire.async(bookmark.id, {
          parentId: bookmark.parentId,
          index: bookmark.position,
          node: bookmarkNode(bookmark),
        });
      }),
      onChanged: this.storeEvent("bookmark-changed", (fire, detail) => {
        fire.async(detail.bookmark.id, { ...detail.changes });
      }),
      onMoved: this.storeEvent("bookmark-moved", (fire, detail) => {
        fire.async(detail.bookmark.id, {
          parentId: detail.bookmark.parentId,
          index: detail.bookmark.position,
          oldParentId: detail.previousParentId,
          oldIndex: detail.previousIndex,
        });
      }),
    };

    getAPI(context) {
      const store = getDesktopProfileStore();
      const event = name =>
        new EventManager({
          context,
          module: "bookmarks",
          event: name,
          extensionApi: this,
        }).api();
      return {
        bookmarks: {
          onCreated: event("onCreated"),
          onRemoved: event("onRemoved"),
          onChanged: event("onChanged"),
          onMoved: event("onMoved"),

          async get(idOrIdList) {
            const ids = Array.isArray(idOrIdList) ? idOrIdList : [idOrIdList];
            return Promise.all(
              ids.map(async id =>
                id === ROOT_ID
                  ? rootNode()
                  : bookmarkNode(await requireBookmark(store, id))
              )
            );
          },

          async getChildren(id) {
            await requireBookmark(store, id);
            return (await store.listBookmarks(id)).map(bookmarkNode);
          },

          async getRecent(numberOfItems) {
            return (await flattenBookmarks(store))
              .sort((left, right) => right.dateAdded - left.dateAdded)
              .slice(0, numberOfItems);
          },

          async getTree() {
            return [await bookmarkTree(store, ROOT_ID)];
          },

          async getSubTree(id) {
            return [await bookmarkTree(store, id)];
          },

          async search(query) {
            const options = typeof query === "string" ? { query } : query;
            const needle = (options.query || "").toLocaleLowerCase();
            return (await flattenBookmarks(store)).filter(node => {
              if (options.url !== undefined && node.url !== options.url) {
                return false;
              }
              if (options.title !== undefined && node.title !== options.title) {
                return false;
              }
              return (
                !needle ||
                node.title.toLocaleLowerCase().includes(needle) ||
                node.url?.toLocaleLowerCase().includes(needle)
              );
            });
          },

          async create(details) {
            if (details.type === "separator") {
              throw new ExtensionError("Navis does not support separators");
            }
            const type =
              details.type || (details.url == null ? "folder" : "bookmark");
            const bookmark = await store.createBookmark({
              parentId: details.parentId || ROOT_ID,
              type,
              url: type === "bookmark" ? details.url : null,
              title: details.title || "",
            });
            const positioned =
              details.index == null
                ? bookmark
                : await store.moveBookmark(
                    bookmark.id,
                    bookmark.parentId,
                    details.index
                  );
            return bookmarkNode(positioned);
          },

          async move(id, destination) {
            const bookmark = await requireBookmark(store, id);
            const parentId = destination.parentId ?? bookmark.parentId;
            const index = destination.index ?? bookmark.position;
            return bookmarkNode(await store.moveBookmark(id, parentId, index));
          },

          async update(id, changes) {
            await requireBookmark(store, id);
            return bookmarkNode(await store.updateBookmark(id, changes));
          },

          async remove(id) {
            const bookmark = await requireBookmark(store, id);
            if (
              bookmark.type === "folder" &&
              (await store.listBookmarks(id)).length
            ) {
              throw new ExtensionError(
                "Cannot remove a non-empty bookmark folder"
              );
            }
            await store.removeBookmark(id);
          },

          async removeTree(id) {
            await requireBookmark(store, id);
            await store.removeBookmark(id);
          },
        },
      };
    }
  };
}
