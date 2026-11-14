import test from "node:test";
import assert from "node:assert/strict";
import {
  captureRect,
  durationOf,
  formatDuration,
  listenSource,
  normalizeScan,
  pickElement,
  playbackFor,
  previewCandidates,
  soundcloudWidgetUrl,
  trackRows,
  youtubeId,
  youtubeImages,
  youtubeLinkRows,
} from "../src/lib/preview.js";
import { PREVIEW_RULE_ID, previewHeaderRule } from "../src/lib/previewrule.js";
import { expandTemplate, parseHlsMaster, pickVariant } from "../src/lib/streams.js";

const CDN = "https://cdn.example.com";

function frame(frameId, elements, extra = {}) {
  return { frameId, top: frameId === 0, dpr: 1, viewport: { w: 1000, h: 800 }, pageImage: "", elements, ...extra };
}

function video(extra = {}) {
  return { tag: "video", src: "", poster: "", rect: { x: 0, y: 0, w: 640, h: 360 }, visible: true, playing: false, started: false, ...extra };
}

const hlsRow = { id: `${CDN}/hls/master.m3u8`, kind: "hls", url: `${CDN}/hls/master.m3u8?t=1`, frameId: 0 };
const fileRow = { id: `${CDN}/v/clip.mp4`, kind: "video", url: `${CDN}/v/clip.mp4?sig=x`, frameId: 0 };
const audioRow = { id: `${CDN}/a/song.mp3`, kind: "audio", url: `${CDN}/a/song.mp3`, frameId: 0 };

test("normalizeScan keeps frames with a result and their frameId", () => {
  const frames = normalizeScan([{ frameId: 0, result: { top: true, elements: [] } }, { frameId: 3, result: null }, null]);
  assert.deepEqual(frames, [{ frameId: 0, top: true, elements: [] }]);
});

test("a direct file matches the element playing it, ignoring the query string", () => {
  const playing = video({ src: `${CDN}/v/clip.mp4?other=1`, poster: `${CDN}/p.jpg` });
  const m = pickElement(fileRow, [frame(0, [video({ src: "blob:x", playing: true }), playing])]);
  assert.equal(m.element, playing);
  assert.equal(m.exact, true);
});

test("an HLS row takes the MSE player of its own frame: playing, then biggest", () => {
  const small = video({ src: "blob:a", playing: true, rect: { x: 0, y: 0, w: 200, h: 112 } });
  const big = video({ src: "blob:b", rect: { x: 0, y: 0, w: 1280, h: 720 } });
  const other = video({ src: "blob:c", playing: true });
  const frames = [frame(0, [big, small]), frame(7, [other])];
  assert.equal(pickElement(hlsRow, frames).element, small);
  assert.equal(pickElement({ ...hlsRow, frameId: 7 }, frames).element, other);
  // elements playing another file are not the HLS player
  assert.equal(pickElement(hlsRow, [frame(0, [video({ src: `${CDN}/v/other.mp4`, playing: true })])]), null);
});

test("candidates: poster first, then the file, the playing video and the cover", () => {
  const frames = [frame(0, [video({ src: `${CDN}/v/clip.mp4`, poster: `${CDN}/poster.jpg`, playing: true })], { pageImage: `${CDN}/og.jpg` })];
  assert.deepEqual(
    previewCandidates(fileRow, frames, { canCapture: true }).map((c) => c.type + ":" + (c.url || "")),
    [`image:${CDN}/poster.jpg`, `video:${fileRow.url}`, "capture:", `image:${CDN}/og.jpg`],
  );
});

test("candidates: a stream comes from itself, then the capture of its player, then the cover", () => {
  const frames = [frame(0, [video({ src: "blob:a", playing: true, rect: { x: 10, y: 20, w: 320, h: 180 } })], { dpr: 2, pageImage: `${CDN}/og.jpg` })];
  const capture = { type: "capture", rect: { x: 20, y: 40, w: 640, h: 360 } };
  const cover = { type: "image", url: `${CDN}/og.jpg` };
  assert.deepEqual(previewCandidates(hlsRow, frames, { canCapture: true }), [
    { type: "stream", format: "hls", url: hlsRow.url },
    capture,
    cover,
  ]);
  assert.deepEqual(previewCandidates(hlsRow, frames, { canCapture: true, hls: false }), [capture, cover], "no native HLS");
  assert.deepEqual(previewCandidates(hlsRow, frames, { canCapture: false, streams: false }), [cover]);
  const dash = { ...hlsRow, kind: "dash", url: `${CDN}/d/manifest.mpd` };
  assert.equal(previewCandidates(dash, frames)[0].format, "dash");
});

