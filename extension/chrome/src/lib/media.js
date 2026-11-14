// Pure media classification, filtering, de-duplication and grouping used by the
// background sniffer and by the popup list.

export const MAX_MEDIA_PER_TAB = 50;
/** Range pieces smaller than this are treated as player fragments. */
export const FRAGMENT_MAX_BYTES = 1024 * 1024;
/** Direct files smaller than this (when the size is known) are UI blips. */
export const MIN_DIRECT_BYTES = 32 * 1024;

const EXTENSION_KINDS = Object.freeze({
  m3u8: "hls",
  mpd: "dash",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  mkv: "video",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  wav: "audio",
});

const SEGMENT_EXTENSIONS = new Set(["ts", "m4s", "aac", "cmfv", "cmfa", "m4f", "mp2t"]);

const HLS_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
const DASH_CONTENT_TYPES = new Set(["application/dash+xml"]);
const SEGMENT_CONTENT_TYPES = new Set([
  "video/mp2t",
  "video/mpeg2-ts",
  "video/iso.segment",
  "audio/iso.segment",
]);
const REJECTED_CONTENT_TYPE = /^(text\/html|application\/json|text\/css|text\/javascript|application\/javascript|image\/|font\/)/;

const SEGMENT_FILENAME = /^(seg|segment|chunk|frag|fragment|part|init)([-_.]?\d+)?([-_.].*)?\.(mp4|m4a|m4v|webm|mp3)$/i;
const SEGMENT_SUFFIX = /[-_](seg|segment|chunk|frag|fragment|init)[-_]?\d*\.(mp4|m4a|m4v|webm)$/i;

export const KIND_LABELS = Object.freeze({
  hls: "Vídeo HLS",
  dash: "DASH",
  video: "Vídeo",
  audio: "Áudio",
});

function parseUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Case-insensitive lookup in a webRequest header array. */
export function headerValue(headers, name) {
  if (!Array.isArray(headers)) return "";
  const lower = name.toLowerCase();
  const h = headers.find((x) => x && typeof x.name === "string" && x.name.toLowerCase() === lower);
  return h ? String(h.value ?? "") : "";
}

/** Picks the request headers Cachalot replays when downloading a stream. */
export function pickReplayHeaders(requestHeaders) {
  const out = {};
  for (const name of ["Referer", "Origin", "User-Agent"]) {
    const v = headerValue(requestHeaders, name);
    if (v) out[name] = v;
  }
  return out;
}

