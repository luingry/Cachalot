// Cachalot service worker: toolbar state, media sniffer, context menus,
// keyboard shortcut and every call to the local bridge.

import { STORAGE_KEYS, createBridgeClient, describeBridgeError } from "./lib/bridge.js";
import { cookiesForDomain, registrableDomainOfUrl } from "./lib/domain.js";
import { createBadgeFeedback } from "./lib/feedback.js";
import {
  buildDisplayList,
  displayCount,
  markAudioStreams,
  mediaKey,
  modeForKind,
  modeForRow,
  wantsNowPlaying,
} from "./lib/media.js";
import { readMediaSession } from "./lib/pagescan.js";
import { parsePairingCode } from "./lib/pairing.js";
import {
  COMMAND_SEND_PAGE,
  MENU_AUDIO,
  MENU_DOWNLOAD,
  buildDownloadPayload,
  contextMenuMode,
  contextMenuTarget,
} from "./lib/payload.js";
import {
  detectPlatform,
  iconStateFor,
  isHttpUrl,
  isMusicPlatform,
  isPageOnlyPlatform,
  soundcloudTrackUrl,
} from "./lib/platforms.js";
import { PREVIEW_RULE_ID } from "./lib/previewrule.js";
import { adoptPackagedPairing, recordLoadedBuild, shouldReloadForNewBuild } from "./lib/selfsetup.js";
import { annotateMedia, getTabMedia, handleTabUrlChange, registerSniffer, removeTabMedia } from "./sniffer.js";

const BADGE_COLOR = "#E8743C";
const BADGE_TEXT_COLOR = "#FFFFFF";
const ICON_SIZES = [16, 24, 32, 48];
const ICONS = {
  active: Object.fromEntries(ICON_SIZES.map((s) => [s, `/icons/active-${s}.png`])),
  inactive: Object.fromEntries(ICON_SIZES.map((s) => [s, `/icons/inactive-${s}.png`])),
};

const bridge = createBridgeClient({ storage: chrome.storage.local });
const iconStates = new Map();

// ---- Toolbar icon and badge ----------------------------------------------

/**
 * A per-tab chrome.action call that never complains about a tab closed meanwhile. setIcon's own bindings report
 * "Unchecked runtime.lastError: No tab with id" on the extension's error page even when its promise is awaited and
 * caught; a callback that reads lastError is the only way to mark the error as handled. Resolves false then.
 */
function actionCall(method, details) {
  const fn = chrome.action[method];
  if (typeof fn !== "function") return Promise.resolve(true);
  return new Promise((resolve) => {
    try {
      fn.call(chrome.action, details, () => resolve(!chrome.runtime.lastError));
    } catch {
      resolve(false);
    }
  });
}

async function paintBadge(tabId, text, color) {
  await Promise.all([
    actionCall("setBadgeBackgroundColor", { tabId, color }),
    actionCall("setBadgeTextColor", { tabId, color: BADGE_TEXT_COLOR }),
    actionCall("setBadgeText", { tabId, text }),
  ]);
}

// Tabs showing a ✓ / ! badge, mirrored to storage.session: if the worker stops
// inside the 2 s window, the next instance puts the media count back.
const FEEDBACK_KEY = "badgeFeedback";
const feedbackTabs = new Set();

function persistFeedbackTabs() {
  chrome.storage.session.set({ [FEEDBACK_KEY]: [...feedbackTabs] }).catch(() => {});
}

const feedback = createBadgeFeedback({
  setBadge: async (tabId, text, color) => {
    feedbackTabs.add(tabId);
    persistFeedbackTabs();
    await paintBadge(tabId, text, color).catch(() => {});
  },
  restore: (tabId) => {
    feedbackTabs.delete(tabId);
    persistFeedbackTabs();
    return refreshTab(tabId);
  },
});

/** Repaints a tab's icon (active/inactive) and media-count badge. */
async function refreshTab(tabId, knownTab = null, knownItems = null) {
  let tab = knownTab;
  if (!tab) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
  }
  const items = knownItems || (await getTabMedia(tabId)).items;
  const count = displayCount(items);
  const state = iconStateFor(tab.url || tab.pendingUrl || "", count);
  iconStates.set(tabId, state);
  try {
    // Tab-specific action state is reset by Chrome on navigation, so it is
    // always written, never cached.
    if (!(await actionCall("setIcon", { tabId, path: ICONS[state] }))) return; // the tab closed meanwhile
    if (!feedback.isActive(tabId)) await paintBadge(tabId, count > 0 ? String(count) : "", BADGE_COLOR);
  } catch {
    // tab went away meanwhile
  }
}