test("playbackFor plays each type its own way", () => {
  assert.deepEqual(playbackFor(fileRow), { type: "video", url: fileRow.url });
  assert.deepEqual(playbackFor(audioRow), { type: "audio", url: audioRow.url });
  assert.deepEqual(playbackFor(hlsRow), { type: "stream", format: "hls", url: hlsRow.url });
  assert.equal(playbackFor(hlsRow, { hls: false }), null);
  assert.equal(playbackFor({ ...hlsRow, kind: "dash" }).format, "dash");
});

test("candidates: a file no element plays ignores the page player's poster", () => {
  const frames = [frame(0, [video({ src: "blob:a", poster: `${CDN}/player.jpg`, playing: true })])];
  assert.deepEqual(previewCandidates(fileRow, frames, { canCapture: true }), [{ type: "video", url: fileRow.url }]);
});

test("candidates: audio uses the page cover; nothing when there is none", () => {
  const frames = [frame(0, [video({ src: "blob:a", playing: true })], { pageImage: `${CDN}/cover.jpg` })];
  assert.deepEqual(previewCandidates(audioRow, frames), [{ type: "image", url: `${CDN}/cover.jpg` }]);
  assert.deepEqual(previewCandidates(audioRow, [frame(0, [])]), []);
});

test("youtubeId reads every YouTube URL shape and rejects the rest", () => {
  const id = "dQw4w9WgXcQ";
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&t=42`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?si=x`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://youtu.be/${id}?si=abc`,
  ]) {
    assert.equal(youtubeId(url), id, url);
  }
  assert.equal(youtubeId("https://www.youtube.com/"), "");
  assert.equal(youtubeId("https://www.youtube.com/watch?v=short"), "");
  assert.equal(youtubeId("https://vimeo.com/watch?v=dQw4w9WgXcQ"), "");
});

test("a YouTube page row previews with YouTube's own pictures", () => {
  const page = { id: "page:x", kind: "page", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", frameId: 0 };
  const yt = youtubeImages(page.url);
  assert.equal(yt.thumb, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  const frames = [frame(0, [video({ src: "blob:yt", playing: true, duration: 213 })], { pageImage: "https://i.ytimg.com/old.jpg" })];
  assert.deepEqual(previewCandidates(page, frames, { canCapture: true }).map((c) => c.type + ":" + (c.url || "")), [
    `image:${yt.thumb}`,
    "capture:",
    "image:https://i.ytimg.com/old.jpg",
  ]);
  const pb = playbackFor(page);
  assert.equal(pb.type, "slides");
  assert.deepEqual(pb.urls, [yt.stills[0], ...yt.frames]);
  assert.equal(durationOf(page, frames), 213);
  const plain = [frame(0, [video({ src: "https://www.youtube.com/media/clip.webm", playing: true, duration: 4 })])];
  assert.equal(durationOf(page, plain), 4, "the page's main player, whatever its source");
  assert.equal(playbackFor({ ...page, url: "https://www.youtube.com/feed" }), null);
});

test("youtubeLinkRows lists the other videos on the page, in order, once, without the page's own", () => {
  const frames = [
    frame(0, [], {
      videos: [
        { id: "AAAAAAAAAAA", short: false, title: "Outro vídeo", duration: "3:21", thumb: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg?sqp=x" },
        { id: "dQw4w9WgXcQ", short: false, title: "O vídeo da página", duration: "", thumb: "" },
        { id: "BBBBBBBBBBB", short: true, title: "", duration: "", thumb: "" },
      ],
    }),
    frame(3, [], { videos: [{ id: "AAAAAAAAAAA", short: false, title: "repetido", duration: "", thumb: "" }] }),
  ];
  const rows = youtubeLinkRows(frames, { excludeId: "dQw4w9WgXcQ" });
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.label, r.url, r.name, r.durationText]), [
    ["yt:AAAAAAAAAAA", "youtube", "YouTube", "https://www.youtube.com/watch?v=AAAAAAAAAAA", "Outro vídeo", "3:21"],
    ["yt:BBBBBBBBBBB", "youtube", "Shorts", "https://www.youtube.com/shorts/BBBBBBBBBBB", "Vídeo do YouTube", ""],
  ]);
  // thumbnail: YouTube's own picture, else the one the page loaded; the preview steps through its frames
  assert.deepEqual(previewCandidates(rows[0], frames, { canCapture: true }), [
    { type: "image", url: "https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg" },
    { type: "image", url: "https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg?sqp=x" },
  ]);
  assert.equal(playbackFor(rows[1]).type, "slides");
  assert.equal(durationOf(rows[0], frames), 0, "the card's own text is used instead");
});

