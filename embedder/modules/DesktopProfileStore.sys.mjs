/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";
import { Sqlite } from "resource://gre/modules/Sqlite.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { EventEmitter } from "resource://gre/modules/EventEmitter.sys.mjs";

const DATABASE_NAME = "navis.sqlite";
const ROOT_BOOKMARK_FOLDER = "root";
const MAX_HISTORY_RESULTS = 500;
const MAX_RESTORED_SESSIONS = 128;
const MAX_CLOSED_SESSIONS = 25;
const MAX_CREDENTIALS = 2000;
const CREDENTIAL_KEY_LABEL_PREFIX = "Navis Password Manager";

function freezeHistoryEntry(row) {
  return Object.freeze({
    url: row.getResultByName("url"),
    title: row.getResultByName("title"),
    lastVisitedAt: row.getResultByName("last_visited_at"),
    visitCount: row.getResultByName("visit_count"),
  });
}

function freezeBookmark(row) {
  return Object.freeze({
    id: row.getResultByName("id"),
    parentId: row.getResultByName("parent_id"),
    type: row.getResultByName("type"),
    url: row.getResultByName("url") || null,
    title: row.getResultByName("title"),
    position: row.getResultByName("position"),
    createdAt: row.getResultByName("created_at"),
    updatedAt: row.getResultByName("updated_at"),
  });
}

function freezeClosedTab(row) {
  return Object.freeze({
    sessionId: row.getResultByName("id"),
    windowId: row.getResultByName("window_id"),
    index: row.getResultByName("position"),
    url: row.getResultByName("url"),
    title: row.getResultByName("title"),
    closedAt: row.getResultByName("closed_at"),
  });
}

function freezeCredentialSummary(record) {
  return Object.freeze({
    id: record.id,
    origin: record.origin,
    actionOrigin: record.actionOrigin,
    username: record.username,
    usernameField: record.usernameField,
    passwordField: record.passwordField,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    timesUsed: record.timesUsed,
  });
}

function checkedString(
  value,
  name,
  { allowEmpty = false, maximum = Number.POSITIVE_INFINITY } = {}
) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (!allowEmpty && !value.trim())
  ) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

function checkedLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_RESULTS) {
    throw new RangeError(
      `History result limit must be between 1 and ${MAX_HISTORY_RESULTS}`
    );
  }
  return value;
}

