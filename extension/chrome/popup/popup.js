// Toolbar popup. Opened from the toolbar it targets the active tab; opened as
// a page with ?tab=<id> it targets that tab (used by the end-to-end test;
// &nostreams=1 there keeps thumbnails from loading the media itself).

import { describeBridgeError } from "../src/lib/bridge.js";
import { registrableDomainOfUrl } from "../src/lib/domain.js";
import { scanFrame } from "../src/lib/pagescan.js";
import { parsePairingCode } from "../src/lib/pairing.js";
import { sortRows } from "../src/lib/media.js";
import { detectPlatform, isHttpUrl, isMusicPlatform } from "../src/lib/platforms.js";
import {
  durationOf,
  formatDuration,
  listenSource,
  normalizeScan,
  playbackFor,
  previewCandidates,
  trackRows,
  youtubeId,
  youtubeLinkRows,
} from "../src/lib/preview.js";
import { PREVIEW_RULE_ID, previewHeaderRule } from "../src/lib/previewrule.js";
import { anyActive, awaitingListing, currentItem, downloadKey, downloadView, latestByUrl } from "../src/lib/progress.js";
import { attachMse, dashPlan, parseHlsMaster, pickVariant } from "../src/lib/streams.js";
import { WAVE_ICON, createTransientView, icon } from "./transient.js";

const $ = (id) => document.getElementById(id);
const CLOSED_POLL_MS = 4000;
const RESCAN_MS = 1500;
const MEDIA_TIMEOUT_MS = 6000;
const STREAM_TIMEOUT_MS = 10000;
const MAX_MEDIA_THUMBS = 6;
const LINK_RESCAN_MS = 2500;
const SVG_NS = "http://www.w3.org/2000/svg";
const LOAD_STREAMS = !new URLSearchParams(location.search).has("nostreams");
const NATIVE_HLS = document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";

const state = {
  tab: null,
  sendable: false,
  domain: "",
  connection: "checking",
  rowFeedback: new Map(), // row id -> { ok, text }
  pollTimer: null,
  pageOnly: false,
  sniffedRows: [],
  linkRows: [], // YouTube videos the page shows (scan)
  trackRows: [], // music tracks the page shows (scan)
  music: false,
  linkSeen: new Map(), // YouTube video id -> when this popup first saw it
  linkTimer: null,
  newestFirst: true,
  transient: null, // { rowId, view, host }: the card in transient mode
  restoreTransient: "", // row id whose transient view was open when the popup closed
};

async function message(type, extra = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...extra });
    return res || { ok: false, error: "internal" };
  } catch (err) {
    return { ok: false, error: "internal", message: String(err?.message || err) };
  }
}