test("trackRows lists the page's tracks once, without the page's own, with cover and stream", () => {
  const frames = [
    frame(0, [], {
      tracks: [
        { url: "https://soundcloud.com/artista/faixa-um", title: "Faixa Um", artist: "Artista", duration: "3:05", artwork: "https://i1.sndcdn.com/a.jpg", stream: "" },
        { url: "https://soundcloud.com/artista/esta", title: "Esta", artist: "Artista", duration: "", artwork: "", stream: "" },
        { url: "https://banda.bandcamp.com/track/a", title: "Faixa A", artist: "Banda", duration: "0:06", artwork: "", stream: "https://t4.bcbits.com/stream/a.mp3" },
      ],
    }),
    frame(2, [], { tracks: [{ url: "https://soundcloud.com/artista/faixa-um#t=1", title: "repetida" }] }),
  ];
  const rows = trackRows(frames, { excludeUrl: "https://soundcloud.com/artista/esta?in=x", platformName: (u) => (u.includes("bandcamp") ? "Bandcamp" : "SoundCloud") });
  assert.deepEqual(rows.map((r) => [r.kind, r.label, r.name, r.artist, r.durationText]), [
    ["track", "SoundCloud", "Faixa Um", "Artista", "3:05"],
    ["track", "Bandcamp", "Faixa A", "Banda", "0:06"],
  ]);
  assert.deepEqual(previewCandidates(rows[0], frames), [{ type: "image", url: "https://i1.sndcdn.com/a.jpg" }]);
  // sound plays by type: a stream file in <audio>, a SoundCloud page in SoundCloud's own player
  assert.deepEqual(listenSource(rows[1]), { type: "media", src: "https://t4.bcbits.com/stream/a.mp3", hls: false });
  const sc = listenSource(rows[0]);
  assert.equal(sc.type, "widget");
  assert.equal(new URL(sc.url).origin, "https://w.soundcloud.com");
  assert.equal(new URL(sc.url).searchParams.get("url"), "https://soundcloud.com/artista/faixa-um");
  assert.equal(soundcloudWidgetUrl("https://soundcloud.com/a/b").includes("auto_play=true"), true);
});

test("listenSource: audio files, audio HLS (natively), nothing for video", () => {
  assert.deepEqual(listenSource(audioRow), { type: "media", src: audioRow.url, hls: false });
  const scStream = { ...hlsRow, audio: true };
  assert.deepEqual(listenSource(scStream), { type: "media", src: hlsRow.url, hls: true });
  assert.equal(listenSource(scStream, { hls: false }), null);
  assert.equal(listenSource(hlsRow), null, "a video stream is watched, not listened to");
  assert.equal(listenSource(fileRow), null);
  assert.equal(playbackFor(scStream).type, "audio");
  const playing = { ...scStream, meta: { title: "Música", artist: "Artista", artwork: "https://cdn/cover.jpg" } };
  assert.deepEqual(previewCandidates(playing, [frame(0, [])])[0], { type: "image", url: "https://cdn/cover.jpg" });
});