/** Lower-case file extension of the last path segment ("" when none). */
export function extensionOf(pathname) {
  const last = String(pathname || "").split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

export function baseContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

/** "hls" | "dash" | "video" | "audio" | "segment" | null */
export function kindFromContentType(contentType) {
  const ct = baseContentType(contentType);
  if (!ct) return null;
  if (HLS_CONTENT_TYPES.has(ct)) return "hls";
  if (DASH_CONTENT_TYPES.has(ct)) return "dash";
  if (SEGMENT_CONTENT_TYPES.has(ct)) return "segment";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  return null;
}

/** Parses "bytes 0-1023/4096" into { start, end, total } (total may be null). */
export function parseContentRange(value) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

/** Parses a "bytes=500-999" request Range header into { start, end|null }. */
export function parseRangeHeader(value) {
  const m = /^bytes=(\d+)-(\d*)$/i.exec(String(value || "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) };
}

/** True for HLS/DASH segment and init-chunk paths that should never be listed. */
export function isSegmentPath(pathname) {
  const path = String(pathname || "");
  if (SEGMENT_EXTENSIONS.has(extensionOf(path))) return true;
  const file = path.split("/").pop() || "";
  return SEGMENT_FILENAME.test(file) || SEGMENT_SUFFIX.test(file);
}

function queryRange(searchParams) {
  const range = searchParams.get("range");
  if (range) {
    const m = /^(\d+)-(\d+)$/.exec(range);
    if (m) return { start: Number(m[1]), end: Number(m[2]) };
  }
  const bs = toNumber(searchParams.get("bytestart"));
  const be = toNumber(searchParams.get("byteend"));
  if (bs !== null && be !== null) return { start: bs, end: be };
  return null;
}

/**
 * True when a response is only a small piece of a larger file: a byte range
 * (request Range header, Content-Range, or range/bytestart query) under 1 MB
 * that does not cover the whole resource.
 */
export function isFragmentResponse({ pieceSize, contentRange, requestRange, searchParams }) {
  const small = (n) => n !== null && n < FRAGMENT_MAX_BYTES;
  const cr = parseContentRange(contentRange);
  if (cr) {
    const piece = cr.end - cr.start + 1;
    const partial = cr.start > 0 || (cr.total !== null && piece < cr.total);
    if (partial && small(piece)) return true;
  }
  const rr = parseRangeHeader(requestRange);
  if (rr) {
    const span = rr.end !== null ? rr.end - rr.start + 1 : null;
    if (span !== null && small(span) && !(cr && cr.total !== null && span >= cr.total)) return true;
    if (rr.start > 0 && small(pieceSize)) return true;
  }
  if (searchParams) {
    const qr = queryRange(searchParams);
    if (qr) {
      const span = qr.end - qr.start + 1;
      if (small(pieceSize) || small(span)) return true;
    }
  }
  return false;
}

/**
 * Classifies a finished response. Returns { kind, size } for media worth
 * listing, or null for everything else (segments, fragments, non-media).
 *
 * input: { url, statusCode, contentType, contentLength, contentRange, requestRange }
 */
export function classifyMediaResponse(input) {
  const { url, statusCode = 200, contentType = "", contentLength = null, contentRange = "", requestRange = "" } = input || {};
  const u = parseUrl(url);
  if (!u) return null;
  if (statusCode < 200 || statusCode >= 300) return null;
  const ct = baseContentType(contentType);
  if (REJECTED_CONTENT_TYPE.test(ct)) return null;

  const ctKind = kindFromContentType(ct);
  if (ctKind === "segment") return null;
  if (isSegmentPath(u.pathname)) return null;

  const extKind = EXTENSION_KINDS[extensionOf(u.pathname)] || null;
  let kind;
  if (extKind === "hls" || extKind === "dash") kind = extKind;
  else kind = ctKind || extKind;
  if (!kind) return null;

  if (kind === "hls" || kind === "dash") return { kind, size: null };

  const pieceSize = toNumber(contentLength);
  if (isFragmentResponse({ pieceSize, contentRange, requestRange, searchParams: u.searchParams })) return null;
  const cr = parseContentRange(contentRange);
  // Content-Range carries the full size; a query-string range only says how
  // big this piece is, so the file size stays unknown.
  const size = cr ? cr.total : queryRange(u.searchParams) ? null : pieceSize;
  if (size !== null && size < MIN_DIRECT_BYTES) return null;
  return { kind, size };
}

const RANGE_QUERY_PARAMS = ["bytestart", "byteend"];

/**
 * URL of the whole file for CDNs that select a byte range through the query
 * string (Instagram/Facebook bytestart & byteend): those parameters are dropped.
 */
export function canonicalMediaUrl(url) {
  const u = parseUrl(url);
  if (!u) return url;
  let changed = false;
  for (const name of RANGE_QUERY_PARAMS) {
    if (u.searchParams.has(name)) {
      u.searchParams.delete(name);
      changed = true;
    }
  }
  return changed ? u.toString() : url;
}

/** De-duplication key: origin + path (volatile query strings are ignored). */
export function mediaKey(url) {
  const u = parseUrl(url);
  return u ? `${u.origin}${u.pathname}` : String(url || "");
}

/**
 * Inserts or refreshes an entry in a tab list. Entries with the same key are
 * merged in place (latest URL and headers, largest known size). The list keeps
 * at most `cap` entries, dropping the oldest. Returns { list, changed }.
 */
export function upsertMedia(list, entry, cap = MAX_MEDIA_PER_TAB) {
  const current = Array.isArray(list) ? list : [];
  const key = entry.key || mediaKey(entry.url);
  const idx = current.findIndex((e) => e.key === key);
  if (idx >= 0) {
    const prev = current[idx];
    const size = Math.max(prev.size ?? -1, entry.size ?? -1);
    const merged = {
      ...prev,
      url: entry.url || prev.url,
      headers: { ...prev.headers, ...entry.headers },
      size: size >= 0 ? size : null,
    };
    const changed =
      merged.url !== prev.url || merged.size !== prev.size || JSON.stringify(merged.headers) !== JSON.stringify(prev.headers);
    if (!changed) return { list: current, changed: false };
    const next = current.slice();
    next[idx] = merged;
    return { list: next, changed: true };
  }
  const next = [...current, { ...entry, key }];
  while (next.length > cap) next.shift();
  return { list: next, changed: true };
}

// ---- HLS grouping -------------------------------------------------------

const GENERIC_PLAYLIST = /^(master|playlist|index|main|manifest|stream|prog_index|chunklist|media|mono|hls|video|audio|live)$/i;
const MASTER_PLAYLIST = /^(master|playlist|manifest|main)$/i;
const QUALITY_DIR = /^(\d{3,4}p(\d{2})?|\d{3,4}x\d{3,4}|\d+k(bps)?|hd|sd|fhd|uhd|qhd|4k|high|medium|mid|low|best|auto|source|audio|video|v\d+|a\d+|stream_?\d+|hls_?\d+p?|(audio|video)[_-]\w+)$/i;
const QUALITY_SUFFIX = /([_.-](\d{3,4}p?(\d{2})?|\d{3,4}x\d{3,4}|\d+k(bps)?|hd|sd|fhd|uhd|high|medium|mid|low|audio|video|v\d+|a\d+))+$/i;

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function playlistBase(filename) {
  return filename.replace(/\.m3u8$/i, "").toLowerCase();
}

/** Key shared by a master playlist and its variant/rendition playlists. */
export function hlsGroupKey(url) {
  const u = parseUrl(url);
  if (!u) return String(url || "");
  const segs = u.pathname.split("/").filter(Boolean);
  const file = segs.pop() || "";
  while (segs.length && QUALITY_DIR.test(segs[segs.length - 1])) segs.pop();
  let base = playlistBase(file).replace(QUALITY_SUFFIX, "");
  if (GENERIC_PLAYLIST.test(base) || QUALITY_DIR.test(base) || /^\d+$/.test(base)) base = "";
  return `${u.origin}/${segs.join("/")}|${base}`;
}

function representativeScore(entry) {
  const u = parseUrl(entry.url);
  if (!u) return [9, 99, entry.detectedAt || 0];
  const segs = u.pathname.split("/").filter(Boolean);
  const base = playlistBase(segs[segs.length - 1] || "");
  return [MASTER_PLAYLIST.test(base) ? 0 : 1, segs.length, entry.detectedAt || 0];
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Picks the playlist to send for an HLS group (master-like, shallowest, oldest). */
export function pickRepresentative(members) {
  return members.slice().sort((a, b) => compareScores(representativeScore(a), representativeScore(b)))[0];
}

// ---- Display ------------------------------------------------------------

/** pt-BR size text ("850 KB", "12,3 MB") or "" when unknown. */
export function formatSize(bytes) {
  const n = toNumber(bytes);
  if (n === null || n === 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = i <= 1 ? 0 : value < 10 ? 1 : value < 100 ? 1 : 0;
  const text = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
  return `${text} ${units[i]}`;
}

/** Short human name for a media URL: file name, or parent/file for generic names. */
export function displayName(url) {
  const u = parseUrl(url);
  if (!u) return String(url || "");
  const segs = u.pathname.split("/").filter(Boolean).map(safeDecode);
  if (!segs.length) return u.hostname;
  const last = segs[segs.length - 1];
  const base = last.replace(/\.[a-z0-9]{2,5}$/i, "");
  const generic = GENERIC_PLAYLIST.test(base) || QUALITY_DIR.test(base) || base.length < 4 || /^\d+$/.test(base);
  if (generic && segs.length > 1) return `${segs[segs.length - 2]}/${last}`;
  return last;
}

/**
 * Builds the rows the popup shows: HLS variants collapsed under their master,
 * oldest first by detection (an HLS group dates from its first playlist). The
 * popup decides the order it displays (newest first by default).
 */
export function buildDisplayList(entries) {
  const groups = [];
  const byKey = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.kind === "hls") {
      const gk = hlsGroupKey(e.url);
      let g = byKey.get(gk);
      if (!g) {
        g = [];
        byKey.set(gk, g);
        groups.push(g);
      }
      g.push(e);
    } else {
      groups.push([e]);
    }
  }
  const rows = groups.map((members, order) => {
    const rep = members.length > 1 ? pickRepresentative(members) : members[0];
    const u = parseUrl(rep.url);
    return {
      id: rep.key || mediaKey(rep.url),
      kind: rep.kind,
      label: KIND_LABELS[rep.kind] || "Mídia",
      url: rep.url,
      name: displayName(rep.url),
      host: u ? u.hostname : "",
      size: rep.size ?? null,
      sizeText: formatSize(rep.size),
      variants: members.length - 1,
      headers: rep.headers || {},
      frameId: rep.frameId ?? null,
      meta: rep.meta || members.find((m) => m.meta)?.meta || null, // what the page said was playing
      detectedAt: Math.min(...members.map((m) => m.detectedAt || 0)),
      order,
    };
  });
  rows.sort((a, b) => a.detectedAt - b.detectedAt || a.order - b.order);
  return rows;
}

/** Popup order: newest first (default) or oldest first, by row.detectedAt; ties keep their order. */
export function sortRows(rows, newestFirst = true) {
  const sorted = rows
    .map((row, i) => [row, i])
    .sort((a, b) => (a[0].detectedAt || 0) - (b[0].detectedAt || 0) || a[1] - b[1])
    .map(([row]) => row);
  return newestFirst ? sorted.reverse() : sorted;
}

/** Number of rows the popup would show (used for the toolbar badge). */
export function displayCount(entries) {
  return buildDisplayList(entries).length;
}

/**
 * Rows of a music page: its HLS/DASH streams carry sound only (SoundCloud,
 * Bandcamp…), so they are labelled, previewed and downloaded as audio.
 */
export function markAudioStreams(rows, musicPage) {
  if (!musicPage) return rows;
  return rows.map((r) =>
    r.kind === "hls" || r.kind === "dash" ? { ...r, audio: true, label: r.kind === "hls" ? "Áudio HLS" : "Áudio DASH" } : r,
  );
}

/** Should a sniffed media ask the page what is playing? Audio files, and streams on music pages. */
export function wantsNowPlaying(entry, musicPage) {
  return entry.kind === "audio" || (musicPage && (entry.kind === "hls" || entry.kind === "dash"));
}

/** Mode sent to Cachalot for a sniffed row. */
export function modeForRow(row) {
  return row.audio ? "audio" : modeForKind(row.kind);
}

/** Mode sent to Cachalot for a media kind. */
export function modeForKind(kind) {
  return kind === "audio" ? "audio" : "video";
}
