// Builds /download request bodies and resolves what a context-menu click
// targets. Pure functions shared by the background worker and the tests.

import { isHttpUrl, isSendableUrl } from "./platforms.js";

export const MENU_DOWNLOAD = "cachalot-download";
export const MENU_AUDIO = "cachalot-audio";
export const COMMAND_SEND_PAGE = "send-page";

const MAX_TITLE = 300;

/** Audio formats Cachalot converts to (module AudioFormats), in the order the format question shows them. */
export const AUDIO_FORMATS = Object.freeze(["mp3", "flac", "wav", "original"]);

export const AUDIO_FORMAT_LABELS = Object.freeze({
  mp3: "MP3",
  flac: "FLAC",
  wav: "WAV",
  original: "Original",
});

export const AUDIO_FORMAT_HINTS = Object.freeze({
  mp3: "320 kbps",
  flac: "Sem perdas, comprimido",
  wav: "Sem perdas, sem compressão",
  original: "Como o site entrega",
});

function normalizeMode(mode) {
  return mode === "audio" || mode === "video" ? mode : null;
}

/** Body for POST /download following the bridge contract. */
export function buildDownloadPayload({
  urls,
  mode = null,
  title = "",
  pageUrl = "",
  headers = null,
  cookies = null,
  audioFormat = null,
  rememberFormat = false,
} = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter((u) => isSendableUrl(u));
  const body = { urls: list, mode: normalizeMode(mode), quality: null };
  const cleanTitle = typeof title === "string" ? title.trim().slice(0, MAX_TITLE) : "";
  if (cleanTitle) body.title = cleanTitle;
  if (isHttpUrl(pageUrl)) body.pageUrl = pageUrl;
  if (headers && typeof headers === "object") {
    const picked = {};
    for (const name of ["Referer", "Origin", "User-Agent"]) {
      if (typeof headers[name] === "string" && headers[name]) picked[name] = headers[name];
    }
    if (Object.keys(picked).length) body.headers = picked;
  }
  if (Array.isArray(cookies) && cookies.length) body.cookies = cookies;
  if (AUDIO_FORMATS.includes(audioFormat)) {
    body.audioFormat = audioFormat;
    if (rememberFormat === true) body.rememberFormat = true; // Cachalot stores it for the page's site
  }
  return body;
}

/**
 * URL a context-menu click refers to: the link (http(s) or magnet), then the
 * media/image source, then the frame, then the page. blob:/data: sources fall
 * back to the page. Returns { url, source } or null when nothing sendable was
 * clicked.
 */
export function contextMenuTarget(info = {}, tab = null) {
  if (isSendableUrl(info.linkUrl)) return { url: info.linkUrl, source: "link" };
  const candidates = [
    ["src", info.srcUrl],
    ["frame", info.frameUrl],
    ["page", info.pageUrl || tab?.url],
  ];
  for (const [source, url] of candidates) {
    if (isHttpUrl(url)) return { url, source };
  }
  return null;
}

/** Download mode for a context-menu click. */
export function contextMenuMode(info = {}) {
  if (info.menuItemId === MENU_AUDIO) return "audio";
  if (info.mediaType === "audio") return "audio";
  if (info.mediaType === "video") return "video";
  return null;
}