async function resolveTab() {
  const param = new URLSearchParams(location.search).get("tab");
  if (param) {
    try {
      return await chrome.tabs.get(Number(param));
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setBusy(button, busy, label) {
  button.classList.toggle("is-busy", busy);
  button.disabled = busy || button.disabled;
  if (busy) {
    button.dataset.label = button.dataset.label || button.innerHTML;
    button.replaceChildren(el("span", "spinner"), el("span", "", label));
  } else if (button.dataset.label) {
    button.innerHTML = button.dataset.label;
    delete button.dataset.label;
  }
}

// ---- Connection status ---------------------------------------------------

function canSend() {
  return state.sendable && (state.connection === "paired" || state.connection === "closed");
}

function updateButtons() {
  const enabled = canSend();
  for (const id of ["sendPage", "sendAudio"]) {
    const b = $(id);
    if (!b.classList.contains("is-busy") && !b.classList.contains("is-done")) b.disabled = !enabled;
  }
  for (const b of document.querySelectorAll(".media-row .btn, .transient-open")) {
    if (!b.classList.contains("is-busy") && !b.classList.contains("is-done")) b.disabled = !enabled;
  }
  $("showCachalot").disabled = state.connection !== "paired";
}

const SHOW_TITLE = "Abrir o Cachalot";

/** Header button: the Cachalot page in SwissTechKnife, in front of the browser (which closes this popup). */
async function showCachalot(button) {
  button.disabled = true;
  const res = await message("showCachalot");
  if (res.ok) return window.close();
  button.disabled = state.connection !== "paired";
  button.classList.add("is-error");
  button.title = describeBridgeError(res);
  setTimeout(() => {
    button.classList.remove("is-error");
    button.title = SHOW_TITLE;
  }, 2500);
}

function setConnection(next, info = {}) {
  const failing = (s) => s === "closed" || s === "unpaired";
  // the status block shows only when something is wrong: connected, it goes away; while checking again it stays
  // only if it was already showing a failure (no flash on every open)
  $("status").hidden = next === "paired" || (next === "checking" && !failing(state.connection));
  state.connection = next;
  $("status").dataset.state = next;
  $("statusMeta").textContent = "";
  $("retry").hidden = true;
  $("pairForm").hidden = true;
  $("pairHint").hidden = true;
  $("pairError").hidden = true;

  if (next === "checking") {
    $("statusText").textContent = "Procurando o Cachalot…";
  } else if (next === "paired") {
    $("statusText").textContent = "Conectado ao Cachalot";
    if (info.version) $("statusMeta").textContent = `v${info.version}`;
    pollDownloads();
  } else if (next === "closed") {
    $("statusText").textContent = "Cachalot fechado — abra o SwissTechKnife";
    $("retry").hidden = false;
  } else if (next === "unpaired") {
    $("statusText").textContent = "Cole o código de pareamento";
    $("pairForm").hidden = false;
    $("pairHint").hidden = false;
    const error = info.error || (info.hasCode ? "O código salvo não é mais aceito. Cole o código atual." : "");
    if (error) showPairError(error);
  }

  clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (next === "closed") state.pollTimer = setInterval(() => refreshStatus({ quiet: true }), CLOSED_POLL_MS);
  updateButtons();
}

function showPairError(text) {
  const p = $("pairError");
  p.textContent = text;
  p.hidden = false;
}

async function refreshStatus({ quiet = false } = {}) {
  if (!quiet) setConnection("checking");
  const res = await message("status");
  if (quiet && res.state === state.connection) return;
  if (res.state === "paired") setConnection("paired", res);
  else if (res.state === "unpaired") setConnection("unpaired", res);
  else setConnection("closed");
}

async function onPairSubmit(event) {
  event.preventDefault();
  const { code, valid } = parsePairingCode($("pairInput").value);
  if (!valid) {
    showPairError(describeBridgeError({ error: "invalid_code" }));
    $("pairInput").focus();
    return;
  }
  $("pairError").hidden = true;
  const button = $("pairButton");
  setBusy(button, true, "Pareando");
  const res = await message("pair", { code });
  setBusy(button, false);
  button.disabled = false;
  if (res.ok) {
    $("pairInput").value = "";
    setConnection("paired", res);
  } else if (res.error === "closed") {
    setConnection("closed");
  } else {
    showPairError(describeBridgeError(res));
    $("pairInput").select();
  }
}

/**
 * Inline text for a failed send. When the status block above already explains
 * the problem (pairing lost, app closed) the line stays short instead of
 * repeating it.
 */
function sendErrorText(res) {
  if (res.error === "unauthorized") return "Não enviado: pareie de novo acima.";
  if (res.error === "closed") return "Não enviado: o Cachalot está fechado.";
  return describeBridgeError(res);
}

/** Reacts to a failed send: 401 shows the pairing UI, a dead bridge the closed state. */
function applySendError(res) {
  if (res.error === "unauthorized") {
    setConnection("unpaired", { error: describeBridgeError(res) });
    $("pairInput").focus();
  } else if (res.error === "closed") {
    setConnection("closed");
  }
}

// ---- Current page --------------------------------------------------------

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderPage() {
  const tab = state.tab;
  const url = tab?.url || "";
  state.sendable = isHttpUrl(url);
  const card = document.querySelector(".page-card");
  card.classList.toggle("is-unsupported", !state.sendable);

  if (state.sendable) $("sendPage").dataset.url = url;
  const host = state.sendable ? hostLabel(url) : "Página do navegador";
  $("pageHost").textContent = host;
  $("pageTitle").textContent = state.sendable ? tab.title || host : "Esta página não pode ser enviada ao Cachalot";
  const platform = state.sendable ? detectPlatform(url) : null;
  $("pagePlatform").hidden = !platform;
  if (platform) $("pagePlatform").textContent = platform.name;

  const fallback = $("faviconFallback");
  fallback.textContent = (host[0] || "?").toUpperCase();
  const img = $("favicon");
  const icon = tab?.favIconUrl || "";
  if (/^(https?|data):/i.test(icon)) {
    img.onload = () => {
      img.hidden = false;
      fallback.hidden = true;
    };
    img.onerror = () => {
      img.hidden = true;
      fallback.hidden = false;
    };
    img.src = icon;
  }
}

function showPageFeedback(ok, text) {
  const p = $("pageFeedback");
  p.className = `feedback msg ${ok ? "msg-ok" : "msg-error"}`;
  p.textContent = text;
  p.hidden = false;
  // restart the fade-in animation for repeated sends
  p.style.animation = "none";
  void p.offsetWidth;
  p.style.animation = "";
}

async function sendPage(mode, button) {
  if (!state.tab || cancelFromButton(button)) return;
  setBusy(button, true, "Enviando");
  const res = await message("sendPage", { tabId: state.tab.id, mode });
  setBusy(button, false);
  // Success needs no message: the "Baixar" button itself turns into "✓ Na fila" and follows the download.
  if (res.ok) {
    $("pageFeedback").hidden = true;
    markSent(state.tab.url);
  } else {
    showPageFeedback(false, sendErrorText(res));
    applySendError(res);
  }
  updateButtons();
}

// ---- Download progress ---------------------------------------------------
// What the extension sent (and what Cachalot already has) shows its progress on
// the very button that sent it: "Na fila…", "42%", "✓ Baixado", "Falhou". Once
// it is downloaded, a folder button to its left opens where the file was saved.
// Cachalot is asked (GET /downloads) when the popup opens and every second
// while something is on its way; never otherwise.

const SENT_KEY = "sentUrls";
const DL_POLL_MS = 1000;
// sent: key -> when it was sent (ms). Only a recent send counts while Cachalot does not list the item.
const dl = { sent: new Map(), resent: new Map(), items: new Map(), timer: null };

async function loadSent() {
  dl.sent = new Map();
  try {
    const sent = (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
    for (const [url, at] of Object.entries(sent)) {
      const key = downloadKey(url);
      dl.sent.set(key, Math.max(dl.sent.get(key) || 0, Number(at) || 0));
    }
  } catch {
    // nothing sent is followed
  }
}

function markSent(url) {
  const key = downloadKey(url);
  // Sent again after it was downloaded: wait for Cachalot's new item instead of the old one.
  if (dl.items.get(key)?.status === "concluido") dl.resent.set(key, Date.now());
  dl.sent.set(key, Date.now());
  pollDownloads();
}

/** On hover "✓ Baixado" says "Baixar" and a download on its way says "Cancelar" (CSS swaps the two spans). */
function setDownloadLabel(label, view) {
  const hover = view.state === "done" ? "Baixar" : view.cancelId ? "Cancelar" : "";
  if (hover) label.replaceChildren(el("span", "dl-now", view.text), el("span", "dl-hover", hover));
  else label.textContent = view.text;
}

/** Click on a button whose download is on its way: cancel it in Cachalot. False = not cancellable. */
function cancelFromButton(button) {
  const id = button.dataset.cancel;
  if (!id) return false;
  cancelDownload(button, id);
  return true;
}

async function cancelDownload(button, id) {
  const key = downloadKey(button.dataset.url);
  button.disabled = true;
  const res = await message("cancelDownload", { id });
  if (res.ok) {
    // Cachalot drops the item: forget it was sent, so the button offers "Baixar" again.
    dl.items.delete(key);
    dl.sent.delete(key);
    dl.resent.delete(key);
    await forgetSent(key);
    paintDownloads();
    return;
  }
  button.disabled = false;
  showPageFeedback(false, describeBridgeError(res));
}

async function forgetSent(key) {
  try {
    const sent = (await chrome.storage.local.get(SENT_KEY))[SENT_KEY] || {};
    for (const url of Object.keys(sent)) if (downloadKey(url) === key) delete sent[url];
    await chrome.storage.local.set({ [SENT_KEY]: sent });
  } catch {
    // only the "✓ Na fila" mark would come back
  }
}

function paintDownload(button) {
  const key = downloadKey(button.dataset.url);
  if (!key) return null;
  const view = downloadView(currentItem(dl.items.get(key), dl.resent.get(key)), awaitingListing(dl.sent.get(key)));
  const label = button.id === "sendPage" ? button.querySelector(":scope > span:last-child") : button;
  if (button.classList.contains("is-busy") || !label) return view;
  paintFolder(button, view);
  if (!view) {
    if (button.dataset.dl) {
      delete button.dataset.dl;
      delete button.dataset.cancel;
      label.textContent = "Baixar";
      button.classList.remove("is-done");
      button.title = "";
      button.disabled = !canSend();
    }
    return null;
  }
  button.dataset.dl = view.state;
  if (view.cancelId) button.dataset.cancel = view.cancelId;
  else delete button.dataset.cancel;
  button.style.setProperty("--dp", String(view.progress));
  setDownloadLabel(label, view);
  button.title = view.title;
  button.classList.toggle("is-done", view.locked);
  button.disabled = view.locked || !canSend();
  return view;
}

function paintDownloads() {
  return [...document.querySelectorAll("button[data-url]")].map(paintDownload);
}

const FOLDER_TITLE = "Abrir a pasta do arquivo";
const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /></svg>';

/** The folder button to the left of a "✓ Baixado" button; gone in every other state. */
function paintFolder(button, view) {
  const prev = button.previousElementSibling;
  let folder = prev?.classList.contains("folder-btn") ? prev : null;
  if (!view?.folderId) {
    folder?.remove();
    return;
  }
  if (!folder) {
    folder = el("button", button.classList.contains("btn-sm") ? "icon-btn icon-btn-sm folder-btn" : "icon-btn folder-btn");
    folder.type = "button";
    folder.title = FOLDER_TITLE;
    folder.setAttribute("aria-label", FOLDER_TITLE);
    folder.innerHTML = FOLDER_ICON;
    folder.addEventListener("click", () => openFolder(folder));
    button.before(folder);
  }
  folder.dataset.id = view.folderId;
}

async function openFolder(folder) {
  if (folder.classList.contains("is-busy")) return;
  folder.classList.add("is-busy");
  folder.classList.remove("is-error");
  const res = await message("openFolder", { id: folder.dataset.id });
  folder.classList.remove("is-busy");
  if (res.ok) return;
  folder.classList.add("is-error");
  folder.title = res.error === "http" && res.status === 404 ? "O arquivo não está mais na pasta" : describeBridgeError(res);
  setTimeout(() => {
    folder.classList.remove("is-error");
    folder.title = FOLDER_TITLE;
  }, 2500);
}

async function pollDownloads() {
  clearTimeout(dl.timer);
  dl.timer = null;
  if (state.connection !== "paired") return paintDownloads();
  const res = await message("downloads");
  if (res.ok) dl.items = latestByUrl(res.items);
  if (anyActive(paintDownloads())) dl.timer = setTimeout(pollDownloads, DL_POLL_MS);
}

// ---- Sniffed media -------------------------------------------------------

function rowMeta(row) {
  // Most useful facts first: the host is the part that may be cut off.
  const parts = [];
  if (row.artist || row.meta?.artist) parts.push(row.artist || row.meta.artist);
  if (row.sizeText) parts.push(row.sizeText);
  if (row.variants > 0) parts.push(row.variants === 1 ? "+1 variante" : `+${row.variants} variantes`);
  parts.push(row.host);
  return parts.filter(Boolean).join(" · ");
}

function chipClass(row) {
  if (row.kind === "audio" || row.audio || row.kind === "track") return "chip chip-audio";
  if (row.kind === "dash") return "chip chip-dash";
  return "chip";
}

// ---- Thumbnails and previews -------------------------------------------------
// Each row gets a tile that survives list re-renders. The still comes from a
// scan of the tab's frames (poster, the file or stream itself, a crop of the
// playing video, the page's cover image), tried in order until one loads. The
// larger preview on hover plays the media itself, by type: video files and
// HLS/DASH streams play muted; audio rows have a listen button instead.

const preview = {
  frames: [],
  scannedAt: 0,
  scanning: null,
  rescanTimer: null,
  shot: null,
  mediaThumbs: 0,
  rounds: 0,
  headers: null, // promise: the Referer session rule is in place
  sources: new Map(), // playback key -> promise of { src } | { mse } | null
  tiles: new Map(), // row id -> { node, row, media: null | { tag, src }, tried, busy }
  pop: { token: 0, abort: null },
};

function svgIcon(className, d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

const PLAY_PATH = "M8 5.5v13l10.5-6.5z";
const STOP_PATH = "M7 7h10v10H7z";
const NOTE_PATH = "M9 18V5l11-2v13M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm11-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z";

function tileFor(row) {
  let tile = preview.tiles.get(row.id);
  if (!tile) {
    const node = el("div", "thumb");
    tile = { node, row, media: null, tried: "", busy: false, player: null };
    if (listenSource(row, { hls: NATIVE_HLS })) {
      node.append(svgIcon("glyph glyph-audio", NOTE_PATH));
      // Sound is heard, not seen: the tile is a play/stop button and opens the row's player.
      const badge = el("span", "listen");
      badge.append(svgIcon("listen-play", PLAY_PATH), svgIcon("listen-stop", STOP_PATH));
      node.append(badge);
      node.classList.add("is-listenable");
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", "Tocar");
      node.title = "Tocar";
      node.addEventListener("click", () => togglePlay(tile));
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          togglePlay(tile);
        }
      });
    } else if (row.kind === "audio" || row.audio || row.kind === "track") {
      node.append(svgIcon("glyph glyph-audio", NOTE_PATH));
    } else {
      node.append(svgIcon("glyph", PLAY_PATH));
    }
    node.addEventListener("pointerenter", () => showPop(tile));
    node.addEventListener("pointerleave", hidePop);
    preview.tiles.set(row.id, tile);
  }
  tile.row = row;
  return tile.node;
}

function waitFor(node, okEvent, timeoutMs = MEDIA_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      node.removeEventListener(okEvent, onOk);
      node.removeEventListener("error", onError);
      resolve(ok);
    };
    const onOk = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    node.addEventListener(okEvent, onOk);
    node.addEventListener("error", onError);
  });
}

