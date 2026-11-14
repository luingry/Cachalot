// Picks what to show as the thumbnail of a sniffed media row, from the scan of
// the tab's frames (see pagescan.js). Pure: the popup renders the candidates in
// order and falls through when one fails to load.
//
// Candidates: { type: "image", url }          poster or page cover image
//             { type: "video", url }          first frames of the file itself
//             { type: "stream", format, url } first frames of the HLS/DASH stream
//             { type: "capture", rect }       crop of the visible tab (device pixels)
//
// playbackFor(row) says how the larger hover preview plays the media itself.

import { mediaKey } from "./media.js";

/** frames: [{ frameId, result: scanFrame() }] from chrome.scripting.executeScript. */
export function normalizeScan(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.result && Array.isArray(r.result.elements))
    .map((r) => ({ frameId: r.frameId ?? 0, ...r.result }));
}

function area(el) {
  return Math.max(0, el.rect?.w || 0) * Math.max(0, el.rect?.h || 0);
}

/** Playing first, then started, visible, then the biggest. */
function rank(el) {
  return (el.playing ? 8 : 0) + (el.started ? 4 : 0) + (el.visible ? 2 : 0);
}

/**
 * The element that most likely plays this row: the one whose source is the
 * row's file; otherwise (MSE players use blob: sources) the main video of the
 * frame the request came from.
 */
export function pickElement(row, frames) {
  const key = row.id || mediaKey(row.url);
  for (const frame of frames) {
    const el = frame.elements.find((e) => e.src && !e.src.startsWith("blob:") && mediaKey(e.src) === key);
    if (el) return { frame, element: el, exact: true };
  }
  if (row.kind === "audio") return null;
  const pool = row.kind === "page" ? frames.filter((f) => f.top) : frames.filter((f) => row.frameId === null || row.frameId === undefined || f.frameId === row.frameId);
  let best = null;
  for (const frame of pool.length ? pool : frames) {
    for (const el of frame.elements) {
      if (el.tag !== "video") continue;
      // a stream's player has a blob: (MSE) source; one with an http source plays another file
      if (row.kind !== "page" && el.src && !el.src.startsWith("blob:") && el.src.startsWith("http")) continue;
      const score = [rank(el), area(el)];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
        best = { frame, element: el, exact: false, score };
      }
    }
  }
  return best && { frame: best.frame, element: best.element, exact: false };
}