// A track's stream starts loading a moment before the page announces it.
const NOW_PLAYING_DELAY_MS = 1500;

/** Stores with a new audio media what the page says is playing (title, artist, artwork). */
function readNowPlaying(tabId, entry, pageUrl) {
  if (!chrome.scripting || !wantsNowPlaying(entry, isMusicPlatform(pageUrl))) return;
  setTimeout(async () => {
    for (const frameId of [...new Set([entry.frameId || 0, 0])]) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: readMediaSession });
        if (res?.result?.title) {
          await annotateMedia(tabId, entry.key, { meta: res.result });
          return;
        }
      } catch {
        // frame gone or not scriptable: try the top frame
      }
    }
  }, NOW_PLAYING_DELAY_MS);
}

// Registered synchronously so webRequest events can wake the worker.
registerSniffer({ onChange: (tabId, items) => refreshTab(tabId, null, items), onNew: readNowPlaying });

// The popup gives its preview requests the page's Referer (session rule) and
// holds a port open meanwhile: the rule goes when the popup closes.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "preview") return;
  port.onDisconnect.addListener(() => {
    chrome.declarativeNetRequest?.updateSessionRules({ removeRuleIds: [PREVIEW_RULE_ID] }).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    handleTabUrlChange(tabId, changeInfo.url)
      .catch(() => false)
      .then(() => refreshTab(tabId, tab));
  } else if (changeInfo.status) {
    refreshTab(tabId, tab);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  refreshTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  iconStates.delete(tabId);
  removeTabMedia(tabId).catch(() => {});
});

/**
 * Worker start: repaints tabs whose ✓ / ! badge a previous instance could not
 * clear, and drops stored lists of tabs closed while no worker was running.
 */
async function recoverState() {
  const [data, tabs] = await Promise.all([chrome.storage.session.get(null), chrome.tabs.query({})]);
  const open = new Set(tabs.map((t) => t.id));
  const stale = Object.keys(data).filter((key) => key.startsWith("media:") && !open.has(Number(key.slice(6))));
  if (stale.length) await chrome.storage.session.remove(stale);
  const leftover = Array.isArray(data[FEEDBACK_KEY]) ? data[FEEDBACK_KEY] : [];
  for (const tabId of leftover) {
    if (open.has(tabId) && !feedback.isActive(tabId)) refreshTab(tabId);
  }
  persistFeedbackTabs();
}

recoverState().catch(() => {});

// ---- Self setup (files written by the Cachalot module) ---------------------

const selfSetup = {
  fetchFn: (...args) => fetch(...args),
  storage: chrome.storage.local,
  getURL: (path) => chrome.runtime.getURL(path),
  codeKey: STORAGE_KEYS.code,
};

/** Pairs with the code the module left in the extension folder; the ping tells the module at once. */
async function pairFromPackage() {
  if (await adoptPackagedPairing(selfSetup)) await bridge.status();
}

/** Popup, options page or another extension view open: reloading now would close it under the user. */
async function extensionViewsOpen() {
  if (typeof chrome.runtime.getContexts !== "function") return false;
  const views = await chrome.runtime.getContexts({ contextTypes: ["POPUP", "TAB", "SIDE_PANEL"] });
  return views.length > 0;
}

/** The module copied a new version over this one: reload to run it (unpacked extensions do not on their own). */
async function reloadIfUpdated() {
  if (await extensionViewsOpen()) return;
  if (await shouldReloadForNewBuild(selfSetup)) chrome.runtime.reload();
}

reloadIfUpdated()
  .catch(() => {})
  .then(() => pairFromPackage())
  .catch(() => {});

// ---- Sending to Cachalot -------------------------------------------------

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function cookieStoreId(tabId) {
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    return stores.find((s) => s.tabIds.includes(tabId))?.id;
  } catch {
    return undefined;
  }
}

/** Cookies of the page's registrable domain (and subdomains), bridge format. */
async function collectCookies(tab) {
  const domain = registrableDomainOfUrl(tab?.url);
  if (!domain) return { domain: "", cookies: [] };
  const storeId = await cookieStoreId(tab.id);
  const query = storeId ? { domain, storeId } : { domain };
  const raw = await chrome.cookies.getAll(query);
  return { domain, cookies: cookiesForDomain(raw, domain) };
}

async function resolveCookieChoice(tab, explicit) {
  if (typeof explicit === "boolean") return explicit;
  return true; // whether a site's cookies are used is Cachalot's choice (Configurações › Login e cookies)
}

/**
 * Sends URLs to Cachalot on behalf of a tab.
 * options: { urls, mode, headers, cookies (boolean | undefined = site setting), title (default: the tab's) }
 */