function imgNode(src) {
  const img = document.createElement("img");
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  img.src = src;
  return img;
}

function videoNode({ preload = "metadata", hover = false } = {}) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = preload;
  if (hover) {
    v.autoplay = true;
    v.loop = true;
  }
  return v;
}

/** Stops a <video>'s downloads. */
function release(video) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

/** YouTube answers missing pictures with a 120×90 placeholder: anything that small is "missing" there. */
function minWidthFor(src) {
  return /^https:\/\/i\.ytimg\.com\//.test(src) ? 121 : 1;
}

function loadImage(src) {
  const img = imgNode(src);
  const loaded = img.complete && img.naturalWidth ? Promise.resolve(true) : waitFor(img, "load");
  return loaded.then((ok) => (ok && img.naturalWidth >= minWidthFor(src) ? img : null));
}

/** Installs the Referer rule once per popup; the service worker drops it when the popup closes. */
function ensurePreviewHeaders(rows) {
  if (preview.headers) return preview.headers;
  preview.headers = (async () => {
    if (!chrome.declarativeNetRequest?.updateSessionRules) return;
    const tabIds = [chrome.tabs.TAB_ID_NONE];
    const self = await chrome.tabs.getCurrent().catch(() => null);
    if (self?.id !== undefined) tabIds.push(self.id);
    const referer = rows.map((r) => r.headers?.Referer).find(Boolean) || state.tab?.url;
    const rule = previewHeaderRule({ referer, extensionId: chrome.runtime.id, tabIds });
    if (!rule) return;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PREVIEW_RULE_ID], addRules: [rule] });
      chrome.runtime.connect({ name: "preview" }); // closes with the popup
    } catch (err) {
      console.warn("[Cachalot] preview headers:", err);
    }
  })();
  return preview.headers;
}