test("the page of a SoundCloud track is itself playable (the page card)", () => {
  const page = (url) => ({ id: `main:${url}`, kind: "page", url });
  const track = listenSource(page("https://soundcloud.com/ospiel/second-before?in=x"));
  assert.equal(track.type, "widget");
  assert.equal(new URL(track.url).searchParams.get("url"), "https://soundcloud.com/ospiel/second-before");
  assert.equal(listenSource(page("https://soundcloud.com/forss/sets/soulhack")).type, "widget");
  assert.equal(listenSource(page("https://soundcloud.com/discover")), null);
  assert.equal(listenSource(page("https://soundcloud.com/forss")), null, "an artist page");
  assert.equal(listenSource(page("https://soundcloud.com/forss/likes")), null);
  assert.equal(listenSource(page("https://www.youtube.com/watch?v=dQw4w9WgXcQ")), null);
});

test("formatDuration", () => {
  assert.equal(formatDuration(42), "0:42");
  assert.equal(formatDuration(725), "12:05");
  assert.equal(formatDuration(3729), "1:02:09");
});

test("parseHlsMaster lists variants with absolute URLs; media playlists have none", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
    "720p/index.m3u8",
    "#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240",
    "",
    "https://other.cdn/240p.m3u8?sig=1",
    "#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=256x144",
    "144p.m3u8",
  ].join("\n");
  const variants = parseHlsMaster(master, `${CDN}/hls/v1/master.m3u8`);
  assert.deepEqual(variants.map((v) => [v.url, v.bandwidth, v.height]), [
    [`${CDN}/hls/v1/720p/index.m3u8`, 2500000, 720],
    ["https://other.cdn/240p.m3u8?sig=1", 400000, 240],
    [`${CDN}/hls/v1/144p.m3u8`, 150000, 144],
  ]);
  assert.deepEqual(parseHlsMaster("#EXTM3U\n#EXTINF:4,\nseg1.ts\n", CDN + "/x.m3u8"), []);
  assert.equal(parseHlsMaster("<html>", CDN), null);
});

test("pickVariant takes the lightest variant that still looks like video", () => {
  const v = (bandwidth, height) => ({ url: `u${bandwidth}`, bandwidth, height });
  assert.equal(pickVariant([v(2500000, 720), v(400000, 240), v(150000, 144)]).url, "u400000");
  assert.equal(pickVariant([v(800000, 0), v(300000, 0)]).url, "u300000", "no resolution: lightest");
  assert.equal(pickVariant([v(150000, 144), v(90000, 120)]).url, "u150000", "only tiny variants: the best of them");
  assert.equal(pickVariant([]), null);
});

test("expandTemplate fills DASH identifiers with widths", () => {
  const vars = { RepresentationID: "v1", Number: 7, Time: 90000, Bandwidth: 500000 };
  assert.equal(expandTemplate("chunk-$RepresentationID$-$Number%05d$.m4s", vars), "chunk-v1-00007.m4s");
  assert.equal(expandTemplate("t/$Time$/$Bandwidth$.mp4?a=$$", vars), "t/90000/500000.mp4?a=$");
});

test("previewHeaderRule sets the Referer only on the extension's own preview requests", () => {
  const rule = previewHeaderRule({ referer: "https://site.com/watch/1", extensionId: "abc", tabIds: [-1, 42] });
  assert.equal(rule.id, PREVIEW_RULE_ID);
  assert.deepEqual(rule.action.requestHeaders, [{ header: "referer", operation: "set", value: "https://site.com/watch/1" }]);
  assert.deepEqual(rule.condition.initiatorDomains, ["abc"]);
  assert.deepEqual(rule.condition.tabIds, [-1, 42]);
  assert.ok(rule.condition.excludedRequestDomains.includes("127.0.0.1"), "never the bridge");
  assert.equal(previewHeaderRule({ referer: "chrome://newtab", extensionId: "abc" }), null);
});

test("captureRect clamps to the viewport and skips sub-frames and hidden players", () => {
  const f = frame(0, [], { dpr: 1.5 });
  assert.deepEqual(captureRect(f, video({ rect: { x: -100, y: 700, w: 640, h: 360 } })), { x: 0, y: 1050, w: 810, h: 150 });
  assert.equal(captureRect(f, video({ visible: false })), null);
  assert.equal(captureRect(frame(4, []), video()), null);
  assert.equal(captureRect(f, video({ rect: { x: 0, y: 790, w: 640, h: 360 } })), null, "only 10 px on screen");
});