async function sendToCachalot(tab, { urls, mode = null, headers = null, cookies, title = null } = {}) {
  if (!tab || !isHttpUrl(tab.url)) return { ok: false, error: "unsupported_page" };
  const withCookies = await resolveCookieChoice(tab, cookies);
  const cookieList = withCookies ? (await collectCookies(tab)).cookies : null;
  const payload = buildDownloadPayload({
    urls,
    mode,
    title: title ?? (tab.title || ""),
    pageUrl: tab.url,
    headers,
    cookies: cookieList,
  });
  if (!payload.urls.length) return { ok: false, error: "unsupported_page" };
  const result = await bridge.download(payload);
  if (result.ok) await rememberSent(payload.urls);
  return result;
}

const SENT_KEY = "sentUrls";
const MAX_SENT = 300;

/** URLs sent to Cachalot (url -> when): the popup follows their progress on the item that was clicked. */
async function rememberSent(urls) {
  try {
    const sent = (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
    for (const url of urls) sent[url] = Date.now();
    const kept = Object.entries(sent).sort((a, b) => b[1] - a[1]).slice(0, MAX_SENT);
    await chrome.storage.local.set({ [SENT_KEY]: Object.fromEntries(kept) });
  } catch {
    // the progress just is not shown
  }
}

/** The popup's rows of a tab (streams of music pages marked as audio). */
async function displayRows(tabId, tab) {
  const { items } = await getTabMedia(tabId);
  return markAudioStreams(buildDisplayList(items), Boolean(tab && isMusicPlatform(tab.url)));
}

/** Finds a sniffed entry of a tab by row id, or by URL (origin + path). */
async function findMedia(tabId, { id = null, url = null } = {}) {
  if (id) return (await displayRows(tabId, await getTab(tabId))).find((row) => row.id === id) || null;
  const { items } = await getTabMedia(tabId);
  if (url) {
    const key = mediaKey(url);
    const entry = items.find((e) => e.key === key);
    return entry ? { ...entry, url } : null;
  }
  return null;
}

async function handleContextClick(info, tab) {
  if (info.menuItemId !== MENU_DOWNLOAD && info.menuItemId !== MENU_AUDIO) return null;
  const target = contextMenuTarget(info, tab);
  const tabId = tab?.id;
  if (!target || tabId === undefined) {
    feedback.show(tabId, false);
    return { ok: false, error: "unsupported_page" };
  }
  let mode = contextMenuMode(info);
  let headers = null;
  if (target.source !== "page") {
    const sniffed = await findMedia(tabId, { url: target.url });
    if (sniffed) {
      headers = sniffed.headers;
      if (!mode) mode = modeForKind(sniffed.kind);
    }
  }
  const sendTab = tab.url ? tab : await getTab(tabId);
  const result = await sendToCachalot(sendTab, { urls: [target.url], mode, headers });
  await feedback.show(tabId, result.ok);
  return result;
}

async function handleCommand(command, tab) {
  if (command !== COMMAND_SEND_PAGE) return null;
  let target = tab;
  if (!target?.url) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    target = active;
  }
  if (!target) return { ok: false, error: "unsupported_page" };
  const result = await sendToCachalot(target, { urls: [target.url], mode: null });
  await feedback.show(target.id, result.ok);
  return result;
}

// ---- Context menus, shortcut, install --------------------------------------

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD,
      title: "Baixar com o Cachalot",
      contexts: ["page", "link", "video", "audio", "image", "frame"],
    });
    chrome.contextMenus.create({
      id: MENU_AUDIO,
      title: "Baixar só o áudio com o Cachalot",
      contexts: ["page", "link", "video", "audio"],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  recordLoadedBuild(selfSetup).catch(() => {});
  pairFromPackage().catch(() => {});
  if (details.reason === "install") chrome.runtime.openOptionsPage().catch(() => {});
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextClick(info, tab).catch((err) => console.error("[Cachalot] context menu:", err));
});

chrome.commands.onCommand.addListener((command, tab) => {
  handleCommand(command, tab).catch((err) => console.error("[Cachalot] command:", err));
});

// ---- Messages from the popup and options page --------------------------------