/** What a <video> needs to play the row's own media: { src } or { mse: plan }; null when it cannot. */
function sourceFor(pb) {
  const key = `${pb.format || pb.type}:${pb.url}`;
  if (!preview.sources.has(key)) preview.sources.set(key, resolveSource(pb).catch(() => null));
  return preview.sources.get(key);
}

async function resolveSource(pb) {
  await preview.headers;
  if (pb.type !== "stream") return { src: pb.url };
  const res = await fetch(pb.url, { credentials: "include" });
  if (!res.ok) return null;
  const text = await res.text();
  const base = res.url || pb.url;
  if (pb.format === "hls") {
    const variants = parseHlsMaster(text, base);
    if (variants === null) return null;
    return { src: pickVariant(variants)?.url || pb.url }; // lightest variant: a preview, not the download
  }
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const plan = dashPlan(doc, base, { maxSegments: 6, canPlay: (type) => MediaSource.isTypeSupported(type) });
  if (!plan) return null;
  return plan.kind === "file" ? { src: plan.url } : { mse: plan };
}

/** Points a <video> at a source; resolves true once a frame can show. */
async function playInto(video, source, { segments = 0, signal } = {}) {
  const ready = waitFor(video, "loadeddata", STREAM_TIMEOUT_MS);
  if (source.mse) {
    const plan = segments ? { ...source.mse, segments: source.mse.segments.slice(0, segments) } : source.mse;
    try {
      await attachMse(video, plan, { signal });
    } catch {
      return false;
    }
  } else {
    video.src = source.src;
  }
  return ready;
}

/** One screenshot per scan, shared by every capture candidate. */
function screenshot() {
  if (!preview.shot) {
    preview.shot = chrome.tabs
      .captureVisibleTab(state.tab.windowId, { format: "jpeg", quality: 85 })
      .then(loadImage)
      .catch(() => null);
  }
  return preview.shot;
}

async function cropCapture(rect) {
  const shot = await screenshot();
  if (!shot) return null;
  const w = Math.min(rect.w, shot.naturalWidth - rect.x);
  const h = Math.min(rect.h, shot.naturalHeight - rect.y);
  if (w < 32 || h < 18) return null;
  const scale = Math.min(1, 480 / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d").drawImage(shot, rect.x, rect.y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Resolves to { tag, src, node } for a candidate that loaded, or null. */
async function loadCandidate(c) {
  if (c.type === "image") {
    await preview.headers;
    const img = await loadImage(c.url);
    return img && { tag: "img", src: c.url, node: img };
  }
  if (c.type === "capture") {
    const src = await cropCapture(c.rect);
    if (!src) return null;
    const img = await loadImage(src);
    return img && { tag: "img", src, node: img };
  }
  if (c.type === "video" || c.type === "stream") {
    if (preview.mediaThumbs >= MAX_MEDIA_THUMBS) return null;
    preview.mediaThumbs++;
    const source = await sourceFor(c);
    const v = videoNode({ preload: c.type === "video" ? "metadata" : "auto" });
    const target = source && c.type === "video" ? { src: `${source.src.split("#")[0]}#t=0.5` } : source;
    const ok = target && (await playInto(v, target, { segments: 1 }));
    if (!ok || !v.videoWidth) {
      release(v);
      preview.mediaThumbs--;
      return null;
    }
    v.pause();
    return { tag: "video", src: "", node: v };
  }
  return null;
}

async function fillTile(tile) {
  if (tile.media || tile.busy) return;
  const candidates = previewCandidates(tile.row, preview.frames, {
    canCapture: Boolean(state.tab?.active),
    streams: LOAD_STREAMS,
    hls: NATIVE_HLS,
  });
  const signature = JSON.stringify(candidates);
  if (!candidates.length || signature === tile.tried) return;
  tile.busy = true;
  tile.tried = signature;
  try {
    for (const c of candidates) {
      const media = await loadCandidate(c);
      if (!media) continue;
      media.node.classList.add("thumb-media");
      tile.node.prepend(media.node);
      tile.media = { tag: media.tag, src: media.src };
      tile.node.dataset.preview = c.type;
      // next frame: lets the fade-in transition run
      requestAnimationFrame(() => tile.node.classList.add("has-media"));
      return;
    }
  } finally {
    tile.busy = false;
  }
}

async function scanTab() {
  if (!state.tab || !state.sendable || !chrome.scripting) return [];
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: state.tab.id, allFrames: true }, func: scanFrame });
    return normalizeScan(results);
  } catch {
    return []; // page the browser does not let extensions read (store, PDF viewer…)
  }
}