/** Duration in seconds of the element playing the row (0 when unknown, live or audio-less match). */
export function durationOf(row, frames) {
  if (row.kind === "youtube" || row.kind === "track") return 0; // its card's own text (durationText)
  const match = pickElement(row, frames);
  if (!match || (row.kind === "video" && !match.exact)) return 0;
  const d = Number(match.element.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/** "0:42", "12:05", "1:02:09" */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Crop of a top-frame element in screenshot pixels, clamped to the viewport; null when off screen. */
export function captureRect(frame, el) {
  if (!frame?.top || !el?.visible) return null;
  const vw = frame.viewport?.w || 0;
  const vh = frame.viewport?.h || 0;
  const x = Math.max(0, el.rect.x);
  const y = Math.max(0, el.rect.y);
  const w = Math.min(vw || Infinity, el.rect.x + el.rect.w) - x;
  const h = Math.min(vh || Infinity, el.rect.y + el.rect.h) - y;
  if (w < 48 || h < 27) return null;
  const dpr = frame.dpr || 1;
  return { x: Math.round(x * dpr), y: Math.round(y * dpr), w: Math.round(w * dpr), h: Math.round(h * dpr) };
}

function topImage(frames, frame) {
  return frame?.pageImage || frames.find((f) => f.top)?.pageImage || "";
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** Video id of a YouTube page (watch, shorts, live, embed, youtu.be, music), or "". */
export function youtubeId(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return "";
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let id = "";
  if (host === "youtu.be") id = u.pathname.split("/")[1] || "";
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") || "";
    const m = /^\/(shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
    if (!id && m) id = m[2];
  }
  return YOUTUBE_ID.test(id) ? id : "";
}

/**
 * YouTube's own pictures of a video: the thumbnail (largest first) and the three
 * frames it samples along the video, used as a slideshow preview.
 */
export function youtubeImages(pageUrl) {
  const id = youtubeId(pageUrl);
  if (!id) return null;
  const base = `https://i.ytimg.com/vi/${id}`;
  return {
    thumb: `${base}/mqdefault.jpg`,
    stills: [`${base}/maxresdefault.jpg`, `${base}/hqdefault.jpg`],
    frames: [`${base}/hq1.jpg`, `${base}/hq2.jpg`, `${base}/hq3.jpg`],
  };
}

/**
 * How the media itself plays in the hover preview, by type:
 * { type: "video", url } file · { type: "stream", format: "hls" | "dash", url } · { type: "audio", url }
 * · { type: "slides", urls } pictures of a page-only video (YouTube).
 * options.hls: the browser plays HLS natively.
 */
/**
 * Rows for the YouTube videos the scan found with a thumbnail (feeds, recommendations,
 * Shorts, embeds), in page order, without the page's own video.
 */
export function youtubeLinkRows(frames, { excludeId = "" } = {}) {
  const rows = [];
  const seen = new Set(excludeId ? [excludeId] : []);
  for (const frame of frames) {
    for (const v of frame.videos || []) {
      if (!v?.id || seen.has(v.id)) continue;
      seen.add(v.id);
      rows.push({
        id: `yt:${v.id}`,
        kind: "youtube",
        label: v.short ? "Shorts" : "YouTube",
        url: v.short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
        name: v.title || "Vídeo do YouTube",
        host: "youtube.com",
        sizeText: "",
        variants: 0,
        headers: {},
        durationText: v.duration || "",
        thumb: v.thumb || "",
      });
    }
  }
  return rows;
}

/** Rows for the music tracks the scan found (SoundCloud cards, Bandcamp albums, JSON-LD), without the page's own. */
export function trackRows(frames, { excludeUrl = "", platformName = () => "" } = {}) {
  const rows = [];
  const own = String(excludeUrl || "").split(/[?#]/)[0].replace(/\/$/, "");
  const seen = new Set();
  for (const frame of frames) {
    for (const t of frame.tracks || []) {
      const url = String(t?.url || "").split("#")[0];
      if (!url || seen.has(url) || url.replace(/\/$/, "") === own) continue;
      seen.add(url);
      let host = "";
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      rows.push({
        id: `track:${url}`,
        kind: "track",
        label: t.playlist ? "Playlist" : platformName(url) || "Música",
        url,
        name: t.title,
        artist: t.artist || "",
        host,
        sizeText: "",
        variants: 0,
        headers: {},
        durationText: t.duration || "",
        artwork: t.artwork || "",
        stream: t.stream || "",
      });
    }
  }
  return rows;
}

/** SoundCloud's own embeddable player for a track page (plays hidden in the popup). */
export function soundcloudWidgetUrl(trackUrl) {
  const params = new URLSearchParams({
    url: trackUrl,
    auto_play: "true",
    visual: "false",
    show_comments: "false",
    hide_related: "true",
    show_teaser: "false",
  });
  return `https://w.soundcloud.com/player/?${params}`;
}

/**
 * How a row's sound plays in the popup's player, or null when it cannot:
 * { type: "media", src, hls } an <audio> element (files; HLS natively) ·
 * { type: "widget", url } SoundCloud's player for a track page.
 */
export function listenSource(row, { hls = true } = {}) {
  if (row.kind === "page") {
    // the page of a SoundCloud track or playlist: its own track, in SoundCloud's player
    try {
      const u = new URL(row.url);
      const parts = u.pathname.split("/").filter(Boolean);
      const track = parts.length === 2 && !/^(sets|tracks|albums|reposts|likes|followers|following|popular-tracks|comments)$/.test(parts[1]);
      const set = parts.length === 3 && parts[1] === "sets";
      if (/(^|\.)soundcloud\.com$/.test(u.hostname) && (track || set) && !/^(discover|you|search|stream|charts|feed)$/.test(parts[0])) {
        return { type: "widget", url: soundcloudWidgetUrl(`${u.origin}${u.pathname}`) };
      }
    } catch {
      // not a URL
    }
    return null;
  }
  if (row.kind === "audio") return { type: "media", src: row.url, hls: false };
  if (row.kind === "hls" && row.audio) return hls ? { type: "media", src: row.url, hls: true } : null;
  if (row.kind === "track") {
    if (row.stream) return { type: "media", src: row.stream, hls: /\.m3u8(\?|$)/i.test(row.stream) };
    try {
      if (/(^|\.)soundcloud\.com$/.test(new URL(row.url).hostname)) return { type: "widget", url: soundcloudWidgetUrl(row.url) };
    } catch {
      return null;
    }
  }
  return null;
}

export function playbackFor(row, { hls = true } = {}) {
  if (row.kind === "track" || row.audio) return { type: "audio", url: row.stream || row.url };
  if (row.kind === "page" || row.kind === "youtube") {
    const yt = youtubeImages(row.url);
    return yt ? { type: "slides", urls: [...yt.stills.slice(0, 1), ...yt.frames], fallback: yt.stills[1] } : null;
  }
  if (row.kind === "video") return { type: "video", url: row.url };
  if (row.kind === "audio") return { type: "audio", url: row.url };
  if (row.kind === "dash") return { type: "stream", format: "dash", url: row.url };
  if (row.kind === "hls" && hls) return { type: "stream", format: "hls", url: row.url };
  return null;
}

/**
 * Ordered thumbnail candidates for a row.
 * options.canCapture: the tab is the visible one of its window (captureVisibleTab shows it).
 * options.streams / options.hls: the popup may load the media itself (HLS natively).
 */
export function previewCandidates(row, frames, { canCapture = false, streams = true, hls = true } = {}) {
  const list = [];
  const add = (c) => {
    if (c && !list.some((x) => x.type === c.type && x.url === c.url)) list.push(c);
  };
  if (row.meta?.artwork) add({ type: "image", url: row.meta.artwork }); // what the page said was playing
  if (row.kind === "track") {
    if (row.artwork) add({ type: "image", url: row.artwork });
    return list;
  }
  if (row.kind === "youtube") {
    // another video listed on the page: YouTube's thumbnail, else the one the page shows
    const yt = youtubeImages(row.url);
    if (yt) add({ type: "image", url: yt.thumb });
    if (row.thumb) add({ type: "image", url: row.thumb });
    return list;
  }
  if (row.kind === "page") {
    // The page's own video (YouTube): its thumbnail, else what the page shows.
    const yt = youtubeImages(row.url);
    if (yt) add({ type: "image", url: yt.thumb });
  }
  const found = pickElement(row, frames);
  // A direct file that no element plays: the page's main player shows something else.
  const match = found && (found.exact || row.kind !== "video") ? found : null;
  const el = match?.element;
  const playable = el && (el.playing || el.started);

  if (el?.poster) add({ type: "image", url: el.poster });
  const own = streams ? playbackFor(row, { hls }) : null;
  if (own && (own.type === "video" || own.type === "stream")) add(own);
  if (canCapture && playable) {
    const rect = captureRect(match.frame, el);
    if (rect) add({ type: "capture", rect });
  }
  const cover = topImage(frames, match?.frame);
  if (cover) add({ type: "image", url: cover });
  return list;
}
