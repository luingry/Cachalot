// Network media sniffer. Watches media/XHR/other requests of every tab and
// keeps a per-tab list of HLS/DASH manifests and direct media files (at most
// MAX_MEDIA_PER_TAB, oldest dropped). The worker holds each list in memory and
// writes it to chrome.storage.session at most every FLUSH_MS per tab — a busy
// feed sends many media responses a second — so it survives worker restarts.

import {
  canonicalMediaUrl,
  classifyMediaResponse,
  headerValue,
  mediaKey,
  pickReplayHeaders,
  upsertMedia,
} from "./lib/media.js";
import { isIgnoredMediaHost, isPageOnlyPlatform } from "./lib/platforms.js";

const REQUEST_FILTER = {
  urls: ["http://*/*", "https://*/*"],
  types: ["media", "xmlhttprequest", "other"],
};
const MAX_PENDING = 2000;
const FLUSH_MS = 400;

// requestId -> { headers, range }. In-memory only: a request that spans a
// worker restart simply loses its captured headers.
const pending = new Map();
// tabId -> promise chain, so read-modify-write cycles of one tab never race.
const tabLocks = new Map();
// tabId -> { pageUrl, items }: this worker's copy of the stored lists.
const records = new Map();
// tabId -> timer of the pending storage write.
const flushTimers = new Map();
let notifyChange = () => {};
let notifyNew = () => {};

export function storageKey(tabId) {
  return `media:${tabId}`;
}

function withTabLock(tabId, task) {
  const previous = tabLocks.get(tabId) || Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => {});
  tabLocks.set(tabId, settled);
  settled.then(() => {
    if (tabLocks.get(tabId) === settled) tabLocks.delete(tabId);
  });
  return run;
}

/** The tab's record, from memory or (first use in this worker) from storage. Call under the tab lock. */
async function readRecord(tabId) {
  const cached = records.get(tabId);
  if (cached) return cached;
  const key = storageKey(tabId);
  const data = await chrome.storage.session.get(key);
  const stored = data?.[key];
  const record = {
    pageUrl: typeof stored?.pageUrl === "string" ? stored.pageUrl : "",
    items: Array.isArray(stored?.items) ? stored.items : [],
  };
  records.set(tabId, record);
  return record;
}

function cancelFlush(tabId) {
  clearTimeout(flushTimers.get(tabId));
  flushTimers.delete(tabId);
}

/** Writes the tab's list soon; changes arriving meanwhile go out in the same write. */
function scheduleFlush(tabId) {
  if (flushTimers.has(tabId)) return;
  flushTimers.set(
    tabId,
    setTimeout(() => {
      flushTimers.delete(tabId);
      withTabLock(tabId, async () => {
        const record = records.get(tabId);
        if (!record || closedTabs.has(tabId)) return;
        try {
          await chrome.storage.session.set({ [storageKey(tabId)]: { pageUrl: record.pageUrl, items: record.items } });
        } catch (err) {
          console.warn("[Cachalot] could not persist sniffed media:", err);
          return;
        }
        notifyChange(tabId, record.items);
      }).catch(() => {});
    }, FLUSH_MS),
  );
}

/** Raw sniffed entries of a tab: { pageUrl, items } (including changes not written yet). */
export function getTabMedia(tabId) {
  return withTabLock(tabId, async () => {
    const { pageUrl, items } = await readRecord(tabId);
    return { pageUrl, items };
  });
}

// Tabs closed during this worker's life. A late webRequest event can arrive
// after tabs.onRemoved; it must not store a list nobody will ever remove.
const closedTabs = new Set();
const MAX_CLOSED_TABS = 500;

export function removeTabMedia(tabId) {
  closedTabs.add(tabId);
  if (closedTabs.size > MAX_CLOSED_TABS) closedTabs.delete(closedTabs.values().next().value);
  cancelFlush(tabId);
  records.delete(tabId);
  return withTabLock(tabId, () => chrome.storage.session.remove(storageKey(tabId)));
}

function withoutHash(url) {
  return String(url || "").split("#")[0];
}

/**
 * Called when a tab's top-level URL changes. Drops the list unless the change
 * only touched the fragment (#...). Resolves to true when something was cleared.
 */