/**
 * Scans the page (at most every RESCAN_MS) and fills the tiles still empty.
 * force: scan even when every tile has its picture (new YouTube videos may have appeared).
 */
function refreshPreviews(rows, { force = false } = {}) {
  if (preview.tiles.size || rows.length) ensurePreviewHeaders([...rows, ...state.sniffedRows]);
  const pending = [...preview.tiles.values()].filter((t) => !t.media);
  if ((!pending.length && !force) || preview.scanning || preview.rescanTimer) return;
  const wait = Math.max(0, preview.scannedAt + RESCAN_MS - Date.now());
  preview.rescanTimer = setTimeout(async () => {
    preview.rescanTimer = null;
    preview.scanning = scanTab();
    preview.frames = await preview.scanning;
    preview.scanning = null;
    preview.scannedAt = Date.now();
    preview.shot = null;
    updateLinkRows();
    for (const tile of preview.tiles.values()) showDuration(tile);
    await Promise.all([...preview.tiles.values()].map(fillTile));
    document.body.dataset.previews = String(++preview.rounds); // read by the end-to-end test
  }, wait);
}

function showDuration(tile) {
  const seconds = durationOf(tile.row, preview.frames);
  const text = tile.row.durationText || (seconds ? formatDuration(seconds) : "");
  let badge = tile.node.querySelector(".duration");
  if (!text) return badge?.remove();
  if (!badge) {
    badge = el("span", "duration");
    tile.node.append(badge);
  }
  badge.textContent = text;
}

function placePop(pop, tile) {
  const anchor = tile.node.closest(".media-row") || tile.node.closest(".page-head") || tile.node;
  const r = anchor.getBoundingClientRect();
  const height = pop.offsetHeight || 169;
  const above = r.top - height - 8;
  pop.style.top = `${above >= 8 ? above : Math.min(r.bottom + 8, innerHeight - height - 8)}px`;
  pop.classList.add("is-open");
}

/** Larger preview: the media playing by type (muted), else the still. */
async function showPop(tile) {
  if (tile === player.tile) return; // its player is open: the controls stay visible
  const token = ++preview.pop.token;
  preview.pop.abort?.abort();
  const pop = $("previewPop");
  delete pop.dataset.playing;
  pop.classList.remove("is-slides");
  const still = tile.media?.tag === "img" ? tile.media.src : "";
  const pb = LOAD_STREAMS ? playbackFor(tile.row, { hls: NATIVE_HLS }) : null;

  if (pb?.type === "slides") return showSlides(tile, pb, still, token);
  if (!pb || pb.type === "audio") {
    if (!still) return;
    pop.replaceChildren(imgNode(still));
    placePop(pop, tile);
    return;
  }
  const v = videoNode({ preload: "auto", hover: true });
  if (still) v.poster = still;
  pop.replaceChildren(v);
  if (tile.media) placePop(pop, tile); // the still shows while the media loads
  const abort = new AbortController();
  preview.pop.abort = abort;
  const source = await sourceFor(pb);
  if (token !== preview.pop.token) return;
  const ok = source && (await playInto(v, source, { signal: abort.signal }));
  if (token !== preview.pop.token) return release(v);
  if (ok) {
    pop.dataset.playing = "1";
    v.play().catch(() => {});
    placePop(pop, tile);
  } else if (still) {
    release(v);
    pop.replaceChildren(imgNode(still));
  } else {
    release(v);
    pop.classList.remove("is-open");
  }
}

/**
 * Page-only video (YouTube): its streams play only in its own player, so the
 * preview steps through the pictures YouTube samples along the video.
 */
async function showSlides(tile, pb, still, token) {
  const pop = $("previewPop");
  const first = (await loadImage(pb.urls[0])) || (await loadImage(pb.fallback)) || (still && (await loadImage(still)));
  if (token !== preview.pop.token || !first) return;
  pop.classList.add("is-slides");
  pop.replaceChildren(first);
  placePop(pop, tile);
  const frames = (await Promise.all(pb.urls.slice(1).map(loadImage))).filter(Boolean);
  if (token !== preview.pop.token || !frames.length) return;
  const slides = [first, ...frames];
  pop.dataset.playing = "1";
  let i = 0;
  const timer = setInterval(() => {
    if (token !== preview.pop.token) return clearInterval(timer);
    i = (i + 1) % slides.length;
    pop.replaceChildren(slides[i]);
  }, 900);
}

function hidePop() {
  preview.pop.token++;
  preview.pop.abort?.abort();
  preview.pop.abort = null;
  const pop = $("previewPop");
  pop.classList.remove("is-open", "is-slides");
  delete pop.dataset.playing;
  const old = pop.firstElementChild;
  if (old?.tagName === "VIDEO") release(old);
}

// ---- Player ------------------------------------------------------------------
// One sound at a time. The row that plays gets a player line: a play button that
// turns into stop, and a progress line that marks the position and seeks (click,
// drag, arrow keys). Files and HLS play in an <audio>; SoundCloud tracks listed
// on the page play in SoundCloud's own player, hidden, driven by its message API.

const SC_ORIGIN = "https://w.soundcloud.com";
const SEEK_STEP_S = 5;

const player = {
  tile: null,
  source: null,
  audio: null,
  frame: null,
  duration: 0,
  current: 0,
  buffered: 0,
  playing: false,
  seeking: null, // fraction while the pointer drags the line
};

function clockToSeconds(text) {
  return String(text || "")
    .split(":")
    .reduce((total, part) => total * 60 + (Number(part) || 0), 0);
}