const handlers = {
  async status() {
    const state = await bridge.status();
    // Code rejected or missing: the module may have written a new one next to the extension.
    if (state.state === "unpaired" && (await adoptPackagedPairing(selfSetup))) return bridge.status();
    return state;
  },

  async pair({ code }) {
    const parsed = parsePairingCode(code);
    if (!parsed.valid) return { ok: false, error: "invalid_code" };
    return bridge.pair(parsed.code);
  },

  async media({ tabId }) {
    const tab = await getTab(tabId);
    return {
      pageOnly: Boolean(tab && isPageOnlyPlatform(tab.url)),
      platform: tab ? detectPlatform(tab.url) : null,
      music: Boolean(tab && isMusicPlatform(tab.url)),
      rows: await displayRows(tabId, tab),
    };
  },

  async sendPage({ tabId, mode = null, cookies, title = null }) {
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: "unsupported_page" };
    // title: the name the user typed in the popup (none: the tab's)
    return sendToCachalot(tab, { urls: [tab.url], mode: mode === "audio" ? "audio" : null, cookies, title: title ? String(title) : null });
  },

  async sendMedia({ tabId, id, cookies }) {
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: "unsupported_page" };
    const row = await findMedia(tabId, { id });
    if (!row) return { ok: false, error: "not_found" };
    return sendToCachalot(tab, {
      urls: [row.url],
      mode: modeForRow(row),
      headers: row.headers,
      cookies,
      title: row.meta?.title ? [row.meta.artist, row.meta.title].filter(Boolean).join(" - ") : null,
    });
  },

  /** Another video or track the page shows (popup list): sent by its own page URL. */
  async sendLink({ tabId, url, title = "", mode = null, cookies }) {
    const tab = await getTab(tabId);
    if (!tab) return { ok: false, error: "unsupported_page" };
    if (!isHttpUrl(url)) return { ok: false, error: "not_found" };
    return sendToCachalot(tab, { urls: [url], mode: mode === "audio" ? "audio" : null, cookies, title: String(title || "") });
  },

  /** SoundCloud player bar button (content script): the track that is playing, as audio, on behalf of its tab. */
  async sendPlaying({ url, title = "" }, sender) {
    const tab = sender?.tab;
    if (!tab?.id) return { ok: false, error: "unsupported_page" };
    const track = soundcloudTrackUrl(url);
    if (!track) return { ok: false, error: "not_found", message: describeBridgeError({ error: "not_found" }) };
    const result = await sendToCachalot(tab, { urls: [track], mode: "audio", title: String(title || "") });
    await feedback.show(tab.id, result.ok);
    return result.ok ? result : { ...result, message: describeBridgeError(result) };
  },

  async downloads() {
    return bridge.downloads();
  },

  async cancelDownload({ id }) {
    if (!id) return { ok: false, error: "not_found" };
    return bridge.cancel(id);
  },

  async showCachalot() {
    return bridge.show();
  },

  async openFolder({ id }) {
    if (!id) return { ok: false, error: "not_found" };
    return bridge.openFolder(id);
  },

  /**
   * Transient mode: Cachalot downloads the audio of a row (sniffed media, a link the page shows, or the page
   * itself) to analyze it. Sent like the download would be: same headers, cookies by the site's switch.
   */
  async transientPrepare({ tabId, id = null, url = null, title = "", cookies }) {
    const tab = await getTab(tabId);
    if (!tab || !isHttpUrl(tab.url)) return { ok: false, error: "unsupported_page" };
    let target = url;
    let headers = null;
    if (id) {
      const row = await findMedia(tabId, { id });
      if (!row) return { ok: false, error: "not_found" };
      target = row.url;
      headers = row.headers;
      if (!title && row.meta?.title) title = [row.meta.artist, row.meta.title].filter(Boolean).join(" - ");
    }
    if (!isHttpUrl(target)) return { ok: false, error: "not_found" };
    const withCookies = await resolveCookieChoice(tab, cookies);
    const cookieList = withCookies ? (await collectCookies(tab)).cookies : null;
    // no title: Cachalot uses the one its engine finds (YouTube's own, not the tab's "… - YouTube")
    const payload = buildDownloadPayload({ urls: [target], title, pageUrl: tab.url, headers, cookies: cookieList });
    return bridge.transient("prepare", { url: target, title: payload.title || "", pageUrl: payload.pageUrl, headers: payload.headers, cookies: payload.cookies });
  },

  async transient({ op, body }) {
    if (!["status", "export", "open", "format"].includes(op)) return { ok: false, error: "internal" };
    return bridge.transient(op, body || {});
  },

  async syncCookies({ tabId }) {
    const tab = await getTab(tabId);
    if (!tab || !isHttpUrl(tab.url)) return { ok: false, error: "unsupported_page" };
    const { domain, cookies } = await collectCookies(tab);
    return bridge.sendCookies(domain, cookies);
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;
  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: "internal", message: String(err?.message || err) }));
  return true;
});

// Debug surface for the service-worker console (and the end-to-end test):
// context menus and shortcuts cannot be clicked from automation.
globalThis.cachalot = {
  handleContextClick,
  handleCommand,
  iconState: (tabId) => iconStates.get(tabId) || null,
  refreshTab,
  status: () => bridge.status(),
};
