import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MEDIA_PER_TAB,
  buildDisplayList,
  canonicalMediaUrl,
  classifyMediaResponse,
  displayCount,
  displayName,
  formatSize,
  hlsGroupKey,
  isFragmentResponse,
  isSegmentPath,
  kindFromContentType,
  mediaKey,
  modeForKind,
  parseContentRange,
  markAudioStreams,
  modeForRow,
  pickReplayHeaders,
  sortRows,
  upsertMedia,
  wantsNowPlaying,
} from "../src/lib/media.js";

const MB = 1024 * 1024;

test("classify by extension", () => {
  assert.deepEqual(classifyMediaResponse({ url: "https://cdn.x.com/v/master.m3u8" }), { kind: "hls", size: null });
  assert.deepEqual(classifyMediaResponse({ url: "https://cdn.x.com/v/manifest.mpd", contentType: "application/xml" }), { kind: "dash", size: null });
  for (const ext of ["mp4", "webm", "mov", "mkv"]) {
    assert.equal(classifyMediaResponse({ url: `https://x.com/a.${ext}`, contentLength: 5 * MB })?.kind, "video", ext);
  }
  for (const ext of ["mp3", "m4a", "ogg", "opus", "flac", "wav"]) {
    assert.equal(classifyMediaResponse({ url: `https://x.com/a.${ext}`, contentLength: 5 * MB })?.kind, "audio", ext);
  }
});

test("classify by content type when the URL has no extension", () => {
  assert.equal(classifyMediaResponse({ url: "https://x.com/play?id=1", contentType: "video/mp4", contentLength: 3 * MB })?.kind, "video");
  assert.equal(classifyMediaResponse({ url: "https://x.com/stream", contentType: "audio/mpeg; charset=x", contentLength: 3 * MB })?.kind, "audio");
  assert.equal(classifyMediaResponse({ url: "https://x.com/p", contentType: "application/vnd.apple.mpegurl" })?.kind, "hls");
  assert.equal(classifyMediaResponse({ url: "https://x.com/p", contentType: "application/x-mpegURL" })?.kind, "hls");
  assert.equal(classifyMediaResponse({ url: "https://x.com/p", contentType: "application/dash+xml" })?.kind, "dash");
  assert.equal(classifyMediaResponse({ url: "https://x.com/api", contentType: "application/json" }), null);
  assert.equal(classifyMediaResponse({ url: "https://x.com/page" }), null);
  // content type decides ambiguous containers
  assert.equal(classifyMediaResponse({ url: "https://x.com/a.webm", contentType: "audio/webm", contentLength: 2 * MB })?.kind, "audio");
});

test("rejects error statuses, html/json bodies and non-http URLs", () => {
  assert.equal(classifyMediaResponse({ url: "https://x.com/a.mp4", statusCode: 404 }), null);
  assert.equal(classifyMediaResponse({ url: "https://x.com/a.mp4", statusCode: 302 }), null);
  assert.equal(classifyMediaResponse({ url: "https://x.com/a.mp4", contentType: "text/html" }), null);
  assert.equal(classifyMediaResponse({ url: "https://x.com/a.m3u8", contentType: "application/json" }), null);
  assert.equal(classifyMediaResponse({ url: "blob:https://x.com/1", contentType: "video/mp4" }), null);
  assert.equal(classifyMediaResponse(undefined), null);
});

test("hides HLS/DASH segments and init chunks", () => {
  for (const path of ["/v/seg-001.ts", "/v/720p/12.ts", "/v/chunk_5.m4s", "/a/audio_001.aac", "/v/init.mp4", "/v/seg-12.mp4", "/v/video_init.mp4", "/v/x.cmfv"]) {
    assert.ok(isSegmentPath(path), path);
    assert.equal(classifyMediaResponse({ url: `https://cdn.x.com${path}`, contentLength: 3 * MB }), null, path);
  }
  assert.equal(classifyMediaResponse({ url: "https://cdn.x.com/v/1", contentType: "video/MP2T" }), null);
  assert.equal(kindFromContentType("video/iso.segment"), "segment");
  assert.ok(!isSegmentPath("/videos/my-holiday.mp4"));
  assert.ok(!isSegmentPath("/videos/segmentation-talk.mp4"));
});