function playerLine(tile) {
  if (tile.player) return tile.player;
  const line = el("div", "player");
  const button = el("button", "player-btn");
  button.type = "button";
  button.append(svgIcon("icon-play", PLAY_PATH), svgIcon("icon-stop", STOP_PATH));
  button.addEventListener("click", () => togglePlay(tile));
  const seek = el("div", "seek");
  seek.tabIndex = 0;
  seek.setAttribute("role", "slider");
  seek.setAttribute("aria-label", "Posição");
  const track = el("div", "seek-track");
  track.append(el("div", "seek-buffer"), el("div", "seek-fill"), el("div", "seek-knob"));
  seek.append(track);
  const time = el("span", "player-time", "0:00");
  line.append(button, seek, time);
  bindSeek(seek, tile);
  tile.player = { line, button, seek, time };
  return tile.player;
}

function bindSeek(seek, tile) {
  const fraction = (e) => {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  seek.addEventListener("pointerdown", (e) => {
    if (player.tile !== tile || !player.duration) return;
    seek.setPointerCapture(e.pointerId);
    player.seeking = fraction(e);
    renderPlayer();
  });
  seek.addEventListener("pointermove", (e) => {
    if (player.seeking === null || player.tile !== tile) return;
    player.seeking = fraction(e);
    renderPlayer();
  });
  const release = (e) => {
    if (player.seeking === null || player.tile !== tile) return;
    const f = fraction(e);
    player.seeking = null;
    seekTo(f * player.duration);
  };
  seek.addEventListener("pointerup", release);
  seek.addEventListener("pointercancel", () => {
    player.seeking = null;
    renderPlayer();
  });
  seek.addEventListener("keydown", (e) => {
    if (player.tile !== tile || !player.duration) return;
    const moves = { ArrowRight: SEEK_STEP_S, ArrowUp: SEEK_STEP_S, ArrowLeft: -SEEK_STEP_S, ArrowDown: -SEEK_STEP_S };
    if (e.key in moves) seekTo(player.current + moves[e.key]);
    else if (e.key === "Home") seekTo(0);
    else if (e.key === "End") seekTo(player.duration - 1);
    else return;
    e.preventDefault();
  });
}

function renderPlayer() {
  for (const tile of preview.tiles.values()) {
    const active = tile === player.tile;
    const playing = active && player.playing;
    tile.node.classList.toggle("is-playing", playing);
    if (tile.node.classList.contains("is-listenable")) {
      tile.node.setAttribute("aria-label", playing ? "Parar" : "Tocar");
      tile.node.title = playing ? "Parar" : "Tocar";
    }
    if (!active || !tile.player) continue;
    const { line, button, seek, time } = tile.player;
    line.classList.toggle("is-playing", playing);
    button.setAttribute("aria-label", playing ? "Parar" : "Tocar");
    button.title = playing ? "Parar" : "Tocar";
    const d = player.duration;
    const p = player.seeking ?? (d ? Math.min(1, player.current / d) : 0);
    line.style.setProperty("--p", String(p));
    line.style.setProperty("--b", String(d ? Math.min(1, player.buffered / d) : 0));
    const shown = player.seeking !== null ? player.seeking * d : player.current;
    time.textContent = d ? `${formatDuration(shown)} / ${formatDuration(d)}` : formatDuration(shown);
    seek.setAttribute("aria-valuemin", "0");
    seek.setAttribute("aria-valuemax", String(Math.round(d)));
    seek.setAttribute("aria-valuenow", String(Math.round(shown)));
    seek.setAttribute("aria-valuetext", time.textContent);
  }
}

function audioElement() {
  if (player.audio) return player.audio;
  const a = new Audio();
  a.preload = "auto";
  const sync = () => {
    player.current = a.currentTime || 0;
    if (Number.isFinite(a.duration) && a.duration > 0) player.duration = a.duration;
    if (a.buffered.length) player.buffered = a.buffered.end(a.buffered.length - 1);
    renderPlayer();
  };
  for (const ev of ["timeupdate", "durationchange", "progress", "seeked"]) a.addEventListener(ev, sync);
  a.addEventListener("playing", () => {
    player.playing = true;
    sync();
  });
  for (const ev of ["pause", "ended"]) {
    a.addEventListener(ev, () => {
      player.playing = false;
      renderPlayer();
    });
  }
  a.addEventListener("error", () => {
    player.playing = false;
    player.tile?.node.classList.add("is-unplayable");
    renderPlayer();
  });
  player.audio = a;
  return a;
}

function widgetSend(method, value) {
  const message = value === undefined ? { method } : { method, value };
  player.frame?.contentWindow?.postMessage(JSON.stringify(message), SC_ORIGIN);
}

addEventListener("message", (e) => {
  if (e.origin !== SC_ORIGIN || !player.frame || e.source !== player.frame.contentWindow) return;
  let msg;
  try {
    msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  switch (msg?.method) {
    case "ready":
      for (const ev of ["play", "pause", "finish", "playProgress", "loadProgress"]) widgetSend("addEventListener", ev);
      widgetSend("getDuration");
      widgetSend("play");
      break;
    case "getDuration":
      player.duration = (Number(msg.value) || 0) / 1000;
      break;
    case "playProgress":
      player.current = (Number(msg.value?.currentPosition) || 0) / 1000;
      player.playing = true;
      break;
    case "loadProgress":
      player.buffered = (Number(msg.value?.loadedProgress) || 0) * player.duration;
      break;
    case "play":
      player.playing = true;
      widgetSend("getDuration");
      break;
    case "pause":
    case "finish":
      player.playing = false;
      break;
    default:
      return;
  }
  renderPlayer();
});

function stopCurrent() {
  player.audio?.pause();
  player.frame?.remove();
  player.frame = null;
  const old = player.tile;
  if (old?.player) {
    old.player.line.remove();
    (old.node.closest(".media-row") || old.node.closest(".page-card"))?.classList.remove("has-player");
    old.player = null;
  }
  Object.assign(player, { tile: null, source: null, duration: 0, current: 0, buffered: 0, playing: false, seeking: null });
}

function seekTo(seconds) {
  const s = Math.max(0, Math.min(seconds, player.duration || seconds));
  player.current = s;
  if (player.source?.type === "widget") widgetSend("seekTo", Math.round(s * 1000));
  else if (player.audio) player.audio.currentTime = s;
  renderPlayer();
}

async function togglePlay(tile) {
  hidePop(); // the big cover would sit on top of the player that opens now
  if (player.tile === tile && player.source) {
    // same row: stop ⇄ play, keeping the position
    if (player.playing) {
      if (player.source.type === "widget") widgetSend("pause");
      else player.audio.pause();
    } else if (player.source.type === "widget") {
      widgetSend("play");
    } else {
      player.audio.play().catch(() => tile.node.classList.add("is-unplayable"));
    }
    return;
  }
  stopCurrent();
  const source = listenSource(tile.row, { hls: NATIVE_HLS });
  if (!source) return;
  Object.assign(player, { tile, source, duration: clockToSeconds(tile.row.durationText) });
  tile.node.classList.remove("is-unplayable");
  const { line } = playerLine(tile);
  const li = tile.node.closest(".media-row") || tile.node.closest(".page-card");
  li?.append(line);
  li?.classList.add("has-player");
  renderPlayer();
  await preview.headers;
  if (player.tile !== tile) return;
  if (source.type === "widget") {
    const frame = document.createElement("iframe");
    frame.className = "sc-widget";
    frame.title = "SoundCloud";
    frame.allow = "autoplay";
    frame.src = source.url;
    player.frame = frame;
    document.body.append(frame);
    return;
  }
  const audio = audioElement();
  audio.src = source.src;
  audio.play().catch(() => {
    if (player.tile === tile) tile.node.classList.add("is-unplayable");
  });
}

function renderRow(row) {
  const li = el("li", "media-row");
  li.dataset.id = row.id;
  const tile = tileFor(row);
  li.append(tile);

  const text = el("div", "media-text");
  const title = el("div", "media-title");
  const name = el("span", "media-name", row.meta?.title || row.name);
  name.title = row.url;
  title.append(el("span", chipClass(row), row.label), name);
  text.append(title, el("div", "media-meta", rowMeta(row)));
  li.append(text);

  const button = el("button", "btn btn-ghost btn-sm", "Baixar");
  button.type = "button";
  button.dataset.url = row.url; // its download's progress shows here (see paintDownload)
  const done = state.rowFeedback.get(row.id);
  button.addEventListener("click", () => sendRow(row, li, button));
  li.append(button, transientButton(row, li));
  paintDownload(button);

  const playing = preview.tiles.get(row.id)?.player;
  if (playing) {
    // the row being listened to keeps its player across list updates
    li.append(playing.line);
    li.classList.add("has-player");
  }
  if (done && !done.ok) li.append(el("p", "media-error msg msg-error", done.text));
  if (state.transient?.rowId === row.id) {
    // the card in transient mode keeps its view across list updates
    li.classList.add("is-transient");
    li.append(state.transient.view.node);
    state.transient.host = li;
  } else if (state.restoreTransient === row.id) {
    queueMicrotask(() => openTransient(row, li));
  }
  return li;
}

// ---- Transient mode ------------------------------------------------------------
// The waveform icon right of "Baixar" turns the card into the transient view
// (popup/transient.js): waveform, transients, sections to download one by one
// or all at once. One card at a time; reopening the popup brings it back.

const TRANSIENT_TITLE = "Modo transiente: waveform e seções da música";
const TRANSIENT_OPEN_KEY = "transientOpen:";

function transientButton(row, host) {
  const b = el("button", row.kind === "page" ? "icon-btn transient-open" : "icon-btn icon-btn-sm transient-open");
  b.type = "button";
  b.title = TRANSIENT_TITLE;
  b.setAttribute("aria-label", TRANSIENT_TITLE);
  b.append(icon(WAVE_ICON));
  b.disabled = !canSend();
  b.addEventListener("click", () => openTransient(row, host));
  return b;
}

function rowTitle(row) {
  if (row.kind === "page") return state.tab?.title || row.url;
  const name = row.meta?.title || row.name || row.url;
  const artist = row.artist || row.meta?.artist;
  return artist ? `${artist} - ${name}` : name;
}

/** What Cachalot needs to fetch the row's audio: the page, a link the page shows, or a sniffed media (by id). */
function transientRequest(row) {
  const tabId = state.tab.id;
  if (row.kind === "page") return { tabId, url: state.tab.url, title: "" }; // Cachalot finds the real title
  if (row.kind === "youtube" || row.kind === "track") return { tabId, url: row.url, title: rowTitle(row) };
  return { tabId, id: row.id, title: row.meta?.title ? rowTitle(row) : state.tab.title || "" };
}

function openTransient(row, host) {
  if (state.transient?.rowId === row.id) return;
  closeTransient();
  state.restoreTransient = "";
  hidePop();
  stopCurrent();
  const view = createTransientView({
    request: transientRequest(row),
    title: rowTitle(row),
    message,
    onClose: () => closeTransient({ destroyed: true }),
  });
  state.transient = { rowId: row.id, view, host };
  host.classList.add("is-transient");
  host.append(view.node);
  document.body.classList.add("has-transient");
  requestAnimationFrame(() => host.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  chrome.storage.session.set({ [TRANSIENT_OPEN_KEY + state.tab.id]: row.id }).catch(() => {});
}

function closeTransient({ destroyed = false } = {}) {
  const t = state.transient;
  if (!t) return;
  state.transient = null;
  if (!destroyed) t.view.destroy();
  t.view.node.remove();
  t.host?.classList.remove("is-transient");
  document.body.classList.remove("has-transient");
  chrome.storage.session.remove(TRANSIENT_OPEN_KEY + state.tab.id).catch(() => {});
}

async function loadTransientRestore() {
  if (!state.tab) return;
  try {
    state.restoreTransient = (await chrome.storage.session.get(TRANSIENT_OPEN_KEY + state.tab.id))[TRANSIENT_OPEN_KEY + state.tab.id] || "";
  } catch {
    state.restoreTransient = "";
  }
}

async function sendRow(row, li, button) {
  if (cancelFromButton(button)) return;
  li.querySelector(".media-error")?.remove();
  setBusy(button, true, "");
  const res =
    row.kind === "youtube" || row.kind === "track"
      ? await message("sendLink", {
          tabId: state.tab.id,
          url: row.url,
          title: row.artist ? `${row.artist} - ${row.name}` : row.name,
          mode: row.kind === "track" ? "audio" : null,
        })
      : await message("sendMedia", { tabId: state.tab.id, id: row.id });
  setBusy(button, false);
  if (res.ok) {
    state.rowFeedback.delete(row.id);
    markSent(row.url);
  } else {
    const text = sendErrorText(res);
    state.rowFeedback.set(row.id, { ok: false, text });
    li.append(el("p", "media-error msg msg-error", text));
    applySendError(res);
  }
  updateButtons();
}

/**
 * The page's own video, previewed in the page card (YouTube: Cachalot picks the
 * formats itself, so it is downloaded through the page URL, never listed).
 */
function mainRow() {
  const url = state.tab?.url || "";
  if (!state.sendable || !(youtubeId(url) || isMusicPlatform(url))) return null;
  return { id: `main:${url}`, kind: "page", url, headers: {}, frameId: 0 };
}

async function loadMedia() {
  const res = state.tab ? await message("media", { tabId: state.tab.id }) : { rows: [] };
  state.pageOnly = Boolean(res.pageOnly);
  state.music = Boolean(res.music);
  state.sniffedRows = !state.pageOnly && Array.isArray(res.rows) ? res.rows : [];
  renderList();
  if ((state.pageOnly || state.music) && !state.linkTimer) {
    // YouTube and music sites keep adding cards as the page scrolls: look again while the popup is open
    state.linkTimer = setInterval(() => refreshPreviews([], { force: true }), LINK_RESCAN_MS);
  }
}

/** Sniffed media and the YouTube videos shown on the page (never the page's own one), newest first by default. */
function renderList({ fromScan = false } = {}) {
  const rows = sortRows([...state.sniffedRows, ...state.linkRows, ...state.trackRows], state.newestFirst);
  $("mediaList").replaceChildren(...rows.map(renderRow));
  $("sortOrder").hidden = rows.length < 2;
  $("mediaCount").hidden = rows.length === 0;
  $("mediaCount").textContent = String(rows.length);
  const empty = $("mediaEmpty");
  empty.hidden = rows.length > 0;
  if (!state.sendable) empty.textContent = "Nada para baixar nesta página.";
  else if (state.pageOnly) empty.textContent = "Nenhum outro vídeo nesta página ainda. Role a página e eles aparecem aqui.";
  else if (state.music) empty.textContent = "Nenhuma música detectada ainda. Dê play ou role a página.";
  else empty.textContent = "Nenhuma mídia detectada ainda. Dê play no vídeo e reabra.";
  updateButtons();
  paintDownloads();
  if (!fromScan) refreshPreviews(rows);
}

/** After a scan: the YouTube videos and music tracks the page shows now. Re-renders only when the list changed. */
function updateLinkRows() {
  const url = state.tab?.url || "";
  const links = youtubeLinkRows(preview.frames, { excludeId: youtubeId(url) });
  const tracks = trackRows(preview.frames, { excludeUrl: url, platformName: (u) => detectPlatform(u)?.name || "" });
  // A card's age is when this popup first saw it; lower on the page = loaded later.
  const now = Date.now();
  [...links, ...tracks].forEach((row, i) => {
    if (!state.linkSeen.has(row.id)) state.linkSeen.set(row.id, now + i);
    row.detectedAt = state.linkSeen.get(row.id);
  });
  const signature = (list) => list.map((r) => `${r.id}|${r.name}|${r.artist || ""}|${r.durationText}|${r.artwork || ""}`).join("\n");
  if (signature(links) === signature(state.linkRows) && signature(tracks) === signature(state.trackRows)) return;
  state.linkRows = links;
  state.trackRows = tracks;
  renderList({ fromScan: true });
}

const ORDER_KEY = "mediaOrder";

function applySortButton() {
  const button = $("sortOrder");
  const label = state.newestFirst ? "Mais recentes primeiro — clique para inverter" : "Mais antigas primeiro — clique para inverter";
  button.setAttribute("aria-pressed", String(!state.newestFirst));
  button.setAttribute("aria-label", label);
  button.title = label;
}

async function loadSortOrder() {
  try {
    state.newestFirst = (await chrome.storage.local.get(ORDER_KEY))[ORDER_KEY] !== "oldest";
  } catch {
    state.newestFirst = true;
  }
  applySortButton();
}

function toggleSortOrder() {
  state.newestFirst = !state.newestFirst;
  applySortButton();
  renderList({ fromScan: true });
  chrome.storage.local.set({ [ORDER_KEY]: state.newestFirst ? "newest" : "oldest" }).catch(() => {});
}

// ---- Boot ------------------------------------------------------------------

async function init() {
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("showCachalot").addEventListener("click", (e) => showCachalot(e.currentTarget));
  $("retry").addEventListener("click", () => refreshStatus());
  $("pairForm").addEventListener("submit", onPairSubmit);
  $("sendPage").addEventListener("click", (e) => sendPage(null, e.currentTarget));
  $("sendAudio").addEventListener("click", (e) => sendPage("audio", e.currentTarget));
  $("sortOrder").addEventListener("click", toggleSortOrder);

  await Promise.all([loadSortOrder(), loadSent()]);
  $("extVersion").textContent = `v${chrome.runtime.getManifest().version}`;
  state.tab = await resolveTab();
  renderPage();
  await loadTransientRestore();
  const main = mainRow();
  if (main) {
    // the page's own video: its preview takes the favicon's place once it loads
    const node = tileFor(main);
    node.classList.add("page-thumb");
    document.querySelector(".page-head").prepend(node);
    const card = document.querySelector(".page-card");
    $("sendAudio").after(transientButton(main, card));
    document.querySelector(".actions").classList.add("has-transient");
    if (state.restoreTransient === main.id) openTransient(main, card);
  }
  setConnection("checking");

  if (state.tab) {
    const key = `media:${state.tab.id}`;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && key in changes) loadMedia();
    });
  }
  await Promise.all([loadMedia(), refreshStatus()]);
  document.body.dataset.ready = "1";
}

init();