export function handleTabUrlChange(tabId, newUrl) {
  return withTabLock(tabId, async () => {
    const record = await readRecord(tabId);
    if (record.pageUrl && withoutHash(record.pageUrl) === withoutHash(newUrl)) return false;
    cancelFlush(tabId);
    records.delete(tabId); // the next media of the tab starts a record for the new page
    if (!record.items.length) return false;
    await chrome.storage.session.remove(storageKey(tabId));
    return true;
  });
}

function trimPending() {
  if (pending.size <= MAX_PENDING) return;
  const drop = Math.floor(pending.size / 2);
  let i = 0;
  for (const key of pending.keys()) {
    if (i++ >= drop) break;
    pending.delete(key);
  }
}

function recordEntry(tabId, entry) {
  return withTabLock(tabId, async () => {
    if (closedTabs.has(tabId)) return;
    const record = await readRecord(tabId);
    if (!record.pageUrl) {
      // first media of this page: learn its URL (also skips prerender tabs that are not visible)
      let tab = null;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        records.delete(tabId);
        return;
      }
      if (closedTabs.has(tabId)) return;
      record.pageUrl = tab.url || tab.pendingUrl || "";
    }
    if (isPageOnlyPlatform(record.pageUrl)) return;
    const isNew = !record.items.some((e) => e.key === entry.key);
    const { list, changed } = upsertMedia(record.items, entry);
    if (!changed) return;
    record.items = list;
    scheduleFlush(tabId);
    if (isNew) notifyNew(tabId, entry, record.pageUrl);
  });
}

/** Adds fields (e.g. what the page says is playing) to a stored entry. */
export function annotateMedia(tabId, key, fields) {
  return withTabLock(tabId, async () => {
    if (closedTabs.has(tabId)) return false;
    const record = await readRecord(tabId);
    const index = record.items.findIndex((e) => e.key === key);
    if (index < 0) return false;
    record.items = record.items.slice();
    record.items[index] = { ...record.items[index], ...fields };
    scheduleFlush(tabId);
    return true;
  });
}

/**
 * Registers the webRequest listeners. Must run synchronously at worker start
 * so that requests wake a stopped worker. onChange(tabId, items) fires after a
 * tab's list changed (written to storage); onNew(tabId, entry, pageUrl) when a
 * media appears for the first time.
 */
export function registerSniffer({ onChange, onNew = () => {} }) {
  notifyChange = onChange;
  notifyNew = onNew;
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0 || details.method !== "GET") return;
      pending.set(details.requestId, {
        headers: details.requestHeaders || [],
        range: headerValue(details.requestHeaders, "Range"),
      });
      trimPending();
    },
    REQUEST_FILTER,
    ["requestHeaders", "extraHeaders"],
  );

  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      const request = pending.get(details.requestId);
      pending.delete(details.requestId);
      if (details.tabId < 0 || details.method !== "GET") return;
      if (isIgnoredMediaHost(details.url)) return;

      const responseHeaders = details.responseHeaders || [];
      const contentType = headerValue(responseHeaders, "Content-Type");
      const result = classifyMediaResponse({
        url: details.url,
        statusCode: details.statusCode,
        contentType,
        contentLength: headerValue(responseHeaders, "Content-Length"),
        contentRange: headerValue(responseHeaders, "Content-Range"),
        requestRange: request?.range || "",
      });
      if (!result) return;

      const headers = pickReplayHeaders(request?.headers);
      if (!headers["User-Agent"] && typeof navigator !== "undefined") headers["User-Agent"] = navigator.userAgent;
      const url = canonicalMediaUrl(details.url);

      recordEntry(
        details.tabId,
        {
          key: mediaKey(url),
          url,
          kind: result.kind,
          size: result.size,
          contentType,
          headers,
          frameId: details.frameId ?? 0,
          detectedAt: Date.now(),
        },
      ).catch(() => {});
    },
    REQUEST_FILTER,
    ["responseHeaders"],
  );

  chrome.webRequest.onErrorOccurred.addListener((details) => {
    pending.delete(details.requestId);
  }, REQUEST_FILTER);
}