test("hides range fragments under 1 MB but keeps whole files", () => {
  // player probing a piece in the middle of a file
  assert.equal(
    classifyMediaResponse({ url: "https://x.com/a.mp4", statusCode: 206, contentLength: 500000, contentRange: "bytes 1000000-1499999/80000000", requestRange: "bytes=1000000-1499999" }),
    null,
  );
  assert.ok(isFragmentResponse({ pieceSize: 1024, contentRange: "", requestRange: "bytes=0-1023" }));
  // "bytes=0-" on a small file returns the whole file: keep it, size = total
  assert.deepEqual(
    classifyMediaResponse({ url: "https://x.com/clip.webm", statusCode: 206, contentLength: 900000, contentRange: "bytes 0-899999/900000", requestRange: "bytes=0-" }),
    { kind: "video", size: 900000 },
  );
  // a large first piece is not a fragment; size comes from Content-Range
  assert.deepEqual(
    classifyMediaResponse({ url: "https://x.com/movie.mp4", statusCode: 206, contentLength: 4 * MB, contentRange: `bytes 0-${4 * MB - 1}/${300 * MB}`, requestRange: "bytes=0-" }),
    { kind: "video", size: 300 * MB },
  );
  // query-string ranges (fbcdn / instagram style)
  assert.equal(classifyMediaResponse({ url: "https://scontent.x.net/v.mp4?bytestart=0&byteend=800000", contentLength: 800001 }), null);
  assert.equal(classifyMediaResponse({ url: "https://x.net/v.mp4?range=0-50000", contentType: "video/mp4", contentLength: 50001 }), null);
  // a big query-range piece is kept, but its size is not the file size
  assert.deepEqual(
    classifyMediaResponse({ url: "https://scontent.x.net/v.mp4?bytestart=0&byteend=3000000", contentLength: 3000001 }),
    { kind: "video", size: null },
  );
});

test("canonicalMediaUrl drops bytestart/byteend so the whole file is fetched", () => {
  assert.equal(
    canonicalMediaUrl("https://scontent.cdninstagram.com/v/t50/abc.mp4?efg=1&bytestart=0&byteend=3000000&oh=x"),
    "https://scontent.cdninstagram.com/v/t50/abc.mp4?efg=1&oh=x",
  );
  const plain = "https://cdn.x.com/a.mp4?token=1";
  assert.equal(canonicalMediaUrl(plain), plain, "untouched when there is no byte range");
  assert.equal(canonicalMediaUrl("not a url"), "not a url");
});

test("hides tiny direct files (UI sounds) but not manifests", () => {
  assert.equal(classifyMediaResponse({ url: "https://x.com/click.mp3", contentLength: 4000 }), null);
  assert.deepEqual(classifyMediaResponse({ url: "https://x.com/a.m3u8", contentLength: 300 }), { kind: "hls", size: null });
  assert.deepEqual(classifyMediaResponse({ url: "https://x.com/a.mp3" }), { kind: "audio", size: null }, "unknown size is kept");
});

test("parseContentRange", () => {
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.deepEqual(parseContentRange("bytes 5-9/*"), { start: 5, end: 9, total: null });
  assert.equal(parseContentRange("garbage"), null);
});

test("pickReplayHeaders keeps Referer, Origin and User-Agent only", () => {
  const headers = [
    { name: "referer", value: "https://site.com/watch" },
    { name: "Origin", value: "https://site.com" },
    { name: "User-Agent", value: "UA/1" },
    { name: "Cookie", value: "secret" },
    { name: "Range", value: "bytes=0-" },
  ];
  assert.deepEqual(pickReplayHeaders(headers), { Referer: "https://site.com/watch", Origin: "https://site.com", "User-Agent": "UA/1" });
  assert.deepEqual(pickReplayHeaders(undefined), {});
});

test("mediaKey ignores volatile query strings", () => {
  assert.equal(mediaKey("https://cdn.x.com/a.mp4?token=1&exp=2"), "https://cdn.x.com/a.mp4");
  assert.equal(mediaKey("https://cdn.x.com/a.mp4?token=9"), mediaKey("https://cdn.x.com/a.mp4"));
});

test("upsertMedia dedupes by origin+path, refreshes URL and size, caps at 50", () => {
  const e = (url, extra = {}) => ({ key: mediaKey(url), url, kind: "video", size: null, headers: {}, detectedAt: 1, ...extra });
  let { list, changed } = upsertMedia([], e("https://x.com/a.mp4?t=1"));
  assert.equal(list.length, 1);
  assert.ok(changed);
  ({ list, changed } = upsertMedia(list, e("https://x.com/a.mp4?t=2", { size: 5 * MB, headers: { Referer: "r" } })));
  assert.equal(list.length, 1);
  assert.ok(changed);
  assert.equal(list[0].url, "https://x.com/a.mp4?t=2");
  assert.equal(list[0].size, 5 * MB);
  assert.equal(list[0].headers.Referer, "r");
  ({ changed } = upsertMedia(list, e("https://x.com/a.mp4?t=2", { size: 1000, headers: { Referer: "r" } })));
  assert.equal(changed, false, "a smaller size for the same file changes nothing");

  let big = [];
  for (let i = 0; i < MAX_MEDIA_PER_TAB + 5; i++) big = upsertMedia(big, e(`https://x.com/${i}.mp4`)).list;
  assert.equal(big.length, MAX_MEDIA_PER_TAB);
  assert.equal(big[0].url, "https://x.com/5.mp4", "oldest entries are dropped first");
});