function checkedCredentialOrigin(value, name) {
  const candidate = checkedString(value, name, { maximum: 2048 });
  let uri;
  try {
    uri = Services.io.newURI(candidate);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTP(S) origin`);
  }
  if (!uri.schemeIs("http") && !uri.schemeIs("https")) {
    throw new TypeError(`${name} must be an HTTP(S) origin`);
  }
  return uri.prePath;
}

/**
 *
 */
class DesktopProfileStoreImpl extends EventEmitter {
  #connection = null;
  #ready;
  #writeTail = Promise.resolve();
  #closing = false;
  #visited = new Set();
  #historyDelegate;
  #credentialKeyLabel = null;

  constructor() {
    super();
    this.#historyDelegate = Object.freeze({
      onVisited: request => this.recordVisit(request),
      getVisited: urls => urls.map(url => this.#visited.has(url)),
      onTitleChanged: () => undefined,
      onSessionTitleChanged: request => this.recordTitle(request),
      onClear: () => this.clearHistory(),
    });
    this.#ready = this.#initialize();
    AsyncShutdown.profileBeforeChange.addBlocker(
      "Desktop Profile Store: flush and close Navis data",
      () => this.close(),
      { fetchState: () => ({ closing: this.#closing }) }
    );
  }

  get ready() {
    return this.#ready.then(() => undefined);
  }

  get historyDelegate() {
    return this.#historyDelegate;
  }

  async #initialize() {
    this.#connection = await Sqlite.openConnection({
      path: PathUtils.join(PathUtils.profileDir, DATABASE_NAME),
    });
    await this.#connection.execute("PRAGMA foreign_keys = ON");
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS profile_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `);
    let keyRows = await this.#connection.executeCached(
      "SELECT value FROM profile_settings WHERE key = :key",
      { key: "credential-key-id" }
    );
    if (!keyRows.length) {
      const keyId = Services.uuid.generateUUID().toString().slice(1, -1);
      await this.#connection.executeCached(
        "INSERT INTO profile_settings(key, value) VALUES(:key, :value)",
        { key: "credential-key-id", value: keyId }
      );
      keyRows = await this.#connection.executeCached(
        "SELECT value FROM profile_settings WHERE key = :key",
        { key: "credential-key-id" }
      );
    }
    this.#credentialKeyLabel = `${CREDENTIAL_KEY_LABEL_PREFIX} ${keyRows[0].getResultByName("value")}`;
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS history_pages (
        url TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        last_visited_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1
      )
    `);
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS history_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL REFERENCES history_pages(url) ON DELETE CASCADE,
        visited_at INTEGER NOT NULL,
        flags INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.#connection.execute(`
      CREATE INDEX IF NOT EXISTS history_visits_url_time
      ON history_visits(url, visited_at DESC)
    `);
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS bookmarks (
        id TEXT PRIMARY KEY NOT NULL,
        parent_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('bookmark', 'folder')),
        url TEXT,
        title TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((type = 'bookmark' AND url IS NOT NULL) OR
              (type = 'folder' AND url IS NULL))
      )
    `);
    await this.#connection.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS bookmarks_parent_position
      ON bookmarks(parent_id, position)
    `);
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS session_tabs (
        position INTEGER PRIMARY KEY NOT NULL,
        url TEXT NOT NULL,
        selected INTEGER NOT NULL CHECK(selected IN (0, 1))
      )
    `);
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS closed_tabs (
        id TEXT PRIMARY KEY NOT NULL,
        window_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        closed_at INTEGER NOT NULL
      )
    `);
    await this.#connection.execute(`
      CREATE INDEX IF NOT EXISTS closed_tabs_time
      ON closed_tabs(closed_at DESC)
    `);
    await this.#connection.execute(`
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY NOT NULL,
        origin TEXT NOT NULL,
        action_origin TEXT NOT NULL,
        username_ciphertext TEXT NOT NULL,
        password_ciphertext TEXT NOT NULL,
        username_field TEXT NOT NULL DEFAULT '',
        password_field TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        times_used INTEGER NOT NULL DEFAULT 0
      )
    `);
    await this.#connection.execute(`
      CREATE INDEX IF NOT EXISTS credentials_origin_updated
      ON credentials(origin, last_used_at DESC, updated_at DESC)
    `);
    const rows = await this.#connection.execute(
      "SELECT url FROM history_pages"
    );
    this.#visited = new Set(rows.map(row => row.getResultByName("url")));
  }

  #enqueueWrite(operation, { reportError = false } = {}) {
    if (this.#closing) {
      return Promise.reject(new Error("Desktop Profile Store is closing"));
    }
    const result = this.#writeTail.then(async () => {
      await this.#ready;
      return operation(this.#connection);
    });
    this.#writeTail = result.catch(error => {
      if (reportError) {
        console.error("Desktop Profile Store background write failed", error);
      }
    });
    return result;
  }

  recordVisit(request) {
    const url = checkedString(request?.url, "History URL");
    if (request.private) {
      return false;
    }
    const visitedAt = Date.now();
    const flags = Number.isInteger(request.flags) ? request.flags : 0;
    this.#visited.add(url);
    this.#enqueueWrite(
      async connection => {
        await connection.executeTransaction(async () => {
          await connection.executeCached(
            `
            INSERT INTO history_pages(url, last_visited_at, visit_count)
            VALUES(:url, :visitedAt, 1)
            ON CONFLICT(url) DO UPDATE SET
              last_visited_at = excluded.last_visited_at,
              visit_count = history_pages.visit_count + 1
          `,
            { url, visitedAt }
          );
          await connection.executeCached(
            `
            INSERT INTO history_visits(url, visited_at, flags)
            VALUES(:url, :visitedAt, :flags)
          `,
            { url, visitedAt, flags }
          );
        });
        const [row] = await connection.executeCached(
          `SELECT url, title, last_visited_at, visit_count
           FROM history_pages WHERE url = :url`,
          { url }
        );
        if (row) {
          this.emit("history-visited", freezeHistoryEntry(row));
        }
      },
      { reportError: true }
    );
    return true;
  }

  recordTitle(request) {
    const url = checkedString(request?.url, "History title URL");
    const title = checkedString(request?.title ?? "", "History title", {
      allowEmpty: true,
    });
    if (request.private || !this.#visited.has(url)) {
      return false;
    }
    this.#enqueueWrite(
      async connection => {
        await connection.executeCached(
          "UPDATE history_pages SET title = :title WHERE url = :url",
          { url, title }
        );
        this.emit("history-title-changed", { url, title });
      },
      { reportError: true }
    );
    return true;
  }

  async queryHistory({ search = "", limit = 100 } = {}) {
    checkedString(search, "History search", { allowEmpty: true });
    checkedLimit(limit);
    await this.#ready;
    await this.#writeTail;
    const normalizedSearch = search.trim();
    const rows = normalizedSearch
      ? await this.#connection.executeCached(
          `
            SELECT url, title, last_visited_at, visit_count
            FROM history_pages
            WHERE url LIKE :pattern ESCAPE '\\'
               OR title LIKE :pattern ESCAPE '\\'
            ORDER BY last_visited_at DESC
            LIMIT :limit
          `,
          {
            pattern: `%${normalizedSearch.replace(/[\\%_]/g, "\\$&")}%`,
            limit,
          }
        )
      : await this.#connection.executeCached(
          `
            SELECT url, title, last_visited_at, visit_count
            FROM history_pages
            ORDER BY last_visited_at DESC
            LIMIT :limit
          `,
          { limit }
        );
    return Object.freeze(rows.map(freezeHistoryEntry));
  }

  async deleteHistory(urls) {
    if (!Array.isArray(urls) || !urls.length) {
      throw new TypeError("deleteHistory() requires at least one URL");
    }
    const uniqueUrls = [
      ...new Set(urls.map(url => checkedString(url, "History URL"))),
    ];
    for (const url of uniqueUrls) {
      this.#visited.delete(url);
    }
    await this.#enqueueWrite(connection =>
      connection.executeTransaction(async () => {
        for (const url of uniqueUrls) {
          await connection.executeCached(
            "DELETE FROM history_pages WHERE url = :url",
            { url }
          );
        }
      })
    );
    this.emit("history-removed", {
      allHistory: false,
      urls: Object.freeze(uniqueUrls),
    });
    return Object.freeze(uniqueUrls);
  }

  async getHistoryVisits(url) {
    checkedString(url, "History URL");
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.executeCached(
      `SELECT id, visited_at, flags FROM history_visits
       WHERE url = :url ORDER BY visited_at ASC`,
      { url }
    );
    return Object.freeze(
      rows.map(row =>
        Object.freeze({
          id: String(row.getResultByName("id")),
          visitTime: row.getResultByName("visited_at"),
          flags: row.getResultByName("flags"),
        })
      )
    );
  }

  async addHistoryVisit({ url, title = "", visitedAt = Date.now() }) {
    checkedString(url, "History URL");
    checkedString(title, "History title", { allowEmpty: true });
    if (!Number.isFinite(visitedAt) || visitedAt < 0) {
      throw new TypeError("History visit time must be a positive timestamp");
    }
    this.#visited.add(url);
    const entry = await this.#enqueueWrite(async connection => {
      await connection.executeTransaction(async () => {
        await connection.executeCached(
          `INSERT INTO history_pages(
             url, title, last_visited_at, visit_count
           ) VALUES(:url, :title, :visitedAt, 1)
           ON CONFLICT(url) DO UPDATE SET
             title = CASE
               WHEN excluded.title = '' THEN history_pages.title
               ELSE excluded.title
             END,
             last_visited_at = MAX(
               history_pages.last_visited_at,
               excluded.last_visited_at
             ),
             visit_count = history_pages.visit_count + 1`,
          { url, title, visitedAt }
        );
        await connection.executeCached(
          `INSERT INTO history_visits(url, visited_at, flags)
           VALUES(:url, :visitedAt, 0)`,
          { url, visitedAt }
        );
      });
      const [row] = await connection.executeCached(
        `SELECT url, title, last_visited_at, visit_count
         FROM history_pages WHERE url = :url`,
        { url }
      );
      return row ? freezeHistoryEntry(row) : null;
    });
    if (entry) {
      this.emit("history-visited", entry);
      if (title) {
        this.emit("history-title-changed", { url, title: entry.title });
      }
    }
    return entry;
  }

  async deleteHistoryRange(startTime, endTime) {
    if (
      !Number.isFinite(startTime) ||
      !Number.isFinite(endTime) ||
      startTime > endTime
    ) {
      throw new TypeError("History range must contain valid ordered times");
    }
    const affected = await this.#enqueueWrite(async connection => {
      const rows = await connection.executeCached(
        `SELECT DISTINCT url FROM history_visits
         WHERE visited_at >= :startTime AND visited_at <= :endTime`,
        { startTime, endTime }
      );
      const urls = rows.map(row => row.getResultByName("url"));
      await connection.executeTransaction(async () => {
        await connection.executeCached(
          `DELETE FROM history_visits
           WHERE visited_at >= :startTime AND visited_at <= :endTime`,
          { startTime, endTime }
        );
        await connection.execute(
          `DELETE FROM history_pages
           WHERE NOT EXISTS (
             SELECT 1 FROM history_visits
             WHERE history_visits.url = history_pages.url
           )`
        );
        await connection.execute(
          `UPDATE history_pages SET
             last_visited_at = (
               SELECT MAX(visited_at) FROM history_visits
               WHERE history_visits.url = history_pages.url
             ),
             visit_count = (
               SELECT COUNT(*) FROM history_visits
               WHERE history_visits.url = history_pages.url
             )`
        );
      });
      const remaining = await connection.execute(
        "SELECT url FROM history_pages"
      );
      this.#visited = new Set(remaining.map(row => row.getResultByName("url")));
      return Object.freeze(urls);
    });
    if (affected.length) {
      this.emit("history-removed", {
        allHistory: false,
        urls: affected,
      });
    }
    return affected;
  }

  async clearHistory() {
    this.#visited.clear();
    await this.#enqueueWrite(connection =>
      connection.executeTransaction(async () => {
        await connection.execute("DELETE FROM history_visits");
        await connection.execute("DELETE FROM history_pages");
      })
    );
    this.emit("history-removed", {
      allHistory: true,
      urls: Object.freeze([]),
    });
  }

  async listBookmarks(parentId = ROOT_BOOKMARK_FOLDER) {
    checkedString(parentId, "Bookmark parent ID");
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.executeCached(
      `
        SELECT id, parent_id, type, url, title, position, created_at, updated_at
        FROM bookmarks
        WHERE parent_id = :parentId
        ORDER BY position ASC
      `,
      { parentId }
    );
    return Object.freeze(rows.map(freezeBookmark));
  }

  async createBookmark({
    parentId = ROOT_BOOKMARK_FOLDER,
    type = "bookmark",
    url = null,
    title = "",
  } = {}) {
    checkedString(parentId, "Bookmark parent ID");
    if (type !== "bookmark" && type !== "folder") {
      throw new TypeError("Bookmark type must be bookmark or folder");
    }
    if (type === "bookmark") {
      checkedString(url, "Bookmark URL");
    } else if (url !== null) {
      throw new TypeError("Bookmark folders cannot have a URL");
    }
    checkedString(title, "Bookmark title", { allowEmpty: true });
    const id = Services.uuid.generateUUID().toString().slice(1, -1);
    const now = Date.now();
    await this.#enqueueWrite(async connection => {
      await this.#requireFolder(connection, parentId);
      const [positionRow] = await connection.executeCached(
        `
          SELECT COALESCE(MAX(position) + 1, 0) AS next_position
          FROM bookmarks WHERE parent_id = :parentId
        `,
        { parentId }
      );
      await connection.executeCached(
        `
          INSERT INTO bookmarks(
            id, parent_id, type, url, title, position, created_at, updated_at
          ) VALUES(
            :id, :parentId, :type, :url, :title, :position, :now, :now
          )
        `,
        {
          id,
          parentId,
          type,
          url,
          title,
          position: positionRow.getResultByName("next_position"),
          now,
        }
      );
    });
    const bookmark = await this.getBookmark(id);
    this.emit("bookmark-created", bookmark);
    return bookmark;
  }

  async getBookmark(id) {
    checkedString(id, "Bookmark ID");
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.executeCached(
      `
        SELECT id, parent_id, type, url, title, position, created_at, updated_at
        FROM bookmarks WHERE id = :id
      `,
      { id }
    );
    return rows.length ? freezeBookmark(rows[0]) : null;
  }

  async updateBookmark(id, changes) {
    checkedString(id, "Bookmark ID");
    if (!changes || typeof changes !== "object") {
      throw new TypeError("Bookmark changes must be an object");
    }
    const allowed = new Set(["title", "url"]);
    for (const key of Object.keys(changes)) {
      if (!allowed.has(key)) {
        throw new TypeError(`Unknown bookmark field: ${key}`);
      }
    }
    if (!Object.keys(changes).length) {
      return this.getBookmark(id);
    }
    if (Object.hasOwn(changes, "title")) {
      checkedString(changes.title, "Bookmark title", { allowEmpty: true });
    }
    if (Object.hasOwn(changes, "url")) {
      checkedString(changes.url, "Bookmark URL");
    }
    await this.#enqueueWrite(async connection => {
      const rows = await connection.executeCached(
        "SELECT type, title, url FROM bookmarks WHERE id = :id",
        { id }
      );
      if (!rows.length) {
        throw new Error("Unknown bookmark");
      }
      const type = rows[0].getResultByName("type");
      if (type === "folder" && Object.hasOwn(changes, "url")) {
        throw new TypeError("Bookmark folders cannot have a URL");
      }
      await connection.executeCached(
        `
          UPDATE bookmarks
          SET title = :title, url = :url, updated_at = :updatedAt
          WHERE id = :id
        `,
        {
          id,
          title: changes.title ?? rows[0].getResultByName("title"),
          url: changes.url ?? rows[0].getResultByName("url"),
          updatedAt: Date.now(),
        }
      );
    });
    const bookmark = await this.getBookmark(id);
    this.emit("bookmark-changed", {
      bookmark,
      changes: Object.freeze({
        ...(Object.hasOwn(changes, "title") ? { title: bookmark.title } : {}),
        ...(Object.hasOwn(changes, "url") ? { url: bookmark.url } : {}),
      }),
    });
    return bookmark;
  }

  async moveBookmark(id, parentId, index) {
    checkedString(id, "Bookmark ID");
    checkedString(parentId, "Bookmark parent ID");
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError("Bookmark position must be a nonnegative integer");
    }
    const previous = await this.getBookmark(id);
    if (!previous) {
      throw new Error("Unknown bookmark");
    }
    await this.#enqueueWrite(async connection => {
      await this.#requireFolder(connection, parentId);
      const rows = await connection.executeCached(
        "SELECT parent_id, type FROM bookmarks WHERE id = :id",
        { id }
      );
      if (!rows.length) {
        throw new Error("Unknown bookmark");
      }
      if (rows[0].getResultByName("type") === "folder") {
        await this.#rejectBookmarkCycle(connection, id, parentId);
      }
      const oldParentId = rows[0].getResultByName("parent_id");
      const parentIds = new Set([oldParentId, parentId]);
      await connection.executeTransaction(async () => {
        const siblingRows = await connection.executeCached(
          `
            SELECT id FROM bookmarks
            WHERE parent_id = :parentId AND id != :id
            ORDER BY position ASC
          `,
          { parentId, id }
        );
        const ordered = siblingRows.map(row => row.getResultByName("id"));
        ordered.splice(Math.min(index, ordered.length), 0, id);
        await connection.executeCached(
          `UPDATE bookmarks SET parent_id = :parentId, position = -1,
                                updated_at = :updatedAt WHERE id = :id`,
          { id, parentId, updatedAt: Date.now() }
        );
        await this.#writeBookmarkOrder(connection, parentId, ordered);
        if (oldParentId !== parentId) {
          const oldRows = await connection.executeCached(
            `SELECT id FROM bookmarks WHERE parent_id = :parentId
             ORDER BY position ASC`,
            { parentId: oldParentId }
          );
          await this.#writeBookmarkOrder(
            connection,
            oldParentId,
            oldRows.map(row => row.getResultByName("id"))
          );
        }
        for (const touchedParent of parentIds) {
          await connection.executeCached(
            "UPDATE bookmarks SET updated_at = :now WHERE id = :id",
            { id: touchedParent, now: Date.now() }
          );
        }
      });
    });
    const bookmark = await this.getBookmark(id);
    this.emit("bookmark-moved", {
      bookmark,
      previousParentId: previous.parentId,
      previousIndex: previous.position,
    });
    return bookmark;
  }

  async removeBookmark(id) {
    checkedString(id, "Bookmark ID");
    const bookmark = await this.getBookmark(id);
    if (!bookmark) {
      return false;
    }
    await this.#enqueueWrite(connection =>
      connection.executeTransaction(async () => {
        const rows = await connection.executeCached(
          "SELECT parent_id FROM bookmarks WHERE id = :id",
          { id }
        );
        if (!rows.length) {
          return;
        }
        const parentId = rows[0].getResultByName("parent_id");
        await connection.executeCached(
          `
            WITH RECURSIVE descendants(id) AS (
              SELECT :id
              UNION ALL
              SELECT bookmarks.id FROM bookmarks
              JOIN descendants ON bookmarks.parent_id = descendants.id
            )
            DELETE FROM bookmarks WHERE id IN (SELECT id FROM descendants)
          `,
          { id }
        );
        const siblingRows = await connection.executeCached(
          `SELECT id FROM bookmarks WHERE parent_id = :parentId
           ORDER BY position ASC`,
          { parentId }
        );
        await this.#writeBookmarkOrder(
          connection,
          parentId,
          siblingRows.map(row => row.getResultByName("id"))
        );
      })
    );
    this.emit("bookmark-removed", bookmark);
    return true;
  }

  async #requireFolder(connection, id) {
    if (id === ROOT_BOOKMARK_FOLDER) {
      return;
    }
    const rows = await connection.executeCached(
      "SELECT type FROM bookmarks WHERE id = :id",
      { id }
    );
    if (!rows.length || rows[0].getResultByName("type") !== "folder") {
      throw new Error("Bookmark parent is not a folder");
    }
  }

  async #rejectBookmarkCycle(connection, id, parentId) {
    let candidate = parentId;
    while (candidate !== ROOT_BOOKMARK_FOLDER) {
      if (candidate === id) {
        throw new Error("A bookmark folder cannot contain itself");
      }
      const rows = await connection.executeCached(
        "SELECT parent_id FROM bookmarks WHERE id = :id",
        { id: candidate }
      );
      if (!rows.length) {
        throw new Error("Unknown bookmark parent");
      }
      candidate = rows[0].getResultByName("parent_id");
    }
  }

  async #writeBookmarkOrder(connection, parentId, ids) {
    for (let position = 0; position < ids.length; position += 1) {
      await connection.executeCached(
        `UPDATE bookmarks SET position = :temporary
         WHERE id = :id AND parent_id = :parentId`,
        { temporary: -position - 2, id: ids[position], parentId }
      );
    }
    for (let position = 0; position < ids.length; position += 1) {
      await connection.executeCached(
        `UPDATE bookmarks SET position = :position
         WHERE id = :id AND parent_id = :parentId`,
        { position, id: ids[position], parentId }
      );
    }
  }

  #credentialKeyStore() {
    return Cc["@mozilla.org/security/oskeystore;1"].getService(
      Ci.nsIOSKeyStore
    );
  }

  async #ensureCredentialKey() {
    const keyStore = this.#credentialKeyStore();
    if (!(await keyStore.asyncSecretAvailable(this.#credentialKeyLabel))) {
      const [countRow] = await this.#connection.execute(
        "SELECT COUNT(*) AS credential_count FROM credentials"
      );
      if (countRow.getResultByName("credential_count") > 0) {
        throw new Error("The Navis password key is unavailable");
      }
      // The recovery phrase is intentionally not persisted in the profile:
      // doing so beside the ciphertext would defeat OS-backed protection.
      await keyStore.asyncGenerateSecret(this.#credentialKeyLabel);
    }
    return keyStore;
  }

  async #encryptCredentialString(value) {
    const bytes = [...new TextEncoder().encode(value)];
    const keyStore = await this.#ensureCredentialKey();
    return keyStore.asyncEncryptBytes(this.#credentialKeyLabel, bytes);
  }

  async #decryptCredentialString(value) {
    const keyStore = this.#credentialKeyStore();
    if (!(await keyStore.asyncSecretAvailable(this.#credentialKeyLabel))) {
      throw new Error("The Navis password key is unavailable");
    }
    const bytes = await keyStore.asyncDecryptBytes(
      this.#credentialKeyLabel,
      value
    );
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  async #projectCredential(row, { includePassword = false } = {}) {
    const record = {
      id: row.getResultByName("id"),
      origin: row.getResultByName("origin"),
      actionOrigin: row.getResultByName("action_origin"),
      username: await this.#decryptCredentialString(
        row.getResultByName("username_ciphertext")
      ),
      usernameField: row.getResultByName("username_field"),
      passwordField: row.getResultByName("password_field"),
      createdAt: row.getResultByName("created_at"),
      updatedAt: row.getResultByName("updated_at"),
      lastUsedAt: row.getResultByName("last_used_at"),
      timesUsed: row.getResultByName("times_used"),
    };
    if (!includePassword) {
      return freezeCredentialSummary(record);
    }
    return Object.freeze({
      ...record,
      password: await this.#decryptCredentialString(
        row.getResultByName("password_ciphertext")
      ),
    });
  }

  async listCredentials({ origin = null } = {}) {
    const normalizedOrigin =
      origin === null
        ? null
        : checkedCredentialOrigin(origin, "Credential origin");
    await this.#ready;
    await this.#writeTail;
    const rows = normalizedOrigin
      ? await this.#connection.executeCached(
          `
            SELECT id, origin, action_origin, username_ciphertext,
                   password_ciphertext, username_field, password_field,
                   created_at, updated_at, last_used_at, times_used
            FROM credentials
            WHERE origin = :origin
            ORDER BY last_used_at DESC, updated_at DESC
          `,
          { origin: normalizedOrigin }
        )
      : await this.#connection.execute(`
          SELECT id, origin, action_origin, username_ciphertext,
                 password_ciphertext, username_field, password_field,
                 created_at, updated_at, last_used_at, times_used
          FROM credentials
          ORDER BY origin ASC, username_ciphertext ASC
        `);
    const credentials = await Promise.all(
      rows.map(row => this.#projectCredential(row))
    );
    if (normalizedOrigin === null) {
      credentials.sort(
        (left, right) =>
          left.origin.localeCompare(right.origin) ||
          left.username.localeCompare(right.username) ||
          right.lastUsedAt - left.lastUsedAt
      );
    }
    return Object.freeze(credentials);
  }

  async getCredential(
    id,
    {
      reauthenticate = false,
      reauthenticationReason = "",
      reauthenticationCaption = "Navis",
      window = null,
    } = {}
  ) {
    checkedString(id, "Credential ID", { maximum: 128 });
    if (typeof reauthenticate !== "boolean") {
      throw new TypeError("Credential reauthentication must be boolean");
    }
    checkedString(
      reauthenticationReason,
      "Credential reauthentication reason",
      {
        allowEmpty: true,
        maximum: 512,
      }
    );
    checkedString(
      reauthenticationCaption,
      "Credential reauthentication caption",
      { maximum: 128 }
    );
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.executeCached(
      `
        SELECT id, origin, action_origin, username_ciphertext,
               password_ciphertext, username_field, password_field,
               created_at, updated_at, last_used_at, times_used
        FROM credentials WHERE id = :id
      `,
      { id }
    );
    if (!rows.length) {
      return null;
    }
    if (
      reauthenticate &&
      (AppConstants.platform === "win" || AppConstants.platform === "macosx")
    ) {
      const result = await Cc["@mozilla.org/security/osreauthenticator;1"]
        .getService(Ci.nsIOSReauthenticator)
        .asyncReauthenticateUser(
          reauthenticationReason,
          reauthenticationCaption,
          window
        );
      if (!result?.[0]) {
        throw Components.Exception(
          "Credential reveal was not authorized",
          Cr.NS_ERROR_ABORT
        );
      }
    }
    return this.#projectCredential(rows[0], { includePassword: true });
  }

  async saveCredential({
    id = null,
    origin,
    actionOrigin = origin,
    username = "",
    password,
    usernameField = "",
    passwordField = "",
  } = {}) {
    if (id !== null) {
      checkedString(id, "Credential ID", { maximum: 128 });
    }
    const normalizedOrigin = checkedCredentialOrigin(
      origin,
      "Credential origin"
    );
    const normalizedActionOrigin = checkedCredentialOrigin(
      actionOrigin,
      "Credential action origin"
    );
    checkedString(username, "Credential username", {
      allowEmpty: true,
      maximum: 1024,
    });
    checkedString(password, "Credential password", { maximum: 4096 });
    checkedString(usernameField, "Credential username field", {
      allowEmpty: true,
      maximum: 256,
    });
    checkedString(passwordField, "Credential password field", {
      allowEmpty: true,
      maximum: 256,
    });

    let savedId = id;
    await this.#enqueueWrite(async connection => {
      if (savedId === null) {
        const candidates = await connection.executeCached(
          `
            SELECT id, username_ciphertext FROM credentials
            WHERE origin = :origin
          `,
          { origin: normalizedOrigin }
        );
        for (const candidate of candidates) {
          const candidateUsername = await this.#decryptCredentialString(
            candidate.getResultByName("username_ciphertext")
          );
          if (candidateUsername === username) {
            savedId = candidate.getResultByName("id");
            break;
          }
        }
      }

      const now = Date.now();
      // Key creation is serialized so a new profile cannot race two
      // asyncGenerateSecret() calls for the same OS-owned label.
      const encryptedUsername = await this.#encryptCredentialString(username);
      const encryptedPassword = await this.#encryptCredentialString(password);
      if (savedId !== null) {
        const updatedRows = await connection.executeCached(
          `
            UPDATE credentials SET
              origin = :origin,
              action_origin = :actionOrigin,
              username_ciphertext = :usernameCiphertext,
              password_ciphertext = :passwordCiphertext,
              username_field = :usernameField,
              password_field = :passwordField,
              updated_at = :now,
              last_used_at = :now,
              times_used = times_used + 1
            WHERE id = :id
            RETURNING id
          `,
          {
            id: savedId,
            origin: normalizedOrigin,
            actionOrigin: normalizedActionOrigin,
            usernameCiphertext: encryptedUsername,
            passwordCiphertext: encryptedPassword,
            usernameField,
            passwordField,
            now,
          }
        );
        if (!updatedRows.length) {
          throw new Error("Unknown credential");
        }
        return;
      }

      const [countRow] = await connection.execute(
        "SELECT COUNT(*) AS credential_count FROM credentials"
      );
      if (countRow.getResultByName("credential_count") >= MAX_CREDENTIALS) {
        throw new RangeError(`At most ${MAX_CREDENTIALS} credentials are kept`);
      }
      savedId = Services.uuid.generateUUID().toString().slice(1, -1);
      await connection.executeCached(
        `
          INSERT INTO credentials(
            id, origin, action_origin, username_ciphertext,
            password_ciphertext, username_field, password_field,
            created_at, updated_at, last_used_at, times_used
          ) VALUES(
            :id, :origin, :actionOrigin, :usernameCiphertext,
            :passwordCiphertext, :usernameField, :passwordField,
            :now, :now, :now, 1
          )
        `,
        {
          id: savedId,
          origin: normalizedOrigin,
          actionOrigin: normalizedActionOrigin,
          usernameCiphertext: encryptedUsername,
          passwordCiphertext: encryptedPassword,
          usernameField,
          passwordField,
          now,
        }
      );
    });
    const summaries = await this.listCredentials({ origin: normalizedOrigin });
    return summaries.find(credential => credential.id === savedId) ?? null;
  }

  async touchCredential(id) {
    checkedString(id, "Credential ID", { maximum: 128 });
    const now = Date.now();
    await this.#enqueueWrite(connection =>
      connection.executeCached(
        `
          UPDATE credentials
          SET last_used_at = :now, times_used = times_used + 1
          WHERE id = :id
        `,
        { id, now }
      )
    );
  }

  async removeCredential(id) {
    checkedString(id, "Credential ID", { maximum: 128 });
    let removed = false;
    await this.#enqueueWrite(async connection => {
      const rows = await connection.executeCached(
        "DELETE FROM credentials WHERE id = :id RETURNING id",
        { id }
      );
      removed = Boolean(rows.length);
    });
    return removed;
  }

  async clearCredentials(since = 0) {
    if (!Number.isFinite(since) || since < 0) {
      throw new TypeError("Credential clearing requires a valid start time");
    }
    let empty = false;
    await this.#enqueueWrite(async connection => {
      await connection.executeCached(
        "DELETE FROM credentials WHERE updated_at >= :since",
        { since }
      );
      const [row] = await connection.execute(
        "SELECT COUNT(*) AS count FROM credentials"
      );
      empty = row.getResultByName("count") === 0;
    });
    if (!empty) {
      return true;
    }
    try {
      const keyStore = this.#credentialKeyStore();
      if (await keyStore.asyncSecretAvailable(this.#credentialKeyLabel)) {
        await keyStore.asyncDeleteSecret(this.#credentialKeyLabel);
      }
      return true;
    } catch (error) {
      // Ciphertext is already gone. Retaining an otherwise unreferenced OS key
      // is safer than pretending that the user's credential rows survived.
      console.error(
        "Navis could not remove its unreferenced password key",
        error
      );
      return false;
    }
  }

  async saveSessionState(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      throw new TypeError("Session restoration state cannot be empty");
    }
    if (entries.length > MAX_RESTORED_SESSIONS) {
      throw new RangeError(
        `At most ${MAX_RESTORED_SESSIONS} Sessions can be restored`
      );
    }
    let selectedCount = 0;
    const normalized = entries.map((entry, position) => {
      if (!entry || typeof entry !== "object") {
        throw new TypeError("Session restoration entries must be objects");
      }
      const url = checkedString(entry.url, "Session restoration URL");
      const selected = Boolean(entry.selected);
      selectedCount += Number(selected);
      return { position, url, selected: Number(selected) };
    });
    if (selectedCount !== 1) {
      throw new TypeError("Session restoration state needs one selected entry");
    }
    await this.#enqueueWrite(connection =>
      connection.executeTransaction(async () => {
        await connection.execute("DELETE FROM session_tabs");
        for (const entry of normalized) {
          await connection.executeCached(
            `
              INSERT INTO session_tabs(position, url, selected)
              VALUES(:position, :url, :selected)
            `,
            entry
          );
        }
      })
    );
  }

  async addClosedTab({ windowId, position, url, title = "" }) {
    if (!Number.isSafeInteger(windowId) || !Number.isInteger(position)) {
      throw new TypeError("A closed tab requires stable window and tab indices");
    }
    checkedString(url, "Closed tab URL", { maximum: 8192 });
    checkedString(title, "Closed tab title", {
      allowEmpty: true,
      maximum: 4096,
    });
    const record = {
      id: Services.uuid.generateUUID().toString().slice(1, -1),
      windowId,
      position: Math.max(0, position),
      url,
      title,
      closedAt: Date.now(),
    };
    await this.#enqueueWrite(connection =>
      connection.executeTransaction(async () => {
        await connection.executeCached(
          `INSERT INTO closed_tabs(
             id, window_id, position, url, title, closed_at
           ) VALUES(
             :id, :windowId, :position, :url, :title, :closedAt
           )`,
          record
        );
        await connection.executeCached(
          `DELETE FROM closed_tabs WHERE id IN (
             SELECT id FROM closed_tabs
             ORDER BY closed_at DESC, id DESC
             LIMIT -1 OFFSET :limit
           )`,
          { limit: MAX_CLOSED_SESSIONS }
        );
      })
    );
    const frozen = Object.freeze({
      sessionId: record.id,
      windowId,
      index: record.position,
      url,
      title,
      closedAt: record.closedAt,
    });
    this.emit("closed-session-changed", frozen);
    return frozen;
  }

  async listClosedTabs(limit = MAX_CLOSED_SESSIONS) {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_CLOSED_SESSIONS) {
      throw new RangeError(
        `Closed-session limit must be between 0 and ${MAX_CLOSED_SESSIONS}`
      );
    }
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.executeCached(
      `SELECT id, window_id, position, url, title, closed_at
       FROM closed_tabs ORDER BY closed_at DESC, id DESC LIMIT :limit`,
      { limit }
    );
    return Object.freeze(rows.map(freezeClosedTab));
  }

  async takeClosedTab(sessionId, { remove = true } = {}) {
    checkedString(sessionId, "Closed session ID", { maximum: 128 });
    let record = null;
    await this.#enqueueWrite(async connection => {
      const rows = await connection.executeCached(
        `SELECT id, window_id, position, url, title, closed_at
         FROM closed_tabs WHERE id = :sessionId`,
        { sessionId }
      );
      record = rows.length ? freezeClosedTab(rows[0]) : null;
      if (record && remove) {
        await connection.executeCached(
          "DELETE FROM closed_tabs WHERE id = :sessionId",
          { sessionId }
        );
      }
    });
    if (record && remove) {
      this.emit("closed-session-changed", record);
    }
    return record;
  }

  async loadSessionState() {
    await this.#ready;
    await this.#writeTail;
    const rows = await this.#connection.execute(
      "SELECT position, url, selected FROM session_tabs ORDER BY position ASC"
    );
    if (
      !rows.length ||
      rows.filter(row => row.getResultByName("selected")).length !== 1
    ) {
      return Object.freeze([]);
    }
    return Object.freeze(
      rows.map(row =>
        Object.freeze({
          url: row.getResultByName("url"),
          selected: Boolean(row.getResultByName("selected")),
        })
      )
    );
  }

  async close() {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    try {
      await this.#ready;
      await this.#writeTail;
      await this.#connection?.close();
    } finally {
      this.#connection = null;
    }
  }
}

let store = null;

export function getDesktopProfileStore() {
  store ??= new DesktopProfileStoreImpl();
  return store;
}

export const DESKTOP_PROFILE_ROOT_BOOKMARK_FOLDER = ROOT_BOOKMARK_FOLDER;