test("hlsGroupKey groups variants with their master", () => {
  const master = hlsGroupKey("https://cdn.x.com/v/123/master.m3u8");
  assert.equal(hlsGroupKey("https://cdn.x.com/v/123/720p/index.m3u8"), master);
  assert.equal(hlsGroupKey("https://cdn.x.com/v/123/1080p/index.m3u8?token=a"), master);
  assert.equal(hlsGroupKey("https://cdn.x.com/v/123/index_720.m3u8"), master);
  assert.equal(hlsGroupKey("https://cdn.x.com/v/123/audio/index.m3u8"), master);
  assert.notEqual(hlsGroupKey("https://cdn.x.com/v/456/master.m3u8"), master, "other video id");
  assert.notEqual(hlsGroupKey("https://other.cdn.com/v/123/master.m3u8"), master, "other origin");
  assert.equal(hlsGroupKey("https://x.com/hls/movie.m3u8"), hlsGroupKey("https://x.com/hls/movie_1080p.m3u8"));
  assert.notEqual(hlsGroupKey("https://x.com/hls/movie.m3u8"), hlsGroupKey("https://x.com/hls/trailer.m3u8"));
});

test("buildDisplayList collapses HLS variants, prefers the master and keeps detection order", () => {
  const mk = (url, kind, detectedAt, size = null) => ({ key: mediaKey(url), url, kind, size, headers: { Referer: "https://site/" }, detectedAt });
  const entries = [
    mk("https://site.com/song.mp3", "audio", 1, 4 * MB),
    mk("https://cdn.site.com/v/9/720p/index.m3u8", "hls", 2),
    mk("https://cdn.site.com/v/9/master.m3u8", "hls", 3),
    mk("https://cdn.site.com/v/9/480p/index.m3u8", "hls", 4),
    mk("https://site.com/clip.webm", "video", 5, 2 * MB),
    mk("https://cdn.site.com/d/manifest.mpd", "dash", 6),
  ];
  const rows = buildDisplayList(entries);
  // oldest first; an HLS group dates from its first playlist (the popup shows newest first)
  assert.deepEqual(rows.map((r) => [r.kind, r.detectedAt]), [["audio", 1], ["hls", 2], ["video", 5], ["dash", 6]]);
  const hls = rows[1];
  assert.equal(hls.url, "https://cdn.site.com/v/9/master.m3u8");
  assert.equal(hls.variants, 2);
  assert.equal(hls.label, "Vídeo HLS");
  assert.equal(hls.name, "9/master.m3u8");
  assert.equal(hls.host, "cdn.site.com");
  assert.equal(rows[3].label, "DASH");
  assert.equal(rows[2].label, "Vídeo");
  assert.equal(rows[2].sizeText, "2 MB");
  assert.equal(rows[0].label, "Áudio");
  assert.equal(rows[0].headers.Referer, "https://site/");
  assert.equal(displayCount(entries), 4);
  assert.deepEqual(buildDisplayList(undefined), []);
});

test("sortRows: newest first by default, oldest first on request, stable on ties", () => {
  const rows = [{ id: "a", detectedAt: 5 }, { id: "b", detectedAt: 1 }, { id: "c", detectedAt: 5 }, { id: "d", detectedAt: 9 }];
  assert.deepEqual(sortRows(rows).map((r) => r.id), ["d", "c", "a", "b"]);
  assert.deepEqual(sortRows(rows, false).map((r) => r.id), ["b", "a", "c", "d"]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d"], "input untouched");
});

test("music pages: streams are audio, and new audio asks what is playing", () => {
  const rows = [{ kind: "hls", label: "Vídeo HLS" }, { kind: "dash", label: "DASH" }, { kind: "video", label: "Vídeo" }];
  assert.deepEqual(markAudioStreams(rows, true).map((r) => [r.label, Boolean(r.audio), modeForRow(r)]), [
    ["Áudio HLS", true, "audio"],
    ["Áudio DASH", true, "audio"],
    ["Vídeo", false, "video"],
  ]);
  assert.equal(markAudioStreams(rows, false), rows);
  assert.ok(wantsNowPlaying({ kind: "audio" }, false));
  assert.ok(wantsNowPlaying({ kind: "hls" }, true));
  assert.ok(!wantsNowPlaying({ kind: "hls" }, false));
  assert.ok(!wantsNowPlaying({ kind: "video" }, true));
});

test("displayName", () => {
  assert.equal(displayName("https://x.com/videos/My%20Trip.mp4?x=1"), "My Trip.mp4");
  assert.equal(displayName("https://x.com/v/abc/index.m3u8"), "abc/index.m3u8");
  assert.equal(displayName("https://x.com/"), "x.com");
});

test("formatSize uses pt-BR decimals", () => {
  assert.equal(formatSize(0), "");
  assert.equal(formatSize(null), "");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(850 * 1024), "850 KB");
  assert.equal(formatSize(12.34 * MB), "12,3 MB");
  assert.equal(formatSize(1.5 * 1024 * MB), "1,5 GB");
  assert.equal(formatSize(250 * MB), "250 MB");
});

test("modeForKind", () => {
  assert.equal(modeForKind("audio"), "audio");
  assert.equal(modeForKind("hls"), "video");
  assert.equal(modeForKind("video"), "video");
});
